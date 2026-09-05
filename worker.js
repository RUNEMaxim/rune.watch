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
// FIX 10: Drei Midgard-Anfragen liefen bisher DIREKT AUS DEM BROWSER gegen
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
// FIX 16: /wallets -- synchronisiert jetzt auch die getrackte WALLET-LISTE selbst
//        geräteübergreifend, nicht mehr nur die Kaufliste (/purchases). Vorher tauchte eine auf
//        einem Gerät zusätzlich hinzugefügte oder entfernte Wallet-Adresse auf einem anderen
//        Gerät nicht auf, weil es dafür überhaupt keinen Sync-Mechanismus gab. Nutzt exakt
//        denselben Anker wie /purchases: die ERSTE getrackte Wallet-Adresse (wallets[0]) als
//        Schlüssel -- setzt also voraus, dass diese auf allen Geräten identisch eingetragen ist.
//        Gleiches additiv-mergendes Tombstone-Muster wie bei /purchases (siehe dort), nur mit
//        Adressen statt Kauf-IDs als Einträge.
//
//        VORHER EINMALIG PER SQL AUSFÜHREN (D1 -> Console):
//
//          CREATE TABLE IF NOT EXISTS user_wallet_lists (
//            address TEXT PRIMARY KEY,
//            wallets TEXT,
//            updated_at INTEGER
//          );
//          CREATE TABLE IF NOT EXISTS user_wallet_lists_deleted (
//            address TEXT NOT NULL,
//            deleted_wallet TEXT NOT NULL,
//            deleted_at INTEGER,
//            PRIMARY KEY (address, deleted_wallet)
//          );
// FIX 18 (NEU): Zusätzlich zum reinen Tages-Dedup (sync_activity_days, siehe FIX 17) jetzt auch
//        ein ECHTER Request-Zähler pro Adresse+Tag -- beantwortet "wie OFT (nicht nur an wie
//        vielen Tagen) synchronisiert eine einzelne Adresse". Läuft komplett UNABHÄNGIG neben
//        dem bestehenden Tages-Dedup her (der bleibt exakt wie er ist, wird für die
//        Retention-Quote weiter gebraucht) -- der neue Zähler zählt bewusst JEDEN einzelnen
//        Aufruf, ohne Dedup, als reine Zusatz-Kennzahl. Im /stats-Dashboard als zwei neue
//        Kacheln sichtbar: "Requests gesamt (30T)" und "Ø Requests je aktiver Adresse".
//
//        VORHER EINMALIG PER SQL AUSFÜHREN (D1 -> Console):
//
//          CREATE TABLE IF NOT EXISTS sync_activity_counts (
//            address TEXT NOT NULL,
//            day TEXT NOT NULL,
//            count INTEGER NOT NULL DEFAULT 0,
//            PRIMARY KEY (address, day)
//          );
// FIX 19 (NEU, auf Wunsch "beides zusammen"): sowohl die toten Midgard-Fallback-Domains
//        entfernt (midgard.thorchain.network existiert nicht mehr, siehe DNS-Test/Nutzer-
//        Feedback -- war bisher als "Fallback" gelistet, griff aber faktisch nie) ALS AUCH einen
//        echten D1-Stale-Cache für /volume ergänzt, nach demselben bewährten Muster wie
//        balance_cache bei /balance (FIX 6): schlägt die Live-Anfrage bei Liquify (jetzt der
//        EINZIGE Anbieter) fehl, wird der letzte bekannte Stand (bis zu 1h alt) statt eines
//        Fehlers ausgeliefert. /recent-swaps hatte mit recent_swaps_snapshot (FIX 14) bereits
//        ein äquivalentes Sicherheitsnetz -- dessen Cache-Alter-Grenze wurde hier nicht
//        angetastet, da er anders funktioniert (Momentaufnahme statt Alters-Grenze).
//
//        VORHER EINMALIG PER SQL AUSFÜHREN (D1 -> Console):
//
//          CREATE TABLE IF NOT EXISTS volume_cache (
//            id INTEGER PRIMARY KEY CHECK (id = 1),
//            payload TEXT NOT NULL,
//            updated_at INTEGER NOT NULL
//          );
// FIX 20 (NEU): /drawings -- geräteübergreifender Sync der Chart-Zeichnungen (horizontale
//        Linien, Trendlinien, Fibonacci), analog zu /wallets (FIX 16), nur mit ZWEI Schlüsseln
//        statt einem: Wallet-Adresse UND Chart-Bezeichner (chart, entspricht storageKeyPrefix
//        im Frontend) -- Zeichnungen sind PRO CHART getrennt, nicht global pro Adresse.
//
//        VORHER EINMALIG PER SQL AUSFÜHREN (D1 -> Console):
//
//          CREATE TABLE IF NOT EXISTS user_chart_drawings (
//            address TEXT NOT NULL,
//            chart TEXT NOT NULL,
//            h_lines TEXT,
//            t_lines TEXT,
//            fib_lines TEXT,
//            updated_at INTEGER,
//            PRIMARY KEY (address, chart)
//          );
//          CREATE TABLE IF NOT EXISTS user_chart_drawings_deleted (
//            address TEXT NOT NULL,
//            chart TEXT NOT NULL,
//            deleted_id TEXT NOT NULL,
//            deleted_at INTEGER,
//            PRIMARY KEY (address, chart, deleted_id)
//          );
// FIX 21 (NEU): /memoless-Fehlerantwort bei einem eigenen Worker-seitigen Fehlschlag (Timeout,
//        Netzwerkfehler zum Upstream etc., siehe handleMemoless catch-Block) hatte bisher die
//        Form { error: "MEMOLESS_UPSTREAM_FAILED", message: "..." } -- also einen reinen STRING
//        unter "error", kein Objekt. Das Frontend liest die Fehlermeldung aber einheitlich über
//        registerData?.error?.message (so, wie es auch die durchgereichten ECHTEN
//        THORChain-Fehler liefern, z.B. { error: { message: "Failed to register memo" } }).
//        Bei einem reinen String ist .message darauf immer undefined -- das Frontend fiel in
//        diesem Fall auf die nichtssagende generische Meldung ("Something went wrong") zurück,
//        obwohl der Worker die eigentliche Ursache (Timeout/Netzwerkfehler) bereits kannte.
//        Jetzt liefert der catch-Block dieselbe { error: { message: "..." } }-Form wie ein
//        echter Upstream-Fehler -- das Frontend zeigt ab sofort in BEIDEN Fällen die konkrete
//        Ursache an.
// FIX 22 (Korrektur von FIX 21): /memoless-Fehlercode statt fertigem deutschen Satz, siehe
//        handleMemoless catch-Block -- Übersetzung passiert im Frontend über swapTimeout/
//        swapNetworkError/swapErrorGeneric.
// FIX 23 (NEU, gemeldet: "Top Swap Pairs" zeigt viel zu wenig Volumen, z.B. $4.4M bei $40M
//        echtem 24h-Netzwerkvolumen -- 24h-Label stimmte de facto nicht): Die alte
//        last_height-Nachlauf-Logik (FIX 12/13) versuchte, LÜCKENLOS alle Swaps seit dem
//        letzten Cron-Durchlauf zu erfassen und dabei ein glaubwürdiges "echtes" 24h/7d/30d-
//        Fenster zu behaupten. Sobald zwischen zwei Durchläufen mehr als
//        SWAP_COLLECT_MAX_PAGES*50 (bisher 500) Swaps passierten, blieb last_height nach Design
//        ABSICHTLICH stehen ("nächster Durchlauf versucht es erneut") -- lief das Netzwerk
//        dauerhaft über dieser Schwelle, rückte last_height NIE wieder vor, und swap_events
//        deckte in Wahrheit nur noch ein enges, sich nicht vergrößerndes Zeitfenster ab (einige
//        Stunden statt der behaupteten 24h/7d/30d), ohne dass das im UI erkennbar war.
//
//        NEU (auf expliziten Wunsch): komplett andere Strategie -- statt eines behaupteten
//        Zeitfensters werden ab jetzt schlicht die NEUESTEN SWAP_EVENTS_KEEP (1000) Swaps
//        gehalten, unabhängig davon, welche Zeitspanne die tatsächlich abdecken. last_height/
//        swap_collector_state/hitPageLimit/window-Parameter (24h|7d|30d) entfallen ersatzlos --
//        es gibt kein "Fenster" mehr, das fälschlich zu groß behauptet werden könnte. Stattdessen
//        liefert /top-pairs die tatsächlich abgedeckte Zeitspanne (spanFromMs/spanToMs) direkt
//        mit, damit das Frontend ehrlich anzeigen kann, wie alt der älteste erfasste Swap ist,
//        statt eine feste, potenziell falsche Fensterbeschriftung zu zeigen.
//
//        swap_collector_state wird nicht mehr gelesen/geschrieben, kann aber unverändert in D1
//        stehen bleiben (keine Migration nötig, nur toter Zustand).
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

// FIX 19: midgard.thorchain.network entfernt -- die Domain existiert nicht mehr (DNS-Fehler
// bei direktem Test, konsistent mit den entsprechenden Fixes im Frontend/app.js). Liquify ist
// aktuell der EINZIGE zuverlässige öffentliche Midgard-Anbieter -- siehe FIX 19 im Kopfkommentar
// für den neu ergänzten D1-Stale-Cache (volume_cache), der diesen Single-Point-of-Failure für
// /volume abfedert, solange kein zweiter echter Anbieter verfügbar ist.
const MIDGARD_BASES = [
  'https://gateway.liquify.com/chain/thorchain_midgard/v2',
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
// Quelle danebengestartet wird.
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

let nodesCache = null; // { promise, atMs }
const NODES_CACHE_MS = 2000;

function fetchNodes() {
  if (nodesCache && Date.now() - nodesCache.atMs < NODES_CACHE_MS) {
    return nodesCache.promise;
  }
  const promise = fetchFromBases(getThornodeBases(), '/thorchain/nodes');
  promise.catch(() => {
    if (nodesCache && nodesCache.promise === promise) nodesCache = null;
  });
  nodesCache = { promise, atMs: Date.now() };
  return promise;
}

function fetchNodeAtHeight(nodeAddress, height) {
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
// FIX 10: /volume -- 24h- und 30-Tage-Swap-Volumen.
// ----------------------------------------------------------------------------
function fetchVolumeInterval(interval, count) {
  return fetchFromBases(MIDGARD_BASES, `/history/swaps?interval=${interval}&count=${count}`);
}

let volumeCache = null; // { promise, atMs }
const VOLUME_CACHE_MS = 5000;

function fetchVolumeBundleLive() {
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
  promise.catch(() => {
    if (volumeCache && volumeCache.promise === promise) volumeCache = null;
  });
  volumeCache = { promise, atMs: Date.now() };
  return promise;
}

const VOLUME_STALE_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1h, wie CACHE_MAX_AGE_MS bei /balance

async function readVolumeCache(env) {
  try {
    const row = await env.DB.prepare('SELECT payload, updated_at FROM volume_cache WHERE id = 1').first();
    if (!row || !row.payload) return null;
    return { data: JSON.parse(row.payload), updatedAt: row.updated_at };
  } catch (e) {
    console.warn('[rune-rewards-backend] volume_cache nicht lesbar (Migration ausgeführt?):', e?.message || String(e));
    return null;
  }
}

async function writeVolumeCache(env, data) {
  try {
    let merged = data;
    if (!data.hour || !data.day) {
      const existing = await readVolumeCache(env);
      if (existing && existing.data) {
        merged = {
          hour: data.hour || existing.data.hour || null,
          hourError: data.hour ? null : (data.hourError || existing.data.hourError || null),
          day: data.day || existing.data.day || null,
          dayError: data.day ? null : (data.dayError || existing.data.dayError || null),
        };
      }
    }
    await env.DB.prepare(
      `INSERT INTO volume_cache (id, payload, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
    ).bind(JSON.stringify(merged), Date.now()).run();
  } catch (e) {
    console.warn('[rune-rewards-backend] volume_cache-Schreiben fehlgeschlagen (Migration ausgeführt?):', e?.message || String(e));
  }
}

const VOLUME_FRESH_ENOUGH_MS = 60 * 1000;
const VOLUME_BACKGROUND_REFRESH_INTERVAL_MS = 20 * 1000;

async function fetchVolumeBundle(env, ctx) {
  let cached = null;
  try {
    cached = await readVolumeCache(env);
  } catch (e) {
    console.warn('[rune-rewards-backend] /volume: Cache-Lesen (Fast-Path) fehlgeschlagen:', e?.message || String(e));
  }
  if (cached && (Date.now() - cached.updatedAt) < VOLUME_FRESH_ENOUGH_MS) {
    if ((Date.now() - cached.updatedAt) >= VOLUME_BACKGROUND_REFRESH_INTERVAL_MS) {
      const refresh = (async () => {
        try {
          const data = await fetchVolumeBundleLive();
          if (data.hour || data.day) await writeVolumeCache(env, data);
        } catch (e) {
          console.warn('[rune-rewards-backend] /volume Hintergrund-Refresh fehlgeschlagen:', e?.message || String(e));
        }
      })();
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(refresh);
      }
    }
    return { data: cached.data, stale: false, staleSince: cached.updatedAt };
  }

  try {
    const data = await fetchVolumeBundleLive();
    if (data.hour || data.day) {
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(writeVolumeCache(env, data));
      } else {
        await writeVolumeCache(env, data);
      }
      return { data, stale: false };
    }
    console.warn('[rune-rewards-backend] /volume: beide Teilanfragen fehlgeschlagen, versuche Stale-Cache:', data.hourError, data.dayError);
    const cachedBothFailed = cached || await readVolumeCache(env);
    if (cachedBothFailed && (Date.now() - cachedBothFailed.updatedAt) < VOLUME_STALE_CACHE_MAX_AGE_MS) {
      return { data: cachedBothFailed.data, stale: true, staleSince: cachedBothFailed.updatedAt };
    }
    return { data, stale: false };
  } catch (e) {
    console.warn('[rune-rewards-backend] /volume Live-Anfrage fehlgeschlagen, versuche Stale-Cache:', e?.message || String(e));
    const cachedOnError = cached || await readVolumeCache(env);
    if (cachedOnError && (Date.now() - cachedOnError.updatedAt) < VOLUME_STALE_CACHE_MAX_AGE_MS) {
      return { data: cachedOnError.data, stale: true, staleSince: cachedOnError.updatedAt };
    }
    return {
      data: { hour: null, hourError: e?.message || String(e), day: null, dayError: e?.message || String(e) },
      stale: false,
    };
  }
}

async function handleVolume(request, env, ctx) {
  const result = await fetchVolumeBundle(env, ctx);
  return json({ ...result.data, stale: result.stale, staleSince: result.staleSince || null }, env);
}

// ----------------------------------------------------------------------------
// FIX 10: /recent-swaps
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
  promise.catch(() => {
    if (recentSwapsCache && recentSwapsCache.promise === promise) {
      recentSwapsCache = null;
    }
  });
  recentSwapsCache = { promise, atMs: Date.now() };
  return promise;
}

let recentSwapsWarmedUp = false;

async function readRecentSwapsSnapshot(env) {
  const row = await env.DB.prepare('SELECT payload FROM recent_swaps_snapshot WHERE id = 1').first();
  if (!row || !row.payload) return null;
  try {
    return JSON.parse(row.payload);
  } catch (e) {
    return null;
  }
}

async function handleRecentSwaps(request, env, ctx) {
  if (!recentSwapsWarmedUp) {
    const livePromise = fetchRecentSwapActionsCached().then(data => {
      recentSwapsWarmedUp = true;
      return data;
    }).catch(e => {
      recentSwapsWarmedUp = true;
      throw e;
    });
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(livePromise.catch(() => {}));
    }
    try {
      const snapshot = await readRecentSwapsSnapshot(env);
      if (snapshot) return json(snapshot, env);
    } catch (e) {
      console.warn('[rune-rewards-backend] Snapshot-Lesen fehlgeschlagen (Migration ausgeführt?):', e?.message || String(e));
    }
    try {
      const data = await livePromise;
      return json(data, env);
    } catch (e) {
      console.warn('[rune-rewards-backend] /recent-swaps fehlgeschlagen (beide Quellen):', e?.message || String(e));
      return json({ actions: [] }, env);
    }
  }

  try {
    const data = await fetchRecentSwapActionsCached();
    return json(data, env);
  } catch (e) {
    console.warn('[rune-rewards-backend] /recent-swaps fehlgeschlagen (beide Quellen):', e?.message || String(e));
    return json({
      actions: []
    }, env);
  }
}

// ----------------------------------------------------------------------------
// FIX 23: Top-5-Swap-Paare -- KEIN behauptetes Zeitfenster (24h/7d/30d) mehr, siehe
// ausführliche Begründung im Kopfkommentar der Datei (FIX 23). Stattdessen: bei jedem
// Cron-Durchlauf werden schlicht die neuesten SWAP_COLLECT_PAGES*50 (1000) Swaps von Midgard
// geholt, dedupliziert (INSERT OR IGNORE), und die Tabelle wird danach auf die neuesten
// SWAP_EVENTS_KEEP (1000) Einträge INSGESAMT gekappt -- unabhängig davon, welche Zeitspanne
// diese 1000 Swaps tatsächlich abdecken. /top-pairs liest daraus die Top 5 und liefert
// zusätzlich die TATSÄCHLICH abgedeckte Zeitspanne (ältester/neuester erfasster Swap) mit,
// damit das Frontend ehrlich anzeigen kann "letzte 1.000 Swaps, deckt die letzten X Stunden
// ab" statt einer festen, potenziell falschen "24h"-Beschriftung.
//
// swap_collector_state (last_height-Fortschritt) wird NICHT MEHR benutzt -- kann in D1 stehen
// bleiben, wird aber nirgends mehr gelesen oder geschrieben.
//
// VORHER EINMALIG PER SQL AUSFÜHREN (D1 -> Console), falls noch nicht vorhanden:
//
//   CREATE TABLE IF NOT EXISTS swap_events (
//     tx_id TEXT PRIMARY KEY,
//     pair TEXT NOT NULL,
//     volume_usd REAL,
//     ts INTEGER NOT NULL
//   );
//   CREATE INDEX IF NOT EXISTS idx_swap_events_ts ON swap_events(ts);
// ----------------------------------------------------------------------------

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

function buildSwapEventRow(a) {
  if (a.status && a.status !== 'success') return null;
  const txId = a.in && a.in[0] && a.in[0].txID;
  if (!txId) return null;
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
  return { txId, pair, volumeUsd, ts };
}

// FIX 23: 20 Seiten * 50 = 1000 Swaps pro Cron-Durchlauf, IMMER die neuesten (kein
// last_height-Filter mehr) -- ersetzt die alte last_height-Nachlauf-Logik komplett.
const SWAP_COLLECT_PAGES = 20;
// Tabelle wird nach jedem Durchlauf auf die neuesten SWAP_EVENTS_KEEP Einträge INSGESAMT
// gekappt (nicht nach Alter, sondern nach Anzahl) -- siehe Kopfkommentar FIX 23.
const SWAP_EVENTS_KEEP = 1000;

// FIX 29 (KRITISCH -- Cloudflare-Alarm: "D1 rows_written limit exceeded", Worker liefert bis
// Tagesende nur noch Fehler): FIX 23 hat pro Cron-Durchlauf IMMER bis zu 1000 Swaps neu
// abgefragt und versucht, ALLE davon per INSERT OR IGNORE einzufügen -- auch wenn beim
// vorherigen Durchlauf schon fast alle davon gespeichert wurden. D1 zählt JEDEN
// Einfüge-VERSUCH zu rows_written, unabhängig davon, ob er wegen Duplikat ignoriert wird.
// Läuft der Cron alle paar Minuten, kommen so binnen weniger Stunden hunderttausende
// überflüssige Schreibversuche zusammen -- exakt das gemeldete Limit-Problem.
//
// Fix: swap_collector_state (die Tabelle existierte bereits, wurde seit FIX 23 nur nicht mehr
// genutzt) hält wieder die höchste bereits gesehene Block-Höhe fest. Jeder Durchlauf
// paginiert nur so lange, bis eine BEKANNTE Höhe erreicht wird (= alles Neue seit letztem Mal
// eingesammelt) -- ein normaler Durchlauf muss dadurch nur noch die paar WIRKLICH neuen Swaps
// einfügen (typischerweise eine Handvoll, nicht 1000), nicht mehr denselben Datenberg jedes
// Mal komplett neu. Sicherheitsnetz (hitPageLimit) bleibt wie beim ursprünglichen Design: wird
// SWAP_COLLECT_PAGES komplett ausgeschöpft, ohne die alte Höhe wieder zu erreichen (mehr als
// SWAP_COLLECT_PAGES*50 Swaps seit dem letzten Durchlauf), bleibt last_height bewusst
// UNVERÄNDERT -- der nächste Durchlauf versucht dann, ab genau dort weiterzumachen, statt
// fälschlich so zu tun, als wäre man auf dem neuesten Stand.
async function collectSwapPairStats(env) {
  let lastHeight = null;
  try {
    const stateRow = await env.DB.prepare('SELECT last_height FROM swap_collector_state WHERE id = 1').first();
    lastHeight = stateRow ? stateRow.last_height : null;
  } catch (e) {
    console.warn('[rune-rewards-backend] swap_collector_state nicht lesbar (Migration ausgeführt?):', e?.message || String(e));
  }

  const collectedRows = [];
  let maxHeightSeen = lastHeight;
  let reachedKnownHeight = false;
  let firstPageActions = null; // für die Momentaufnahme (FIX 14) -- unabhängig vom Höhen-Filter
  let hitPageLimit = false;

  for (let page = 0; page < SWAP_COLLECT_PAGES; page++) {
    let data;
    try {
      data = await fetchFromBases(MIDGARD_BASES, `/actions?type=swap&limit=50&offset=${page * 50}`, {
        timeoutMs: 12000,
      });
    } catch (e) {
      console.warn('[rune-rewards-backend] Swap-Paar-Sammlung fehlgeschlagen (Seite', page, '):', e?.message || String(e));
      break; // was bisher gesammelt wurde, wird trotzdem gespeichert -- besser als nichts
    }
    const actions = (data && Array.isArray(data.actions)) ? data.actions : [];
    if (page === 0) firstPageActions = actions;
    if (!actions.length) break;

    for (const a of actions) {
      const height = parseInt(a.height, 10);
      // Midgard liefert neueste zuerst -- sobald eine Höhe auftaucht, die wir beim letzten
      // Durchlauf schon erfasst hatten, ist ALLES Neue seit damals vollständig eingesammelt,
      // weiteres Paginieren würde nur bereits bekannte, ältere Swaps erneut anfassen (und
      // erneute, unnötige D1-Schreibversuche verursachen).
      if (lastHeight != null && isFinite(height) && height <= lastHeight) {
        reachedKnownHeight = true;
        break;
      }
      const row = buildSwapEventRow(a);
      if (row) collectedRows.push(row);
      if (isFinite(height) && (maxHeightSeen == null || height > maxHeightSeen)) {
        maxHeightSeen = height;
      }
    }

    if (reachedKnownHeight || actions.length < 50) break; // fertig bzw. letzte Seite erreicht
    if (page === SWAP_COLLECT_PAGES - 1) hitPageLimit = true;
  }

  // FIX 14: Momentaufnahme der aktuellsten Swaps (Seite 0, UNGEFILTERT nach Höhe -- die
  // Live-Anzeige im Frontend will immer die neuesten paar Swaps sehen) für den sofortigen
  // Fallback in /recent-swaps speichern. Läuft unabhängig davon, ob es NEUE Swaps für die
  // Statistik gab.
  if (firstPageActions && firstPageActions.length) {
    try {
      await env.DB.prepare(
        `INSERT INTO recent_swaps_snapshot (id, payload, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).bind(JSON.stringify({ actions: firstPageActions.slice(0, 20) }), Date.now()).run();
    } catch (e) {
      console.warn('[rune-rewards-backend] Momentaufnahme-Schreiben fehlgeschlagen (Migration ausgeführt?):', e?.message || String(e));
    }
  }

  if (!collectedRows.length) return; // nichts Neues seit letztem Mal -- kein weiterer D1-Zugriff nötig

  try {
    const stmt = env.DB.prepare(
      'INSERT OR IGNORE INTO swap_events (tx_id, pair, volume_usd, ts) VALUES (?, ?, ?, ?)'
    );
    await env.DB.batch(collectedRows.map((r) => stmt.bind(r.txId, r.pair, r.volumeUsd, r.ts)));

    if (maxHeightSeen != null && !hitPageLimit) {
      await env.DB.prepare(
        `INSERT INTO swap_collector_state (id, last_height) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET last_height = excluded.last_height`
      ).bind(maxHeightSeen).run();
    } else if (hitPageLimit) {
      console.warn('[rune-rewards-backend] Swap-Paar-Sammlung: Seitenlimit erreicht, ohne die alte last_height wieder zu treffen -- lasse last_height unverändert, versuche es beim nächsten Durchlauf erneut (mehr als', SWAP_COLLECT_PAGES * 50, 'Swaps seit dem letzten Durchlauf).');
    }

    // FIX 23 (bleibt bestehen): rollierendes Fenster nach ANZAHL statt Alter -- immer nur die
    // neuesten SWAP_EVENTS_KEEP Einträge behalten. Betrifft jetzt aber nur noch die paar NEUEN
    // Zeilen pro Durchlauf (dank Höhen-Filter oben), nicht mehr potenziell 1000 auf einmal.
    await env.DB.prepare(
      `DELETE FROM swap_events WHERE tx_id NOT IN (
         SELECT tx_id FROM swap_events ORDER BY ts DESC LIMIT ?
       )`
    ).bind(SWAP_EVENTS_KEEP).run();
  } catch (e) {
    console.warn('[rune-rewards-backend] Swap-Paar-Sammlung: D1-Schreibfehler (Migration ausgeführt?):', e?.message || String(e));
  }
}

// FIX 23: kein window-Parameter mehr (24h|7d|30d entfällt ersatzlos, siehe Kopfkommentar) --
// /top-pairs liefert immer die Top 5 aus den aktuell gehaltenen (neuesten SWAP_EVENTS_KEEP)
// Swaps, dazu swapCount/spanFromMs/spanToMs, damit das Frontend die tatsächlich abgedeckte
// Zeitspanne ehrlich anzeigen kann statt einer festen, potenziell falschen Beschriftung.
async function handleTopPairs(request, env) {
  const url = new URL(request.url);
  const sortByVolume = url.searchParams.get('sort') === 'volume';
  const orderClause = sortByVolume ? 'vol DESC' : 'cnt DESC';
  try {
    const [rows, spanRow] = await Promise.all([
      env.DB.prepare(
        `SELECT pair, COUNT(*) as cnt, SUM(COALESCE(volume_usd, 0)) as vol
         FROM swap_events
         GROUP BY pair
         ORDER BY ${orderClause}
         LIMIT 5`
      ).all(),
      env.DB.prepare('SELECT MIN(ts) as oldest, MAX(ts) as newest, COUNT(*) as total FROM swap_events').first(),
    ]);
    return json({
      sort: sortByVolume ? 'volume' : 'count',
      swapCount: spanRow?.total || 0,
      spanFromMs: spanRow?.oldest ?? null,
      spanToMs: spanRow?.newest ?? null,
      pairs: (rows.results || []).map((r) => ({ pair: r.pair, count: r.cnt, volumeUsd: r.vol })),
    }, env);
  } catch (e) {
    console.error('[rune-rewards-backend] /top-pairs fehlgeschlagen (Tabelle angelegt?):', e?.message || String(e));
    return json({ sort: sortByVolume ? 'volume' : 'count', swapCount: 0, spanFromMs: null, spanToMs: null, pairs: [] }, env);
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
      transactions: [...bondRes.items, ...unbondRes.items].sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0)),
    };
  } catch (e) {
    return { success: false, errorDetail: e?.message || String(e) };
  }
}

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
// FIX 24 (gemeldet: "Rewards-Historie/Ø Monat lädt zu langsam, das muss doch sofort gehen"):
// vorher 20 Höhen pro Refresh-Aufruf in Batches von 5 (= 4 sequenzielle Batches à 150ms Pause).
// Bei z.B. 127 nachzuladenden Churns brauchte das ~7 Refresh-Aufrufe hintereinander (je alle
// ~4s vom Frontend abgefragt, siehe REWARDS_BACKEND_POLL_MS) -- real 30-60+ Sekunden, bis die
// Historie (und damit Ø Monat/TOTAL) vollständig war. Jetzt: gleiche Anzahl sequenzieller
// Batches (4) wie vorher -- die Wartezeit durch die 150ms-Pausen zwischen Batches bleibt also
// gleich -- aber jeder Batch fragt 3x so viele Höhen gleichzeitig ab (15 statt 5), macht
// insgesamt 60 statt 20 Höhen pro Aufruf. Bei 127 Churns sind das nur noch ~3 Aufrufe statt ~7
// -- Backfill ist dadurch in etwa 3x schneller abgeschlossen, ohne dass ein einzelner Aufruf
// länger braucht als vorher (gleiche Batch-Struktur, nur mehr Parallelität pro Batch).
// FIX 25 (Korrektur von FIX 24 -- gemeldet: "die Historie ist doch im Worker gespeichert, das
// muss doch sofort fertig sein"): FIX 24 hat den Durchsatz PRO Aufruf erhöht (20->60 Höhen),
// aber das Kernproblem nicht behoben -- bei z.B. 128 nachzuladenden Churns waren immer noch
// ~3 GETRENNTE, vom Frontend nacheinander ausgelöste Refresh-Aufrufe nötig (gebunden an
// Poll-Intervall + Cooldown). Das ist unnötig: die eigentliche Arbeit läuft ohnehin im
// Hintergrund über ctx.waitUntil() UND schreibt nach JEDEM einzelnen Batch sofort in D1 (siehe
// Schleife unten) -- es gibt keinen technischen Grund, die Verarbeitung künstlich nach 60
// Höhen abzubrechen und auf den NÄCHSTEN externen HTTP-Aufruf zu warten. Jetzt: EIN einziger
// Hintergrund-Durchlauf verarbeitet die GESAMTE fehlende Liste (bis zur Sicherheitsgrenze 500 --
// mehr als jede reale Adresse je an einmal nachzuholenden Churns haben sollte, analog zum
// bereits bestehenden Muster bei SWAP_COLLECT_PAGES*50=500 für /top-pairs). Das Frontend-Polling
// (REWARDS_BACKEND_POLL_MS) dient danach nur noch dazu, den bereits LAUFENDEN Fortschritt
// anzuzeigen (die Zeilen wachsen währenddessen sichtbar in bond_history_rows), nicht mehr dazu,
// JEDEN einzelnen Verarbeitungsschritt selbst anzustoßen.
// FIX 32 (KRITISCH -- erneuter D1-Alarm bei 77%, gemeldet: "immer noch Probleme"): FIX 25's
// Erhöhung auf 500 hatte einen Nebeneffekt, den ich übersehen hatte: INSERT OR REPLACE zählt
// bei D1 als LÖSCHEN+EINFÜGEN (2 Schreibvorgänge pro Zeile, nicht 1). Bleibt eine Adresse
// LÄNGER im Status 'building' hängen (z.B. weil für ältere Höhen keine verwertbaren
// Provider-Daten verfügbar sind, siehe hasProviderData weiter unten), wird sie vom Cron
// bevorzugt IMMER WIEDER aufgegriffen ("ORDER BY status='pending' DESC" -- 'building' zählt
// hier mit) -- jeder dieser Durchläufe versuchte bis zu 500 REPLACE-Operationen, macht bis zu
// 1000 tatsächliche Schreibvorgänge JE Adresse JE Cron-Tick. Deutlich zu aggressiv. Auf 40
// reduziert -- immer noch doppelt so schnell wie die ursprünglichen 20, aber weit weniger
// riskant bei wiederholten Durchläufen für ein- und dieselbe (evtl. dauerhaft "steckende")
// Adresse.
const MAX_HEIGHTS_PER_ADDRESS_PER_RUN = 40;
const HEIGHT_BATCH_SIZE = 10;
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

  // FIX 24: Cooldown von 3s auf 2s reduziert, passend zum ebenfalls verkürzten Frontend-Poll-
  // Intervall (REWARDS_BACKEND_POLL_MS, siehe app.js) -- verhindert, dass ein Poll knapp VOR
  // Ablauf des alten 3s-Cooldowns "leer" ankommt (kein neuer Refresh ausgelöst) und dadurch
  // unnötig eine ganze Poll-Runde verschenkt wird, während der Sync eigentlich schneller
  // vorankommen könnte.
  const REFRESH_COOLDOWN_MS = 2 * 1000;
  const recentlyRefreshed = trackedRow.last_refreshed_at && (now - trackedRow.last_refreshed_at) < REFRESH_COOLDOWN_MS;
  // FIX 25 (Korrektur eines durch FIX 25 selbst entstandenen Nebeneffekts): last_refreshed_at
  // wird erst GANZ AM ENDE von refreshOneAddress geschrieben (siehe dort) -- bei einem jetzt
  // potenziell lange laufenden Einzel-Durchlauf (bis zu 500 Höhen, siehe
  // MAX_HEIGHTS_PER_ADDRESS_PER_RUN) bleibt last_refreshed_at während der GESAMTEN Laufzeit auf
  // dem alten (oft NULL/längst abgelaufenen) Stand stehen. Ohne diese zusätzliche Prüfung hätte
  // JEDER weitere Poll (alle 2.5s vom Frontend) einen ZWEITEN, PARALLEL LAUFENDEN
  // refreshOneAddress-Aufruf für dieselbe Adresse ausgelöst, während der erste noch mitten in
  // der Bearbeitung war -- unnötige doppelte THORNode-Anfragen (durch INSERT OR REPLACE zwar
  // nicht FALSCH, aber verschwenderisch und unnötige Last). Jetzt: status === 'building'
  // bedeutet "hier läuft bereits etwas" (dieser Status wird ZU BEGINN der Verarbeitung gesetzt,
  // siehe refreshOneAddress) -- ein neuer On-Demand-Trigger wird dafür übersprungen. Bleibt ein
  // Durchlauf ausnahmsweise wirklich hängen (z.B. Worker-Absturz mitten in der Verarbeitung),
  // greift weiterhin der bestehende Cron-Job (runRefreshCycle), der 'pending'/'building'-Adressen
  // ohnehin regelmäßig erneut aufgreift -- kein Adressen kann dadurch dauerhaft stecken bleiben.
  const alreadyInProgress = trackedRow.status === 'building';
  if (trackedRow.status !== 'done' && !recentlyRefreshed && !alreadyInProgress) {
    ctx.waitUntil(refreshOneAddress(env, trackedRow, now).catch((e) => {
      console.error('[rune-rewards-backend] Sofort-Refresh fehlgeschlagen für', address, e);
    }));
  }

  const rows = await env.DB
    .prepare('SELECT churn_height, churn_timestamp, reward_amount FROM bond_history_rows WHERE bond_address = ? ORDER BY churn_height ASC')
    .bind(address)
    .all();

  const entries = (rows.results || [])
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
    ctx.waitUntil(
      writeBalanceCache(env, address, { balance, bonded, totalActiveBondBase, accruedAward, matchedNodeAddresses, nodeBreakdown })
        .catch((e) => console.error('[rune-rewards-backend] Cache-Schreiben fehlgeschlagen für', address, e))
    );
    return json({
      address, balance, balanceError, bonded, totalActiveBondBase, accruedAward,
      matchedNodeAddresses, nodeBreakdown, nodesError, stale: false,
    }, env);
  }

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

  return json({
    address, balance, balanceError, bonded, totalActiveBondBase, accruedAward,
    matchedNodeAddresses, nodeBreakdown, nodesError, stale: false,
  }, env);
}

const DONATION_THOR_ADDRESS = 'thor1nzyddftjwdfnnwxrs849stf2yw6c9xzda5jeuy';
const DONATION_ETH_ADDRESS = '0x4a342E59Dbbd29b4D254a0975A980467bf4B1Bc1';
const USDC_CONTRACT_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ETH_RPC_URL = 'https://ethereum-rpc.publicnode.com';
const DONATION_FRESH_MS = 12 * 1000;
const DONATION_BACKGROUND_REFRESH_MS = 12 * 1000;

function utcMonthString(ms) {
  return new Date(ms).toISOString().slice(0, 7); // 'YYYY-MM'
}

async function fetchDonationBalanceRune() {
  const balJson = await fetchBalance(DONATION_THOR_ADDRESS);
  const runeEntry = (balJson.balances || []).find((b) => b.denom === 'rune');
  return runeEntry ? Number(runeEntry.amount) / 1e8 : 0;
}

async function fetchDonationUsdcBalance() {
  const paddedAddress = DONATION_ETH_ADDRESS.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const data = '0x70a08231' + paddedAddress;
  const res = await fetchWithTimeout(ETH_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [{ to: USDC_CONTRACT_ADDRESS, data }, 'latest'],
      id: 1,
    }),
    timeoutMs: 8000,
  });
  if (!res.ok) throw new Error('ETH_RPC_HTTP_' + res.status);
  const rpcJson = await res.json();
  if (rpcJson.error) throw new Error('ETH_RPC_ERROR: ' + (rpcJson.error.message || JSON.stringify(rpcJson.error)));
  if (!rpcJson.result) return 0;
  return Number(BigInt(rpcJson.result)) / 1e6;
}

async function fetchDonationEthBalance() {
  const res = await fetchWithTimeout(ETH_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_getBalance',
      params: [DONATION_ETH_ADDRESS, 'latest'],
      id: 1,
    }),
    timeoutMs: 8000,
  });
  if (!res.ok) throw new Error('ETH_RPC_HTTP_' + res.status);
  const rpcJson = await res.json();
  if (rpcJson.error) throw new Error('ETH_RPC_ERROR: ' + (rpcJson.error.message || JSON.stringify(rpcJson.error)));
  if (!rpcJson.result) return 0;
  return Number(BigInt(rpcJson.result)) / 1e18;
}

async function fetchEthUsdPrice() {
  const pool = await fetchFromBases(MIDGARD_BASES, '/pool/ETH.ETH');
  const price = parseFloat(pool?.assetPriceUSD);
  if (!Number.isFinite(price) || price <= 0) throw new Error('MIDGARD_ETH_PRICE_MISSING');
  return price;
}

function highWaterMark(current, previousPeak, sameMonth) {
  if (current == null) return sameMonth ? previousPeak : null;
  if (!sameMonth || previousPeak == null) return current;
  return Math.max(current, previousPeak);
}

async function refreshDonationBalance(env, expectedMonth) {
  try {
    const [runeResult, usdcResult, ethResult, ethPriceResult] = await Promise.allSettled([
      fetchDonationBalanceRune(), fetchDonationUsdcBalance(), fetchDonationEthBalance(), fetchEthUsdPrice(),
    ]);

    const row = await env.DB.prepare('SELECT month, baseline_rune, baseline_usdc, baseline_eth, last_balance_rune, last_balance_usdc, last_balance_eth, last_eth_usd_price FROM donation_tracking WHERE id = 1').first();
    const sameMonth = row && row.month === expectedMonth;
    const month = sameMonth ? row.month : utcMonthString(Date.now());

    const rawRune = runeResult.status === 'fulfilled' ? runeResult.value : null;
    const rawUsdc = usdcResult.status === 'fulfilled' ? usdcResult.value : null;
    const rawEth = ethResult.status === 'fulfilled' ? ethResult.value : null;
    const ethUsdPrice = ethPriceResult.status === 'fulfilled' ? ethPriceResult.value : (row ? row.last_eth_usd_price : null);
    if (rawRune == null && rawUsdc == null && rawEth == null) return;

    const currentRune = highWaterMark(rawRune, row ? row.last_balance_rune : null, sameMonth);
    const currentUsdc = highWaterMark(rawUsdc, row ? row.last_balance_usdc : null, sameMonth);
    const currentEth = highWaterMark(rawEth, row ? row.last_balance_eth : null, sameMonth);

    const baselineRune = sameMonth ? row.baseline_rune : (currentRune ?? 0);
    const baselineUsdc = sameMonth ? (row.baseline_usdc ?? 0) : (currentUsdc ?? 0);
    const baselineEth = sameMonth ? (row.baseline_eth ?? 0) : (currentEth ?? 0);

    await env.DB.prepare(
      `INSERT INTO donation_tracking (id, month, baseline_rune, baseline_usdc, baseline_eth, last_balance_rune, last_balance_usdc, last_balance_eth, last_eth_usd_price, last_balance_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET month = excluded.month, baseline_rune = excluded.baseline_rune, baseline_usdc = excluded.baseline_usdc, baseline_eth = excluded.baseline_eth, last_balance_rune = excluded.last_balance_rune, last_balance_usdc = excluded.last_balance_usdc, last_balance_eth = excluded.last_balance_eth, last_eth_usd_price = excluded.last_eth_usd_price, last_balance_at = excluded.last_balance_at, updated_at = excluded.updated_at`
    ).bind(month, baselineRune, baselineUsdc, baselineEth, currentRune, currentUsdc, currentEth, ethUsdPrice, Date.now(), Date.now()).run();
  } catch (e) {
    console.warn('[rune-rewards-backend] /donation-progress Hintergrund-Refresh fehlgeschlagen:', e?.message || String(e));
  }
}

function receivedEthUsdFrom(row) {
  if (row.last_balance_eth == null || row.last_eth_usd_price == null) return 0;
  const receivedEth = Math.max(0, row.last_balance_eth - (row.baseline_eth || 0));
  return receivedEth * row.last_eth_usd_price;
}

async function handleDonationProgress(request, env, ctx) {
  const currentMonth = utcMonthString(Date.now());
  try {
    const row = await env.DB.prepare('SELECT month, baseline_rune, baseline_usdc, baseline_eth, last_balance_rune, last_balance_usdc, last_balance_eth, last_eth_usd_price, last_balance_at FROM donation_tracking WHERE id = 1').first();

    if (row && row.month === currentMonth && row.last_balance_at != null
      && (row.last_balance_rune != null || row.last_balance_usdc != null || row.last_balance_eth != null)
      && (Date.now() - row.last_balance_at) < DONATION_FRESH_MS) {
      if ((Date.now() - row.last_balance_at) >= DONATION_BACKGROUND_REFRESH_MS) {
        const refresh = refreshDonationBalance(env, currentMonth);
        if (ctx && ctx.waitUntil) ctx.waitUntil(refresh); else await refresh;
      }
      const receivedRune = row.last_balance_rune != null ? Math.max(0, row.last_balance_rune - row.baseline_rune) : 0;
      const receivedUsdc = row.last_balance_usdc != null ? Math.max(0, row.last_balance_usdc - (row.baseline_usdc || 0)) : 0;
      return json({ receivedRune, receivedUsdc, receivedEthUsd: receivedEthUsdFrom(row), month: currentMonth }, env);
    }

    const [runeResult, usdcResult, ethResult, ethPriceResult] = await Promise.allSettled([
      fetchDonationBalanceRune(), fetchDonationUsdcBalance(), fetchDonationEthBalance(), fetchEthUsdPrice(),
    ]);
    const rawRune = runeResult.status === 'fulfilled' ? runeResult.value : null;
    const rawUsdc = usdcResult.status === 'fulfilled' ? usdcResult.value : null;
    const rawEth = ethResult.status === 'fulfilled' ? ethResult.value : null;
    const ethUsdPrice = ethPriceResult.status === 'fulfilled' ? ethPriceResult.value : (row ? row.last_eth_usd_price : null);
    const sameMonthLive = row && row.month === currentMonth;
    const currentRune = highWaterMark(rawRune, sameMonthLive ? row.last_balance_rune : null, sameMonthLive);
    const currentUsdc = highWaterMark(rawUsdc, sameMonthLive ? row.last_balance_usdc : null, sameMonthLive);
    const currentEth = highWaterMark(rawEth, sameMonthLive ? row.last_balance_eth : null, sameMonthLive);

    if (!row || row.month !== currentMonth) {
      await env.DB.prepare(
        `INSERT INTO donation_tracking (id, month, baseline_rune, baseline_usdc, baseline_eth, last_balance_rune, last_balance_usdc, last_balance_eth, last_eth_usd_price, last_balance_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET month = excluded.month, baseline_rune = excluded.baseline_rune, baseline_usdc = excluded.baseline_usdc, baseline_eth = excluded.baseline_eth, last_balance_rune = excluded.last_balance_rune, last_balance_usdc = excluded.last_balance_usdc, last_balance_eth = excluded.last_balance_eth, last_eth_usd_price = excluded.last_eth_usd_price, last_balance_at = excluded.last_balance_at, updated_at = excluded.updated_at`
      ).bind(currentMonth, currentRune ?? 0, currentUsdc ?? 0, currentEth ?? 0, currentRune, currentUsdc, currentEth, ethUsdPrice, Date.now(), Date.now()).run();
      return json({ receivedRune: 0, receivedUsdc: 0, receivedEthUsd: 0, month: currentMonth }, env);
    }

    await env.DB.prepare(
      `UPDATE donation_tracking SET last_balance_rune = ?, last_balance_usdc = ?, last_balance_eth = ?, last_eth_usd_price = ?, last_balance_at = ? WHERE id = 1`
    ).bind(currentRune, currentUsdc, currentEth, ethUsdPrice, Date.now()).run();

    const receivedRune = currentRune != null ? Math.max(0, currentRune - row.baseline_rune) : 0;
    const receivedUsdc = currentUsdc != null ? Math.max(0, currentUsdc - (row.baseline_usdc || 0)) : 0;
    const receivedEth = currentEth != null ? Math.max(0, currentEth - (row.baseline_eth || 0)) : 0;
    const receivedEthUsd = ethUsdPrice != null ? receivedEth * ethUsdPrice : 0;
    return json({ receivedRune, receivedUsdc, receivedEthUsd, month: currentMonth }, env);
  } catch (e) {
    console.warn('[rune-rewards-backend] /donation-progress fehlgeschlagen:', e?.message || String(e));
    return json({ receivedRune: null, receivedUsdc: null, receivedEthUsd: null, month: currentMonth }, env);
  }
}

function utcDayString(ms) {
  return new Date(ms).toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function getStatsExcludedAddresses(env) {
  const raw = (env && env.STATS_EXCLUDED_ADDRESSES) || '';
  return new Set(
    raw.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean)
  );
}

function recordSyncActivity(env, ctx, address) {
  if (!env.DB || !ctx || typeof ctx.waitUntil !== 'function') return;
  if (getStatsExcludedAddresses(env).has(String(address || '').toLowerCase())) return;
  const now = Date.now();
  const day = utcDayString(now);

  const dedupTask = env.DB
    .prepare('INSERT OR IGNORE INTO sync_activity_days (address, day, first_seen_at) VALUES (?, ?, ?)')
    .bind(address, day, now)
    .run()
    .catch((e) => {
      console.error('[rune-rewards-backend] recordSyncActivity (dedup) failed:', e && e.message || e);
    });

  const countTask = env.DB
    .prepare(
      `INSERT INTO sync_activity_counts (address, day, count) VALUES (?, ?, 1)
       ON CONFLICT(address, day) DO UPDATE SET count = count + 1`
    )
    .bind(address, day)
    .run()
    .catch((e) => {
      console.error('[rune-rewards-backend] recordSyncActivity (count) failed:', e && e.message || e);
    });

  ctx.waitUntil(Promise.all([dedupTask, countTask]));
}

const MAX_PURCHASES_PAYLOAD_BYTES = 2_000_000; // Sicherheitsnetz gegen versehentlich riesige Payloads

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
  recordSyncActivity(env, ctx, address);

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
    const incomingSettings = sanitizeSettings(body.settings);

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

    const existingRow = await env.DB
      .prepare('SELECT data, settings FROM user_purchases WHERE address = ?')
      .bind(address)
      .first();
    let existing = [];
    if (existingRow && existingRow.data) {
      try { existing = JSON.parse(existingRow.data); } catch (e) { existing = []; }
    }
    let existingSettings = null;
    if (existingRow && existingRow.settings) {
      try { existingSettings = sanitizeSettings(JSON.parse(existingRow.settings)); } catch (e) { existingSettings = null; }
    }
    const finalSettings = incomingSettings || existingSettings;

    const merged = [...existing];
    for (const row of incoming) {
      if (!row || !Number.isFinite(row.amount) || !Number.isFinite(row.priceUsd)) continue;
      if (row.id && deletedIds.has(row.id)) continue;
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

const MAX_WALLETS_PAYLOAD_BYTES = 200_000; // eine reine Adressliste bleibt immer winzig -- großzügiges Sicherheitsnetz

async function handleWallets(request, env, ctx) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address');
  if (!isValidThorAddress(address)) {
    return json({ error: 'INVALID_ADDRESS' }, env, 400);
  }
  recordSyncActivity(env, ctx, address);

  if (request.method === 'GET') {
    const row = await env.DB
      .prepare('SELECT wallets, updated_at FROM user_wallet_lists WHERE address = ?')
      .bind(address)
      .first();
    let wallets = [];
    if (row && row.wallets) {
      try { wallets = JSON.parse(row.wallets); } catch (e) { wallets = []; }
    }
    const deletedRows = await env.DB
      .prepare('SELECT deleted_wallet FROM user_wallet_lists_deleted WHERE address = ?')
      .bind(address)
      .all();
    const deletedAddrs = new Set((deletedRows.results || []).map((r) => r.deleted_wallet));
    if (deletedAddrs.size) wallets = wallets.filter((w) => !deletedAddrs.has(w));
    return json({
      address,
      wallets,
      deletedAddrs: [...deletedAddrs],
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
    const incoming = Array.isArray(body.wallets) ? body.wallets.filter((w) => typeof w === 'string' && w.trim()) : null;
    if (!incoming) {
      return json({ error: 'INVALID_WALLETS' }, env, 400);
    }
    const newlyDeleted = Array.isArray(body.deletedAddrs) ? body.deletedAddrs.filter((w) => typeof w === 'string' && w.trim()) : [];

    if (newlyDeleted.length) {
      const now0 = Date.now();
      const stmt = env.DB.prepare(
        'INSERT OR IGNORE INTO user_wallet_lists_deleted (address, deleted_wallet, deleted_at) VALUES (?, ?, ?)'
      );
      await env.DB.batch(newlyDeleted.map((w) => stmt.bind(address, w, now0)));
    }

    const deletedRows = await env.DB
      .prepare('SELECT deleted_wallet FROM user_wallet_lists_deleted WHERE address = ?')
      .bind(address)
      .all();
    const deletedAddrs = new Set((deletedRows.results || []).map((r) => r.deleted_wallet));

    const existingRow = await env.DB
      .prepare('SELECT wallets FROM user_wallet_lists WHERE address = ?')
      .bind(address)
      .first();
    let existing = [];
    if (existingRow && existingRow.wallets) {
      try { existing = JSON.parse(existingRow.wallets); } catch (e) { existing = []; }
    }

    const merged = [...new Set([...existing, ...incoming])].filter((w) => !deletedAddrs.has(w));

    const serialized = JSON.stringify(merged);
    if (serialized.length > MAX_WALLETS_PAYLOAD_BYTES) {
      return json({ error: 'TOO_LARGE' }, env, 413);
    }
    const now = Date.now();
    await env.DB
      .prepare(
        `INSERT INTO user_wallet_lists (address, wallets, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           wallets = excluded.wallets,
           updated_at = excluded.updated_at`
      )
      .bind(address, serialized, now)
      .run();
    return json({ address, updatedAt: now, wallets: merged, deletedAddrs: [...deletedAddrs] }, env);
  }

  return json({ error: 'METHOD_NOT_ALLOWED' }, env, 405);
}

const MAX_DRAWINGS_PAYLOAD_BYTES = 500_000; // Zeichnungen sind kleine Objekte, aber grosszügig bemessen für viele Linien

async function handleDrawings(request, env, ctx) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address');
  const chart = url.searchParams.get('chart');
  if (!isValidThorAddress(address)) {
    return json({ error: 'INVALID_ADDRESS' }, env, 400);
  }
  if (!chart || typeof chart !== 'string' || chart.length > 200) {
    return json({ error: 'INVALID_CHART' }, env, 400);
  }
  recordSyncActivity(env, ctx, address);

  if (request.method === 'GET') {
    const row = await env.DB
      .prepare('SELECT h_lines, t_lines, fib_lines, updated_at FROM user_chart_drawings WHERE address = ? AND chart = ?')
      .bind(address, chart)
      .first();
    let hLines = [], tLines = [], fibLines = [];
    if (row) {
      try { hLines = row.h_lines ? JSON.parse(row.h_lines) : []; } catch (e) { hLines = []; }
      try { tLines = row.t_lines ? JSON.parse(row.t_lines) : []; } catch (e) { tLines = []; }
      try { fibLines = row.fib_lines ? JSON.parse(row.fib_lines) : []; } catch (e) { fibLines = []; }
    }
    const deletedRows = await env.DB
      .prepare('SELECT deleted_id FROM user_chart_drawings_deleted WHERE address = ? AND chart = ?')
      .bind(address, chart)
      .all();
    const deletedIds = new Set((deletedRows.results || []).map((r) => r.deleted_id));
    if (deletedIds.size) {
      hLines = hLines.filter((l) => !l.id || !deletedIds.has(l.id));
      tLines = tLines.filter((l) => !l.id || !deletedIds.has(l.id));
      fibLines = fibLines.filter((l) => !l.id || !deletedIds.has(l.id));
    }
    return json({
      address,
      chart,
      hLines,
      tLines,
      fibLines,
      deletedIds: [...deletedIds],
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
    const incomingH = Array.isArray(body.hLines) ? body.hLines : null;
    const incomingT = Array.isArray(body.tLines) ? body.tLines : null;
    const incomingF = Array.isArray(body.fibLines) ? body.fibLines : null;
    if (!incomingH || !incomingT || !incomingF) {
      return json({ error: 'INVALID_DRAWINGS' }, env, 400);
    }
    const newlyDeleted = Array.isArray(body.deletedIds) ? body.deletedIds.filter((d) => typeof d === 'string' && d.trim()) : [];

    if (newlyDeleted.length) {
      const now0 = Date.now();
      const stmt = env.DB.prepare(
        'INSERT OR IGNORE INTO user_chart_drawings_deleted (address, chart, deleted_id, deleted_at) VALUES (?, ?, ?, ?)'
      );
      await env.DB.batch(newlyDeleted.map((d) => stmt.bind(address, chart, d, now0)));
    }

    const deletedRows = await env.DB
      .prepare('SELECT deleted_id FROM user_chart_drawings_deleted WHERE address = ? AND chart = ?')
      .bind(address, chart)
      .all();
    const deletedIds = new Set((deletedRows.results || []).map((r) => r.deleted_id));

    const existingRow = await env.DB
      .prepare('SELECT h_lines, t_lines, fib_lines FROM user_chart_drawings WHERE address = ? AND chart = ?')
      .bind(address, chart)
      .first();
    const mergeById = (existing, incoming) => {
      const byId = new Map();
      for (const item of existing) if (item && item.id && !deletedIds.has(item.id)) byId.set(item.id, item);
      for (const item of incoming) if (item && item.id && !deletedIds.has(item.id)) byId.set(item.id, item);
      return [...byId.values()];
    };
    let existingH = [], existingT = [], existingF = [];
    if (existingRow) {
      try { existingH = existingRow.h_lines ? JSON.parse(existingRow.h_lines) : []; } catch (e) { existingH = []; }
      try { existingT = existingRow.t_lines ? JSON.parse(existingRow.t_lines) : []; } catch (e) { existingT = []; }
      try { existingF = existingRow.fib_lines ? JSON.parse(existingRow.fib_lines) : []; } catch (e) { existingF = []; }
    }
    const mergedH = mergeById(existingH, incomingH);
    const mergedT = mergeById(existingT, incomingT);
    const mergedF = mergeById(existingF, incomingF);

    const serializedH = JSON.stringify(mergedH);
    const serializedT = JSON.stringify(mergedT);
    const serializedF = JSON.stringify(mergedF);
    if (serializedH.length + serializedT.length + serializedF.length > MAX_DRAWINGS_PAYLOAD_BYTES) {
      return json({ error: 'TOO_LARGE' }, env, 413);
    }
    const now = Date.now();
    await env.DB
      .prepare(
        `INSERT INTO user_chart_drawings (address, chart, h_lines, t_lines, fib_lines, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(address, chart) DO UPDATE SET
           h_lines = excluded.h_lines,
           t_lines = excluded.t_lines,
           fib_lines = excluded.fib_lines,
           updated_at = excluded.updated_at`
      )
      .bind(address, chart, serializedH, serializedT, serializedF, now)
      .run();
    return json({ address, chart, updatedAt: now, hLines: mergedH, tLines: mergedT, fibLines: mergedF, deletedIds: [...deletedIds] }, env);
  }

  return json({ error: 'METHOD_NOT_ALLOWED' }, env, 405);
}

const MAX_SWAP_HISTORY_PAYLOAD_BYTES = 200_000; // kleine Objekte, aber grosszügig bemessen

async function handleSwapHistory(request, env, ctx) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address');
  if (!isValidThorAddress(address)) {
    return json({ error: 'INVALID_ADDRESS' }, env, 400);
  }
  recordSyncActivity(env, ctx, address);

  if (request.method === 'GET') {
    const rows = await env.DB
      .prepare('SELECT swap_id, from_asset, to_asset, amount, destination, track_status, in_tx_id, out_tx_id, resolved_at, registered_at FROM user_swap_history WHERE address = ? ORDER BY COALESCE(resolved_at, registered_at) DESC LIMIT 50')
      .bind(address)
      .all();
    return json({
      address,
      swaps: (rows.results || []).map((r) => ({
        id: r.swap_id,
        fromAsset: r.from_asset,
        toAsset: r.to_asset,
        amount: r.amount,
        destination: r.destination,
        trackStatus: r.track_status,
        trackInTxId: r.in_tx_id,
        trackOutTxId: r.out_tx_id,
        resolvedAtMs: r.resolved_at,
        registeredAtMs: r.registered_at,
      })),
    }, env);
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'INVALID_BODY' }, env, 400);
    }
    const raw = JSON.stringify(body || {});
    if (raw.length > MAX_SWAP_HISTORY_PAYLOAD_BYTES) {
      return json({ error: 'PAYLOAD_TOO_LARGE' }, env, 413);
    }
    const incoming = Array.isArray(body.swaps) ? body.swaps : [];
    const valid = incoming.filter((s) => s && typeof s.id === 'string' && s.id.trim() && s.trackStatus === 'success');
    if (valid.length) {
      const stmt = env.DB.prepare(
        `INSERT OR IGNORE INTO user_swap_history
         (address, swap_id, from_asset, to_asset, amount, destination, track_status, in_tx_id, out_tx_id, resolved_at, registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      await env.DB.batch(valid.map((s) => stmt.bind(
        address,
        s.id,
        s.fromAsset || null,
        s.toAsset || null,
        s.amount != null ? String(s.amount) : null,
        s.destination || null,
        s.trackStatus,
        s.trackInTxId || null,
        s.trackOutTxId || null,
        Number.isFinite(s.resolvedAtMs) ? s.resolvedAtMs : null,
        Number.isFinite(s.registeredAtMs) ? s.registeredAtMs : null
      )));
    }
    return json({ address, saved: valid.length }, env);
  }

  return json({ error: 'METHOD_NOT_ALLOWED' }, env, 405);
}

async function handleStats(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.STATS_ACCESS_KEY || key !== env.STATS_ACCESS_KEY) {
    return json({ error: 'UNAUTHORIZED' }, env, 401);
  }

  const now = Date.now();
  const day1 = utcDayString(now);
  const day7 = utcDayString(now - 7 * 24 * 60 * 60 * 1000);
  const day30 = utcDayString(now - 30 * 24 * 60 * 60 * 1000);

  const [totalRow, active1Row, active7Row, active30Row, depthRow, totalRequests1Row, totalRequests7Row, totalRequests30Row] = await Promise.all([
    env.DB.prepare('SELECT COUNT(DISTINCT address) AS n FROM sync_activity_days').first(),
    env.DB.prepare('SELECT COUNT(DISTINCT address) AS n FROM sync_activity_days WHERE day >= ?').bind(day1).first(),
    env.DB.prepare('SELECT COUNT(DISTINCT address) AS n FROM sync_activity_days WHERE day >= ?').bind(day7).first(),
    env.DB.prepare('SELECT COUNT(DISTINCT address) AS n FROM sync_activity_days WHERE day >= ?').bind(day30).first(),
    // NEU (auf Wunsch: "wie viel Prozent war an 3/10/30 verschiedenen Tagen da"): EINE Abfrage,
    // die pro Adresse zählt, an wie vielen VERSCHIEDENEN Tagen sie in den letzten 30 Tagen
    // aktiv war, und daraus direkt in SQL die Schwellenwert-Kästchen (>=2/3/10/30) zusammenzählt
    // -- effizienter als 4 einzelne HAVING-Unterabfragen, da die Gruppierung nur einmal läuft.
    env.DB.prepare(
      `SELECT
         COUNT(*) AS n2,
         SUM(CASE WHEN d >= 3 THEN 1 ELSE 0 END) AS n3,
         SUM(CASE WHEN d >= 10 THEN 1 ELSE 0 END) AS n10,
         SUM(CASE WHEN d >= 30 THEN 1 ELSE 0 END) AS n30
       FROM (
         SELECT address, COUNT(DISTINCT day) AS d FROM sync_activity_days
         WHERE day >= ?
         GROUP BY address
         HAVING d >= 2
       )`
    ).bind(day30).first(),
    env.DB.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM sync_activity_counts WHERE day >= ?').bind(day1).first()
      .catch((e) => {
        console.warn('[rune-rewards-backend] sync_activity_counts (1d) nicht lesbar:', e?.message || String(e));
        return { n: 0 };
      }),
    env.DB.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM sync_activity_counts WHERE day >= ?').bind(day7).first()
      .catch((e) => {
        console.warn('[rune-rewards-backend] sync_activity_counts (7d) nicht lesbar:', e?.message || String(e));
        return { n: 0 };
      }),
    env.DB.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM sync_activity_counts WHERE day >= ?').bind(day30).first()
      .catch((e) => {
        console.warn('[rune-rewards-backend] sync_activity_counts (30d) nicht lesbar:', e?.message || String(e));
        return { n: 0 };
      }),
  ]);

  const active1 = active1Row?.n || 0;
  const active7 = active7Row?.n || 0;
  const active30 = active30Row?.n || 0;
  const returning30 = depthRow?.n2 || 0; // >=2 Tage (bisheriges "Wiederkehrer"-Kriterium, unverändert)
  const returning3d = depthRow?.n3 || 0; // >=3 Tage
  const returning10d = depthRow?.n10 || 0; // >=10 Tage
  const returning30d = depthRow?.n30 || 0; // an JEDEM der letzten 30 Tage (Maximum)
  const totalRequests1 = totalRequests1Row?.n || 0;
  const totalRequests7 = totalRequests7Row?.n || 0;
  const totalRequests30 = totalRequests30Row?.n || 0;

  const pctOf = (n) => active30 > 0 ? Math.round((n / active30) * 1000) / 10 : null;

  const stats = {
    totalUniqueAddressesEver: totalRow?.n || 0,
    activeLast1d: active1,
    activeLast7d: active7,
    activeLast30d: active30,
    returningLast30d: returning30,
    retentionRate30d: pctOf(returning30),
    // NEU: Nutzungstiefe -- wie viel Prozent der in den letzten 30 Tagen aktiven Adressen waren
    // an mindestens X verschiedenen Tagen aktiv. Jede Stufe ist eine TEILMENGE der vorherigen
    // (wer an >=10 Tagen aktiv war, war zwangsläufig auch an >=3 Tagen aktiv).
    engagementDepth: [
      { minDays: 2, count: returning30, pct: pctOf(returning30) },
      { minDays: 3, count: returning3d, pct: pctOf(returning3d) },
      { minDays: 10, count: returning10d, pct: pctOf(returning10d) },
      { minDays: 30, count: returning30d, pct: pctOf(returning30d) },
    ],
    totalRequestsLast1d: totalRequests1,
    totalRequestsLast7d: totalRequests7,
    totalRequestsLast30d: totalRequests30,
  };

  const wantsHtml = (request.headers.get('Accept') || '').includes('text/html');
  if (!wantsHtml) {
    return json(stats, env);
  }

  const tile = (key, label, value, hint) => `
    <div class="tile">
      <div class="tile-value" id="v-${key}">${value == null ? '—' : value}</div>
      <div class="tile-label">${label}</div>
      ${hint ? `<div class="tile-hint">${hint}</div>` : ''}
    </div>`;

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>rune.watch — Stats</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 48px;
    background: #0b0f14; color: #e7ecf0;
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
  }
  h1 {
    font-size: 15px; font-weight: 600; letter-spacing: 0.02em;
    color: #8fa3b0; text-transform: uppercase; margin: 0 0 4px;
  }
  .subtitle { font-size: 12.5px; color: #5f7480; margin-bottom: 22px; }
  .grid {
    display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;
    max-width: 480px;
  }
  .tile {
    background: linear-gradient(165deg, #131a22 0%, #0e141b 100%);
    border: 1px solid #1f2b35; border-radius: 14px; padding: 16px 14px;
  }
  .tile-value {
    font-size: 28px; font-weight: 700; font-family: 'Space Grotesk', -apple-system, sans-serif;
    color: #2dd4bf; line-height: 1.1;
    transition: opacity 0.15s ease;
  }
  .tile-label { font-size: 12px; color: #93a5b1; margin-top: 6px; }
  .tile-hint { font-size: 10.5px; color: #52646f; margin-top: 3px; }
  .tile.wide { grid-column: 1 / -1; }
  .tile-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .tile-select {
    background: #0e141b; color: #93a5b1; border: 1px solid #1f2b35; border-radius: 6px;
    font-size: 10.5px; font-weight: 600; padding: 3px 6px; font-family: inherit;
    cursor: pointer;
  }
  .tile-select:focus { outline: 1px solid #2dd4bf; }
  .refresh {
    margin-top: 22px; font-size: 11.5px; color: #4c5c66;
    display: flex; align-items: center; gap: 6px;
  }
  .dot {
    width: 6px; height: 6px; border-radius: 50%; background: #2dd4bf; flex-shrink: 0;
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .depth-row {
    display: grid; grid-template-columns: 56px 1fr 42px 40px; align-items: center; gap: 8px;
    margin-bottom: 8px; font-size: 12px;
  }
  .depth-label { color: #93a5b1; }
  .depth-bar-track {
    height: 8px; border-radius: 4px; background: #1a232c; overflow: hidden;
  }
  .depth-bar-fill {
    height: 100%; border-radius: 4px; background: #2dd4bf;
    transition: width 0.2s ease;
  }
  .depth-pct { color: #e7ecf0; font-weight: 600; text-align: right; }
  .depth-count { color: #52646f; font-size: 10.5px; }
</style>
</head>
<body>
  <h1>rune.watch — Sync-Aktivität</h1>
  <div class="subtitle">Adressbasiert, geräteübergreifend (nicht Cloudflare "Visits")</div>
  <div class="grid">
    <div class="tile">
      <div class="tile-head">
        <div class="tile-label" style="margin-top:0">Aktive Adressen</div>
        <select class="tile-select" id="sel-active">
          <option value="1d">24h</option>
          <option value="7d">7 Tage</option>
          <option value="30d" selected>30 Tage</option>
        </select>
      </div>
      <div class="tile-value" id="v-active">${stats.activeLast30d}</div>
    </div>
    <div class="tile">
      <div class="tile-head">
        <div class="tile-label" style="margin-top:0">Requests gesamt</div>
        <select class="tile-select" id="sel-requests">
          <option value="1d">24h</option>
          <option value="7d">7 Tage</option>
          <option value="30d" selected>30 Tage</option>
        </select>
      </div>
      <div class="tile-value" id="v-requests">${stats.totalRequestsLast30d}</div>
      <div class="tile-hint">alle Sync-Aufrufe, nicht Tage-dedupliziert</div>
    </div>
    ${tile('total', 'Adressen insgesamt', stats.totalUniqueAddressesEver, 'seit Einführung des Trackings')}
    ${tile('returning', 'Wiederkehrer – 30 Tage', stats.returningLast30d, '≥2 verschiedene Tage synchronisiert')}
    ${tile('rate', 'Retention-Quote', stats.retentionRate30d == null ? '—' : stats.retentionRate30d + '%', 'Anteil Wiederkehrer an aktiven Adressen (30T)')}
    ${tile('avgreq', 'Ø Requests je aktiver Adresse', stats.activeLast30d > 0 ? Math.round((stats.totalRequestsLast30d / stats.activeLast30d) * 10) / 10 : '—', 'für denselben Zeitraum wie "Requests gesamt"')}
    <div class="tile wide">
      <div class="tile-label" style="margin-top:0; margin-bottom:12px;">Nutzungstiefe (letzte 30 Tage)</div>
      ${stats.engagementDepth.map(row => `
        <div class="depth-row">
          <div class="depth-label">≥ ${row.minDays} Tage</div>
          <div class="depth-bar-track">
            <div class="depth-bar-fill" id="v-depth-bar-${row.minDays}" style="width:${row.pct == null ? 0 : row.pct}%"></div>
          </div>
          <div class="depth-pct" id="v-depth-pct-${row.minDays}">${row.pct == null ? '—' : row.pct + '%'}</div>
          <div class="depth-count" id="v-depth-count-${row.minDays}">(${row.count})</div>
        </div>`).join('')}
      <div class="tile-hint" style="margin-top:8px;">Anteil der in den letzten 30 Tagen aktiven Adressen (<span id="v-depth-base">${stats.activeLast30d}</span>), die an mindestens X verschiedenen Tagen synchronisiert haben. Jede Stufe ist in der vorherigen enthalten.</div>
    </div>
  </div>
  <div class="refresh"><span class="dot"></span><span id="stamp">Stand: ${new Date().toLocaleString('de-DE', { timeZone: 'UTC' })} UTC · aktualisiert live</span></div>
<script>
  const REFRESH_MS = 1000;
  let latestStats = null;

  function renderSelected() {
    if (!latestStats) return;
    const activePeriod = document.getElementById('sel-active').value;
    const requestsPeriod = document.getElementById('sel-requests').value;
    const activeMap = { '1d': latestStats.activeLast1d, '7d': latestStats.activeLast7d, '30d': latestStats.activeLast30d };
    const requestsMap = { '1d': latestStats.totalRequestsLast1d, '7d': latestStats.totalRequestsLast7d, '30d': latestStats.totalRequestsLast30d };
    const activeVal = activeMap[activePeriod];
    const requestsVal = requestsMap[requestsPeriod];
    const activeForAvg = activeMap[requestsPeriod];
    const avgVal = activeForAvg > 0 ? Math.round((requestsVal / activeForAvg) * 10) / 10 : null;

    setText('v-active', activeVal);
    setText('v-requests', requestsVal);
    setText('v-total', latestStats.totalUniqueAddressesEver);
    setText('v-returning', latestStats.returningLast30d);
    setText('v-rate', latestStats.retentionRate30d == null ? '—' : latestStats.retentionRate30d + '%');
    setText('v-avgreq', avgVal == null ? '—' : avgVal);
    setText('v-depth-base', latestStats.activeLast30d);
    (latestStats.engagementDepth || []).forEach(row => {
      const bar = document.getElementById('v-depth-bar-' + row.minDays);
      if (bar) bar.style.width = (row.pct == null ? 0 : row.pct) + '%';
      setText('v-depth-pct-' + row.minDays, row.pct == null ? '—' : row.pct + '%');
      setText('v-depth-count-' + row.minDays, '(' + row.count + ')');
    });
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el && el.textContent !== String(val)) el.textContent = val == null ? '—' : val;
  }

  async function refreshStats() {
    try {
      const res = await fetch(location.href, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) return;
      latestStats = await res.json();
      renderSelected();
      document.getElementById('stamp').textContent =
        'Stand: ' + new Date().toLocaleTimeString('de-DE', { timeZone: 'UTC' }) + ' UTC · aktualisiert live';
    } catch (e) { /* nächster Tick versucht es erneut, kein Grund für eine Fehlermeldung */ }
  }
  document.getElementById('sel-active').addEventListener('change', renderSelected);
  document.getElementById('sel-requests').addEventListener('change', renderSelected);
  setInterval(refreshStats, REFRESH_MS);
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store', ...corsHeaders(env) },
  });
}

const MEMOLESS_UPSTREAM = 'https://api.thorchain.org/memoless/api/v1';
const MEMOLESS_ALLOWED_PATHS = new Set(['assets', 'register', 'preflight']);

async function handleMemoless(request, env) {
  const url = new URL(request.url);
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
    return new Response(text, {
      status: res.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...corsHeaders(env),
      },
    });
  } catch (e) {
    const code = e?.name === 'AbortError' ? 'MEMOLESS_TIMEOUT' : 'MEMOLESS_UPSTREAM_FAILED';
    return json({ error: { code, message: e?.message || String(e) } }, env, 502);
  }
}

export default {
  async fetch(request, env, ctx) {
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
      if (url.pathname === '/donation-progress') {
        return await handleDonationProgress(request, env, ctx);
      }
      if (url.pathname === '/volume') {
        return await handleVolume(request, env, ctx);
      }
      if (url.pathname === '/recent-swaps') {
        return await handleRecentSwaps(request, env, ctx);
      }
      if (url.pathname === '/top-pairs') {
        return await handleTopPairs(request, env);
      }
      if (url.pathname === '/purchases') {
        return await handlePurchases(request, env, ctx);
      }
      if (url.pathname === '/wallets') {
        return await handleWallets(request, env, ctx);
      }
      if (url.pathname === '/drawings') {
        return await handleDrawings(request, env, ctx);
      }
      if (url.pathname === '/swap-history') {
        return await handleSwapHistory(request, env, ctx);
      }
      if (url.pathname === '/stats') {
        return await handleStats(request, env);
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
  const seenNodeAddresses = new Set();
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

  await env.DB
    .prepare('UPDATE tracked_addresses SET status = ? WHERE bond_address = ?')
    .bind('building', address)
    .run();

  for (let i = 0; i < missing.length; i += HEIGHT_BATCH_SIZE) {
    const batch = missing.slice(i, i + HEIGHT_BATCH_SIZE);
    await Promise.all(batch.map(async (churn) => {
      const queryHeight = churn.height - 1;
      let rewardAmount = 0;
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
        return;
      }

      if (!hasProviderData) {
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
