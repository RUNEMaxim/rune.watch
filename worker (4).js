// ============================================================================
// rune-rewards-backend — GEBÜNDELTE Version für den Cloudflare-Dashboard-Editor
// FIX 1: Poisoned-Zero-Check entfernt
// FIX 2: Sofort-Refresh bei jedem Abruf statt nur alle 5 Min. per Cron
// FIX 3: Refresh-Cooldown 3s
// FIX 4: /balance-Endpunkt - Balance+Bonded laufen server-seitig (kein CORS-Problem mehr)
// FIX 5: Dedizierter Liquify-Endpunkt (eigener API-Key) als bevorzugte THORNode-Quelle -- der
//        öffentliche, geteilte Gateway (viele anonyme Nutzer, evtl. mit internem Lastausgleich
//        über mehrere, nicht immer synchrone Instanzen) bleibt als Fallback.
// FIX 6: /balance cached erfolgreiche Antworten in D1 (balance_cache) und fällt bei einem
//        Liquify-Ausfall/Timeout auf den letzten bekannten Stand zurück (bis zu 1h alt),
//        statt sofort einen Fehler an den Client zu liefern.
// FIX 7: getThornodeBases() enthielt bisher AUSSCHLIESSLICH Liquify (einmal mit, einmal ohne
//        eigenen API-Key -- aber beides derselbe Anbieter/dieselbe Infrastruktur!). Fiel Liquify
//        aus, gab es serverseitig KEINEN echten Fallback, egal was clientseitig gemacht wird.
//        Ergänzt um public-thornode.nativeswap.io (kein Key nötig, laut rune.tools-Projekt eine
//        zuverlässig funktionierende, echte Alternative) und als letzten Versuch
//        thornode.thorchain.network. WICHTIG: diese beiden Alternativen unterstützen KEINE
//        historischen ?height=N-Abfragen (nur aktueller Stand) -- deshalb NUR für
//        Nicht-Height-Anfragen (fetchNodes, fetchBalance) aktiv, NICHT für fetchNodeAtHeight
//        (Reward-Berechnung pro Churn-Höhe). Würde man sie dort auch zulassen, könnte bei einem
//        Liquify-Ausfall still und leise der AKTUELLE Node-Stand statt der historische
//        eingelesen werden -- falsche Reward-Zahlen, ohne dass es auffällt.
// FIX 8 (PERFORMANCE / Core Web Vitals): fetchFromBases probierte die Fallback-Quellen bisher
//        STRIKT NACHEINANDER, jede mit vollen 10s Timeout -- im schlimmsten Fall (erste Quelle(n)
//        hängen statt sauber zu antworten) warteten Client-Requests bis zu ~30s auf eine Antwort,
//        was sich 1:1 in den LCP/FCP-Ausreißern auf 15-25s widerspiegelt. Ersetzt durch ein
//        "Hedged Request"-Muster: Quelle 1 startet sofort; antwortet sie nicht innerhalb von
//        STAGGER_MS, startet zusätzlich (nicht ANSTATT) Quelle 2 parallel dazu, danach ggf.
//        Quelle 3 usw. Es gewinnt schlicht die erste Antwort, unabhängig davon, welche Quelle sie
//        liefert -- alle bereits laufenden Requests werden dabei NICHT abgebrochen (nur die noch
//        nicht gestarteten Quellen werden übersprungen, sobald irgendeine Quelle erfolgreich war).
//        Reduziert die Worst-Case-Wartezeit von ~30s auf ~STAGGER_MS * (Anzahl Quellen - 1) +
//        einen einzelnen Timeout (bei 3 Quellen z.B. ~2.5s*2 + 6s = ~11s statt 30s), ohne die
//        bevorzugte Quelle (Liquify mit eigenem Key) bei normalem Betrieb zu benachteiligen, da
//        sie in aller Regel deutlich schneller als STAGGER_MS antwortet. Gilt jetzt einheitlich
//        für THORNode- UND Midgard-Anfragen (vorher hatte Midgard eine eigene, komplett
//        sequenzielle Kopie derselben Logik).
// FIX 9: /purchases synchronisiert jetzt zusätzlich zur Kaufliste auch die
//        Berechnungs-Einstellungen (costBasisMethod: 'average'|'fifo', rewardValuationMethod:
//        'free'|'market'). Ohne das rechnete jedes Gerät mit seinen eigenen, nur lokal
//        gespeicherten Einstellungen und zeigte einen ANDEREN Ø-Kaufpreis für dieselben Daten.
//
//        VORHER EINMALIG PER SQL AUSFÜHREN (D1 -> Console):
//
//          ALTER TABLE user_purchases ADD COLUMN settings TEXT;
//
//        Die Spalte darf NULL sein -- Adressen ohne gespeicherte Einstellungen verhalten sich
//        exakt wie bisher (der Client behält dann seinen lokalen Stand und schreibt ihn beim
//        nächsten Push hoch).
// FIX 10 (NEU): Drei Midgard-Anfragen liefen bisher DIREKT AUS DEM BROWSER gegen
//        gateway.liquify.com/midgard.thorchain.network -- ohne jeden serverseitigen
//        Fallback/Cache, im Unterschied zu allen anderen Daten (Balance, Bond-Historie), die
//        längst über diesen Worker laufen. Blockiert das Netzwerk eines einzelnen Nutzers (z.B.
//        eine Firewall/ein Proxy, der bestimmte Domains sperrt) BEIDE Midgard-Basen, blieb die
//        betroffene Karte ohne jede Ausweichmöglichkeit dauerhaft leer/fehlerhaft -- ein
//        klassischer Single-Point-of-Failure auf Client-Seite, den kein Fallback im Frontend
//        beheben kann, weil das Problem beim NUTZER liegt, nicht bei Midgard selbst. Server-zu-
//        Server-Anfragen (von HIER aus) sind von dieser Einschränkung nicht betroffen, exakt wie
//        schon bei /balance und /bond-history.
//
//        Drei neue Routen, alle nach demselben bewährten Muster (fetchFromBases/Hedging,
//        kurzlebiger In-Memory-Cache gegen Lastspitzen bei vielen gleichzeitigen Nutzern):
//
//        - /volume         -- 24h- und 30-Tage-Swap-Volumen (löst fetchVolume24h/
//                              fetchVolumeHistory im Frontend ab)
//        - /recent-swaps   -- die letzten Swaps für die Live-Partikel-/Live-Chart-Anzeige
//                              (wird alle 7s gepollt, deshalb mit eigenem kurzem Cache, damit
//                              nicht jeder gleichzeitig online Nutzer einen eigenen
//                              Midgard-Request auslöst)
//        - /bond-ledger    -- die vollständige Bond/Unbond-Transaktionsliste samt Kapital
//                              (Principal) für eine Adresse (löst fetchActionsForType/
//                              fetchBondLedger im Frontend ab). Nutzt dieselbe
//                              fetchActionsForType-Funktion, die auch der bestehende
//                              Cron-Refresh für /bond-history verwendet -- jetzt erweitert um
//                              die volle Transaktionsliste (items), die das Frontend für die
//                              Anzeige einzelner Bond/Unbond-Ereignisse braucht.
// ============================================================================

// Der Liquify-API-Key liegt NICHT mehr im Klartext-Code, sondern als Secret in den
// Worker-Settings (Variables and Secrets -> LIQUIFY_API_KEY). Damit die bisherigen,
// modul-weiten THORNODE_BASES/MIDGARD_BASES weiterhin ohne Umbau aller Funktionssignaturen
// funktionieren, wird env einmal pro Request in `currentEnv` zwischengespeichert (siehe
// fetch()/scheduled() ganz unten) und getThornodeBases() baut die Liste daraus dynamisch.
let currentEnv = null;

// needsHeight: true  -> NUR Quellen, die historische ?height=N-Abfragen unterstützen (Liquify).
// needsHeight: false (Standard) -> volle Liste inkl. NativeSwap/thornode.thorchain.network als
//              Fallback für aktuelle (nicht-historische) Abfragen.
function getThornodeBases({ needsHeight = false } = {}) {
  const key = currentEnv && currentEnv.LIQUIFY_API_KEY;
  const bases = [];
  if (key) bases.push(`https://gateway.liquify.com/api=${key}`);
  bases.push('https://gateway.liquify.com/chain/thorchain_api');
  if (!needsHeight) {
    bases.push('https://public-thornode.nativeswap.io');
    bases.push('https://thornode.thorchain.network');
  }
  return bases;
}

const MIDGARD_BASES = [
  'https://gateway.liquify.com/chain/thorchain_midgard/v2',
  'https://midgard.thorchain.network/v2',
];

async function fetchWithTimeout(url, { timeoutMs = 10000, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// FIX 8: Hedged-Request-Helfer (siehe Kommentar oben). PER_BASE_TIMEOUT_MS ist der Timeout für
// EINE einzelne Quelle (nicht mehr 10s), STAGGER_MS die Wartezeit, bevor zusätzlich die nächste
// Quelle danebengestartet wird. Beide bewusst so gewählt, dass eine normal schnelle Primärquelle
// (typischerweise < 1s) niemals eine zweite parallele Anfrage auslöst -- die Staffelung greift
// wirklich nur, wenn eine Quelle spürbar hängt.
//
// FIX 13: STAGGER_MS von 2500ms auf 800ms reduziert. War Liquify (immer die erste Quelle in den
// jeweiligen BASES-Arrays) spürbar langsam, aber nicht komplett down, ergab sich WORST CASE
// bisher ~2x 2500ms = 5s, bis die zweite Quelle überhaupt eine Antwort zurückgegeben hatte --
// exakt die gemeldete 5s-Verzögerung beim ersten Laden der Live-Swap-Anzeige. Ein kürzerer
// Stagger kann NIEMALS schaden: ist die Primärquelle wie üblich schnell (<800ms), ändert sich
// gar nichts (die zweite Quelle wird ohnehin nie gebraucht, siehe settled-Flag in attempt()
// weiter unten). Nur wenn die Primärquelle TATSÄCHLICH langsam ist, startet die zweite Quelle
// jetzt deutlich früher parallel dazu -- reduziert die Worst-Case-Wartezeit über ALLE gehedgten
// Endpunkte hinweg (Balance, Bond-Ledger, Volumen, Recent-Swaps), nicht nur diesen einen.
const PER_BASE_TIMEOUT_MS = 6000;
const STAGGER_MS = 800;

async function fetchJsonHedged(bases, pathForBase, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = bases.length;
    const errors = [];
    let timers = [];

    const clearAllTimers = () => {
      for (const t of timers) clearTimeout(t);
      timers = [];
    };

    const attempt = async (base, index) => {
      try {
        const res = await fetchWithTimeout(pathForBase(base), {
          timeoutMs: PER_BASE_TIMEOUT_MS,
          headers: { 'x-client-id': 'rune-rewards-backend', ...(options.headers || {}) },
          ...options,
        });
        if (!res.ok) throw new Error(`HTTP_${res.status} (${base})`);
        const data = await res.json();
        if (!settled) {
          settled = true;
          clearAllTimers();
          resolve(data);
        }
      } catch (e) {
        errors[index] = e;
        pending -= 1;
        if (!settled && pending === 0) {
          settled = true;
          clearAllTimers();
          reject(errors.find(Boolean) || new Error('ALL_BASES_FAILED'));
        }
      }
    };

    // Erste Quelle startet sofort. Jede weitere Quelle startet entweder STAGGER_MS nach der
    // vorherigen ODER sofort, sobald ihre linke(n) Nachbar-Quelle(n) bereits fehlgeschlagen sind
    // (kein Grund zu warten, wenn eh schon feststeht, dass wir sie brauchen).
    bases.forEach((base, index) => {
      const timer = setTimeout(() => {
        if (!settled) attempt(base, index);
      }, index * STAGGER_MS);
      timers.push(timer);
    });
  });
}

async function fetchFromBases(bases, path, options = {}) {
  return fetchJsonHedged(bases, (base) => `${base}${path}`, options);
}

// Kurzlebiger Cache (2s) für die komplette Node-Liste: mehrere getrackte Adressen (oder
// mehrere Requests kurz hintereinander) lösen sonst jedes Mal einen eigenen, vollständigen
// /thorchain/nodes-Abruf aus, obwohl die Antwort für ALLE Adressen identisch ist. Der Cache
// lebt nur innerhalb desselben Worker-Isolats (Cloudflare kann Isolate jederzeit neu starten) --
// im schlimmsten Fall greift er einfach nicht und es läuft wie vorher, kein Risiko für falsche
// Daten, nur eine mögliche Zeitersparnis.
let nodesCache = null; // { promise, atMs }
const NODES_CACHE_MS = 2000;

function fetchNodes() {
  if (nodesCache && Date.now() - nodesCache.atMs < NODES_CACHE_MS) {
    return nodesCache.promise;
  }
  const promise = fetchFromBases(getThornodeBases(), '/thorchain/nodes');
  // Siehe ausführliche Begründung bei fetchRecentSwapActionsCached (FIX 11): ein
  // fehlgeschlagenes Promise darf nicht für die volle Cache-Dauer an nachfolgende Aufrufer
  // weitergereicht werden, sonst wiederholt sich ein einzelner Fehlschlag unnötig oft.
  promise.catch(() => {
    if (nodesCache && nodesCache.promise === promise) nodesCache = null;
  });
  nodesCache = { promise, atMs: Date.now() };
  return promise;
}

function fetchNodeAtHeight(nodeAddress, height) {
  // needsHeight: true -- siehe FIX 7 oben. Nur Liquify-Basen, kein NativeSwap/thornode.network.
  return fetchFromBases(getThornodeBases({ needsHeight: true }), `/thorchain/node/${nodeAddress}?height=${height}`);
}

function fetchChurns() {
  return fetchFromBases(MIDGARD_BASES, '/churns');
}

function fetchBalance(address) {
  return fetchFromBases(getThornodeBases(), `/cosmos/bank/v1beta1/balances/${address}`);
}

async function fetchMidgardActionsPage(address, txType, offset) {
  return fetchFromBases(MIDGARD_BASES, `/actions?address=${address}&type=${txType}&limit=50&offset=${offset}`);
}

// ----------------------------------------------------------------------------
// FIX 10: /volume -- 24h- und 30-Tage-Swap-Volumen. Kurzlebiger Cache (5s): das Frontend pollt
// alle 30s, bei mehreren gleichzeitig aktiven Nutzern würde sonst trotzdem jeder Request einzeln
// bis zu Midgard durchgereicht, obwohl die Antwort für alle identisch ist.
// ----------------------------------------------------------------------------
function fetchVolumeInterval(interval, count) {
  return fetchFromBases(MIDGARD_BASES, `/history/swaps?interval=${interval}&count=${count}`);
}

let volumeCache = null; // { promise, atMs }
const VOLUME_CACHE_MS = 5000;

function fetchVolumeBundle() {
  if (volumeCache && Date.now() - volumeCache.atMs < VOLUME_CACHE_MS) {
    return volumeCache.promise;
  }
  const promise = (async () => {
    const [hourResult, dayResult] = await Promise.allSettled([
      fetchVolumeInterval('hour', 24),
      fetchVolumeInterval('day', 30),
    ]);
    return {
      hour: hourResult.status === 'fulfilled' ? hourResult.value : null,
      hourError: hourResult.status === 'rejected' ? (hourResult.reason?.message || String(hourResult.reason)) : null,
      day: dayResult.status === 'fulfilled' ? dayResult.value : null,
      dayError: dayResult.status === 'rejected' ? (dayResult.reason?.message || String(dayResult.reason)) : null,
    };
  })();
  volumeCache = { promise, atMs: Date.now() };
  return promise;
}

async function handleVolume(request, env) {
  const data = await fetchVolumeBundle();
  return json(data, env);
}

// ----------------------------------------------------------------------------
// FIX 10: /recent-swaps -- die letzten Swaps für die Live-Fee-Ticker-Anzeige im Frontend. Wird
// dort alle 7s gepollt -- kurzlebiger Cache (4s), damit bei mehreren gleichzeitig aktiven
// Nutzern nicht jeder einen eigenen Midgard-Request alle 7s auslöst, sondern sich mehrere
// Polls dieselbe, ganz frische Antwort teilen.
//
// FIX 11 (weiterhin 502 trotz limit=50->20 + Cache-Fix): noch zwei Stufen robuster gemacht.
// 1) limit weiter auf 10 reduziert und der Anfrage über die options-Weiterreichung in
//    fetchFromBases ein LÄNGERER, eigener Timeout gegeben (12s statt der globalen 6s in
//    PER_BASE_TIMEOUT_MS) -- der unfilterte netzwerkweite /actions-Endpunkt scheint bei Midgard
//    grundsätzlich langsamer zu sein als adressgefilterte oder aggregierte Endpunkte
//    (/history/swaps, /actions?address=X), vermutlich weil er nicht denselben Weg über
//    vorberechnete/indexierte Daten nehmen kann. Der Timeout gilt NUR für diese eine Anfrage
//    (options.timeoutMs überschreibt in fetchJsonHedged gezielt den Default), alle anderen
//    Endpunkte bleiben bei den bisherigen 6s.
// 2) WICHTIGER: schlagen trotzdem beide Quellen fehl, wird jetzt NIE MEHR ein harter 502-Fehler
//    an den Client zurückgegeben -- stattdessen eine leere, aber gültige Antwort ({actions:[]}).
//    Für eine Live-Anzeige, die ohnehin alle 7s erneut pollt, ist "dieser eine Zyklus zeigt
//    nichts Neues" ein völlig unauffälliger Zustand, "ein Request schlägt sichtbar fehl" dagegen
//    nicht -- das eine ist harmlos, das andere wirkt wie ein kaputtes Feature.
// ----------------------------------------------------------------------------
function fetchRecentSwapActions() {
  return fetchFromBases(MIDGARD_BASES, '/actions?type=swap&limit=10', {
    timeoutMs: 12000
  });
}

let recentSwapsCache = null; // { promise, atMs }
const RECENT_SWAPS_CACHE_MS = 4000;

function fetchRecentSwapActionsCached() {
  if (recentSwapsCache && Date.now() - recentSwapsCache.atMs < RECENT_SWAPS_CACHE_MS) {
    return recentSwapsCache.promise;
  }
  const promise = fetchRecentSwapActions();
  // Bei Fehlschlag den Cache SOFORT wieder leeren (nicht die volle Cache-Dauer stehen lassen)
  // -- verhindert, dass ein einzelner Fehlschlag an nachfolgende Aufrufer innerhalb des
  // 4s-Fensters weitergereicht wird, statt dass diese einen eigenen, frischen Versuch starten.
  promise.catch(() => {
    if (recentSwapsCache && recentSwapsCache.promise === promise) {
      recentSwapsCache = null;
    }
  });
  recentSwapsCache = { promise, atMs: Date.now() };
  return promise;
}

async function handleRecentSwaps(request, env) {
  try {
    const data = await fetchRecentSwapActionsCached();
    return json(data, env);
  } catch (e) {
    console.warn('[rune-rewards-backend] /recent-swaps fehlgeschlagen (beide Quellen):', e?.message || String(e));
    // Bewusst KEIN 502 mehr -- eine leere, aber gültige Antwort. Die Live-Anzeige pollt ohnehin
    // alle 7s erneut; "dieser eine Zyklus zeigt nichts Neues" fällt nicht auf, ein sichtbarer
    // Fehler dagegen schon.
    return json({
      actions: []
    }, env);
  }
}

// ----------------------------------------------------------------------------
// FIX 12: Top-5-Swap-Paare der letzten 12h/24h ("welche Paare wurden am häufigsten
// geswapt"). Das lässt sich NICHT live pro Anfrage berechnen -- dafür bräuchte man
// potenziell tausende Swap-Actions der letzten 24h von Midgard, seitenweise paginiert, bei
// jeder einzelnen Anfrage. Stattdessen sammelt der ohnehin laufende Cron-Job (siehe
// runRefreshCycle) bei JEDEM Durchlauf die letzten 50 Swaps ein und schreibt sie in eine
// eigene D1-Tabelle -- die eigentliche Abfrage (/top-pairs) liest dann nur noch aus dieser
// bereits gesammelten, kleinen Tabelle, dauert also nur Millisekunden statt Sekunden.
//
// VORHER EINMALIG PER SQL AUSFÜHREN (D1 -> Console):
//
//   CREATE TABLE IF NOT EXISTS swap_events (
//     tx_id TEXT PRIMARY KEY,
//     pair TEXT NOT NULL,
//     volume_usd REAL,
//     ts INTEGER NOT NULL
//   );
//   CREATE INDEX IF NOT EXISTS idx_swap_events_ts ON swap_events(ts);
//
// tx_id als Primärschlüssel sorgt automatisch für Deduplizierung (INSERT OR IGNORE) --
// derselbe Swap taucht bei mehreren Cron-Durchläufen in Folge zwangsläufig mehrfach in den
// letzten 50 Actions auf, wird aber nur beim ERSTEN Mal tatsächlich eingefügt.
// ----------------------------------------------------------------------------

// Serverseitiges Äquivalent zu swapAssetLabel im Frontend (app.js) -- absichtlich eigenständig
// dupliziert statt geteilt, da Worker und Frontend getrennt deploybar sind. Baut aus einem
// Midgard-Asset-Bezeichner ein kurzes Anzeige-Label: bei nativen Assets (Chain=Ticker, z.B.
// "BTC.BTC") nur der Ticker, bei Token-Assets (z.B. "TRX.USDT") Chain UND Ticker kombiniert,
// da der Ticker allein mehrdeutig wäre (USDT gibt es auf mehreren Chains).
function deriveAssetLabel(identifier) {
  if (!identifier) return '?';
  const raw = String(identifier);
  const sep = Math.max(raw.indexOf('.'), raw.indexOf('~'));
  const chain = sep > 0 ? raw.slice(0, sep) : raw;
  const rest = sep > 0 ? raw.slice(sep + 1) : '';
  const tickerRaw = (rest.split('-')[0] || chain).toUpperCase();
  const chainClean = String(chain).split('-')[0].slice(0, 8);
  const tickerClean = String(tickerRaw).split('-')[0].slice(0, 8);
  return chainClean && chainClean !== tickerClean ? `${chainClean}.${tickerClean}` : tickerClean;
}

async function collectSwapPairStats(env) {
  let actions;
  try {
    const data = await fetchFromBases(MIDGARD_BASES, '/actions?type=swap&limit=50', {
      timeoutMs: 12000,
    });
    actions = (data && Array.isArray(data.actions)) ? data.actions : [];
  } catch (e) {
    console.warn('[rune-rewards-backend] Swap-Paar-Sammlung fehlgeschlagen:', e?.message || String(e));
    return;
  }
  if (!actions.length) return;

  const rows = [];
  for (const a of actions) {
    if (a.status && a.status !== 'success') continue;
    const txId = a.in && a.in[0] && a.in[0].txID;
    if (!txId) continue;
    const inCoin = a.in && a.in[0] && a.in[0].coins && a.in[0].coins[0];
    const inAsset = inCoin && inCoin.asset;
    const outAsset = (a.out && a.out[0] && a.out[0].coins && a.out[0].coins[0] && a.out[0].coins[0].asset) || (a.pools && a.pools[a.pools.length - 1]);
    const pair = `${deriveAssetLabel(inAsset)} \u2192 ${deriveAssetLabel(outAsset)}`;
    const swap = a.metadata && a.metadata.swap;
    const priceUsd = swap ? parseFloat(swap.inPriceUSD) : NaN;
    const amountBase = inCoin ? parseInt(inCoin.amount, 10) : NaN;
    let volumeUsd = null;
    if (isFinite(priceUsd) && isFinite(amountBase) && amountBase > 0) {
      volumeUsd = (amountBase / 1e8) * priceUsd;
    }
    const ts = a.date ? Math.floor(Number(a.date) / 1e6) : Date.now();
    rows.push({ txId, pair, volumeUsd, ts });
  }
  if (!rows.length) return;

  try {
    const stmt = env.DB.prepare(
      'INSERT OR IGNORE INTO swap_events (tx_id, pair, volume_usd, ts) VALUES (?, ?, ?, ?)'
    );
    await env.DB.batch(rows.map((r) => stmt.bind(r.txId, r.pair, r.volumeUsd, r.ts)));
    // Alte Einträge (älter als 25h, etwas Puffer über die maximal abgefragten 24h hinaus)
    // aufräumen, damit die Tabelle nicht unbegrenzt wächst.
    const cutoff = Date.now() - 25 * 60 * 60 * 1000;
    await env.DB.prepare('DELETE FROM swap_events WHERE ts < ?').bind(cutoff).run();
  } catch (e) {
    // Tabelle evtl. noch nicht angelegt (siehe SQL oben) -- Sammlung einfach beim nächsten
    // Cron-Durchlauf erneut versuchen, kein harter Fehler nötig.
    console.warn('[rune-rewards-backend] Swap-Paar-Sammlung: D1-Schreibfehler (Tabelle angelegt?):', e?.message || String(e));
  }
}

async function handleTopPairs(request, env) {
  const url = new URL(request.url);
  const hoursParam = parseInt(url.searchParams.get('hours'), 10);
  const hours = hoursParam === 12 ? 12 : 24;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  try {
    const rows = await env.DB.prepare(
      `SELECT pair, COUNT(*) as cnt, SUM(COALESCE(volume_usd, 0)) as vol
       FROM swap_events
       WHERE ts >= ?
       GROUP BY pair
       ORDER BY cnt DESC
       LIMIT 5`
    ).bind(cutoff).all();
    return json({
      hours,
      pairs: (rows.results || []).map((r) => ({ pair: r.pair, count: r.cnt, volumeUsd: r.vol })),
    }, env);
  } catch (e) {
    console.error('[rune-rewards-backend] /top-pairs fehlgeschlagen (Tabelle angelegt?):', e?.message || String(e));
    return json({ hours, pairs: [] }, env);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeAddressAwardFromNode(node, bondAddress) {
  if (!node) return 0;
  const providers = node?.bond_providers?.providers || [];
  let nodeTotalBondBase = 0;
  let myBondInNodeBase = 0;
  for (const p of providers) {
    const pBond = Number(p?.bond) || 0;
    nodeTotalBondBase += pBond;
    if (p?.bond_address === bondAddress) myBondInNodeBase = pBond;
  }
  if (myBondInNodeBase <= 0 || nodeTotalBondBase <= 0) return 0;
  const feeBps = Number(node?.bond_providers?.node_operator_fee) || 0;
  const fee = feeBps / 10000;
  const currentAwardBase = Number(node?.current_award) || 0;
  return ((myBondInNodeBase / nodeTotalBondBase) * currentAwardBase * (1 - fee)) / 1e8;
}

const MAX_PAGES_PER_TYPE = 12;

// FIX 10: erweitert um "items" -- die volle Transaktionsliste (dateMs/amount/txId/height/
// nodeAddress je Bond-/Unbond-Ereignis). Vorher wurde nur die AGGREGIERTE Summe
// zurückgegeben (ausreichend für den Cron-Refresh/refreshOneAddress), das neue /bond-ledger
// weiter unten braucht aber die einzelnen Einträge, um sie im Frontend als Liste anzuzeigen --
// exakt das, was vorher das Frontend selbst direkt gegen Midgard berechnet hat.
async function fetchActionsForType(address, txType) {
  let offset = 0;
  let totalBase = 0;
  let earliestDateMs = null;
  const nodeAddresses = new Set();
  let matchedAny = false;
  const items = [];

  for (let page = 0; page < MAX_PAGES_PER_TYPE; page++) {
    const body = await fetchMidgardActionsPage(address, txType, offset);
    const actions = body?.actions || [];
    if (actions.length === 0) break;

    for (const a of actions) {
      if (a.type !== txType) continue;
      // WICHTIG: fehlgeschlagene/erstattete Bond-Versuche (status !== 'success') tauchen in
      // Midgard trotzdem als Aktion vom Typ "bond"/"unbond" auf, haben aber nie tatsächlich den
      // Bond verändert -- ohne diesen Filter würde jeder gescheiterte Versuch fälschlich als
      // echte Ein-/Auszahlung gezählt (siehe gleicher Fix im Frontend, fetchActionsForType).
      if (a.status && a.status !== 'success') continue;
      matchedAny = true;
      let amountBase = 0;
      const coinsGroups = txType === 'bond' ? (a.in || []) : (a.out?.length ? a.out : (a.in || []));
      for (const grp of coinsGroups) {
        for (const c of (grp.coins || [])) {
          if (c.asset === 'THOR.RUNE' || c.asset === 'RUNE') {
            amountBase += Number(c.amount) || 0;
          }
        }
      }
      totalBase += amountBase;
      const dateMs = a.date ? Math.floor(Number(a.date) / 1e6) : null;
      if (dateMs && (earliestDateMs === null || dateMs < earliestDateMs)) earliestDateMs = dateMs;
      const nodeAddress = a.metadata?.bond?.nodeAddress || null;
      if (nodeAddress) nodeAddresses.add(nodeAddress);
      items.push({
        dateMs,
        amount: amountBase / 1e8,
        type: txType,
        txId: a.in?.[0]?.txID || null,
        height: parseInt(a.height, 10) || null,
        nodeAddress,
      });
    }

    if (actions.length < 50) break;
    offset += 50;
  }

  return { totalBase, earliestDateMs, found: matchedAny, nodeAddresses: [...nodeAddresses], items };
}

async function fetchBondLedger(address) {
  try {
    const [bondRes, unbondRes] = await Promise.all([
      fetchActionsForType(address, 'bond'),
      fetchActionsForType(address, 'unbond'),
    ]);
    if (!bondRes.found) {
      return { success: false, errorDetail: 'NO_BOND_ACTIONS' };
    }
    const allNodeAddresses = [...new Set([...bondRes.nodeAddresses, ...unbondRes.nodeAddresses])];
    return {
      success: true,
      principal: (bondRes.totalBase - unbondRes.totalBase) / 1e8,
      earliestDateMs: bondRes.earliestDateMs,
      nodeAddresses: allNodeAddresses,
      // FIX 10: volle Transaktionsliste durchreichen, siehe handleBondLedger weiter unten.
      transactions: [...bondRes.items, ...unbondRes.items].sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0)),
    };
  } catch (e) {
    return { success: false, errorDetail: e?.message || String(e) };
  }
}

// ----------------------------------------------------------------------------
// FIX 10: /bond-ledger -- löst die Midgard-Direktabfrage im Frontend (fetchActionsForType/
// fetchBondLedger dort) ab. Nutzt dieselbe fetchBondLedger-Funktion, die auch der bestehende
// Cron-Refresh (refreshOneAddress) für /bond-history verwendet -- EIN einziger, gemeinsamer,
// bereits gehedgeter Code-Pfad statt zwei getrennter Implementierungen (eine hier, eine im
// Frontend), die beide dieselbe Aufgabe lösen.
// ----------------------------------------------------------------------------
async function handleBondLedger(request, env) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address');
  if (!isValidThorAddress(address)) {
    return json({ error: 'INVALID_ADDRESS' }, env, 400);
  }
  const result = await fetchBondLedger(address);
  return json(result, env);
}

const MAX_ADDRESSES_PER_CRON_RUN = 2;
const MAX_HEIGHTS_PER_ADDRESS_PER_RUN = 20;
const HEIGHT_BATCH_SIZE = 5;
const DONE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const LEDGER_MARGIN_MS = 4 * 24 * 60 * 60 * 1000;
const isValidThorAddress = (addr) => /^thor1[0-9a-z]{20,60}$/.test(String(addr || ''));

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(env) },
  });
}

async function handleBondHistory(request, env, ctx) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address');
  if (!isValidThorAddress(address)) {
    return json({ error: 'INVALID_ADDRESS' }, env, 400);
  }

  const now = Date.now();
  const existing = await env.DB
    .prepare('SELECT * FROM tracked_addresses WHERE bond_address = ?')
    .bind(address)
    .first();

  let trackedRow = existing;
  if (!existing) {
    await env.DB
      .prepare('INSERT INTO tracked_addresses (bond_address, status, created_at) VALUES (?, ?, ?)')
      .bind(address, 'pending', now)
      .run();
    trackedRow = { bond_address: address, status: 'pending', created_at: now };
  }

  const REFRESH_COOLDOWN_MS = 3 * 1000;
  const recentlyRefreshed = trackedRow.last_refreshed_at && (now - trackedRow.last_refreshed_at) < REFRESH_COOLDOWN_MS;
  if (trackedRow.status !== 'done' && !recentlyRefreshed) {
    ctx.waitUntil(refreshOneAddress(env, trackedRow, now).catch((e) => {
      console.error('[rune-rewards-backend] Sofort-Refresh fehlgeschlagen für', address, e);
    }));
  }

  const rows = await env.DB
    .prepare('SELECT churn_height, churn_timestamp, reward_amount FROM bond_history_rows WHERE bond_address = ? ORDER BY churn_height ASC')
    .bind(address)
    .all();

  const entries = (rows.results || [])
    // reward_amount IS NULL bedeutet: für diese Höhe konnten wir keine verwertbaren
    // Provider-Daten ermitteln (siehe refreshOneAddress/hasProviderData) -- das ist NICHT
    // dasselbe wie ein bestätigter 0-Reward-Churn und wird dem Frontend daher gar nicht erst
    // als Datenpunkt gezeigt (kein Reward, kein Churn-out-Marker).
    .filter((r) => r.reward_amount != null)
    .map((r) => ({
      height: r.churn_height,
      dateMs: r.churn_timestamp,
      amount: r.reward_amount,
    }));
  const total = entries.reduce((sum, e) => sum + e.amount, 0);

  return json({
    address,
    status: existing?.status || 'pending',
    lastRefreshedAt: existing?.last_refreshed_at || null,
    earliestDateMs: existing?.earliest_date_ms ?? null,
    principal: existing?.principal ?? null,
    currentBond: existing?.current_bond ?? null,
    ledgerError: existing?.ledger_error ?? null,
    total,
    entries,
  }, env);
}

// ----------------------------------------------------------------------------
// FIX 6: Balance-Cache (D1-Tabelle balance_cache) als Fallback, falls die Live-Abfrage
// bei Liquify scheitert (Timeout/502/etc). Muss vorher per SQL angelegt werden:
//
//   CREATE TABLE IF NOT EXISTS balance_cache (
//     address TEXT PRIMARY KEY,
//     balance REAL,
//     bonded REAL,
//     total_active_bond_base REAL,
//     accrued_award REAL,
//     matched_node_addresses TEXT,
//     node_breakdown TEXT,
//     updated_at INTEGER
//   );
// ----------------------------------------------------------------------------

const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // gecachte Werte älter als 1h werden NICHT mehr als Fallback benutzt

async function readBalanceCache(env, address) {
  const row = await env.DB
    .prepare('SELECT * FROM balance_cache WHERE address = ?')
    .bind(address)
    .first();
  if (!row) return null;
  return {
    balance: row.balance,
    bonded: row.bonded,
    totalActiveBondBase: row.total_active_bond_base,
    accruedAward: row.accrued_award,
    matchedNodeAddresses: row.matched_node_addresses ? JSON.parse(row.matched_node_addresses) : [],
    nodeBreakdown: row.node_breakdown ? JSON.parse(row.node_breakdown) : [],
    updatedAt: row.updated_at,
  };
}

async function writeBalanceCache(env, address, data) {
  await env.DB
    .prepare(
      `INSERT INTO balance_cache
       (address, balance, bonded, total_active_bond_base, accrued_award, matched_node_addresses, node_breakdown, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         balance = excluded.balance,
         bonded = excluded.bonded,
         total_active_bond_base = excluded.total_active_bond_base,
         accrued_award = excluded.accrued_award,
         matched_node_addresses = excluded.matched_node_addresses,
         node_breakdown = excluded.node_breakdown,
         updated_at = excluded.updated_at`
    )
    .bind(
      address,
      data.balance,
      data.bonded,
      data.totalActiveBondBase,
      data.accruedAward,
      JSON.stringify(data.matchedNodeAddresses || []),
      JSON.stringify(data.nodeBreakdown || []),
      Date.now()
    )
    .run();
}

async function handleBalance(request, env, ctx) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address');
  if (!isValidThorAddress(address)) {
    return json({ error: 'INVALID_ADDRESS' }, env, 400);
  }

  const [balanceResult, nodesResult] = await Promise.allSettled([
    fetchBalance(address),
    fetchNodes(),
  ]);

  let balance = null;
  let balanceError = null;
  if (balanceResult.status === 'fulfilled') {
    const runeEntry = (balanceResult.value?.balances || []).find((b) => b.denom === 'rune');
    balance = runeEntry ? Number(runeEntry.amount) / 1e8 : 0;
  } else {
    balanceError = balanceResult.reason?.message || String(balanceResult.reason);
  }

  let bonded = null, totalActiveBondBase = null, accruedAward = null;
  let matchedNodeAddresses = [], nodeBreakdown = [];
  let nodesError = null;
  if (nodesResult.status === 'fulfilled') {
    // Deduplizieren nach node_address, BEVOR irgendetwas summiert wird -- liefert THORNode bei
    // einem Netzwerk-Aussetzer (z.B. rund um einen Churn) denselben Node versehentlich zweimal
    // in der Liste, würde sonst sowohl der Bond als auch der aufgelaufene Reward für diesen Node
    // doppelt gezählt ("Next Reward manchmal doppelt so hoch"). Nodes ohne node_address (sollte
    // nicht vorkommen) werden unverändert durchgelassen, da sie sich nicht dedupen lassen.
    const seenNodeAddresses = new Set();
    const dedupedNodes = [];
    for (const node of nodesResult.value || []) {
      if (!node?.node_address) { dedupedNodes.push(node); continue; }
      if (seenNodeAddresses.has(node.node_address)) continue;
      seenNodeAddresses.add(node.node_address);
      dedupedNodes.push(node);
    }

    let totalBondBase = 0;
    let activeBondBase = 0;
    let accruedAwardBase = 0;
    for (const node of dedupedNodes) {
      const providers = node?.bond_providers?.providers || [];
      let nodeTotalBondBase = 0;
      let myBondInNodeBase = 0;
      for (const p of providers) {
        const pBond = Number(p?.bond) || 0;
        nodeTotalBondBase += pBond;
        if (p?.bond_address === address) {
          totalBondBase += pBond;
          myBondInNodeBase = pBond;
        }
      }
      if (myBondInNodeBase > 0 && nodeTotalBondBase > 0) {
        const feeBps = Number(node?.bond_providers?.node_operator_fee) || 0;
        const fee = feeBps / 10000;
        const currentAwardBase = Number(node?.current_award) || 0;
        accruedAwardBase += (myBondInNodeBase / nodeTotalBondBase) * currentAwardBase * (1 - fee);
        if (node?.node_address) {
          matchedNodeAddresses.push(node.node_address);
          nodeBreakdown.push({ nodeAddress: node.node_address, status: node.status || null, bonded: myBondInNodeBase / 1e8 });
        }
      }
      if (node?.status === 'Active') {
        activeBondBase += Number(node?.total_bond) || 0;
      }
    }
    bonded = totalBondBase / 1e8;
    totalActiveBondBase = activeBondBase;
    accruedAward = accruedAwardBase / 1e8;
  } else {
    nodesError = nodesResult.reason?.message || String(nodesResult.reason);
  }

  const liveOk = balanceError == null && nodesError == null;

  if (liveOk) {
    // Erfolgreich -> im Hintergrund als neuen Cache-Stand wegschreiben, ohne die
    // Antwort an den Client zu verzögern.
    ctx.waitUntil(
      writeBalanceCache(env, address, { balance, bonded, totalActiveBondBase, accruedAward, matchedNodeAddresses, nodeBreakdown })
        .catch((e) => console.error('[rune-rewards-backend] Cache-Schreiben fehlgeschlagen für', address, e))
    );
    return json({
      address, balance, balanceError, bonded, totalActiveBondBase, accruedAward,
      matchedNodeAddresses, nodeBreakdown, nodesError, stale: false,
    }, env);
  }

  // Live-Abfrage (Balance und/oder Nodes) ist fehlgeschlagen -> letzten gecachten Stand
  // als Fallback versuchen, statt den Fehler direkt durchzureichen.
  let cached = null;
  try {
    cached = await readBalanceCache(env, address);
  } catch (e) {
    console.error('[rune-rewards-backend] Cache-Lesen fehlgeschlagen für', address, e);
  }

  if (cached && (Date.now() - cached.updatedAt) < CACHE_MAX_AGE_MS) {
    return json({
      address,
      balance: cached.balance,
      balanceError,
      bonded: cached.bonded,
      totalActiveBondBase: cached.totalActiveBondBase,
      accruedAward: cached.accruedAward,
      matchedNodeAddresses: cached.matchedNodeAddresses,
      nodeBreakdown: cached.nodeBreakdown,
      nodesError,
      stale: true,
      staleSince: cached.updatedAt,
    }, env);
  }

  // Kein brauchbarer Cache vorhanden (nie erfolgreich geladen, oder Cache zu alt) ->
  // wie bisher den echten Fehler durchreichen.
  return json({
    address, balance, balanceError, bonded, totalActiveBondBase, accruedAward,
    matchedNodeAddresses, nodeBreakdown, nodesError, stale: false,
  }, env);
}

// ----------------------------------------------------------------------------
// Kaufliste (Ø-Kaufpreis-Feature) geräteübergreifend speichern/laden, verknüpft mit der
// THORChain-Adresse -- damit dieselben Käufe/Verkäufe auf jedem Gerät sichtbar sind, sobald
// dort dieselbe Adresse eingetragen wird (bisher nur lokal im Browser gespeichert).
//
// Muss vorher per SQL angelegt werden:
//
//   CREATE TABLE IF NOT EXISTS user_purchases (
//     address TEXT PRIMARY KEY,
//     data TEXT,
//     updated_at INTEGER
//   );
//   CREATE TABLE IF NOT EXISTS user_purchases_deleted (
//     address TEXT NOT NULL,
//     deleted_id TEXT NOT NULL,
//     deleted_at INTEGER,
//     PRIMARY KEY (address, deleted_id)
//   );
//
// FIX 9 -- zusätzlich einmalig ausführen (siehe Kopfkommentar):
//
//   ALTER TABLE user_purchases ADD COLUMN settings TEXT;
//
// Die zweite Tabelle ist eine "Tombstone"-Liste: merkt sich dauerhaft, welche Einträge bewusst
// gelöscht wurden. Ohne sie würde ein reiner additiver Merge gelöschte Einträge von einem
// anderen Gerät, das sie noch kennt, bei der nächsten Synchronisierung wieder zurückholen.
//
// Sicherheitshinweis: genau wie /bond-history und /balance gibt es hier KEINE Authentifizierung
// über einen privaten Schlüssel -- die THORChain-Adresse selbst ist der Zugriffsschlüssel (wie
// bei den bestehenden Endpunkten auch). Das ist für dieses Feature vertretbar (kein Zugriff auf
// echte Wallet-Funktionen, nur auf selbst eingetragene Kauf-/Verkaufsnotizen), aber wer die
// Adresse kennt, könnte theoretisch die dazu gespeicherte Kaufliste einsehen/überschreiben.
// ----------------------------------------------------------------------------

const MAX_PURCHASES_PAYLOAD_BYTES = 2_000_000; // Sicherheitsnetz gegen versehentlich riesige Payloads

// FIX 9: Nur bekannte Werte durchlassen -- verhindert, dass irgendein Client beliebigen Unsinn
// in die Spalte schreibt, den die anderen Geräte dann nicht interpretieren können.
function sanitizeSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (raw.costBasisMethod === 'fifo' || raw.costBasisMethod === 'average') {
    out.costBasisMethod = raw.costBasisMethod;
  }
  if (raw.rewardValuationMethod === 'market' || raw.rewardValuationMethod === 'free') {
    out.rewardValuationMethod = raw.rewardValuationMethod;
  }
  return Object.keys(out).length ? out : null;
}

async function handlePurchases(request, env, ctx) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address');
  if (!isValidThorAddress(address)) {
    return json({ error: 'INVALID_ADDRESS' }, env, 400);
  }

  if (request.method === 'GET') {
    const row = await env.DB
      .prepare('SELECT data, settings, updated_at FROM user_purchases WHERE address = ?')
      .bind(address)
      .first();
    let purchases = [];
    if (row && row.data) {
      try { purchases = JSON.parse(row.data); } catch (e) { purchases = []; }
    }
    let settings = null;
    if (row && row.settings) {
      try { settings = sanitizeSettings(JSON.parse(row.settings)); } catch (e) { settings = null; }
    }
    const deletedRows = await env.DB
      .prepare('SELECT deleted_id FROM user_purchases_deleted WHERE address = ?')
      .bind(address)
      .all();
    const deletedIds = new Set((deletedRows.results || []).map((r) => r.deleted_id));
    // Defensiv nochmal gegen die Tombstone-Liste filtern (falls ein alter Stand vor Einführung
    // dieser Tabelle noch tombstonete IDs enthält).
    if (deletedIds.size) purchases = purchases.filter((p) => !p.id || !deletedIds.has(p.id));
    return json({
      address,
      purchases,
      deletedIds: [...deletedIds],
      settings,
      updatedAt: row ? row.updated_at : null,
    }, env);
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'INVALID_BODY' }, env, 400);
    }
    const incoming = Array.isArray(body.purchases) ? body.purchases : null;
    if (!incoming) {
      return json({ error: 'INVALID_PURCHASES' }, env, 400);
    }
    // FIX 9: Anders als bei der Kaufliste gibt es bei den Einstellungen bewusst KEIN additives
    // Zusammenführen -- eine Einstellung ist ein einzelner Wert, kein Datensatz. Hier gilt
    // schlicht "zuletzt geschrieben gewinnt": wer zuletzt umschaltet, bestimmt die Methode für
    // alle Geräte. Sonst könnte ein Gerät mit altem Stand die gerade bewusst geänderte
    // Einstellung eines anderen Geräts stillschweigend zurücksetzen.
    const incomingSettings = sanitizeSettings(body.settings);

    // deletedIds: IDs, die der Client seit dem letzten Sync selbst gelöscht hat (siehe
    // Frontend: deletedPurchaseIds, wird bei jedem Push mitgeschickt). Werden dauerhaft als
    // Tombstone gespeichert, damit sie bei KEINEM zukünftigen Merge (von irgendeinem Gerät)
    // wieder auftauchen können.
    const newlyDeletedIds = Array.isArray(body.deletedIds) ? body.deletedIds.filter(Boolean) : [];

    if (newlyDeletedIds.length) {
      const now0 = Date.now();
      const stmt = env.DB.prepare(
        'INSERT OR IGNORE INTO user_purchases_deleted (address, deleted_id, deleted_at) VALUES (?, ?, ?)'
      );
      await env.DB.batch(newlyDeletedIds.map((id) => stmt.bind(address, id, now0)));
    }

    const deletedRows = await env.DB
      .prepare('SELECT deleted_id FROM user_purchases_deleted WHERE address = ?')
      .bind(address)
      .all();
    const deletedIds = new Set((deletedRows.results || []).map((r) => r.deleted_id));

    // WICHTIG: hier NICHT einfach überschreiben (`data = excluded.data`), sondern serverseitig
    // mit dem bereits gespeicherten Stand additiv zusammenführen UND danach gegen die
    // Tombstone-Liste filtern. Sonst könnte ein Gerät, das kurz nach einem anderen Gerät
    // synchronisiert, dessen Änderungen versehentlich überschreiben (Race Condition) -- z.B.
    // wenn Gerät A gerade neue Käufe importiert hat und Gerät B kurz danach (noch mit älterem
    // lokalem Stand) synchronisiert.
    const existingRow = await env.DB
      .prepare('SELECT data, settings FROM user_purchases WHERE address = ?')
      .bind(address)
      .first();
    let existing = [];
    if (existingRow && existingRow.data) {
      try { existing = JSON.parse(existingRow.data); } catch (e) { existing = []; }
    }
    // FIX 9: Bereits gespeicherte Einstellungen als Rückfall behalten, falls dieser Push gar
    // keine (gültigen) Einstellungen mitschickt -- z.B. von einem noch nicht aktualisierten
    // Client. Ohne das würde ein alter Client die Einstellungen bei jedem Push löschen.
    let existingSettings = null;
    if (existingRow && existingRow.settings) {
      try { existingSettings = sanitizeSettings(JSON.parse(existingRow.settings)); } catch (e) { existingSettings = null; }
    }
    const finalSettings = incomingSettings || existingSettings;

    // WICHTIG: Beim Zusammenführen NUR über die eindeutige ID abgleichen, NICHT mehr über
    // Datum+Menge+Preis. Bei Börsendaten (z.B. Binance/KuCoin) können mehrere echte,
    // unterschiedliche Trades zufällig exakt dieselbe Minute/Menge/Preis haben (z.B. ein Order,
    // der in mehreren gleich großen Teilen zum selben Preis gefüllt wurde) -- ein inhaltlicher
    // Vergleich hätte solche echten, unterschiedlichen Einträge fälschlich als Duplikat verworfen
    // und beim Sync "verschluckt". Der inhaltliche Vergleich bleibt bewusst NUR beim CSV-Import
    // selbst (verhindert dort ein versehentliches doppeltes Hochladen derselben Datei), nicht
    // beim laufenden Geräte-Sync.
    const merged = [...existing];
    for (const row of incoming) {
      if (!row || !Number.isFinite(row.amount) || !Number.isFinite(row.priceUsd)) continue;
      if (row.id && deletedIds.has(row.id)) continue; // bewusst gelöscht -- nicht wieder aufnehmen
      const alreadyThere = row.id ? merged.some((p) => p.id === row.id) : false;
      if (!alreadyThere) merged.push(row);
    }
    const finalList = deletedIds.size ? merged.filter((p) => !p.id || !deletedIds.has(p.id)) : merged;

    const serialized = JSON.stringify(finalList);
    if (serialized.length > MAX_PURCHASES_PAYLOAD_BYTES) {
      return json({ error: 'TOO_LARGE' }, env, 413);
    }
    const now = Date.now();
    await env.DB
      .prepare(
        `INSERT INTO user_purchases (address, data, settings, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           data = excluded.data,
           settings = excluded.settings,
           updated_at = excluded.updated_at`
      )
      .bind(address, serialized, finalSettings ? JSON.stringify(finalSettings) : null, now)
      .run();
    return json({ address, updatedAt: now, purchases: finalList, settings: finalSettings }, env);
  }

  return json({ error: 'METHOD_NOT_ALLOWED' }, env, 405);
}

// ----------------------------------------------------------------------------
// FIX 10 (Memoless-Proxy, war schon vorher da).
//
// Der Browser darf api.thorchain.org nicht direkt aufrufen -- dort fehlen die
// CORS-Freigaben (Access-Control-Allow-Origin), weshalb im Frontend ein "Failed to fetch"
// auftrat, sobald ein Swap registriert werden sollte. Server-zu-Server gibt es diese
// Einschraenkung nicht: der Worker holt die Antwort und reicht sie MIT den noetigen
// CORS-Headern an die Seite weiter -- exakt dasselbe Muster wie schon bei /balance.
//
// Weitergereicht werden ausschliesslich die drei bekannten Memoless-Pfade. Ein offener
// "alles durchreichen"-Proxy waere ein unnoetiges Risiko (fremde Ziele, Missbrauch).
// ----------------------------------------------------------------------------

const MEMOLESS_UPSTREAM = 'https://api.thorchain.org/memoless/api/v1';
const MEMOLESS_ALLOWED_PATHS = new Set(['assets', 'register', 'preflight']);

async function handleMemoless(request, env) {
  const url = new URL(request.url);
  // /memoless/register -> "register"
  const sub = url.pathname.replace(/^\/memoless\/?/, '').replace(/\/+$/, '');
  if (!MEMOLESS_ALLOWED_PATHS.has(sub)) {
    return json({ error: 'NOT_FOUND' }, env, 404);
  }

  const target = `${MEMOLESS_UPSTREAM}/${sub}${url.search || ''}`;
  const init = { method: request.method, headers: { 'Content-Type': 'application/json' } };
  if (request.method === 'POST') {
    init.body = await request.text();
  }

  try {
    const res = await fetchWithTimeout(target, { ...init, timeoutMs: 15000 });
    const text = await res.text();
    // Antwort unveraendert durchreichen (inkl. Statuscode), nur um CORS-Header ergaenzt --
    // so sieht das Frontend echte Fehlermeldungen von THORChain statt eines generischen Fehlers.
    return new Response(text, {
      status: res.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...corsHeaders(env),
      },
    });
  } catch (e) {
    return json({ error: 'MEMOLESS_UPSTREAM_FAILED', message: e?.message || String(e) }, env, 502);
  }
}

// ----------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    // WICHTIG (globales Sicherheitsnetz): jeder einzelne Endpunkt-Handler hat zwar sein eigenes
    // try/catch, aber ein unerwarteter Fehler AUSSERHALB davon (z.B. beim Routing selbst, in
    // corsHeaders(), oder irgendein anderer Programmfehler) würde bisher UNGEFANGEN durchfallen
    // -- und genau DAS liefert Cloudflare als eigenen, generischen 502 aus, komplett an meinem
    // JSON-Fehlerformat vorbei. Dieser äußere try/catch fängt restlos ALLES ab: was auch immer
    // schiefgeht, es kommt IMMER eine gültige JSON-Antwort zurück, nie Cloudflares eigener 502.
    try {
      currentEnv = env;
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders(env) });
      }
      const url = new URL(request.url);
      if (url.pathname === '/bond-history') {
        return await handleBondHistory(request, env, ctx);
      }
      if (url.pathname === '/bond-ledger') {
        return await handleBondLedger(request, env);
      }
      if (url.pathname === '/balance') {
        return await handleBalance(request, env, ctx);
      }
      if (url.pathname === '/volume') {
        return await handleVolume(request, env);
      }
      if (url.pathname === '/recent-swaps') {
        return await handleRecentSwaps(request, env);
      }
      if (url.pathname === '/top-pairs') {
        return await handleTopPairs(request, env);
      }
      if (url.pathname === '/purchases') {
        return await handlePurchases(request, env, ctx);
      }
      if (url.pathname.startsWith('/memoless/')) {
        return await handleMemoless(request, env);
      }
      return json({ error: 'NOT_FOUND' }, env, 404);
    } catch (e) {
      console.error('[rune-rewards-backend] Unerwarteter Fehler im Haupt-Handler:', e && e.stack || e);
      try {
        return json({ error: 'INTERNAL_ERROR', message: e && e.message || String(e) }, env, 500);
      } catch (e2) {
        // Selbst corsHeaders()/json() könnten theoretisch scheitern (z.B. env fehlt komplett)
        // -- allerletzter Rückfall ganz ohne Abhängigkeiten von env.
        return new Response(JSON.stringify({ error: 'INTERNAL_ERROR' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  },

  async scheduled(event, env, ctx) {
    currentEnv = env;
    ctx.waitUntil(runRefreshCycle(env));
  },
};

async function runRefreshCycle(env) {
  await refreshChurnsCache(env);
  await collectSwapPairStats(env);

  const now = Date.now();

  const candidates = await env.DB
    .prepare(
      `SELECT * FROM tracked_addresses
       WHERE status IN ('pending', 'building')
          OR (status = 'done' AND (last_refreshed_at IS NULL OR last_refreshed_at < ?))
       ORDER BY (status = 'pending') DESC, last_refreshed_at ASC
       LIMIT ?`
    )
    .bind(now - DONE_REFRESH_INTERVAL_MS, MAX_ADDRESSES_PER_CRON_RUN)
    .all();

  for (const addressRow of candidates.results || []) {
    try {
      await refreshOneAddress(env, addressRow, now);
    } catch (e) {
      console.error('[rune-rewards-backend] Fehler beim Refresh von', addressRow.bond_address, e);
    }
  }
}

async function refreshChurnsCache(env) {
  let raw;
  try {
    raw = await fetchChurns();
  } catch (e) {
    console.warn('[rune-rewards-backend] Churn-Liste konnte nicht geladen werden:', e.message);
    return;
  }
  if (!Array.isArray(raw) || raw.length === 0) return;

  const known = await env.DB.prepare('SELECT MAX(height) as maxHeight FROM churns_cache').first();
  const knownHeight = known?.maxHeight || 0;

  const fresh = raw
    .map((c) => ({ height: parseInt(c.height, 10), dateMs: Math.floor(parseInt(c.date, 10) / 1e6) }))
    .filter((c) => c.height && c.dateMs && c.height > knownHeight);

  if (!fresh.length) return;

  const stmt = env.DB.prepare('INSERT OR IGNORE INTO churns_cache (height, date_ms) VALUES (?, ?)');
  await env.DB.batch(fresh.map((c) => stmt.bind(c.height, c.dateMs)));
}

async function refreshOneAddress(env, addressRow, now) {
  const { bond_address: address } = addressRow;

  const nodes = await fetchNodes();
  const currentNodeAddresses = [];
  let currentBondBase = 0;
  const seenNodeAddresses = new Set(); // siehe handleBalance -- verhindert Doppelzählung, falls
                                        // THORNode denselben Node versehentlich zweimal liefert
  for (const node of nodes || []) {
    if (node?.node_address) {
      if (seenNodeAddresses.has(node.node_address)) continue;
      seenNodeAddresses.add(node.node_address);
    }
    const providers = node?.bond_providers?.providers || [];
    const match = providers.find((p) => p?.bond_address === address);
    if (match && node?.node_address) {
      currentNodeAddresses.push(node.node_address);
      currentBondBase += Number(match.bond) || 0;
    }
  }

  const ledger = await fetchBondLedger(address);
  const nodeAddresses = [...new Set([...currentNodeAddresses, ...(ledger.nodeAddresses || [])])];

  await env.DB
    .prepare(
      `UPDATE tracked_addresses
       SET node_addresses = ?, earliest_date_ms = ?, principal = ?, current_bond = ?, ledger_error = ?
       WHERE bond_address = ?`
    )
    .bind(
      JSON.stringify(nodeAddresses),
      ledger.success ? ledger.earliestDateMs : (addressRow.earliest_date_ms ?? null),
      ledger.success ? ledger.principal : (addressRow.principal ?? null),
      currentBondBase / 1e8,
      ledger.success ? null : (ledger.errorDetail || 'LEDGER_FAILED'),
      address
    )
    .run();

  if (nodeAddresses.length === 0) {
    await env.DB
      .prepare('UPDATE tracked_addresses SET status = ?, last_refreshed_at = ? WHERE bond_address = ?')
      .bind('done', now, address)
      .run();
    return;
  }

  const earliestDateMs = ledger.success ? ledger.earliestDateMs : addressRow.earliest_date_ms;
  const churnsQuery = earliestDateMs != null
    ? env.DB.prepare('SELECT height, date_ms FROM churns_cache WHERE date_ms >= ? ORDER BY height DESC').bind(earliestDateMs - LEDGER_MARGIN_MS)
    : env.DB.prepare('SELECT height, date_ms FROM churns_cache ORDER BY height DESC');
  const allChurns = await churnsQuery.all();
  const knownRows = await env.DB
    .prepare('SELECT churn_height FROM bond_history_rows WHERE bond_address = ?')
    .bind(address)
    .all();
  const knownHeights = new Set((knownRows.results || []).map((r) => r.churn_height));

  const missing = (allChurns.results || [])
    .filter((c) => !knownHeights.has(c.height))
    .slice(0, MAX_HEIGHTS_PER_ADDRESS_PER_RUN);

  if (missing.length === 0) {
    await env.DB
      .prepare('UPDATE tracked_addresses SET status = ?, last_refreshed_at = ? WHERE bond_address = ?')
      .bind('done', now, address)
      .run();
    return;
  }

  // Erst JETZT auf 'building' setzen -- nur wenn tatsächlich fehlende Reward-Churns nachgeladen
  // werden müssen (nicht schon unconditional davor), damit der Status nicht unnötig zwischen
  // 'done' und 'building' hin- und herspringt, wenn eigentlich nichts nachzuladen ist.
  await env.DB
    .prepare('UPDATE tracked_addresses SET status = ? WHERE bond_address = ?')
    .bind('building', address)
    .run();

  for (let i = 0; i < missing.length; i += HEIGHT_BATCH_SIZE) {
    const batch = missing.slice(i, i + HEIGHT_BATCH_SIZE);
    await Promise.all(batch.map(async (churn) => {
      const queryHeight = churn.height - 1;
      let rewardAmount = 0;
      // FIX: nicht jede Node-Antwort ohne verwertbare Provider-Daten bedeutet "0 Reward /
      // Churn-out" -- ältere Höhen (vor Einführung von bond_providers im THORNode-Schema) oder
      // eine unvollständige Archival-Antwort liefern u.U. GAR KEIN bond_providers-Feld, obwohl
      // die Adresse zu diesem Zeitpunkt tatsächlich aktiv gebondet war. Ohne diese Unterscheidung
      // würde ein reiner Daten-/Schema-Lücke fälschlich als echter Churn-out (0 Reward)
      // gespeichert und in der App als solcher markiert. Nur speichern, wenn MINDESTENS EINE der
      // abgefragten Node-Antworten tatsächlich ein bond_providers.providers-Array enthielt (auch
      // ein LEERES Array zählt -- das heißt, THORNode hat für diese Höhe wirklich Providerdaten
      // geliefert, die Adresse war dort nur nicht/mit 0 Bond gelistet).
      let hasProviderData = false;
      try {
        const nodeResults = await Promise.all(
          nodeAddresses.map((nodeAddr) => fetchNodeAtHeight(nodeAddr, queryHeight))
        );
        for (const node of nodeResults) {
          if (node && node.bond_providers && Array.isArray(node.bond_providers.providers)) {
            hasProviderData = true;
          }
          rewardAmount += computeAddressAwardFromNode(node, address);
        }
      } catch (e) {
        // Netzwerk-/HTTP-Fehler -- könnte transient sein (z.B. Archival-Base kurz down),
        // deshalb hier WEITER als "missing" stehen lassen und beim nächsten Cron-Lauf erneut
        // versuchen (anders als der Fall unten, wo die Antwort zwar ankam, aber strukturell
        // keine Provider-Daten enthielt).
        return;
      }

      if (!hasProviderData) {
        // WICHTIG: hier NICHT einfach überspringen (also NICHT `return`)! Das würde diese Höhe
        // für immer als "missing" stehen lassen -- lag das Fehlen der Provider-Daten an etwas
        // Dauerhaftem (z.B. Höhe liegt vor Einführung von bond_providers im THORNode-Schema),
        // würde JEDER künftige Cron-Lauf exakt dieselbe Höhe wieder versuchen, nie vorankommen,
        // und die Adresse bliebe für immer im Status "building" hängen (genau das führte zum
        // dauerhaften Lade-Zustand im Frontend). Stattdessen wird die Höhe als "erledigt, aber
        // unbekannt" markiert (reward_amount = NULL) -- taucht dann NICHT als Reward oder als
        // Churn-out auf (siehe Filter in handleBondHistory), verschwindet aber aus der
        // "missing"-Liste und blockiert den Fortschritt nicht mehr.
        await env.DB
          .prepare(
            `INSERT OR REPLACE INTO bond_history_rows
             (bond_address, churn_height, churn_timestamp, rune_stack, reward_amount, fetched_at)
             VALUES (?, ?, ?, NULL, NULL, ?)`
          )
          .bind(address, churn.height, churn.date_ms, now)
          .run();
        return;
      }

      await env.DB
        .prepare(
          `INSERT OR REPLACE INTO bond_history_rows
           (bond_address, churn_height, churn_timestamp, rune_stack, reward_amount, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(address, churn.height, churn.date_ms, rewardAmount, rewardAmount, now)
        .run();
    }));
    if (i + HEIGHT_BATCH_SIZE < missing.length) await sleep(150);
  }

  const stillMissing = missing.length === MAX_HEIGHTS_PER_ADDRESS_PER_RUN ? true : false;

  await env.DB
    .prepare('UPDATE tracked_addresses SET status = ?, last_refreshed_at = ? WHERE bond_address = ?')
    .bind(stillMissing ? 'building' : 'done', now, address)
    .run();
}
