// rune-rewards-backend — kompakte Fassung ohne Kommentare (Code identisch zu worker.js)
// VORHER: migration.sql in der D1-Console ausführen.
//
// NEU in dieser Fassung: /thornode-timeline (vierte Seite "Entwicklung").
// VORHER AUSSERDEM einmalig in der D1-Console ausführen:
//
//   CREATE TABLE IF NOT EXISTS thornode_timeline_cache (
//     id INTEGER PRIMARY KEY,
//     payload TEXT NOT NULL,
//     updated_at INTEGER NOT NULL
//   );

let currentEnv = null;

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

// MIDGARD-QUELLEN.
//
// Gemeldet: "warum wird nicht auf nativeswap zurueckgegriffen?" -- weil nativeswap nur fuer
// THORNODE eingetragen war (siehe getThornodeBases), fuer Midgard aber ueberhaupt keine
// zweite Quelle existierte. Faellt Liquify mit 429 aus, bricht alles weg, was ueber Midgard
// laeuft: Bond-Verlauf, Swap-Aktionen, Churns, Volumen.
//
// Warum hier trotzdem keine feste Zweitadresse steht: Ein oeffentliches nativeswap-Midgard
// habe ich nicht gefunden, und die frueheren Standardadressen (Nine Realms,
// thorchain.network) gelten inzwischen als tot -- SwapKit hat sie deshalb durch Liquify
// ersetzt. Eine geratene URL wuerde nur jede Anfrage um einen Fehlversuch verlaengern.
//
// Stattdessen erweiterbar:
//   LIQUIFY_MIDGARD_BASE   -- die Adresse mit API-Schluessel (hoeheres Limit), falls vorhanden
//   MIDGARD_EXTRA_BASES    -- kommagetrennte Ersatzadressen, ohne Code-Aenderung nachtragbar
// Beide sind Worker-Variablen; ohne sie bleibt es bei der bisherigen einen Quelle.
function getMidgardBases() {
  const env = currentEnv || {};
  const key = env.LIQUIFY_API_KEY;
  const bases = [];
  if (env.LIQUIFY_MIDGARD_BASE) {
    // Ausdruecklich gesetzt -> gewinnt, keine Ratereien.
    bases.push(String(env.LIQUIFY_MIDGARD_BASE).replace(/\/+$/, ''));
  } else if (key) {
    // DER EIGENTLICHE FEHLER: Der Liquify-Schluessel wurde nur fuer THORNODE benutzt
    // (getThornodeBases setzt `api=KEY` an erste Stelle). Midgard lief immer ueber die
    // OEFFENTLICHE Adresse -- deshalb "Liquify funktioniert doch": tut es, aber nur dort,
    // wo der Schluessel greift. Die 429 kamen vom ungeschluesselten Endpunkt.
    //
    // Das genaue Pfadformat des Schluessel-Endpunkts fuer Midgard kenne ich nicht, deshalb
    // stehen hier zwei KANDIDATEN. Der hedged Abruf nimmt den ersten, der antwortet; ein
    // falscher Pfad gibt sofort 404 und kostet kaum Zeit. Sobald klar ist, welcher stimmt,
    // gehoert er als LIQUIFY_MIDGARD_BASE gesetzt -- dann faellt das Raten weg.
    bases.push(`https://gateway.liquify.com/api=${key}/chain/thorchain_midgard/v2`);
    bases.push(`https://gateway.liquify.com/api=${key}/v2`);
  }
  bases.push('https://gateway.liquify.com/chain/thorchain_midgard/v2');
  // KEIN ERSATZ VORHANDEN -- bewusst so belassen, damit hier niemand (auch ich nicht) wieder
  // tote Adressen eintraegt: ninerealms wurde im April 2026 abgeschaltet, thorchain.network
  // ist tot, midgard.thorchain.info existiert nicht, midgard.thorswap.net gibt 502. Liquify
  // ist damit faktisch die einzige grosse oeffentliche Midgard-Instanz und ein einzelner
  // Ausfallpunkt (gemeldet, als sie mit inSync:false und vier Tage altem lastThorNode keine
  // Kurse mehr lieferte). Faellt sie aus, zeigt die Karte einen Strich und nennt die Quelle,
  // statt zu schaetzen. Eine eigene Instanz braucht Archiv-Node samt TimescaleDB.
  // Eine neue Adresse gehoert per Variable MIDGARD_EXTRA_BASES ergaenzt, nicht hier fest
  // eingetragen -- erst pruefen: /v2/health muss inSync true und einen aktuellen
  // lastThorNode melden.
  if (env.MIDGARD_EXTRA_BASES) {
    for (const b of String(env.MIDGARD_EXTRA_BASES).split(',')) {
      const t2 = b.trim().replace(/\/+$/, '');
      if (t2) bases.push(t2);
    }
  }
  return bases;
}

async function fetchWithTimeout(url, { timeoutMs = 10000, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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

let nodesCache = null; 
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

function fetchNodesAtHeight(height) {
  return fetchFromBases(getThornodeBases({ needsHeight: true }), `/thorchain/nodes?height=${height}`);
}

function fetchNodeAtHeight(nodeAddress, height) {
  return fetchFromBases(getThornodeBases({ needsHeight: true }), `/thorchain/node/${nodeAddress}?height=${height}`);
}

function fetchChurns() {
  return fetchFromBases(getMidgardBases(), '/churns');
}

function fetchBalance(address) {
  return fetchFromBases(getThornodeBases(), `/cosmos/bank/v1beta1/balances/${address}`);
}

async function fetchMidgardActionsPage(address, txType, offset) {
  return fetchFromBases(getMidgardBases(), `/actions?address=${address}&type=${txType}&limit=50&offset=${offset}`);
}

function fetchVolumeInterval(interval, count) {
  return fetchFromBases(getMidgardBases(), `/history/swaps?interval=${interval}&count=${count}`);
}

let volumeCache = null; 
const VOLUME_CACHE_MS = 5000;

// Rohe Tagesintervalle von vanaheimex (Midgard-Format, eigene laufende Instanz).
async function fetchVanaheimexSwapIntervals() {
  try {
    const json = await fetchFromBases(['https://vanaheimex.com'], '/api/dashboardPlots', { timeoutMs: 9000 });
    const iv = (json && json.swaps && json.swaps.intervals) || [];
    return Array.isArray(iv) && iv.length ? iv : null;
  } catch (e) {
    return null;
  }
}

// VANAHEIMEX IST FUEHREND (Entscheidung: "Liquify ist mir unzuverlaessig geworden").
// Jeder Tag, den vanaheimex mit Werten liefert, kommt von dort. Midgard (Liquify) fuellt nur
// noch Tage, die bei vanaheimex fehlen oder leer sind -- und springt ganz ein, wenn vanaheimex
// ausfaellt (siehe den Fall !vana unten).
//
// SCHLUESSEL IST startTime, NICHT endTime (gemeldet: "der aktuelle Balken fehlt"). Beim
// laufenden Tag setzt Midgard endTime auf Mitternacht, vanaheimex auf JETZT -- ueber endTime
// verglichen landeten beide Eintraege nebeneinander in der Reihe, der leere von Midgard als
// letzter. Genau der wurde dann als letzter Balken gezeichnet: null.
function mischeTagesreihe(midgard, vana) {
  if (!vana || !vana.length) return midgard ? { ...midgard, quelle: 'midgard' } : midgard;
  if (!midgard || !midgard.intervals || !midgard.intervals.length) return { intervals: vana, meta: (midgard && midgard.meta) || null, quelle: 'vanaheimex' };
  const hatWert = (iv) => Number(iv && iv.totalCount) > 0 || Number(iv && iv.totalVolumeUSD) > 0;
  const nachStart = new Map();
  // Erst vanaheimex eintragen, dann Midgard nur dort, wo vanaheimex nichts hat.
  for (const iv of vana) if (hatWert(iv)) nachStart.set(String(iv.startTime), iv);
  for (const iv of midgard.intervals) {
    const vorhanden = nachStart.get(String(iv.startTime));
    if (!vorhanden) nachStart.set(String(iv.startTime), iv);
  }
  const zusammen = [...nachStart.values()].sort((a, b) => Number(a.startTime) - Number(b.startTime));
  return { ...midgard, intervals: zusammen, quelle: 'vanaheimex' };
}

function fetchVolumeBundleLive() {
  if (volumeCache && Date.now() - volumeCache.atMs < VOLUME_CACHE_MS) {
    return volumeCache.promise;
  }
  const promise = (async () => {
    // Dritte Anfrage: dieselbe Tagesreihe von vanaheimex, aus der thorchain.net seine Balken
    // zeichnet. Sie dient hier zweierlei (gemeldet: "ich will den heutigen Tag sehen"):
    //   1. Tage, die Liquify gar nicht oder leer liefert, werden daraus ergaenzt.
    //   2. Der LAUFENDE Tag kommt ueberhaupt erst dadurch in die Reihe -- Midgard liefert ihn
    //      nicht, solange dessen Tagesaggregation haengt.
    const [hourResult, dayResult, vanaResult, rollierendResult] = await Promise.allSettled([
      fetchVolumeInterval('hour', 24),
      fetchVolumeInterval('day', 30),
      fetchVanaheimexSwapIntervals(),
      // Rollierende 24 Stunden, exakt die Zahl, die thorchain.net oben anzeigt
      // (stats.volume24USD, dort ebenfalls durch 100 geteilt).
      fetchVanaheimex24h(),
    ]);
    const tage = dayResult.status === 'fulfilled' ? dayResult.value : null;
    const vana = vanaResult.status === 'fulfilled' ? vanaResult.value : null;
    return {
      hour: hourResult.status === 'fulfilled' ? hourResult.value : null,
      hourError: hourResult.status === 'rejected' ? (hourResult.reason?.message || String(hourResult.reason)) : null,
      day: mischeTagesreihe(tage, vana),
      dayError: dayResult.status === 'rejected' ? (dayResult.reason?.message || String(dayResult.reason)) : null,
      rolling24Usd: rollierendResult.status === 'fulfilled' ? rollierendResult.value : null,
    };
  })();
  promise.catch(() => {
    if (volumeCache && volumeCache.promise === promise) volumeCache = null;
  });
  volumeCache = { promise, atMs: Date.now() };
  return promise;
}

const VOLUME_STALE_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

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
  
  try {
    const _u = new URL(request.url);
    recordVisitor(env, ctx, _u.searchParams.get('v'), _u.searchParams.get('w') === '1');
  } catch (e) {  }
  const result = await fetchVolumeBundle(env, ctx);
  // Der rollierende 24h-Wert ist eine Momentaufnahme -- er wird bei jeder Anfrage frisch
  // geholt, damit die Kopfzahl nicht aus dem Zwischenspeicher veraltet.
  let rolling24Usd = result.data && result.data.rolling24Usd;
  if (rolling24Usd == null) {
    try { rolling24Usd = await fetchVanaheimex24h(); } catch (e) { rolling24Usd = null; }
  }
  return json({ ...result.data, rolling24Usd, stale: result.stale, staleSince: result.staleSince || null }, env);
}

function fetchRecentSwapActions() {
  return fetchFromBases(getMidgardBases(), '/actions?type=swap&limit=10', {
    timeoutMs: 12000
  });
}

let recentSwapsCache = null; 
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

async function mitVerlauf(data, env) {
  try {
    const snap = await readRecentSwapsSnapshot(env);
    if (!snap) return data;
    return {
      ...data,
      knownActiveNodes: Array.isArray(snap.knownActiveNodes) ? snap.knownActiveNodes : [],
      jailEvents: Array.isArray(snap.jailEvents) ? snap.jailEvents : [],
      nodeHistorySince: snap.nodeHistorySince || null,
      nodeHistorySeeded: !!snap.nodeHistorySeeded,
      historyPending: Number(snap.historyPending) || 0,
      nodeHistoryHeights: Number(snap.nodeHistoryHeights) || 0,
      churnAttempts: Array.isArray(snap.churnAttempts) ? snap.churnAttempts : [],
      
      churnTargetHeight: Number(snap.churnTargetHeight) || 0,
      lastChurnHeight: Number(snap.lastChurnHeight) || 0,
    };
  } catch (e) {
    
    return data;
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
      return json(await mitVerlauf(data, env), env);
    } catch (e) {
      console.warn('[rune-rewards-backend] /recent-swaps fehlgeschlagen (beide Quellen):', e?.message || String(e));
      return json(await mitVerlauf({ actions: [] }, env), env);
    }
  }

  try {
    const data = await fetchRecentSwapActionsCached();
    return json(await mitVerlauf(data, env), env);
  } catch (e) {
    console.warn('[rune-rewards-backend] /recent-swaps fehlgeschlagen (beide Quellen):', e?.message || String(e));
    return json(await mitVerlauf({ actions: [] }, env), env);
  }
}

const SWAP_COLLECT_PAGES = 1;

async function collectSwapPairStats(env) {
  
  let firstPageActions = null;

  for (let page = 0; page < SWAP_COLLECT_PAGES; page++) {
    let data;
    try {
      data = await fetchFromBases(getMidgardBases(), `/actions?type=swap&limit=50&offset=${page * 50}`, {
        timeoutMs: 12000,
      });
    } catch (e) {
      console.warn('[rune-rewards-backend] Swap-Paar-Sammlung fehlgeschlagen (Seite', page, '):', e?.message || String(e));
      break;
    }
    const actions = (data && Array.isArray(data.actions)) ? data.actions : [];
    if (page === 0) firstPageActions = actions;
    if (!actions.length) break;

    break;
  }

  if (firstPageActions && firstPageActions.length) {
    try {
      
      let bestehend = {};
      try {
        const alt2 = await env.DB.prepare('SELECT payload FROM recent_swaps_snapshot WHERE id = 1').first();
        bestehend = alt2 && alt2.payload ? JSON.parse(alt2.payload) : {};
      } catch (e) { bestehend = {}; }
      
      delete bestehend.bigSwaps;

      await env.DB.prepare(
        `INSERT INTO recent_swaps_snapshot (id, payload, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).bind(JSON.stringify({ ...bestehend, actions: firstPageActions.slice(0, 20) }), Date.now()).run();
    } catch (e) {
      console.warn('[rune-rewards-backend] Momentaufnahme-Schreiben fehlgeschlagen (Migration ausgeführt?):', e?.message || String(e));
    }
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

  const REFRESH_COOLDOWN_MS = 2 * 1000;
  const recentlyRefreshed = trackedRow.last_refreshed_at && (now - trackedRow.last_refreshed_at) < REFRESH_COOLDOWN_MS;
  const alreadyInProgress = trackedRow.status === 'building';

  let churnFehlt = false;
  if (trackedRow.status === 'done' && !recentlyRefreshed) {
    try {
      const letzteZeile = await env.DB
        .prepare('SELECT MAX(churn_height) AS h FROM bond_history_rows WHERE bond_address = ?')
        .bind(address).first();
      const letzterChurn = await env.DB
        .prepare('SELECT MAX(height) AS h FROM churns_cache').first();
      churnFehlt = !!(letzterChurn?.h && (!letzteZeile?.h || letzterChurn.h > letzteZeile.h));
    } catch (e) {  }
  }

  if ((trackedRow.status !== 'done' || churnFehlt) && !recentlyRefreshed && !alreadyInProgress) {
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

const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

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
      let myYield = null;
      for (const p of providers) {
        const pBond = Number(p?.bond) || 0;
        nodeTotalBondBase += pBond;
        if (p?.bond_address === address) {
          totalBondBase += pBond;
          myBondInNodeBase = pBond;
          // Bond Yield (ADR 029): gespeicherte Einstellung des Providers mitliefern. Feldnamen sind
          // in der THORNode-API noch nicht dokumentiert -- deshalb tolerant nach Schluesseln suchen.
          myYield = null;
          for (const [k, v] of Object.entries(p || {})) {
            if (/yield/i.test(k) && /bps|basis/i.test(k) && v != null && v !== '') { myYield = myYield || {}; myYield.bps = Number(v); }
            else if (/payout|yield.*(target|addr)|target/i.test(k) && v) { myYield = myYield || {}; myYield.target = String(v); }
            else if (/yield/i.test(k) && v && typeof v === 'object') {
              const b = v.bps ?? v.basis_points ?? v.yield_bps; const t = v.target ?? v.payout_target ?? v.address;
              myYield = myYield || {}; if (b != null) myYield.bps = Number(b); if (t) myYield.target = String(t);
            }
          }
        }
      }
      if (myBondInNodeBase > 0 && nodeTotalBondBase > 0) {
        const feeBps = Number(node?.bond_providers?.node_operator_fee) || 0;
        const fee = feeBps / 10000;
        const currentAwardBase = Number(node?.current_award) || 0;
        accruedAwardBase += (myBondInNodeBase / nodeTotalBondBase) * currentAwardBase * (1 - fee);
        if (node?.node_address) {
          matchedNodeAddresses.push(node.node_address);
          nodeBreakdown.push({ nodeAddress: node.node_address, status: node.status || null, bonded: myBondInNodeBase / 1e8, ...(myYield ? { bondYield: myYield } : {}) });
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
  return new Date(ms).toISOString().slice(0, 7); 
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
  const pool = await fetchFromBases(getMidgardBases(), '/pool/ETH.ETH');
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

    const gleich = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-8);
    const unveraendert = gleich(currentRune, row.last_balance_rune)
      && gleich(currentUsdc, row.last_balance_usdc)
      && gleich(currentEth, row.last_balance_eth)
      && gleich(ethUsdPrice, row.last_eth_usd_price);
    const letzterSchreibvorgang = Number(row.last_balance_at) || 0;
    if (!unveraendert || Date.now() - letzterSchreibvorgang > 3600000) {
      await env.DB.prepare(
        `UPDATE donation_tracking SET last_balance_rune = ?, last_balance_usdc = ?, last_balance_eth = ?, last_eth_usd_price = ?, last_balance_at = ? WHERE id = 1`
      ).bind(currentRune, currentUsdc, currentEth, ethUsdPrice, Date.now()).run();
    }

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
  return new Date(ms).toISOString().slice(0, 10); 
}

function getStatsExcludedAddresses(env) {
  const raw = (env && env.STATS_EXCLUDED_ADDRESSES) || '';
  return new Set(
    raw.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean)
  );
}

// ANONYME BESUCHER-ZAEHLUNG (FIX 34a).
//
// Warum es sie gibt: recordSyncActivity weiter unten zaehlt ausschliesslich Nutzer MIT
// eingetragener Wallet -- nur die rufen /purchases, /wallets, /drawings, /swap-history
// ueberhaupt auf. Wer nur Chart, Node-Karte oder Swap benutzt, taucht dort nie auf.
//
// /volume ruft dagegen jeder Besucher auf. Die App haengt dort ein Token an, das ihr Browser
// selbst erzeugt hat -- eine Zufallszahl im localStorage. Keine IP, kein Fingerprint, keine
// Verknuepfung mit einer Wallet, kein Cookie. Fuer niemanden ausser dem Browser selbst deutbar.
//
// Kosten: EIN Schreibvorgang je Geraet und Tag (INSERT OR IGNORE). Auch bei einem Nutzer, der
// die Seite hundertmal am Tag oeffnet, bleibt es bei genau einer Zeile.
const VISITOR_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ANTEIL GERAETE MIT WALLET: zusaetzlich ein Ja/Nein (has_wallet), ob auf dem Geraet eine
// Wallet eingetragen ist -- nie welche. Die Spalte wird nur von 0 auf 1 gehoben (einmal je
// Geraet und Tag), es bleibt also bei hoechstens zwei Schreibvorgaengen je Geraet und Tag.
// Fehlt die Spalte noch (Migration nicht ausgefuehrt), faellt es auf die alte Zaehlung zurueck.
function recordVisitor(env, ctx, token, hasWallet) {
  if (!env.DB || !ctx || typeof ctx.waitUntil !== 'function') return;
  if (!token || !VISITOR_TOKEN_RE.test(token)) return;
  const now = Date.now();
  const day = utcDayString(now);
  const alt = () => env.DB
    .prepare('INSERT OR IGNORE INTO visitor_days (token, day, first_seen_at) VALUES (?, ?, ?)')
    .bind(token, day, now)
    .run();
  ctx.waitUntil(
    env.DB
      .prepare(
        `INSERT INTO visitor_days (token, day, first_seen_at, has_wallet) VALUES (?, ?, ?, ?)
         ON CONFLICT(token, day) DO UPDATE SET has_wallet = 1
         WHERE excluded.has_wallet = 1 AND visitor_days.has_wallet = 0`
      )
      .bind(token, day, now, hasWallet ? 1 : 0)
      .run()
      .catch((e) => {
        console.warn('[rune-rewards-backend] recordVisitor: has_wallet fehlt (Migration 2?), alte Zaehlung:', e?.message || String(e));
        return alt();
      })
      .catch((e) => {
        console.warn('[rune-rewards-backend] recordVisitor fehlgeschlagen (Migration ausgeführt?):', e?.message || String(e));
      })
  );
}

// AKTIV/PASSIV: Die App haengt ?a=1 (Nutzer hat in den letzten 5 Minuten bei sichtbarer Seite
// etwas getan) bzw. ?a=0 (Tab offen im Hintergrund, Timer) an. Fehlt der Parameter (alte App),
// wird nur wie bisher gezaehlt. Tabelle sync_activity_art: je Adresse und Tag aktive/passive
// Aufrufe -- daraus "aktive Tage" fuer echte Power-User.
let syncArtTabelleOk = false;
function recordSyncActivity(env, ctx, address, request = null) {
  if (!env.DB || !ctx || typeof ctx.waitUntil !== 'function') return;
  if (getStatsExcludedAddresses(env).has(String(address || '').toLowerCase())) return;
  const now = Date.now();
  const day = utcDayString(now);
  let art = null;
  try { const a = request ? new URL(request.url).searchParams.get('a') : null; if (a === '1') art = 'aktiv'; else if (a === '0') art = 'passiv'; } catch (e) {}
  if (art) {
    ctx.waitUntil((async () => {
      try {
        if (!syncArtTabelleOk) { await env.DB.prepare('CREATE TABLE IF NOT EXISTS sync_activity_art (address TEXT, day TEXT, aktiv INTEGER DEFAULT 0, passiv INTEGER DEFAULT 0, PRIMARY KEY (address, day))').run(); syncArtTabelleOk = true; }
        await env.DB.prepare(`INSERT INTO sync_activity_art (address, day, aktiv, passiv) VALUES (?, ?, ?, ?)
          ON CONFLICT(address, day) DO UPDATE SET aktiv = aktiv + excluded.aktiv, passiv = passiv + excluded.passiv`)
          .bind(address, day, art === 'aktiv' ? 1 : 0, art === 'passiv' ? 1 : 0).run();
      } catch (e) { console.warn('[rune-rewards-backend] sync_activity_art:', e?.message || e); }
    })());
  }

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

const MAX_PURCHASES_PAYLOAD_BYTES = 2_000_000;

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
  recordSyncActivity(env, ctx, address, request);

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

const MAX_WALLETS_PAYLOAD_BYTES = 200_000;

async function handleWallets(request, env, ctx) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address');
  if (!isValidThorAddress(address)) {
    return json({ error: 'INVALID_ADDRESS' }, env, 400);
  }
  recordSyncActivity(env, ctx, address, request);

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
    // WIEDER HINZUGEFUEGT (restoredAddrs): aus der Loeschliste nehmen -- sonst verschwand eine frueher
    // entfernte Wallet beim erneuten Eintragen sofort wieder.
    const restored = Array.isArray(body.restoredAddrs) ? body.restoredAddrs.filter((w) => typeof w === 'string' && w.trim()) : [];
    // WIEDERHERSTELLUNG MIT ZEITSTEMPEL (gemeldet: "die Adresse, wo ich nicht bonde, springt nach
    // einer Zeit raus"): Ein ANDERES Geraet (z. B. Safari vs. Home-Bildschirm-Icon, die getrennt
    // speichern) schickte seine alte Loeschmarke immer wieder mit und loeschte die gerade neu
    // eingetragene Adresse erneut. Jetzt merkt sich der Server, WANN eine Adresse wieder
    // hinzugefuegt wurde, und nimmt eine Loeschung nur noch an, wenn sie NACHWEISLICH spaeter
    // passiert ist (deletedAt vom Geraet). Alte Loeschmarken ohne Zeit loeschen nichts mehr.
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS user_wallet_lists_restored (address TEXT, wallet TEXT, restored_at INTEGER, PRIMARY KEY (address, wallet))').run();
    if (restored.length) {
      const del = env.DB.prepare('DELETE FROM user_wallet_lists_deleted WHERE address = ? AND deleted_wallet = ?');
      const rest = env.DB.prepare('INSERT OR REPLACE INTO user_wallet_lists_restored (address, wallet, restored_at) VALUES (?, ?, ?)');
      const nowR = Date.now();
      await env.DB.batch([...restored.map((w) => del.bind(address, w)), ...restored.map((w) => rest.bind(address, w, nowR))]);
    }
    const restoredRows = ((await env.DB.prepare('SELECT wallet, restored_at FROM user_wallet_lists_restored WHERE address = ?').bind(address).all()).results) || [];
    const restoredAt = new Map(restoredRows.map((r) => [r.wallet, Number(r.restored_at) || 0]));
    const deletedAt = body.deletedAt && typeof body.deletedAt === 'object' ? body.deletedAt : {};
    const incomingSet = new Set(Array.isArray(body.wallets) ? body.wallets : []);
    const newlyDeletedOhne = newlyDeleted.filter((w) => {
      if (restored.includes(w) || incomingSet.has(w)) return false;          // gleichzeitig vorhanden -> nicht loeschen
      const r = restoredAt.get(w);
      if (r == null) return true;                                             // nie wiederhergestellt -> wie bisher
      return (Number(deletedAt[w]) || 0) > r;                                 // nur eine spaetere echte Loeschung zaehlt
    });
    const wiederGeloescht = newlyDeletedOhne.filter((w) => restoredAt.has(w));
    if (wiederGeloescht.length) {
      const delR = env.DB.prepare('DELETE FROM user_wallet_lists_restored WHERE address = ? AND wallet = ?');
      await env.DB.batch(wiederGeloescht.map((w) => delR.bind(address, w)));
    }

    if (newlyDeletedOhne.length) {
      const now0 = Date.now();
      const stmt = env.DB.prepare(
        'INSERT OR IGNORE INTO user_wallet_lists_deleted (address, deleted_wallet, deleted_at) VALUES (?, ?, ?)'
      );
      await env.DB.batch(newlyDeletedOhne.map((w) => stmt.bind(address, w, now0)));
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

const MAX_DRAWINGS_PAYLOAD_BYTES = 500_000;

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
  recordSyncActivity(env, ctx, address, request);

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

const MAX_SWAP_HISTORY_PAYLOAD_BYTES = 200_000;

async function handleSwapHistory(request, env, ctx) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address');
  if (!isValidThorAddress(address)) {
    return json({ error: 'INVALID_ADDRESS' }, env, 400);
  }
  recordSyncActivity(env, ctx, address, request);

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

// RUNEBOND-EINTRAEGE.
//
// RUNEBond ist die Vermittlungsstelle zwischen Bond Providern und Node-Betreibern. Wer dort
// gelistet ist, nimmt ausdruecklich Bond Provider an -- genau die Information fehlt in
// /thorchain/nodes. Die Liste kommt aus deren oeffentlicher API (/api/nodes, Felder laut
// ihrem npm-Client @hippocampus-web3/runebond-client).
//
// UEBER DEN WORKER, nicht aus dem Browser: einmal je 10 Minuten geholt und hier
// zwischengespeichert, damit ihre API nicht von jedem Besucher einzeln getroffen wird.
// Die Basisadresse steht in RUNEBOND_API_BASE (Variable), falls sie sich aendert.
// Mehrere Kandidaten, der Reihe nach: welche Adresse ihre oeffentliche API bedient, steht
// nirgends. Ihr npm-Client (@hippocampus-web3/runebond-client) kennt nur die PFADE (/api/nodes),
// die Basis wird beim Aufruf gesetzt. Antwortet eine, wird sie fuer diesen Lauf gemerkt.
// Mit gesetzter Variable RUNEBOND_API_BASE faellt das Raten weg.
const RUNEBOND_API_BASES = [
  'https://api.runebond.com',
  'https://app.runebond.com',
  'https://runebond.com',
  'https://integrators.runebond.com',
];
const RUNEBOND_CACHE_MS = 10 * 60 * 1000;
let runebondCache = { at: 0, data: null };
// Letzte Liste MIT Eintraegen. Faellt ein spaeterer Abruf aus, wird sie weiter ausgeliefert
// (mit "stale": true) statt einer leeren Liste -- sonst verschwand die Karte in der App.
let runebondLetzteGute = null;


// RUNEBOND-EINTRAEGE DIREKT VON DER CHAIN (ohne API-Schluessel).
// Laut RUNEBond-Doku ("List your node") laeuft das Listen KOMPLETT on-chain: der Betreiber schickt
// mind. 0,1 RUNE an thor1xazgmh7sv0p393t9ntj6q9p52ahycc8jjlaap9 mit dem Memo
//   TB:V2:LIST:<node>:<min>:<total-bond-target>:<fee>      (min/target in 1e8, fee: 100 = 1 %)
//   TB:LIST:<node>:<operator>:<min>:<max>:<fee>            (altes Format, weiter gueltig)
//   TB:DELIST:<node>
// Wir lesen diese Sendungen ueber Midgard (/actions?address=...&type=send), werten sie in
// zeitlicher Reihenfolge aus (die letzte Meldung je Node gilt) und nehmen nur Meldungen, die
// vom BETREIBER der Node kamen (Abgleich mit /thorchain/nodes) -- sonst koennte jeder fremde
// Nodes listen. Die Provider-Zahl kommt ebenfalls von der Chain.
const RUNEBOND_LIST_ADDR = 'thor1xazgmh7sv0p393t9ntj6q9p52ahycc8jjlaap9';
// MEMOS ZWISCHENSPEICHERN (gemeldet: Liste leer mit "HTTP_429" von Liquify-Midgard). Bisher
// wurden ALLE Listing-Memos bei jedem Abruf neu gelesen -- 1200 Memos = 24 Midgard-Anfragen
// hintereinander, alle 10 Minuten und in jeder Worker-Instanz. Das loeste die Ratenbremse aus.
// Jetzt: einmal komplett lesen, danach nur noch die neuesten Seiten, bis ein schon bekanntes
// Memo auftaucht (meist 1 Anfrage). Bei 429 einmal kurz warten und wiederholen.
let runebondMemos = { liste: [], ids: new Set() };
async function runebondSeite(seite) {
  const pfad = `/actions?address=${RUNEBOND_LIST_ADDR}&type=send&limit=50&offset=${seite * 50}`;
  try { return await fetchFromBases(getMidgardBases(), pfad); }
  catch (e) {
    if (!/429/.test(String(e && e.message || e))) throw e;
    await new Promise(r => setTimeout(r, 1500));
    return fetchFromBases(getMidgardBases(), pfad);
  }
}
async function runebondVonDerChain() {
  const schluessel = a => String(((a.in || [])[0] || {}).txID || '') + '|' + String(a.height || '') + '|' + String(a.date || '');
  const neu = [];
  const vollLesen = !runebondMemos.liste.length;
  for (let seite = 0; seite < 80; seite++) {
    const j = await runebondSeite(seite);
    const a = Array.isArray(j && j.actions) ? j.actions : [];
    let bekannt = false;
    for (const x of a) { if (runebondMemos.ids.has(schluessel(x))) { bekannt = true; } else neu.push(x); }
    if (a.length < 50) break;
    if (!vollLesen && bekannt) break; // Anschluss an den Bestand gefunden
  }
  for (const x of neu) { runebondMemos.ids.add(schluessel(x)); runebondMemos.liste.push(x); }
  const aktionen = runebondMemos.liste.slice();
  const nodes = await fetchNodes();
  const nachAddr = new Map((Array.isArray(nodes) ? nodes : []).map(n => [String(n.node_address).toLowerCase(), n]));
  const zahl = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const rune = v => { const x = zahl(v); return x == null ? null : x >= 1e6 ? x / 1e8 : x; }; // Basis-Einheiten erkennen
  const stand = new Map();
  aktionen.sort((x, y) => Number(x.height) - Number(y.height) || String(x.date).localeCompare(String(y.date)));
  for (const a of aktionen) {
    const memo = String((a.metadata && a.metadata.send && a.metadata.send.memo) || a.memo || '').trim();
    if (!/^TB:/i.test(memo)) continue;
    const von = String(((a.in || [])[0] || {}).address || '').toLowerCase();
    const t = memo.split(':');
    let node = null, eintrag = null, weg = false;
    if (/^TB:V2:LIST:/i.test(memo) && t.length >= 7) {
      node = t[3].toLowerCase();
      eintrag = { minRune: rune(t[4]), target: rune(t[5]), maxRune: null, fee: zahl(t[6]) != null ? zahl(t[6]) / 100 : null };
    } else if (/^TB:LIST:/i.test(memo) && t.length >= 7) {
      node = t[2].toLowerCase();
      const f = zahl(t[6]);
      eintrag = { minRune: rune(t[4]), target: rune(t[5]), maxRune: null, fee: f == null ? null : f > 100 ? f / 100 : f };
    } else if (/^TB:DELIST:/i.test(memo) && t.length >= 3) {
      node = t[2].toLowerCase(); weg = true;
    } else continue;
    const n = nachAddr.get(node);
    if (!n || String(n.node_operator_address || '').toLowerCase() !== von) continue; // nur der Betreiber
    if (weg) { stand.delete(node); continue; }
    stand.set(node, { ...eintrag, seit: a.date ? Math.round(Number(a.date) / 1e6) : null, txId: ((a.in || [])[0] || {}).txID || null });
  }
  const listings = [];
  for (const [addr, e] of stand) {
    const n = nachAddr.get(addr);
    const prov = (n && n.bond_providers && n.bond_providers.providers) || [];
    listings.push({ addr, name: null, minRune: e.minRune, maxRune: e.maxRune, fee: e.fee, providers: prov.length || null,
      target: e.target, status: n ? String(n.status || '') : null, yieldGuard: false, maxTimeToLeave: null, listedAt: e.seit, source: 'chain' });
  }
  return { listings, gelesen: aktionen.length };
}

async function handleRunebondNodes(request, env, ctx) {
  const jetzt = Date.now();
  if (runebondCache.data && jetzt - runebondCache.at < RUNEBOND_CACHE_MS) {
    return json(runebondCache.data, env);
  }
  const kandidaten = (env && env.RUNEBOND_API_BASE)
    ? [String(env.RUNEBOND_API_BASE).replace(/\/+$/, '')]
    : RUNEBOND_API_BASES;
  const kopf = { accept: 'application/json' };
  // Optionaler Schluessel fuer die Integrators-API (integrators.runebond.com verlangt einen).
  if (env && env.RUNEBOND_API_KEY) kopf['x-api-key'] = String(env.RUNEBOND_API_KEY);
  try {
    let roh = null, letzterFehler = null, basisGenutzt = null;
    for (const basis of kandidaten) {
      try {
        const res = await fetchWithTimeout(`${basis}/api/nodes?limit=200`, { timeoutMs: 6000, headers: kopf });
        if (!res.ok) { letzterFehler = new Error(basis + ' HTTP_' + res.status); continue; }
        const j = await res.json();
        const hatDaten = Array.isArray(j) ? j.length : Array.isArray(j?.data) ? j.data.length : 0;
        if (!hatDaten) { letzterFehler = new Error(basis + ' LEER'); continue; }
        roh = j; basisGenutzt = basis; break;
      } catch (e) { letzterFehler = e; }
    }
    if (!roh) {
      // Ohne erreichbare API: dieselben Eintraege direkt aus den Listing-Memos auf der Chain.
      const c = await runebondVonDerChain();
      if (!c.listings.length) throw letzterFehler || new Error('KEINE_QUELLE');
      const daten = { listings: c.listings, fetchedAt: jetzt, base: 'chain (' + c.gelesen + ' Memos)', error: null, apiFehler: letzterFehler ? String(letzterFehler.message || letzterFehler) : null };
      runebondCache = { at: jetzt, data: daten };
      runebondLetzteGute = daten;
      return json(daten, env);
    }
    // Antwort ist {data: [...]} oder direkt ein Array -- beides zulassen.
    const liste = Array.isArray(roh) ? roh : (Array.isArray(roh?.data) ? roh.data : []);
    // Felder laut @hippocampus-web3/runebond-client (NodeListingDto). Ausgeblendete Eintraege
    // (isHidden.hide) zeigt RUNEBond selbst nicht an -- dann hier auch nicht.
    const eintraege = liste
      .filter((e) => e && e.nodeAddress && !e.isDelisted && !(e.isHidden && e.isHidden.hide))
      .map((e) => ({
        addr: String(e.nodeAddress).toLowerCase(),
        name: e.name || null,
        minRune: Number(e.minRune) || null,
        maxRune: Number(e.maxRune) || null,
        fee: Number.isFinite(Number(e.feePercentage)) ? Number(e.feePercentage) : null,
        providers: Number.isFinite(Number(e.bondProvidersCount)) ? Number(e.bondProvidersCount) : null,
        // Ziel-Bond des Betreibers (RUNE) -- mit dem aktuellen Bond ergibt das den freien Platz
        target: Number(e.targetTotalBond) > 0 ? Number(e.targetTotalBond) : null,
        status: e.status ? String(e.status) : null,
        yieldGuard: !!(e.isYieldGuarded && e.isYieldGuarded.hide),
        maxTimeToLeave: Number(e.maxTimeToLeave) > 0 ? Number(e.maxTimeToLeave) : null,
      }));
    // "base" steht mit in der Antwort -- so ist beim Nachsehen sofort klar, welche Adresse
    // tatsaechlich geantwortet hat.
    const daten = { listings: eintraege, fetchedAt: jetzt, base: basisGenutzt, error: null };
    runebondCache = { at: jetzt, data: daten };
    if (eintraege.length) runebondLetzteGute = daten;
    return json(daten, env);
  } catch (e) {
    // Faellt weich aus: die Node-Karte zeigt dann einfach keine Markierungen.
    const fehler = String(e?.message || e);
    // Gibt es eine fruehere gute Liste, die ausliefern (hoechstens 6 h alt) -- nur als veraltet
    // markiert. In 2 Minuten wird es erneut versucht.
    const daten = runebondLetzteGute && jetzt - runebondLetzteGute.fetchedAt < 6 * 3600 * 1000
      ? { ...runebondLetzteGute, stale: true, error: fehler }
      : { listings: [], fetchedAt: jetzt, error: fehler };
    runebondCache = { at: jetzt - (RUNEBOND_CACHE_MS - 120000), data: daten };
    return json(daten, env);
  }
}

// EIGENE ADRESSE? -- gibt NUR ein Ja/Nein zurueck.
//
// Die App fragt das, um die Spenden- und Bonding-Banner bei den eigenen Adressen des Betreibers
// zu unterdruecken. Welche Adressen das sind, steht in STATS_EXCLUDED_ADDRESSES (dieselbe
// Liste, die schon aus der Besucherstatistik ausgenommen ist) und verlaesst den Worker nicht.
async function handleIsOwner(request, env) {
  const url = new URL(request.url);
  const address = String(url.searchParams.get('address') || '').trim().toLowerCase();
  if (!address) return json({ owner: false }, env);
  return json({ owner: getStatsExcludedAddresses(env).has(address) }, env);
}

// AUSGEHENDE KLICKS (z.B. auf die RUNEBond-Empfehlung).
//
// Gezaehlt wird, WIE OFT und von WIE VIELEN Geraeten geklickt wurde -- mehr nicht. Kein Ziel
// ausserhalb der Liste unten, keine Adresse, kein Verweis auf eine Wallet. Das Geraet ist
// derselbe anonyme Zufallswert wie bei der Besucherzaehlung (siehe recordVisitor).
//
// Braucht einmalig:
//   CREATE TABLE IF NOT EXISTS outbound_clicks (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     target TEXT NOT NULL, token TEXT, day TEXT NOT NULL, at INTEGER NOT NULL);
//   CREATE INDEX IF NOT EXISTS idx_outbound_clicks_day ON outbound_clicks(day);
// Stand dieser Datei -- steht unten auf der Statistikseite, damit man sieht, ob der Deploy
// wirklich live ist.
const WORKER_VERSION = '2026-10-28-1600';
const CLICK_TARGETS = new Set(['runebond']);
const CLICK_QUELLEN = new Set(['banner', 'node', 'liste', 'karte']);
let klickSpalteGeprueft = false;

async function handleClick(request, env, ctx) {
  const url = new URL(request.url);
  const target = String(url.searchParams.get('t') || '').toLowerCase();
  // Antwort immer 204, auch bei unbekanntem Ziel: der Klick des Nutzers soll nie an einer
  // Fehlermeldung haengen bleiben, das Ziel oeffnet ja parallel.
  if (!CLICK_TARGETS.has(target) || !env.DB) return new Response(null, { status: 204 });
  const token = url.searchParams.get('v');
  const now = Date.now();
  const sauber = token && VISITOR_TOKEN_RE.test(token) ? token : null;
  // HERKUNFT des Klicks (banner / node / liste / karte) -- nur feste Werte, alles andere leer.
  const qRoh = String(url.searchParams.get('q') || '').toLowerCase();
  const quelle = CLICK_QUELLEN.has(qRoh) ? qRoh : null;
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil((async () => {
      // Spalte "quelle" legt der Worker beim ersten Mal selbst an (SQLite kennt kein
      // "ADD COLUMN IF NOT EXISTS" -- existiert sie schon, schlaegt das still fehl).
      if (!klickSpalteGeprueft) {
        klickSpalteGeprueft = true;
        await env.DB.prepare('ALTER TABLE outbound_clicks ADD COLUMN quelle TEXT').run().catch(() => {});
      }
      await env.DB.prepare('INSERT INTO outbound_clicks (target, token, day, at, quelle) VALUES (?, ?, ?, ?, ?)')
        .bind(target, sauber, utcDayString(now), now, quelle).run()
        .catch(() => env.DB.prepare('INSERT INTO outbound_clicks (target, token, day, at) VALUES (?, ?, ?, ?)')
          .bind(target, sauber, utcDayString(now), now).run())
        .catch((e) => console.warn('[rune-rewards-backend] Klick nicht gezaehlt (Migration 3?):', e?.message || String(e)));
    })());
  }
  return new Response(null, { status: 204 });
}

// ============================================================================================
// MARKTGROESSE (gewuenscht: "wie viele Wallets und User gibt es bei THORChain -- wie viel Potenzial
// hat rune.watch?"). Zaehlt ADRESSEN (keine Personen): Bonder (exakt, aus der Node-Liste),
// Node-Betreiber, TCY-/bRUNE-/ybRUNE-/RUNE-Halter (Besitzerlisten, mit Zeitlimit -> ggf. Untergrenze),
// RUNEPool-Anbieter, gestakte TCY -- und wie viele davon schon in rune.watch eingetragen sind.
// Ergebnis 12 h zwischengespeichert; ?neu=1 rechnet neu. Nur mit Statistik-Schluessel.
// ============================================================================================
async function handleMarkt(request, env) {
  const url = new URL(request.url);
  if (!env.STATS_ACCESS_KEY || url.searchParams.get('key') !== env.STATS_ACCESS_KEY) return json({ error: 'FORBIDDEN' }, env, 403);
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS markt_cache (k TEXT PRIMARY KEY, v TEXT, at INTEGER)').run();
  if (url.searchParams.get('neu') !== '1') {
    const c = await env.DB.prepare('SELECT v, at FROM markt_cache WHERE k = ?').bind('markt').first().catch(() => null);
    if (c && Date.now() - c.at < 12 * 3600e3) return marktAntwort(JSON.parse(c.v), url, env);
  }
  const t0 = Date.now(), BUDGET = 25000;
  const zeitUebrig = () => BUDGET - (Date.now() - t0);
  const E8 = 1e8;
  const erg = { stand: new Date().toISOString(), hinweis: 'Gezaehlt werden Adressen, nicht Personen.' };

  // 1) Nodes: Bonder + Betreiber (exakt)
  const nodes = await fetchFromBases(getThornodeBases(), '/thorchain/nodes').catch(() => null);
  const bonder = new Map(), betreiber = new Set();
  let aktiv = 0;
  for (const n of (Array.isArray(nodes) ? nodes : [])) {
    if (n.status === 'Active') aktiv++;
    if (n.node_operator_address) betreiber.add(String(n.node_operator_address).toLowerCase());
    for (const pr of ((n.bond_providers && n.bond_providers.providers) || [])) {
      const a = String(pr.bond_address || '').toLowerCase(); if (!a) continue;
      bonder.set(a, (bonder.get(a) || 0) + Number(pr.bond || 0) / E8);
    }
  }
  const klassen = { 'unter 1.000': 0, '1.000-10.000': 0, '10.000-100.000': 0, 'ueber 100.000': 0 };
  let bondSumme = 0;
  for (const v of bonder.values()) { bondSumme += v; if (v < 1000) klassen['unter 1.000']++; else if (v < 10000) klassen['1.000-10.000']++; else if (v < 100000) klassen['10.000-100.000']++; else klassen['ueber 100.000']++; }
  erg.nodes = { gesamt: Array.isArray(nodes) ? nodes.length : null, aktiv, betreiber: betreiber.size };
  erg.bonder = { adressen: bonder.size, mitBondUeber0: [...bonder.values()].filter(v => v > 0).length, bondRUNE: Math.round(bondSumme), nachGroesse: klassen };

  // 2) Besitzerlisten (mit Zeitlimit)
  const zaehleDenom = async (denom, minEinheiten, maxSeiten) => {
    let key = null, n = 0, ueber = 0, seiten = 0, total = null, vollstaendig = false;
    while (seiten < maxSeiten && zeitUebrig() > 3000) {
      const q = `/cosmos/bank/v1beta1/denom_owners/${encodeURIComponent(denom)}?pagination.limit=1000${seiten === 0 ? '&pagination.count_total=true' : ''}${key ? '&pagination.key=' + encodeURIComponent(key) : ''}`;
      const j = await fetchFromBases(getThornodeBases(), q).catch(() => null);
      if (!j) break;
      if (seiten === 0 && j.pagination && j.pagination.total != null) total = Number(j.pagination.total) || null;
      const liste = j.denom_owners || [];
      for (const o of liste) { n++; if (Number(o.balance && o.balance.amount) >= minEinheiten) ueber++; }
      seiten++;
      key = j.pagination && j.pagination.next_key;
      if (!key) { vollstaendig = true; break; }
    }
    return { adressenGesamt: total != null ? total : n, gezaehlt: n, abMindestmenge: ueber, mindestmenge: minEinheiten / E8, vollstaendig };
  };
  erg.tcyHalter = await zaehleDenom('tcy', 1 * E8, 30).catch(() => null);
  erg.bruneHalter = await zaehleDenom('x/brune', 1 * E8, 5).catch(() => null);
  erg.ybruneHalter = await zaehleDenom('x/staking-x/brune', 1 * E8, 5).catch(() => null);
  try {
    const st = await fetchFromBases(getThornodeBases(), '/thorchain/tcy_stakers').catch(() => null);
    const liste = (st && (st.tcy_stakers || st)) || [];
    erg.tcyGestakt = Array.isArray(liste) ? { adressen: liste.filter(x => Number(x.amount || 0) > 0).length } : null;
  } catch (e) { erg.tcyGestakt = null; }
  try {
    const rp = await fetchFromBases(getThornodeBases(), '/thorchain/rune_providers').catch(() => null);
    erg.runePool = Array.isArray(rp) ? { adressen: rp.filter(x => Number(x.units || x.deposit_amount || 0) > 0).length } : null;
  } catch (e) { erg.runePool = null; }
  // RUNE zuletzt (groesste Liste), nur Konten ab 10 RUNE zaehlen als "Halter"
  erg.runeHalter = await zaehleDenom('rune', 10 * E8, 200).catch(() => null);

  // 3) rune.watch: eingetragene Wallets (alle Wallet-Listen) und Ueberschneidung mit den Bondern
  const rw = new Set();
  try {
    const rows = await env.DB.prepare('SELECT wallets FROM user_wallet_lists').all();
    for (const r of (rows.results || [])) {
      let w = []; try { w = JSON.parse(r.wallets || '[]'); } catch (e) {}
      for (const x of w) { const a = String((x && (x.address || x)) || '').toLowerCase(); if (a.startsWith('thor1')) rw.add(a); }
    }
  } catch (e) {}
  try {
    const rows = await env.DB.prepare('SELECT DISTINCT address FROM sync_activity_days').all();
    for (const r of (rows.results || [])) { const a = String(r.address || '').toLowerCase(); if (a.startsWith('thor1')) rw.add(a); }
  } catch (e) {}
  let rwBonder = 0, rwBond = 0;
  for (const a of rw) if (bonder.has(a)) { rwBonder++; rwBond += bonder.get(a); }
  erg.runeWatch = {
    adressen: rw.size,
    davonBonder: rwBonder,
    anteilAnBondern: bonder.size ? Math.round(rwBonder / bonder.size * 1000) / 10 : null,
    bondRUNE: Math.round(rwBond),
    anteilAmBond: bondSumme ? Math.round(rwBond / bondSumme * 1000) / 10 : null,
  };
  erg.dauerMs = Date.now() - t0;
  await env.DB.prepare('INSERT OR REPLACE INTO markt_cache (k, v, at) VALUES (?, ?, ?)').bind('markt', JSON.stringify(erg), Date.now()).run().catch(() => {});
  return marktAntwort(erg, url, env);
}

function marktAntwort(erg, url, env) {
  if (url.searchParams.get('format') === 'json') return json(erg, env);
  const f = n => n == null ? '\u2013' : Number(n).toLocaleString('de-DE');
  const h = x => x ? (x.vollstaendig ? f(x.adressenGesamt) : f(x.adressenGesamt) + (x.adressenGesamt === x.gezaehlt ? ' (Untergrenze)' : '')) : '\u2013';
  const ab = x => x ? f(x.abMindestmenge) + (x.vollstaendig ? '' : ' (von ' + f(x.gezaehlt) + ' gezaehlten)') : '\u2013';
  const zeilen = [
    ['Nodes (aktiv)', `${f(erg.nodes && erg.nodes.gesamt)} (${f(erg.nodes && erg.nodes.aktiv)})`],
    ['Node-Betreiber', f(erg.nodes && erg.nodes.betreiber)],
    ['Bonder (Adressen)', f(erg.bonder && erg.bonder.adressen)],
    ['  davon unter 1.000 RUNE', f(erg.bonder && erg.bonder.nachGroesse['unter 1.000'])],
    ['  1.000 - 10.000', f(erg.bonder && erg.bonder.nachGroesse['1.000-10.000'])],
    ['  10.000 - 100.000', f(erg.bonder && erg.bonder.nachGroesse['10.000-100.000'])],
    ['  ueber 100.000', f(erg.bonder && erg.bonder.nachGroesse['ueber 100.000'])],
    ['Bond gesamt (RUNE)', f(erg.bonder && erg.bonder.bondRUNE)],
    ['TCY-Halter (Wallet) / ab 1 TCY', `${h(erg.tcyHalter)} / ${ab(erg.tcyHalter)}`],
    ['TCY gestakt (Adressen)', f(erg.tcyGestakt && erg.tcyGestakt.adressen)],
    ['bRUNE-Halter / ybRUNE-Halter', `${h(erg.bruneHalter)} / ${h(erg.ybruneHalter)}`],
    ['RUNEPool-Anbieter', f(erg.runePool && erg.runePool.adressen)],
    ['RUNE-Konten / ab 10 RUNE', `${h(erg.runeHalter)} / ${ab(erg.runeHalter)}`],
    ['rune.watch: eingetragene Adressen', f(erg.runeWatch && erg.runeWatch.adressen)],
    ['rune.watch: davon Bonder', `${f(erg.runeWatch && erg.runeWatch.davonBonder)} (${erg.runeWatch && erg.runeWatch.anteilAnBondern != null ? erg.runeWatch.anteilAnBondern + ' %' : '\u2013'} aller Bonder)`],
    ['rune.watch: Anteil am gesamten Bond', erg.runeWatch && erg.runeWatch.anteilAmBond != null ? erg.runeWatch.anteilAmBond + ' %' : '\u2013'],
  ];
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>rune.watch Markt</title>
<style>body{font:15px system-ui;background:#0b1418;color:#e6f2f2;margin:20px}table{border-collapse:collapse;width:100%;max-width:640px}td{padding:7px 6px;border-bottom:1px solid #1d2c31}td:last-child{text-align:right;font-variant-numeric:tabular-nums;color:#00DEE1}small{color:#8aa}</style>
<h2>THORChain-Markt fuer rune.watch</h2><small>Stand ${erg.stand} \u00b7 ${erg.hinweis} \u00b7 Rechenzeit ${f(erg.dauerMs)} ms</small>
<table>${zeilen.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>
<p><small>Neu rechnen: Adresse mit &amp;neu=1 aufrufen. Rohdaten: &amp;format=json</small></p>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
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

  const excl = [...getStatsExcludedAddresses(env)];
  const exclSql = excl.length ? ` AND LOWER(address) NOT IN (${excl.map(() => '?').join(',')})` : '';

  const [
    totalRow, active1Row, active7Row, active30Row, depthRow,
    totalRequests1Row, totalRequests7Row, totalRequests30Row, trackingSinceRow,
    vis1Row, vis7Row, vis30Row, visTotalRow, visSinceRow,
    visW1Row, visW30Row, visWSinceRow,
    klick1Row, klick30Row, klickGesamtRow, klickGeraeteRow, klickQuellenRows,
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(DISTINCT address) AS n FROM sync_activity_days WHERE 1=1${exclSql}`).bind(...excl).first(),
    env.DB.prepare(`SELECT COUNT(DISTINCT address) AS n FROM sync_activity_days WHERE day >= ?${exclSql}`).bind(day1, ...excl).first(),
    env.DB.prepare(`SELECT COUNT(DISTINCT address) AS n FROM sync_activity_days WHERE day >= ?${exclSql}`).bind(day7, ...excl).first(),
    env.DB.prepare(`SELECT COUNT(DISTINCT address) AS n FROM sync_activity_days WHERE day >= ?${exclSql}`).bind(day30, ...excl).first(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS n2,
         SUM(CASE WHEN d >= 3 THEN 1 ELSE 0 END) AS n3,
         SUM(CASE WHEN d >= 10 THEN 1 ELSE 0 END) AS n10,
         SUM(CASE WHEN d >= 30 THEN 1 ELSE 0 END) AS n30
       FROM (
         SELECT address, COUNT(DISTINCT day) AS d FROM sync_activity_days
         WHERE 1=1${exclSql}
         GROUP BY address
         HAVING d >= 2
       )`
    // UNBEGRENZT: ueber den gesamten Aufzeichnungszeitraum statt der letzten 30 Tage.
    // Gewuenscht: "wo 30 Tage stehen bitte unbegrenzt, ich will alle Daten". Bei einer
    // Aufzeichnung von wenigen Wochen schnitt das 30-Tage-Fenster die fruehesten Nutzer
    // bereits ab -- genau die, deren Wiederkehr am meisten aussagt.
    ).bind(...excl).first(),
    env.DB.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM sync_activity_counts WHERE day >= ?${exclSql}`).bind(day1, ...excl).first()
      .catch((e) => {
        console.warn('[rune-rewards-backend] sync_activity_counts (1d) nicht lesbar:', e?.message || String(e));
        return { n: 0 };
      }),
    env.DB.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM sync_activity_counts WHERE day >= ?${exclSql}`).bind(day7, ...excl).first()
      .catch((e) => {
        console.warn('[rune-rewards-backend] sync_activity_counts (7d) nicht lesbar:', e?.message || String(e));
        return { n: 0 };
      }),
    env.DB.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM sync_activity_counts WHERE day >= ?${exclSql}`).bind(day30, ...excl).first()
      .catch((e) => {
        console.warn('[rune-rewards-backend] sync_activity_counts (30d) nicht lesbar:', e?.message || String(e));
        return { n: 0 };
      }),
    // Erster Tag, an dem ueberhaupt aufgezeichnet wurde. Bewusst aus sync_activity_days und
    // NICHT aus sync_activity_counts -- die kam spaeter dazu und wuerde einen zu spaeten
    // Startzeitpunkt vortaeuschen.
    env.DB.prepare('SELECT MIN(day) AS d FROM sync_activity_days').first()
      .catch((e) => {
        console.warn('[rune-rewards-backend] Aufzeichnungsbeginn nicht lesbar:', e?.message || String(e));
        return { d: null };
      }),
    
    env.DB.prepare('SELECT COUNT(DISTINCT token) AS n FROM visitor_days WHERE day >= ?').bind(day1).first().catch(() => ({ n: null })),
    env.DB.prepare('SELECT COUNT(DISTINCT token) AS n FROM visitor_days WHERE day >= ?').bind(day7).first().catch(() => ({ n: null })),
    env.DB.prepare('SELECT COUNT(DISTINCT token) AS n FROM visitor_days WHERE day >= ?').bind(day30).first().catch(() => ({ n: null })),
    env.DB.prepare('SELECT COUNT(DISTINCT token) AS n FROM visitor_days').first().catch(() => ({ n: null })),
    env.DB.prepare('SELECT MIN(day) AS d FROM visitor_days').first().catch(() => ({ d: null })),
    // Geraete mit eingetragener Wallet (has_wallet). Ohne Migration 2 -> null, Kachel zeigt "—".
    env.DB.prepare('SELECT COUNT(DISTINCT token) AS n FROM visitor_days WHERE day >= ? AND has_wallet = 1').bind(day1).first().catch(() => ({ n: null })),
    env.DB.prepare('SELECT COUNT(DISTINCT token) AS n FROM visitor_days WHERE day >= ? AND has_wallet = 1').bind(day30).first().catch(() => ({ n: null })),
    env.DB.prepare('SELECT MIN(day) AS d FROM visitor_days WHERE has_wallet = 1').first().catch(() => ({ d: null })),
    // Klicks auf die RUNEBond-Empfehlung. Ohne Migration 3 -> null, Kacheln zeigen "—".
    env.DB.prepare("SELECT COUNT(*) AS n FROM outbound_clicks WHERE target = 'runebond' AND day >= ?").bind(day1).first().catch(() => ({ n: null })),
    env.DB.prepare("SELECT COUNT(*) AS n FROM outbound_clicks WHERE target = 'runebond' AND day >= ?").bind(day30).first().catch(() => ({ n: null })),
    env.DB.prepare("SELECT COUNT(*) AS n FROM outbound_clicks WHERE target = 'runebond'").first().catch(() => ({ n: null })),
    env.DB.prepare("SELECT COUNT(DISTINCT token) AS n FROM outbound_clicks WHERE target = 'runebond' AND token IS NOT NULL").first().catch(() => ({ n: null })),
    // Aufteilung nach Herkunft (30 Tage); alte Klicks ohne Quelle erscheinen als "–".
    env.DB.prepare("SELECT COALESCE(quelle, '-') AS q, COUNT(*) AS n FROM outbound_clicks WHERE target = 'runebond' AND day >= ? GROUP BY q ORDER BY n DESC").bind(day30).all().catch(() => ({ results: null })),
  ]);

  const active1 = active1Row?.n || 0;
  const active7 = active7Row?.n || 0;
  const active30 = active30Row?.n || 0;
  const returning30 = depthRow?.n2 || 0;
  const returning3d = depthRow?.n3 || 0;
  const returning10d = depthRow?.n10 || 0;
  const returning30d = depthRow?.n30 || 0;
  const totalRequests1 = totalRequests1Row?.n || 0;
  const totalRequests7 = totalRequests7Row?.n || 0;
  const totalRequests30 = totalRequests30Row?.n || 0;
  const trackingSince = trackingSinceRow?.d || null; 

  // Bezugsgroesse der Quoten sind jetzt ALLE je erfassten Adressen -- passend zur Zaehlung
  // ueber den ganzen Zeitraum. Mit den 30-Tage-Aktiven als Nenner haette man eine
  // Gesamtzahl durch einen Ausschnitt geteilt, und die Quote waere ueber 100 % gerutscht.
  const alleAdressen = totalRow?.n || 0;
  const pctOf = (n) => alleAdressen > 0 ? Math.round((n / alleAdressen) * 1000) / 10 : null;

  const stats = {
    totalUniqueAddressesEver: totalRow?.n || 0,
    activeLast1d: active1,
    activeLast7d: active7,
    activeLast30d: active30,
    // Werte ueber den GESAMTEN Aufzeichnungszeitraum. Die alten Feldnamen bleiben erhalten,
    // damit nichts bricht, das die JSON-Ausgabe schon ausliest -- sie tragen jetzt dieselben
    // Gesamtwerte.
    returningAllTime: returning30,
    retentionRateAllTime: pctOf(returning30),
    depthBase: alleAdressen,
    returningLast30d: returning30,
    retentionRate30d: pctOf(returning30),
    engagementDepth: [
      { minDays: 2, count: returning30, pct: pctOf(returning30) },
      { minDays: 3, count: returning3d, pct: pctOf(returning3d) },
      { minDays: 10, count: returning10d, pct: pctOf(returning10d) },
      { minDays: 30, count: returning30d, pct: pctOf(returning30d) },
    ],
    totalRequestsLast1d: totalRequests1,
    totalRequestsLast7d: totalRequests7,
    totalRequestsLast30d: totalRequests30,
    trackingSince,
    trackingSinceDays: trackingSince
      ? Math.max(1, Math.round((now - Date.parse(trackingSince + 'T00:00:00Z')) / 86400000) + 1)
      : null,
    
    visitorsLast1d: vis1Row?.n ?? null,
    visitorsLast7d: vis7Row?.n ?? null,
    visitorsLast30d: vis30Row?.n ?? null,
    visitorsTotal: visTotalRow?.n ?? null,
    visitorsSince: visSinceRow?.d ?? null,
    visitorsWithWalletLast1d: visW1Row?.n ?? null,
    visitorsWithWalletLast30d: visW30Row?.n ?? null,
    visitorsWithWalletSince: visWSinceRow?.d ?? null,
    runebondClicksLast1d: klick1Row?.n ?? null,
    runebondClicksLast30d: klick30Row?.n ?? null,
    runebondClicksTotal: klickGesamtRow?.n ?? null,
    runebondClickDevices: klickGeraeteRow?.n ?? null,
    runebondClicksBySource30d: klickQuellenRows && Array.isArray(klickQuellenRows.results) ? klickQuellenRows.results : null,
  };
  // Anteil in Prozent, eine Nachkommastelle. Nenner = alle Geraete im selben Zeitraum.
  const walletPct = (n, total) => (n == null || !total) ? null : Math.round((n / total) * 1000) / 10;
  stats.walletShareLast1d = walletPct(stats.visitorsWithWalletLast1d, stats.visitorsLast1d);
  stats.walletShareLast30d = walletPct(stats.visitorsWithWalletLast30d, stats.visitorsLast30d);

  // KOHORTEN: Adressen nach Woche ihres ersten Syncs; je Kohorte der Anteil, der in Woche
  // 0, 1, 2 ... danach wieder aktiv war. Zeigt, ob neue Nutzer bleiben.
  try {
    const rows = ((await env.DB.prepare(`SELECT address, day FROM sync_activity_days WHERE 1=1${exclSql}`).bind(...excl).all()).results) || [];
    const startMs = stats.trackingSince ? Date.parse(stats.trackingSince + 'T00:00:00Z') : null;
    if (startMs && rows.length) {
      const woche = d => Math.floor((Date.parse(d + 'T00:00:00Z') - startMs) / (7 * 86400000));
      const jeAdresse = new Map();
      for (const r of rows) { const w = woche(r.day); const e = jeAdresse.get(r.address) || { erste: w, wochen: new Set() }; e.erste = Math.min(e.erste, w); e.wochen.add(w); jeAdresse.set(r.address, e); }
      const aktuell = woche(utcDayString(now));
      const kohorten = new Map();
      for (const e of jeAdresse.values()) { const k = kohorten.get(e.erste) || []; k.push(e); kohorten.set(e.erste, k); }
      stats.kohorten = [...kohorten.entries()].sort((a, b) => a[0] - b[0]).map(([w, liste]) => ({
        woche: w, start: utcDayString(startMs + w * 7 * 86400000), n: liste.length,
        anteile: Array.from({ length: Math.min(9, aktuell - w + 1) }, (_, k) => Math.round(liste.filter(e => e.wochen.has(w + k)).length / liste.length * 1000) / 10),
      }));
    }
  } catch (e) { stats.kohorten = null; }
  // AKTIV/PASSIV (ab Einbau): aktive vs. passive Aufrufe, Adressen mit aktiven Tagen.
  try {
    const exclArt = excl.length ? ` AND LOWER(address) NOT IN (${excl.map(() => '?').join(',')})` : '';
    const [a1, a30, tage, seit] = await Promise.all([
      env.DB.prepare(`SELECT COALESCE(SUM(aktiv),0) AS a, COALESCE(SUM(passiv),0) AS p, COUNT(DISTINCT CASE WHEN aktiv > 0 THEN address END) AS na FROM sync_activity_art WHERE day >= ?${exclArt}`).bind(day1, ...excl).first(),
      env.DB.prepare(`SELECT COALESCE(SUM(aktiv),0) AS a, COALESCE(SUM(passiv),0) AS p, COUNT(DISTINCT CASE WHEN aktiv > 0 THEN address END) AS na FROM sync_activity_art WHERE day >= ?${exclArt}`).bind(day30, ...excl).first(),
      env.DB.prepare(`SELECT SUM(CASE WHEN d >= 2 THEN 1 ELSE 0 END) AS n2, SUM(CASE WHEN d >= 5 THEN 1 ELSE 0 END) AS n5, SUM(CASE WHEN d >= 10 THEN 1 ELSE 0 END) AS n10, COUNT(*) AS n1
        FROM (SELECT address, COUNT(*) AS d FROM sync_activity_art WHERE aktiv > 0${exclArt} GROUP BY address)`).bind(...excl).first(),
      env.DB.prepare('SELECT MIN(day) AS d FROM sync_activity_art').first(),
    ]);
    stats.aktivPassiv = { seit: seit && seit.d, h24: a1, d30: a30, aktiveTage: tage };
  } catch (e) { stats.aktivPassiv = null; }

  const wantsHtml = (request.headers.get('Accept') || '').includes('text/html');
  if (!wantsHtml) {
    return json(stats, env);
  }

  // Datum auf der Statistikseite englisch: 22 Sep 2026 statt 22.09.2026.
  const deDate = (isoDay) => {
    if (!isoDay) return null;
    const [y, m, d] = isoDay.split('-');
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m, 10) - 1] || m;
    return `${parseInt(d, 10)} ${mon} ${y}`;
  };
  const trackingHint = stats.trackingSince
    ? `since ${deDate(stats.trackingSince)} · ${stats.trackingSinceDays} days`
    : 'not recording yet';
  const visitorHint = stats.visitorsSince
    ? `since ${deDate(stats.visitorsSince)}`
    : 'not recording yet';

  const tile = (key, label, value, hint) => `
    <div class="tile">
      <div class="tile-value" id="v-${key}">${value == null ? '—' : value}</div>
      <div class="tile-label">${label}</div>
      ${hint ? `<div class="tile-hint" id="h-${key}">${hint}</div>` : ''}
    </div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
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
  /* Festes Zeitraum-Etikett -- sieht aus wie ein Auswahlfeld, ist aber bewusst nicht
     bedienbar: Aktive Adressen und Requests zeigen beide 24h. */
  .tile-period {
    background: #0e141b; color: #93a5b1; border: 1px solid #1f2b35; border-radius: 6px;
    font-size: 10.5px; font-weight: 600; padding: 3px 6px;
  }
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
  /* Zwei Seiten nebeneinander, horizontal wischbar (Snap). Am Handy ein Karussell, am PC
     funktionieren die Punkte unten als Navigation. */
  .pager {
    display: flex; overflow-x: auto; scroll-snap-type: x mandatory;
    scrollbar-width: none; -webkit-overflow-scrolling: touch;
  }
  .pager::-webkit-scrollbar { display: none; }
  .page { flex: 0 0 100%; min-width: 100%; scroll-snap-align: start; padding-right: 2px; }
  .page-title {
    font-size: 11px; color: #5f7480; margin: 0 0 10px; letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .dots { display: flex; gap: 7px; justify-content: center; margin: 20px 0 0; }
  .dot-nav {
    width: 7px; height: 7px; border-radius: 50%; background: #1f2b35; border: none;
    padding: 0; cursor: pointer; transition: background 0.15s ease;
  }
  .dot-nav.active { background: #2dd4bf; }
  .note {
    font-size: 11.5px; color: #6b7c87; line-height: 1.55; margin-top: 14px;
    border-left: 2px solid #1f2b35; padding-left: 11px; max-width: 480px;
  }
  .swipe-hint { font-size: 10.5px; color: #3f4f59; text-align: center; margin-top: 8px; }
  /* REITER OBEN (gemeldet: auf der ersten Seite sah man nicht, dass man wischen kann). Bleibt
     beim Scrollen oben stehen und zeigt, welche Seite gerade offen ist. */
  .tabs { position: sticky; top: 0; z-index: 5; display: flex; gap: 4px; padding: 4px; margin: 0 0 14px;
    background: #0b1117; border: 1px solid #1f2b35; border-radius: 999px; }
  .tab-nav { flex: 1; height: 34px; border: none; border-radius: 999px; background: transparent; color: #6b7c87;
    font: 600 13px/1 Inter, system-ui, sans-serif; cursor: pointer; transition: background .15s, color .15s; }
  .tab-nav.active { background: #2dd4bf; color: #04201c; }
</style>
</head>
<body>
  <h1>rune.watch — sync activity</h1>
  <div class="subtitle">Address based, across devices (not Cloudflare "visits") · recording <span id="v-since">${trackingHint}</span></div>

  <div class="tabs" role="tablist">
    <button class="tab-nav active" data-page="0" role="tab">Addresses</button>
    <button class="tab-nav" data-page="1" role="tab">Visitors</button>
  </div>

  <div class="pager" id="pager">
    <section class="page">
      <div class="page-title">1 · Addresses (wallet entered)</div>
      <div class="grid">
        <div class="tile">
          <div class="tile-head">
            <div class="tile-label" style="margin-top:0">Active addresses</div>
            <div class="tile-period">24h</div>
          </div>
          <div class="tile-value" id="v-active">${stats.activeLast1d}</div>
          <div class="tile-hint">addresses that synced in the last 24h</div>
        </div>
        <div class="tile">
          <div class="tile-head">
            <div class="tile-label" style="margin-top:0">Total requests</div>
            <div class="tile-period">24h</div>
          </div>
          <div class="tile-value" id="v-requests">${stats.totalRequestsLast1d}</div>
          <div class="tile-hint">all sync calls in the last 24h, not deduplicated per day</div>
        </div>
        ${tile('total', 'Addresses total', stats.totalUniqueAddressesEver, trackingHint)}
        ${tile('returning', 'Returning – all time', stats.returningAllTime, 'synced on ≥2 separate days since recording began')}
        ${tile('rate', 'Retention rate', stats.retentionRateAllTime == null ? '—' : stats.retentionRateAllTime + '%', 'share of returning addresses among all addresses')}
        ${tile('avgreq', 'Ø requests per active address', stats.activeLast1d > 0 ? Math.round((stats.totalRequestsLast1d / stats.activeLast1d) * 10) / 10 : '—', 'last 24h, per address active in those 24h')}
        <div class="tile wide">
          <div class="tile-label" style="margin-top:0; margin-bottom:12px;">Usage depth (all time)</div>
          ${stats.engagementDepth.map(row => `
            <div class="depth-row">
              <div class="depth-label">≥ ${row.minDays} days</div>
              <div class="depth-bar-track">
                <div class="depth-bar-fill" id="v-depth-bar-${row.minDays}" style="width:${row.pct == null ? 0 : row.pct}%"></div>
              </div>
              <div class="depth-pct" id="v-depth-pct-${row.minDays}">${row.pct == null ? '—' : row.pct + '%'}</div>
              <div class="depth-count" id="v-depth-count-${row.minDays}">(${row.count})</div>
            </div>`).join('')}
          <div class="tile-hint" style="margin-top:8px;">Share of all recorded addresses (<span id="v-depth-base">${stats.depthBase}</span>) that synced on at least X separate days since recording began. Each step is contained in the one above.</div>
        </div>
        ${(() => {
          const ap = stats.aktivPassiv;
          if (!ap || !ap.seit) return `<div class="tile wide"><div class="tile-label" style="margin-top:0;">Active vs. passive syncs</div><div class="tile-hint" style="margin-top:6px;">Recording starts with the next app version (needs ?a=1/0 from the app).</div></div>`;
          const quote = (a, p) => (a + p) > 0 ? Math.round(a / (a + p) * 1000) / 10 + '%' : '—';
          const t = ap.aktiveTage || {};
          return `<div class="tile wide">
            <div class="tile-label" style="margin-top:0; margin-bottom:10px;">Active vs. passive syncs <span style="opacity:.6">(since ${deDate(ap.seit)})</span></div>
            <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px;">
              <div><div class="tile-value" style="font-size:26px;">${quote(ap.h24.a, ap.h24.p)}</div><div class="tile-hint">active share, 24h<br>${ap.h24.a} active · ${ap.h24.p} passive</div></div>
              <div><div class="tile-value" style="font-size:26px;">${ap.h24.na}</div><div class="tile-hint">addresses with an active sync, 24h</div></div>
              <div><div class="tile-value" style="font-size:26px;">${ap.d30.na}</div><div class="tile-hint">addresses with an active sync, 30d</div></div>
            </div>
            <div class="tile-label" style="margin:14px 0 8px;">Active days per address</div>
            ${[['1', t.n1], ['2', t.n2], ['5', t.n5], ['10', t.n10]].map(([d, n]) => `<div class="depth-row"><div class="depth-label">≥ ${d} days</div><div class="depth-bar-track"><div class="depth-bar-fill" style="width:${t.n1 ? Math.round((n || 0) / t.n1 * 100) : 0}%"></div></div><div class="depth-pct">${n || 0}</div><div class="depth-count"></div></div>`).join('')}
            <div class="tile-hint" style="margin-top:8px;">Active = the user did something on a visible page within 5 minutes before the sync. Passive = tab open in the background, timers. Real power users have many active days.</div>
          </div>`;
        })()}
        ${(() => {
          const k = stats.kohorten;
          if (!k || !k.length) return '';
          const maxW = Math.max(...k.map(x => x.anteile.length));
          const zelle = v => v == null ? '<td></td>' : `<td style="text-align:center; padding:4px 2px; border-radius:5px; background:rgba(45,212,191,${Math.max(0.06, v / 100 * 0.85)}); color:${v > 45 ? '#04201c' : 'inherit'}; font-variant-numeric:tabular-nums;">${Math.round(v)}</td>`;
          return `<div class="tile wide">
            <div class="tile-label" style="margin-top:0; margin-bottom:10px;">Cohorts by first week</div>
            <div style="overflow-x:auto;"><table style="border-collapse:separate; border-spacing:2px; width:100%; font-size:11px;">
              <tr><th style="text-align:left; opacity:.6; font-weight:500;">week of</th><th style="opacity:.6; font-weight:500;">n</th>${Array.from({ length: maxW }, (_, i) => `<th style="opacity:.6; font-weight:500;">W${i}</th>`).join('')}</tr>
              ${k.map(x => `<tr><td style="white-space:nowrap; padding-right:4px;">${(deDate(x.start) || '').replace(/ \d{4}$/, '')}</td><td style="text-align:center; opacity:.8;">${x.n}</td>${Array.from({ length: maxW }, (_, i) => zelle(x.anteile[i])).join('')}</tr>`).join('')}
            </table></div>
            <div class="tile-hint" style="margin-top:8px;">Addresses grouped by the week of their first sync (n). W1, W2 … = share (%) of that group that synced again 1, 2 … weeks later. W0 is always 100.</div>
          </div>`;
        })()}
      </div>
      <div class="swipe-hint">← swipe for visitors →</div>
    </section>

    <section class="page">
      <div class="page-title">2 · Visitors (anonymous, all devices)</div>
      <div class="grid">
        ${tile('vis1', 'Devices – 24h', stats.visitorsLast1d, 'distinct devices in the last 24h')}
        ${tile('vis7', 'Devices – 7 days', stats.visitorsLast7d)}
        ${tile('vis30', 'Devices – 30 days', stats.visitorsLast30d)}
        ${tile('vistotal', 'Devices total', stats.visitorsTotal, visitorHint)}
        ${tile('wshare1', 'With wallet – 24h', stats.walletShareLast1d == null ? null : stats.walletShareLast1d + '%',
          stats.visitorsWithWalletLast1d == null ? 'no data yet' : `${stats.visitorsWithWalletLast1d} of ${stats.visitorsLast1d} devices have a wallet entered`)}
        ${tile('rb1', 'RUNEBond clicks – 24h', stats.runebondClicksLast1d,
          stats.runebondClicksTotal == null ? 'no data yet' : `${stats.runebondClicksTotal} in total`)}
        ${tile('rbdev', 'Devices that clicked', stats.runebondClickDevices,
          stats.runebondClicksLast30d == null ? 'no data yet' : `${stats.runebondClicksLast30d} clicks in 30 days`)}
        ${(() => {
          // Aufteilung nach Herkunft: gross die Summe (30 Tage), darunter je Quelle eine Zeile.
          // Vorher stand die ganze Aufzaehlung als "Zahl" in der grossen Schrift der Kachel.
          const rows = stats.runebondClicksBySource30d;
          const namen = { banner: 'Banner (top of the app)', node: 'Node card (node window)', liste: 'RUNEBond × RUNE.WATCH list', karte: 'Bond card', '-': 'before sources were recorded' };
          if (!rows || !rows.length) return tile('rbsrc', 'RUNEBond clicks by source – 30 days', null, 'no data yet');
          const summe = rows.reduce((a, r) => a + (Number(r.n) || 0), 0);
          const zeilen = rows.map(r => `${namen[r.q] || r.q}: <b>${Number(r.n) || 0}</b>`).join('<br>');
          return tile('rbsrc', 'RUNEBond clicks by source – 30 days', summe, zeilen);
        })()}
        <div class="tile"><div class="tile-label">Worker version</div><div class="tile-hint">${WORKER_VERSION}</div></div>
        ${tile('wshare30', 'With wallet – 30 days', stats.walletShareLast30d == null ? null : stats.walletShareLast30d + '%',
          stats.visitorsWithWalletLast30d == null ? 'no data yet' : `${stats.visitorsWithWalletLast30d} of ${stats.visitorsLast30d} devices` + (stats.visitorsWithWalletSince ? ` · recorded since ${deDate(stats.visitorsWithWalletSince)}` : ''))}
      </div>
    </section>
  </div>

  <div class="dots">
    <button class="dot-nav active" data-page="0" aria-label="Page 1: addresses"></button>
    <button class="dot-nav" data-page="1" aria-label="Page 2: visitors"></button>
  </div>

  <div class="refresh"><span class="dot"></span><span id="stamp">As of ${new Date().toLocaleString('en-GB', { timeZone: 'UTC' })} UTC · updating live</span></div>
<script>
  const REFRESH_MS = 1000;
  let latestStats = null;

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el && el.textContent !== String(val)) el.textContent = val == null ? '—' : val;
  }

  function deDate(isoDay) {
    if (!isoDay) return null;
    const p = isoDay.split('-');
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(p[1], 10) - 1] || p[1];
    return parseInt(p[2], 10) + ' ' + mon + ' ' + p[0];
  }

  function renderSelected() {
    if (!latestStats) return;
    // Aktive Adressen und Requests stehen beide fest auf 24h -- die Gesamtzahl steht ohnehin
    // in "Adressen insgesamt". Der Durchschnitt muss denselben Zeitraum benutzen, sonst teilt
    // man eine 24-Stunden-Summe durch die 30-Tage-Adressen.
    const requestsVal = latestStats.totalRequestsLast1d;
    const avgVal = latestStats.activeLast1d > 0
      ? Math.round((requestsVal / latestStats.activeLast1d) * 10) / 10 : null;
    const trackingHint = latestStats.trackingSince
      ? 'since ' + deDate(latestStats.trackingSince) + ' · ' + latestStats.trackingSinceDays + ' days'
      : 'not recording yet';

    setText('v-since', trackingHint);
    setText('h-total', trackingHint);
    setText('v-active', latestStats.activeLast1d);
    setText('v-requests', requestsVal);
    setText('v-total', latestStats.totalUniqueAddressesEver);
    setText('v-returning', latestStats.returningAllTime);
    setText('v-rate', latestStats.retentionRateAllTime == null ? '—' : latestStats.retentionRateAllTime + '%');
    setText('v-avgreq', avgVal == null ? '—' : avgVal);
    setText('v-depth-base', latestStats.depthBase);
    setText('v-vis1', latestStats.visitorsLast1d);
    setText('v-vis7', latestStats.visitorsLast7d);
    setText('v-vis30', latestStats.visitorsLast30d);
    setText('v-vistotal', latestStats.visitorsTotal);
    setText('h-vistotal', latestStats.visitorsSince ? 'since ' + deDate(latestStats.visitorsSince) : 'not recording yet');
    setText('v-rb1', latestStats.runebondClicksLast1d == null ? '—' : latestStats.runebondClicksLast1d);
    setText('h-rb1', latestStats.runebondClicksTotal == null ? 'no data yet' : latestStats.runebondClicksTotal + ' in total');
    setText('v-rbdev', latestStats.runebondClickDevices == null ? '—' : latestStats.runebondClickDevices);
    setText('h-rbdev', latestStats.runebondClicksLast30d == null ? 'no data yet' : latestStats.runebondClicksLast30d + ' clicks in 30 days');
    setText('v-wshare1', latestStats.walletShareLast1d == null ? '—' : latestStats.walletShareLast1d + '%');
    setText('v-wshare30', latestStats.walletShareLast30d == null ? '—' : latestStats.walletShareLast30d + '%');
    setText('h-wshare1', latestStats.visitorsWithWalletLast1d == null ? 'no data yet'
      : latestStats.visitorsWithWalletLast1d + ' of ' + latestStats.visitorsLast1d + ' devices have a wallet entered');
    setText('h-wshare30', latestStats.visitorsWithWalletLast30d == null ? 'no data yet'
      : latestStats.visitorsWithWalletLast30d + ' of ' + latestStats.visitorsLast30d + ' devices'
        + (latestStats.visitorsWithWalletSince ? ' · recorded since ' + deDate(latestStats.visitorsWithWalletSince) : ''));
    (latestStats.engagementDepth || []).forEach(row => {
      const bar = document.getElementById('v-depth-bar-' + row.minDays);
      if (bar) bar.style.width = (row.pct == null ? 0 : row.pct) + '%';
      setText('v-depth-pct-' + row.minDays, row.pct == null ? '—' : row.pct + '%');
      setText('v-depth-count-' + row.minDays, '(' + row.count + ')');
    });
  }

  async function refreshStats() {
    try {
      const res = await fetch(location.href, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) return;
      latestStats = await res.json();
      renderSelected();
      document.getElementById('stamp').textContent =
        'As of ' + new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC' }) + ' UTC · updating live';
    } catch (e) { /* nächster Tick versucht es erneut */ }
  }

  // Wischen zwischen den Seiten: Die Punkte unten springen, und beim Wischen wandert der
  // aktive Punkt mit.
  const pager = document.getElementById('pager');
  const dots = [...document.querySelectorAll('.dot-nav')];
  const tabs = [...document.querySelectorAll('.tab-nav')];
  [...dots, ...tabs].forEach(d => d.addEventListener('click', () => {
    pager.scrollTo({ left: pager.clientWidth * Number(d.dataset.page), behavior: 'smooth' });
    if (d.classList.contains('tab-nav')) window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  pager.addEventListener('scroll', () => {
    const i = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
    dots.forEach((d, j) => d.classList.toggle('active', j === i));
    tabs.forEach((d, j) => d.classList.toggle('active', j === i));
  }, { passive: true });

  setInterval(refreshStats, REFRESH_MS);
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store', ...corsHeaders(env) },
  });
}

// WELCHE GEBUEHREN ZAEHLEN (gemeldet: "Chainflip nimmt mit weniger Volumen mehr ein als THORChain?").
//
// THORChain zaehlt ueber Midgard nur liquidityFees: die komplette Swap-Gebuehr, bevor sie auf
// Nodes, Pools, POL, TCY usw. verteilt wird. Gas fuer Outbounds und Affiliate-Gebuehren der
// Frontends stecken da NICHT drin.
//
// Bei Chainflip stand hier bisher dailySupplySideRevenue. Laut DefiLlama-Adapter
// (dimension-adapters, fees/chainflip/index.ts) ist das Swap Fees an die LPs PLUS
// "Ingress, Egress, Broker Fees" -- also durchgereichte Gas-Kosten der Ein-/Auszahlung und die
// Gebuehren der Frontends. Die Netzwerkgebuehr (0,1 %, Buy & Burn) fehlte dagegen.
// Das Gegenstueck zu THORChains liquidityFees ist Swap Fees + Network Fees. Weil der Adapter
// die Ingress/Egress/Broker-Gebuehren als EINZIGEN Posten in dailyUserFees meldet, gilt:
//   Swap Fees + Network Fees = dailyFees - dailyUserFees
//
// NEAR INTENTS: KEIN VERGLEICHBARER WERT VORHANDEN (geprueft in fees/near-intents/index.ts).
//   dailyFees      = Protokollgebuehr + Affiliate-Gebuehren der Frontends, beide unter EINEM
//                    Label ('Swap Fees') -- ueber die API nicht trennbar. Die Affiliate-Gebuehren
//                    sind das Gegenstueck zu Chainflips Broker-Gebuehren, gehoeren also nicht rein.
//   dailySupplySide = dailyFees minus das, was NEAR in seine Wallets ueberweist: also Gebuehren,
//                    die Solver und fremde Frontends behalten. Wird an Ueberweisungstagen
//                    negativ (allowNegativeValue) -- daher die -70,8K.
//   dailyRevenue   = diese Ueberweisungen selbst, schubweise gebucht, enthaelt u. a. die
//                    Frontend-Einnahmen von near.com.
// Das eigentliche Gegenstueck zu THORChains liquidityFees waere der SPREAD der Solver -- der wird
// nirgends veroeffentlicht und steckt in keiner dieser Zahlen. Deshalb zeigt "Fees earned" fuer
// NEAR Intents bewusst keinen Wert, statt eine Zahl, die etwas anderes misst.

// OPS-STATUS AUS devops.thorchain.org (Quelle wird in der App genannt). Die Seite hat genau eine
// Datenschnittstelle (/api/feed.json = Live Updates); Aufgaben und Upgrade-Stufen stehen als fertiges
// HTML in der Seite und werden hier ausgelesen. Dazu kommen Chain-Daten direkt von THORNode.
// Zwischengespeichert 90 s (die Seite selbst cached ~60-90 s).
let opsCache = null;
const OPS_CACHE_MS = 90 * 1000;
const opsText = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const opsAttr = (tag, name) => { const m = tag.match(new RegExp(name + '="([^"]*)"')); return m ? opsText(m[1]) : null; };
function parseOpsHtml(html) {
  // Aufgaben: <article class="task" data-...> ... </article>
  const aufgaben = [];
  for (const m of html.matchAll(/<article class="task"([^>]*)>([\s\S]*?)<\/article>/g)) {
    const kopf = m[1], inhalt = m[2];
    const schritte = [...inhalt.matchAll(/<li class="step([^"]*)"[\s\S]*?<span class="step-name">([\s\S]*?)<\/span>/g)].map(sm => ({
      name: opsText(sm[2]), status: /is-done/.test(sm[1]) ? 'done' : /is-next/.test(sm[1]) ? 'next' : /is-now|is-current|is-active/.test(sm[1]) ? 'now' : 'todo' }));
    const upd = inhalt.match(/class="cl-n">(\d+)</);
    const prog = inhalt.match(/class="prog">([^<]*)</);
    aufgaben.push({
      key: opsAttr(kopf, 'data-key'), titel: opsAttr(kopf, 'data-title'), status: opsAttr(kopf, 'data-id'),
      prozent: Number(opsAttr(kopf, 'data-pct')) || 0, prio: opsAttr(kopf, 'data-prio'), version: opsAttr(kopf, 'data-ver') || null,
      kategorien: (opsAttr(kopf, 'data-cats') || '').split(/\s*,\s*|\s*\|\s*/).filter(Boolean), jetzt: opsAttr(kopf, 'data-now'),
      fortschritt: prog ? opsText(prog[1]) : null, updates: upd ? Number(upd[1]) : 0, schritte,
    });
  }
  // UPDATE-VERLAUF je Aufgabe: <template id="cl-KEY"><ol class="cl-list"><li><time datetime=..>..</time><span>06:20 UTC · Text</span></li>
  const verlaeufe = {};
  for (const tm of html.matchAll(/<template id="cl-([^"]+)">([\s\S]*?)<\/template>/g)) {
    verlaeufe[tm[1]] = [...tm[2].matchAll(/<li>\s*<time[^>]*datetime="([^"]*)"[^>]*>[\s\S]*?<\/time>\s*<span>([\s\S]*?)<\/span>\s*<\/li>/g)]
      .map(lm => ({ datum: lm[1], text: opsText(lm[2]) })).slice(0, 30);
  }
  for (const a of aufgaben) a.verlauf = (a.key && verlaeufe[a.key]) || [];
  // eindeutig machen (Fokus- und Gesamtansicht koennen dieselbe Aufgabe enthalten)
  const gesehen = new Set();
  const eindeutig = aufgaben.filter(a => { const k = a.key || a.titel; if (gesehen.has(k)) return false; gesehen.add(k); return true; });
  // Upgrade: Version + Stufen (im HTML, nicht im CSS: Tag mit data-state)
  const verM = html.match(/Upgrade to[\s\S]{0,200}?(v\d+\.\d+\.\d+[\w.-]*)/);
  const stufen = [];
  const segRe = /<(?:div|button|a|section)[^>]*class="upg-seg[^"]*"[^>]*>/g;
  const segs = [...html.matchAll(segRe)];
  segs.forEach((sm, i) => {
    const tag = sm[0];
    const ende = i + 1 < segs.length ? segs[i + 1].index : Math.min(html.length, sm.index + 3000);
    const block = html.slice(sm.index, ende);
    const name = block.match(/<b>([\s\S]*?)<\/b>/);
    const klein = block.match(/class="upg-small">([\s\S]*?)<\//);
    const st = block.match(/class="upg-st">([\s\S]*?)<\/(?:div|span|p)>/);
    // Details (Popover): Ueberschrift, Kurzinfo und Tabelle der Merge Requests
    const popRoh = block.match(/class="upg-pop"[\s\S]*$/);
    // Popover begrenzen: bis zum Ende seiner Tabelle, sonst hoechstens 2500 Zeichen
    const pop = popRoh ? [(() => { const t = popRoh[0]; const e = t.indexOf('</table>'); return t.slice(0, e >= 0 ? e + 8 : Math.min(t.length, 2500)); })()] : null;
    let details = null;
    if (pop) {
      const h3 = pop[0].match(/<h3>([\s\S]*?)<\/h3>/), info = pop[0].match(/<p class="muted"[^>]*>([\s\S]*?)<\/p>/);
      const zeilen = [...pop[0].matchAll(/<tr>\s*<td>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g)]
        .map(z => ({ url: z[1], mr: opsText(z[2]), titel: opsText(z[3]), zustand: opsText(z[4]), freigaben: opsText(z[5]), ci: opsText(z[6]) })).slice(0, 120);
      const absatz = [...pop[0].matchAll(/<p(?: [^>]*)?>([\s\S]*?)<\/p>/g)].map(x => opsText(x[1].replace(/<br\s*\/?>/g, ' \u00b7 '))).filter(Boolean).slice(0, 6);
      details = { titel: h3 ? opsText(h3[1]) : null, info: info ? opsText(info[1].replace(/<br\s*\/?>/g, ' \u00b7 ')) : null, mrs: zeilen, absaetze: absatz };
    }
    stufen.push({ name: name ? opsText(name[1]) : null, unter: klein ? opsText(klein[1]) : null, status: st ? opsText(st[1]).replace(/\s*·\s*details\s*$/i, '') : null, state: opsAttr(tag, 'data-state'), details });
  });
  const standM = html.match(/task progress as of\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
  const obM = html.match(/Outbound by chain:\s*([^<]*)/);
  const outboundJeChain = obM ? obM[1].split(/\s*[·•]\s*/).map(x => { const m2 = x.trim().match(/^([A-Z0-9.]+)\s+(\d+)$/); return m2 ? { chain: m2[1], anzahl: Number(m2[2]) } : null; }).filter(Boolean) : [];
  const refundsM = html.match(/<h2>Refunds<\/h2>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/);
  const refunds = refundsM ? [...refundsM[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(r => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => opsText(c[1])))
    .filter(c => c.length >= 5).map(c => ({ chain: c[0], betrag: c[1], asset: c[2], an: c[3], hoehe: c[4] })) : [];
  return { aufgaben: eindeutig, upgrade: { version: verM ? verM[1] : null, stufen: stufen.filter(x => x.name) }, aufgabenStand: standM ? standM[1] : null, outboundJeChain, refunds };
}
// BLOCKZEIT (gefragt: "was ist mit der Blockzeit?"): Durchschnitt ueber die letzten 50 Bloecke aus
// dem Tendermint-RPC (Zeitstempel des neuesten und des 50 Bloecke aelteren Blocks), wie auf der
// Ops-Seite ("avg block, last 50, nominal 6s").
const OPS_RPC_BASES = ['https://rpc.ninerealms.com', 'https://rpc.thorchain.liquify.com', 'https://rpc.thorswap.net'];
async function opsBlockzeit() {
  for (const b of OPS_RPC_BASES) {
    try {
      const st = await (await fetchWithTimeout(b + '/status', { timeoutMs: 6000 })).json();
      const si = st && (st.result || st).sync_info;
      const h = Number(si && si.latest_block_height), t1 = Date.parse(si && si.latest_block_time);
      if (!(h > 60) || !Number.isFinite(t1)) continue;
      const bl = await (await fetchWithTimeout(b + '/block?height=' + (h - 50), { timeoutMs: 6000 })).json();
      const t0 = Date.parse(((bl && (bl.result || bl).block) || {}).header?.time);
      if (!Number.isFinite(t0)) continue;
      return { hoehe: h, blockzeit: Math.round((t1 - t0) / 50) / 1000 };
    } catch (e) { /* naechste Quelle */ }
  }
  return null;
}
async function handleOps(request, env) {
  if (opsCache && Date.now() - opsCache.at < OPS_CACHE_MS) return json(opsCache.daten, env);
  const basis = 'https://devops.thorchain.org';
  // Chain-Daten (Blockzeit, Queues, Halts, LP-Pausen) werden in der App nicht mehr gezeigt (auf
  // Wunsch) -- deshalb hier auch nicht mehr abgefragt.
  const [seite, feed] = await Promise.allSettled([
    fetchWithTimeout(basis + '/', { timeoutMs: 12000 }).then(r => r.text()),
    fetchWithTimeout(basis + '/api/feed.json', { timeoutMs: 8000 }).then(r => r.json()),
  ]);
  const mimir = { status: 'rejected' }, queue = { status: 'rejected' }, block = { status: 'rejected' };
  const bz = block.status === 'fulfilled' ? block.value : null;
  const teil = seite.status === 'fulfilled' ? parseOpsHtml(seite.value) : { aufgaben: [], upgrade: null, aufgabenStand: null };
  const m = mimir.status === 'fulfilled' ? mimir.value : null;
  const halts = m ? Object.entries(m).filter(([k, v]) => /^(HALT|PAUSE)/.test(k) && Number(v) > 0 && !/^PAUSELP/.test(k)).map(([k]) => k).sort() : [];
  const lpPausiert = m ? Object.entries(m).filter(([k, v]) => /^PAUSELP/.test(k) && Number(v) > 0).length : null;
  const q = queue.status === 'fulfilled' ? queue.value : null;
  const daten = {
    quelle: basis,
    stand: new Date().toISOString(),
    feed: feed.status === 'fulfilled' && feed.value && Array.isArray(feed.value.items) ? feed.value.items.slice(0, 20) : [],
    ...teil,
    chain: { hoehe: bz ? bz.hoehe : null, blockzeit: bz ? bz.blockzeit : null, halts, lpPausiert, swapQueue: q ? Number(q.swap) || 0 : null, outboundQueue: q ? Number(q.outbound) || 0 : null, internalQueue: q ? Number(q.internal) || 0 : null },
    fehler: [seite, feed].map((x, i) => x.status === 'rejected' ? ['seite', 'feed'][i] + ': ' + (x.reason?.message || x.reason) : null).filter(Boolean),
  };
  opsCache = { at: Date.now(), daten };
  return json(daten, env);
}

const DEX_PROTOCOLS = [
  { key: 'chainflip', name: 'Chainflip', slug: 'chainflip', feeFormel: 'fees-minus-userfees' },
  { key: 'near-intents', name: 'NEAR Intents', slug: 'near-intents', feeFormel: 'nicht-vergleichbar' },
  // MAYA PROTOCOL (auf Wunsch, "wenn sie wieder live sind"): seit dem Exploit vom 18.08.2026 ist
  // MAYAChain angehalten. Die Daten laufen trotzdem mit; die Karte zeigt Maya erst, wenn wieder
  // Volumen da ist (Feld "live" unten).
  //
  // QUELLE JETZT MAYAS EIGENES MIDGARD (gewuenscht: "die offiziellen Volumen-Daten von Maya").
  // DefiLlama bleibt nur als Lueckenfueller fuer einzelne Tage.
  //
  // Und der Grund, warum "Fees earned" fuer Maya nie stimmen konnte: Der DefiLlama-Adapter
  // (dexs/mayachain.ts) meldet dailyUserFees = dailyFees = Swap-Gebuehren. Die Chainflip-Formel
  // "dailyFees - dailyUserFees" ergab bei Maya deshalb an JEDEM Tag exakt 0.
  { key: 'maya', name: 'Maya Protocol', slug: 'maya-protocol', feeFormel: 'maya-midgard' },
];

// MAYA MIDGARD. Gleiches Schema wie THORChains Midgard, mit zwei Unterschieden:
//   - Kurs heisst cacaoPriceUSD statt runePriceUSD
//   - CACAO hat 10 Nachkommastellen (1e10), RUNE nur 8
// Ersatzadressen per Worker-Variable MAYA_MIDGARD_EXTRA_BASES (kommagetrennt).
function getMayaMidgardBases() {
  const env = currentEnv || {};
  const bases = ['https://midgard.mayachain.info/v2'];
  if (env.MAYA_MIDGARD_EXTRA_BASES) {
    for (const b of String(env.MAYA_MIDGARD_EXTRA_BASES).split(',')) {
      const t2 = b.trim().replace(/\/+$/, '');
      if (t2) bases.push(t2);
    }
  }
  return bases;
}
const CACAO_BASIS = 1e10;

// Volumen UND Gebuehren aus EINER Reihe (/history/swaps): totalVolume und totalFees, beide in
// CACAO-Basiseinheiten, mal Tageskurs. totalFees ist dieselbe Groesse, die bei THORChain ueber
// vanaheimex in "Fees earned" steht -- die Zeilen bleiben also vergleichbar.
//
// NULL SWAPS SIND BEI MAYA ECHT: Seit dem Exploit steht die Chain, ein Tag ohne Swaps ist dort
// eine wahre 0, kein Loch wie bei Liquify. Unterschieden wird ueber den Kurs: Ein Loch in der
// Datenbank kommt ohne Kurs (alles 0), eine angehaltene Chain hat weiterhin einen.
async function fetchMayaMidgardDaily(tage) {
  const json = await fetchFromBases(getMayaMidgardBases(), `/history/swaps?interval=day&count=${Math.min(100, tage + 2)}`, { timeoutMs: 12000 });
  const intervalle = (json && json.intervals) || [];
  const proTag = new Map();
  for (const iv of intervalle) {
    const start = parseInt(iv.startTime, 10);
    if (!Number.isFinite(start)) continue;
    const preis = parseFloat(iv.cacaoPriceUSD);
    const vol = Number(iv.totalVolume) / CACAO_BASIS;
    const fees = Number(iv.totalFees) / CACAO_BASIS;
    const tag = tagesSchluessel(start);
    if (!(preis > 0) || !Number.isFinite(vol) || !Number.isFinite(fees)) {
      proTag.set(tag, { volumen: null, gebuehren: null });
      continue;
    }
    proTag.set(tag, { volumen: vol * preis, gebuehren: fees * preis, swaps: Number(iv.totalCount) || 0 });
  }
  return proTag;
}
const LLAMA_BASES = ['https://api.llama.fi'];

function tagesSchluessel(sekunden) {
  return new Date(sekunden * 1000).toISOString().slice(0, 10); 
}

async function fetchLlamaSummary(slug) {
  
  return fetchFromBases(LLAMA_BASES, `/summary/dexs/${slug}?excludeTotalDataChartBreakdown=true`, { timeoutMs: 12000 });
}

async function fetchLlamaFees(slug) {
  return fetchFromBases(LLAMA_BASES, `/summary/fees/${slug}?excludeTotalDataChartBreakdown=true&dataType=dailyFees`, { timeoutMs: 12000 });
}

async function fetchLlamaSupplySide(slug) {
  return fetchFromBases(LLAMA_BASES, `/summary/fees/${slug}?excludeTotalDataChartBreakdown=true&dataType=dailySupplySideRevenue`, { timeoutMs: 12000 });
}

async function fetchLlamaUserFees(slug) {
  return fetchFromBases(LLAMA_BASES, `/summary/fees/${slug}?excludeTotalDataChartBreakdown=true&dataType=dailyUserFees`, { timeoutMs: 12000 });
}

let midgardSplitRoh = null;
function merkeSplit(intervalle) {
  let bonding = 0, liquidity = 0;
  for (const iv of intervalle) {
    const b = Number(iv.bondingEarnings), l = Number(iv.liquidityEarnings);
    if (Number.isFinite(b)) bonding += b;
    if (Number.isFinite(l)) liquidity += l;
  }
  const summe = bonding + liquidity;
  midgardSplitRoh = summe > 0
    ? { nodesPct: Math.round(bonding / summe * 1000) / 10, poolsPct: Math.round(liquidity / summe * 1000) / 10 }
    : null;
}

// FEHLENDE KURSE BEI MIDGARD (gemeldet: "THORChain zeigt 0 bei Volumen und Gebuehren").
//
// Midgards Health meldete inSync:false und lastThorNode VIER TAGE zurueck. Die Datenbank hat
// die Swaps des Tages, aber ohne THORNode-Daten fehlt der RUNE-Kurs: runePriceUSD kommt als 0,
// und damit sind ALLE Dollarwerte des Tages 0 -- auch totalVolumeUSD. Das RUNE-Volumen selbst
// ist da (deshalb laeuft die Volumenkarte weiter, die rechnet in RUNE).
//
// Ausdruecklich NICHT selbst umgerechnet: ein geschaetzter Dollarwert waere nicht von einem
// gemessenen zu unterscheiden. Solche Tage bekommen volume = null und gelten als "kein Wert";
// die Karte zeigt dann einen Strich und nennt die Quelle als Ursache.
// WANN IST EIN TAG "KEINE DATEN" STATT "NULL DOLLAR"?
//
// Nachgesehen in Liquifys Midgard: der 22.09. kam mit totalCount 0 und ueberall Nullen zurueck,
// der Tag davor mit 203.099 Swaps. Ein Tag mit NULL Swaps kommt bei THORChain praktisch nicht
// vor -- das ist ein Loch in der Datenbank der Quelle, keine echte Null. Genau daran wird es
// erkannt: keine einzige Transaktion gezaehlt -> Wert unbekannt.
function tagOhneDaten(anzahl) {
  return !(Number(anzahl) > 0);
}

async function fetchMidgardDailyFees(tage) {
  const json = await fetchFromBases(getMidgardBases(), `/history/earnings?interval=day&count=${Math.min(100, tage + 2)}`, { timeoutMs: 12000 });
  const intervalle = (json && json.intervals) || [];
  merkeSplit(intervalle);
  return intervalle.map((iv) => {
    const feesRune = Number(iv.liquidityFees) / 1e8;
    const preis = parseFloat(iv.runePriceUSD);
    const ende = parseInt(iv.endTime, 10);
    const tag = tagesSchluessel(ende - 1);
    const usd = Number.isFinite(feesRune) && Number.isFinite(preis) ? feesRune * preis : 0;
    // Keine Gebuehren an einem ganzen Tag gibt es bei laufendem Netz nicht -> Luecke.
    if (tagOhneDaten(iv.liquidityFees)) return { day: tag, volume: null };
    return { day: tag, volume: usd };
  });
}

// TAGESLUECKEN AUS STUNDENWERTEN SCHLIESSEN.
//
// Nachgemessen bei Liquify: fuer den 22.09. meldete die TAGES-Reihe totalCount 0, waehrend die
// STUNDEN-Reihe desselben Tages normale Werte hatte (17-22 Uhr UTC: 26, 57, 65, 38, 54 Mio.
// USD). Bei Midgard haengt also nur die Tagesaggregation, nicht die Datenbank.
//
// Deshalb: Stundenwerte mitholen (100 Intervalle, gut vier Tage) und je Tag aufsummieren.
// Benutzt wird das NUR fuer Tage, die in der Tagesreihe fehlen, und nur, wenn alle 24 Stunden
// vorliegen -- ein halber Tag waere schlimmer als gar keiner.
async function fetchMidgardHourlyPerDay() {
  try {
    const json = await fetchFromBases(getMidgardBases(), '/history/swaps?interval=hour&count=100', { timeoutMs: 12000 });
    const intervalle = (json && json.intervals) || [];
    const proTag = new Map();
    for (const iv of intervalle) {
      const ende = parseInt(iv.endTime, 10);
      if (!Number.isFinite(ende)) continue;
      const tag = tagesSchluessel(ende - 1);
      const usd = parseFloat(iv.totalVolumeUSD) / 1e2;
      const anzahl = Number(iv.totalCount) || 0;
      const bisher = proTag.get(tag) || { usd: 0, stunden: 0, mitDaten: 0 };
      bisher.usd += Number.isFinite(usd) ? usd : 0;
      bisher.stunden += 1;
      if (anzahl > 0) bisher.mitDaten += 1;
      proTag.set(tag, bisher);
    }
    return proTag;
  } catch (e) {
    return new Map();
  }
}

// LETZTE ABSICHERUNG: vanaheimex.com/api/dashboardData.
//
// Das ist der Server, aus dem der offizielle Explorer thorchain.net seine "Volume (24hr)"-Zahl
// nimmt (stats.volume24USD, dort ebenfalls durch 100 geteilt). Er wird NUR angefragt, wenn
// sowohl die Tages- als auch die Stundenreihe von Midgard nichts hergeben -- also wenn bei
// Liquify wirklich alles haengt.
//
// Wichtig: Das ist ein ROLLIERENDER 24-Stunden-Wert, kein Kalendertag. Er taugt deshalb nur
// als Notnagel fuer den letzten Tag, und die Karte weist ihn als solchen aus (siehe
// thorchainNotfallQuelle in der Antwort).
// TAGESREIHE VON VANAHEIMEX (Quelle der Balken auf thorchain.net).
//
// Deren Chart liest data.swaps.intervals und rechnet totalVolumeUSD/100 -- also GENAU das
// Midgard-Format, nur von einer eigenen, laufenden Instanz. Damit lassen sich ganze Tage
// ersetzen, nicht nur ein rollierender 24h-Wert.
//
// Reihenfolge im Worker: Midgard-Tageswerte, dann Midgard-Stundenwerte, dann diese Reihe,
// zuletzt der 24h-Notnagel.
async function fetchVanaheimexDaily() {
  try {
    const json = await fetchFromBases(['https://vanaheimex.com'], '/api/dashboardPlots', { timeoutMs: 9000 });
    const intervalle = (json && json.swaps && json.swaps.intervals) || [];
    const proTag = new Map();
    for (const iv of intervalle) {
      // Tag ueber startTime bestimmen, nicht ueber endTime: beim LAUFENDEN Tag setzt
      // vanaheimex endTime auf "jetzt", Midgard auf Mitternacht -- ueber endTime gerechnet
      // landeten dieselben Tage auf zwei verschiedenen Schluesseln.
      const start = parseInt(iv.startTime, 10);
      if (!Number.isFinite(start)) continue;
      const usd = parseFloat(iv.totalVolumeUSD) / 1e2;
      // GEBUEHREN aus derselben Reihe: totalFees steht in RUNE-Basiseinheiten, mal Tageskurs.
      // /api/rawEarnings liefert nur meta ohne intervals, taugt also nicht. Gegengerechnet am
      // 21.09.: 96.838 RUNE * 0,6345 = 61,4 Tsd. $ -- dieselbe Groesse, die Midgard meldet.
      const feesRune = Number(iv.totalFees) / 1e8;
      const preis = parseFloat(iv.runePriceUSD);
      const feesUsd = Number.isFinite(feesRune) && Number.isFinite(preis) ? feesRune * preis : 0;
      if (!(usd > 0) && !(feesUsd > 0)) continue;
      proTag.set(tagesSchluessel(start), {
        volumen: usd > 0 ? usd : null,
        gebuehren: feesUsd > 0 ? feesUsd : null,
      });
    }
    return proTag;
  } catch (e) {
    return new Map();
  }
}

async function fetchVanaheimex24h() {
  try {
    const json = await fetchFromBases(['https://vanaheimex.com'], '/api/dashboardData', { timeoutMs: 8000 });
    const roh = Number(json && json.stats && json.stats.volume24USD);
    return Number.isFinite(roh) && roh > 0 ? roh / 1e2 : null;
  } catch (e) {
    return null;
  }
}

async function fetchMidgardDailyVolume(tage) {
  const json = await fetchFromBases(getMidgardBases(), `/history/swaps?interval=day&count=${Math.min(100, tage + 2)}`, { timeoutMs: 12000 });
  const intervalle = (json && json.intervals) || [];
  return intervalle.map((iv) => {
    // Midgard liefert totalVolumeUSD in CENT -- daher /1e2 (gegengerechnet: totalVolume/1e8
    // mal runePriceUSD ergibt denselben Betrag).
    const vol = parseFloat(iv.totalVolumeUSD) / 1e2;
    const ende = parseInt(iv.endTime, 10);
    const tag = tagesSchluessel(ende - 1);
    // Kein einziger Swap an dem Tag -> Luecke bei der Quelle, kein Volumen von 0.
    if (tagOhneDaten(iv.totalCount)) return { day: tag, volume: null };
    return { day: tag, volume: Number.isFinite(vol) ? vol : 0 };
  });
}

function summiereTage(reihe, tage, letzterTag) {
  
  const grenze = new Date(letzterTag + 'T00:00:00.000Z').getTime() - (tage - 1) * 86400000;
  let summe = 0, gezaehlt = 0, ohneWert = 0;
  for (const e of reihe) {
    const t = new Date(e.day + 'T00:00:00.000Z').getTime();
    if (t >= grenze && e.day <= letzterTag) {
      // volume === null: Quelle hatte an dem Tag keinen Kurs (siehe preisFehlt). Solche Tage
      // duerfen die Summe nicht als 0 verwaessern -- sie werden gezaehlt und gemeldet.
      if (e.volume == null) { ohneWert++; continue; }
      summe += e.volume; gezaehlt++;
    }
  }
  return { summe, tage: gezaehlt, ohneWert };
}

async function baueDexVergleich() {
  const roh = await Promise.allSettled([
    ...DEX_PROTOCOLS.map((p) => fetchLlamaSummary(p.slug)),
    fetchMidgardDailyVolume(30),
    fetchMidgardDailyFees(30),
    fetchMidgardHourlyPerDay(),
    fetchVanaheimexDaily(),
    fetchVanaheimex24h(),
    ...DEX_PROTOCOLS.map((p) => fetchLlamaFees(p.slug)),
    ...DEX_PROTOCOLS.map((p) => fetchLlamaSupplySide(p.slug)),
    // Ganz hinten angehaengt, damit sich die Indizes davor nicht verschieben.
    ...DEX_PROTOCOLS.map((p) => p.feeFormel === 'fees-minus-userfees' ? fetchLlamaUserFees(p.slug) : Promise.resolve(null)),
    // Maya Midgard -- wieder ganz hinten, aus demselben Grund.
    fetchMayaMidgardDaily(30),
  ]);
  const mayaRoh = roh[DEX_PROTOCOLS.length + 5 + 3 * DEX_PROTOCOLS.length];
  const mayaTage = mayaRoh && mayaRoh.status === 'fulfilled' ? mayaRoh.value : new Map();

  const reihen = {};
  const fehler = {};
  const mayaFehler = mayaRoh && mayaRoh.status !== 'fulfilled' ? (mayaRoh.reason?.message || String(mayaRoh.reason || 'NO_DATA')) : null;
  DEX_PROTOCOLS.forEach((p, i) => {
    const r = roh[i];
    if (r.status !== 'fulfilled' || !r.value) {
      fehler[p.key] = r.reason?.message || String(r.reason || 'NO_DATA');
      return;
    }
    const chart = Array.isArray(r.value.totalDataChart) ? r.value.totalDataChart : [];
    
    const proTag = new Map();
    for (const eintrag of chart) {
      if (!Array.isArray(eintrag) || eintrag.length < 2) continue;
      const tag = tagesSchluessel(Number(eintrag[0]));
      const v = Number(eintrag[1]);
      if (!Number.isFinite(v)) continue;
      proTag.set(tag, (proTag.get(tag) || 0) + v);
    }
    reihen[p.key] = [...proTag.entries()].map(([day, volume]) => ({ day, volume })).sort((a, b) => a.day < b.day ? -1 : 1);
  });

  const midgardReihe = roh[DEX_PROTOCOLS.length].status === 'fulfilled' ? roh[DEX_PROTOCOLS.length].value : null;
  const midgardFees = roh[DEX_PROTOCOLS.length + 1].status === 'fulfilled' ? roh[DEX_PROTOCOLS.length + 1].value : null;
  const midgardStunden = roh[DEX_PROTOCOLS.length + 2].status === 'fulfilled' ? roh[DEX_PROTOCOLS.length + 2].value : new Map();
  const vanaheimexTage = roh[DEX_PROTOCOLS.length + 3].status === 'fulfilled' ? roh[DEX_PROTOCOLS.length + 3].value : new Map();
  const vanaheimex24h = roh[DEX_PROTOCOLS.length + 4].status === 'fulfilled' ? roh[DEX_PROTOCOLS.length + 4].value : null;
  const llamaFees = {}, llamaSupply = {}, llamaUser = {};
  // +5: davor stehen Midgard-Tageswerte, Midgard-Gebuehren, die Stundenwerte, die Tagesreihe
  // von vanaheimex und dessen 24h-Notnagel.
  DEX_PROTOCOLS.forEach((p, i) => {
    const r = roh[DEX_PROTOCOLS.length + 5 + i];
    if (r && r.status === 'fulfilled' && r.value) llamaFees[p.key] = r.value;
    const r2 = roh[DEX_PROTOCOLS.length + 5 + DEX_PROTOCOLS.length + i];
    if (r2 && r2.status === 'fulfilled' && r2.value) llamaSupply[p.key] = r2.value;
    const r3 = roh[DEX_PROTOCOLS.length + 5 + 2 * DEX_PROTOCOLS.length + i];
    if (r3 && r3.status === 'fulfilled' && r3.value) llamaUser[p.key] = r3.value;
  });

  // VANAHEIMEX ZUERST, Midgard (Liquify) nur als Absicherung.
  //
  // Die Tagesreihe entsteht aus der Vereinigung beider Quellen: Jeder Tag, fuer den vanaheimex
  // einen Wert hat, kommt von dort. Midgard fuellt nur Tage, die bei vanaheimex fehlen, und
  // traegt die ganze Reihe, wenn vanaheimex komplett ausfaellt.
  const heuteTag = tagesSchluessel(Math.floor(Date.now() / 1000));
  const thorVanaTage = [];
  const thorMidgardTage = [];
  {
    const midgardNach = new Map((midgardReihe || []).map((e) => [e.day, e]));
    const vana = vanaheimexTage || new Map();
    const alleTage = [...new Set([...midgardNach.keys(), ...vana.keys()])]
      .filter((d) => d <= heuteTag).sort();
    const reihe = alleTage.map((day) => {
      const v = vana.get(day);
      if (v && v.volumen > 0) { thorVanaTage.push(day); return { day, volume: v.volumen, quelle: 'vanaheimex-tag' }; }
      const m = midgardNach.get(day);
      if (m && m.volume != null) { thorMidgardTage.push(day); return { day, volume: m.volume, quelle: 'midgard' }; }
      return { day, volume: null };
    });
    if (reihe.length) reihen['thorchain'] = reihe;
    else fehler['thorchain'] = 'VANAHEIMEX_UND_MIDGARD_OHNE_DATEN';
  }

  // NEAR INTENTS: Volumen aus Dune (NEARs eigener Datensatz) zuerst -- es ist dieselbe Quelle
  // wie bei DefiLlama, nur direkt. DefiLlama fuellt Tage, die in Dune (noch) fehlen.
  const nearDuneTageVol = [];
  if (nearDune.tage.size) {
    const llamaNach = new Map((reihen['near-intents'] || []).map((e) => [e.day, e]));
    const alleTage = [...new Set([...nearDune.tage.keys(), ...llamaNach.keys()])].filter((d) => d <= heuteTag).sort();
    const reihe = alleTage.map((day) => {
      const d = nearDune.tage.get(day);
      if (d && Number.isFinite(d.vol)) { nearDuneTageVol.push(day); return { day, volume: d.vol, quelle: 'dune-near' }; }
      const l = llamaNach.get(day);
      return l ? { ...l, quelle: 'defillama' } : { day, volume: null };
    }).slice(-40);
    if (reihe.length) { reihen['near-intents'] = reihe; delete fehler['near-intents']; }
  }

  // MAYA: Mayas Midgard zuerst, DefiLlama nur fuer Tage, die dort fehlen (Ausfall der Instanz).
  // DefiLlama liest selbst aus demselben Midgard -- die Zahlen sind gleich definiert, nur spaeter.
  const mayaMidgardTage = [], mayaLlamaTage = [];
  {
    const llamaNach = new Map((reihen['maya'] || []).map((e) => [e.day, e]));
    const alleTage = [...new Set([...mayaTage.keys(), ...llamaNach.keys()])]
      .filter((d) => d <= heuteTag).sort();
    const reihe = alleTage.map((day) => {
      const m = mayaTage.get(day);
      if (m && m.volumen != null) { mayaMidgardTage.push(day); return { day, volume: m.volumen, quelle: 'maya-midgard' }; }
      const l = llamaNach.get(day);
      if (l && l.volume != null) { mayaLlamaTage.push(day); return { day, volume: l.volume, quelle: 'defillama' }; }
      return { day, volume: null };
    }).slice(-40);
    if (reihe.length) { reihen['maya'] = reihe; delete fehler['maya']; }
    else if (mayaFehler) fehler['maya'] = 'MAYA_MIDGARD: ' + mayaFehler;
  }

  // Danach die Reste aus Midgards Stundenwerten (siehe
  // fetchMidgardHourlyPerDay). Nur vollstaendige Tage, und nur, wenn tatsaechlich Swaps
  // gezaehlt wurden -- sonst bliebe es bei "kein Wert".
  const thorStundenTage = [];
  if (reihen['thorchain'] && midgardStunden && midgardStunden.size) {
    reihen['thorchain'] = reihen['thorchain'].map((eintrag) => {
      if (eintrag.volume != null) return eintrag;
      const std = midgardStunden.get(eintrag.day);
      // Gemessen: fuer den 22.09. liefert Midgard nur 23 Stundenintervalle -- die letzte Stunde
      // vor Mitternacht fehlt ganz. Die urspruengliche Bedingung "alle 24" verwarf deshalb
      // jeden Tag. Jetzt reichen 20 Stunden MIT Daten; der Tag ist dann leicht zu niedrig,
      // aber um Groessenordnungen richtiger als gar kein Wert. Wie viele Stunden es waren,
      // steht in der Antwort.
      if (!std || std.mitDaten < 20 || !(std.usd > 0)) return eintrag;
      thorStundenTage.push({ tag: eintrag.day, stunden: std.mitDaten });
      return { day: eintrag.day, volume: std.usd, quelle: 'midgard-stunden' };
    });
  }

  // Wenn danach IMMER NOCH kein einziger der letzten beiden Tage einen Wert hat, greift die
  // letzte Absicherung: der rollierende 24-Stunden-Wert von vanaheimex (Quelle von
  // thorchain.net). Er wird dem letzten fehlenden Tag zugeordnet und offen ausgewiesen.
  // Greift, sobald der LETZTE Tag der Reihe noch immer keinen Wert hat -- vorher verlangte die
  // Regel zwei leere Tage in Folge und sprang deshalb nie an.
  let thorNotfall = null;
  if (reihen['thorchain'] && reihen['thorchain'].length && vanaheimex24h) {
    const letzter = reihen['thorchain'][reihen['thorchain'].length - 1];
    if (letzter && letzter.volume == null) {
      reihen['thorchain'] = reihen['thorchain'].map((e) =>
        e.day === letzter.day ? { day: e.day, volume: vanaheimex24h, quelle: 'vanaheimex-24h' } : e);
      thorNotfall = letzter.day;
    }
  }


  const heute = tagesSchluessel(Math.floor(Date.now() / 1000));
  const letzteTage = Object.values(reihen).filter((r) => r.length)
    .map((r) => { const nurAbgeschlossen = r.filter((e) => e.day < heute); return nurAbgeschlossen.length ? nurAbgeschlossen[nurAbgeschlossen.length - 1].day : null; })
    .filter(Boolean);
  // NACHZUEGLER NICHT ALLES AUFHALTEN LASSEN (gemeldet: "Was ist mit DefiLlama?" -- Anzeige stand
  // am 26. noch auf dem 22., weil EINE DefiLlama-Reihe seit Tagen nichts Neues hatte). Quellen,
  // die mehr als 1 Tag hinter der neuesten liegen, bestimmen den Stichtag nicht mehr; sie stehen
  // fuer den Stichtag ohne Wert ("wartet auf DefiLlama") und holen von selbst auf.
  const tagMinus = (tag, n) => new Date(Date.parse(tag + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
  const juengster = letzteTage.length ? letzteTage.slice().sort().pop() : null;
  const aktuelle = juengster ? letzteTage.filter(d => d >= tagMinus(juengster, 1)) : [];
  const stichtag = aktuelle.length ? aktuelle.slice().sort()[0] : (letzteTage.length ? letzteTage.slice().sort()[0] : null);
  // Welche Quelle haengt hinterher? Der Stichtag ist bewusst der FRUEHESTE gemeinsame Tag
  // (sonst stuende ein voller Tag THORChain gegen einen halben Tag Chainflip). Nur sagte die
  // Anzeige nie, WORAUF sie wartet -- gemeldet: "warum noch nicht der 20., es ist doch nach
  // 0:00 UTC". Midgard hat den Tag sofort, DefiLlama aggregiert Stunden spaeter.
  const letzterTagJe = {};
  for (const [key, r] of Object.entries(reihen)) {
    const fertig = (r || []).filter((e) => e.day < heute);
    letzterTagJe[key] = fertig.length ? fertig[fertig.length - 1].day : null;
  }
  const neuesterTag = letzteTage.length ? letzteTage.slice().sort().pop() : null;
  const nachzuegler = stichtag && neuesterTag && neuesterTag > stichtag
    ? Object.entries(letzterTagJe).filter(([, d]) => !d || d <= stichtag).map(([k]) => k)
    : [];
  // Quellen, die fuer den Stichtag gar keinen Wert haben (laenger als 1 Tag im Rueckstand).
  const veraltetSeit = Object.fromEntries(Object.entries(letzterTagJe).filter(([, d]) => d && stichtag && d < stichtag));

  const ALLE = [{ key: 'thorchain', name: 'THORChain', source: thorMidgardTage.length && !thorVanaTage.length ? 'midgard' : 'vanaheimex' },
    ...DEX_PROTOCOLS.map((p) => ({ key: p.key, name: p.name,
      source: p.key === 'maya' && mayaMidgardTage.length ? 'maya-midgard' : (p.key === 'near-intents' && nearDuneTageVol.length ? 'dune-near' : 'defillama') }))];
  const protokolle = ALLE.map((p) => {
    const reihe = reihen[p.key] || [];
    if (!reihe.length || !stichtag) {
      return { key: p.key, name: p.name, source: p.source, error: fehler[p.key] || 'NO_DATA', d1: null, d7: null, d30: null };
    }
    const d1 = summiereTage(reihe, 1, stichtag);
    const d7 = summiereTage(reihe, 7, stichtag);
    const d30 = summiereTage(reihe, 30, stichtag);
    // Kein einziger Tag mit Wert, aber Tage ohne Kurs -> Wert unbekannt (null), nicht 0.
    // Die Karte zeigt dafuer einen Strich und nennt die Quelle (siehe quelleProblem).
    const wert = (x) => (x.tage === 0 && x.ohneWert > 0) ? null : x.summe;
    const luecken = d30.ohneWert > 0;
    return {
      key: p.key, name: p.name, source: p.source,
      d1: wert(d1), d7: wert(d7), d30: wert(d30),
      days1: d1.tage, days7: d7.tage, days30: d30.tage,
      // Welche Quelle hakt -- die Karte zeigt das als Hinweis an.
      quelleProblem: luecken ? p.source : null,
      tageOhneWert: luecken ? { d1: d1.ohneWert, d7: d7.ohneWert, d30: d30.ohneWert } : null,
      
      series: reihe.filter((e) => e.day <= stichtag).slice(-30),
      // LIVE = in den letzten 2 Tagen echtes Volumen (fuer Maya: wieder am Netz?)
      live: reihe.filter((e) => e.day <= stichtag).slice(-2).some((e) => Number(e.volume) > 0),
      error: null,
    };
  });

  const alsReihe = (j) => {
    const chart = j && Array.isArray(j.totalDataChart) ? j.totalDataChart : [];
    if (!chart.length) return null;
    const proTag = new Map();
    for (const e of chart) {
      if (!Array.isArray(e) || e.length < 2) continue;
      const tag = tagesSchluessel(Number(e[0]));
      const v = Number(e[1]);
      if (Number.isFinite(v)) proTag.set(tag, (proTag.get(tag) || 0) + v);
    }
    return [...proTag.entries()].map(([day, volume]) => ({ day, volume })).sort((a, b) => a.day < b.day ? -1 : 1);
  };
  
  const feeReihen = {}, feeAllReihen = {};
  // Gebuehren ebenso: vanaheimex (totalFees * Tageskurs) zuerst, Midgards liquidityFees nur
  // fuer Tage, die bei vanaheimex fehlen.
  const thorGebuehrenTage = [];
  const thorGebuehrenMidgardTage = [];
  {
    const midgardNach = new Map((midgardFees || []).map((e) => [e.day, e]));
    const vana = vanaheimexTage || new Map();
    const alleTage = [...new Set([...midgardNach.keys(), ...vana.keys()])]
      .filter((d) => d <= heuteTag).sort();
    const reihe = alleTage.map((day) => {
      const v = vana.get(day);
      if (v && v.gebuehren > 0) { thorGebuehrenTage.push(day); return { day, volume: v.gebuehren, quelle: 'vanaheimex-tag' }; }
      const m = midgardNach.get(day);
      if (m && m.volume != null) { thorGebuehrenMidgardTage.push(day); return { day, volume: m.volume, quelle: 'midgard' }; }
      return { day, volume: null };
    });
    if (reihe.length) feeReihen['thorchain'] = reihe;
  }
  // Neuer Name der Grundlage -> haltAlteTageFest verwirft die frueher festgehaltenen
  // Midgard-Gebuehrentage einmalig und uebernimmt die vanaheimex-Werte.
  const feeBasisJe = { thorchain: 'vanaheimex-totalFees' };
  const rohReihen = {};
  for (const p of DEX_PROTOCOLS) {
    const alles = alsReihe(llamaFees[p.key]);
    if (alles) feeAllReihen[p.key] = alles;
    if (p.feeFormel === 'fees-minus-userfees') {
      // Nur Tage, fuer die BEIDE Reihen vorliegen. Fehlt dailyUserFees fuer einen Tag, ist der
      // Wert unbekannt (null) -- auf keinen Fall die Bruttozahl samt Gas und Broker zeigen.
      const user = alsReihe(llamaUser[p.key]);
      if (alles && user) {
        const userJeTag = new Map(user.map((e) => [e.day, e.volume]));
        feeReihen[p.key] = alles.map((e) => {
          const u = userJeTag.get(e.day);
          if (!Number.isFinite(u)) return { day: e.day, volume: null };
          const netto = e.volume - u;
          // Mehr Nutzergebuehren als Gesamtgebuehren kann es nach der Adapter-Logik nicht geben;
          // taucht das auf, ist der Tag in der Quelle kaputt, nicht negativ.
          return { day: e.day, volume: netto >= 0 ? netto : null };
        });
        feeBasisJe[p.key] = 'defillama-fees-minus-userFees';
      }
    } else if (p.feeFormel === 'maya-midgard') {
      // Mayas Midgard (totalFees * Tageskurs) zuerst. Lueckenfueller ist DefiLlamas dailyFees
      // -- NICHT minus dailyUserFees (das waere bei Maya immer 0, siehe DEX_PROTOCOLS).
      const llamaNach = new Map((alles || []).map((e) => [e.day, e.volume]));
      const alleTage = [...new Set([...mayaTage.keys(), ...llamaNach.keys()])]
        .filter((d) => d <= heuteTag).sort();
      const reihe = alleTage.map((day) => {
        const m = mayaTage.get(day);
        if (m && m.gebuehren != null) return { day, volume: m.gebuehren, quelle: 'maya-midgard' };
        const l = llamaNach.get(day);
        if (Number.isFinite(l)) return { day, volume: l, quelle: 'defillama' };
        return { day, volume: null };
      }).slice(-40);
      if (reihe.length) { feeReihen[p.key] = reihe; feeBasisJe[p.key] = 'maya-midgard-totalFees'; }
    } else if (p.feeFormel === 'supplyside') {
      const supply = alsReihe(llamaSupply[p.key]);
      if (supply) { feeReihen[p.key] = supply; feeBasisJe[p.key] = 'defillama-supplySide'; }
    }
    // NEAR mit Dune-Daten: die PROTOKOLLGEBUEHR allein (ohne Affiliate-Gebuehren der Frontends)
    // ist vergleichbar mit THORChains liquidityFees -> regulaere Reihe statt "nicht vergleichbar".
    if (p.key === 'near-intents' && nearDune.tage.size) {
      const reihe = [...nearDune.tage.entries()].filter(([day, d]) => day <= heuteTag && d && Number.isFinite(d.prot))
        .map(([day, d]) => ({ day, volume: d.prot, quelle: 'dune-near-protocol-fees' })).sort((a, b) => a.day < b.day ? -1 : 1).slice(-40);
      if (reihe.length >= 3) {
        feeReihen[p.key] = reihe; feeBasisJe[p.key] = 'dune-near-protocol-fees';
        const aff = [...nearDune.tage.entries()].filter(([day, d]) => day <= heuteTag && d && Number.isFinite(d.aff))
          .map(([day, d]) => ({ day, volume: d.aff })).sort((a, b) => a.day < b.day ? -1 : 1).slice(-40);
        if (aff.length) rohReihen['near-intents-affiliate'] = aff;
      }
    }
    // 'nicht-vergleichbar': bewusst keine Reihe fuer den Vergleich (siehe DEX_PROTOCOLS).
    // Auf Wunsch wird DefiLlamas Supply-Side-Wert trotzdem als Rohzahl mitgeliefert -- er
    // erscheint in der Karte, zaehlt aber weder in die Anteile noch in den Chart.
    if (p.feeFormel === 'nicht-vergleichbar' && !feeReihen[p.key]) {
      const supply = alsReihe(llamaSupply[p.key]);
      if (supply) rohReihen[p.key] = supply;
    }
  }
  const nichtVergleichbar = new Set(DEX_PROTOCOLS.filter((p) => p.feeFormel === 'nicht-vergleichbar' && !feeReihen[p.key]).map((p) => p.key));
  for (const p of protokolle) {
    
    const j = llamaFees[p.key];
    if (j) p.feeMethodology = {
      text: (j.methodology && (j.methodology.Fees || j.methodology.fees || j.methodology.Revenue)) || null,
      url: j.methodologyURL || null,
    };
    const reihe = feeReihen[p.key];
    if (reihe && reihe.length && stichtag) {
      const f1 = summiereTage(reihe, 1, stichtag), f7 = summiereTage(reihe, 7, stichtag), f30 = summiereTage(reihe, 30, stichtag);
      p.fees = { d1: (f1.tage === 0 && f1.ohneWert > 0) ? null : f1.summe,
                 d7: (f7.tage === 0 && f7.ohneWert > 0) ? null : f7.summe,
                 d30: (f30.tage === 0 && f30.ohneWert > 0) ? null : f30.summe, days1: f1.tage, days7: f7.tage, days30: f30.tage };
      p.feeSeries = reihe.filter((e) => e.day <= stichtag).slice(-30);
      p.feeBasis = feeBasisJe[p.key] || null;
    } else { p.fees = null; p.feeBasis = null; p.feeSeries = []; }
    // Die Karte zeigt dafuer einen Strich mit Erklaerung statt die Zeile auszublenden.
    p.feeNichtVergleichbar = nichtVergleichbar.has(p.key);
    const roh = rohReihen[p.key];
    if (p.feeNichtVergleichbar && roh && roh.length && stichtag) {
      const r1 = summiereTage(roh, 1, stichtag), r7 = summiereTage(roh, 7, stichtag), r30 = summiereTage(roh, 30, stichtag);
      p.feesRoh = { d1: r1.tage ? r1.summe : null, d7: r7.tage ? r7.summe : null, d30: r30.tage ? r30.summe : null,
                    basis: 'defillama-supplySide' };
      // Tagesreihe dazu fuer den Chart -- auch negative Tage, genau so, wie DefiLlama sie meldet.
      p.feeRohSeries = roh.filter((e) => e.day <= stichtag).slice(-30);
    } else { p.feesRoh = null; p.feeRohSeries = null; }
    
    const alles = feeAllReihen[p.key];
    if (alles && alles.length && stichtag) {
      const a1 = summiereTage(alles, 1, stichtag), a7 = summiereTage(alles, 7, stichtag), a30 = summiereTage(alles, 30, stichtag);
      p.feesAll = { d1: a1.summe, d7: a7.summe, d30: a30.summe };
    } else p.feesAll = null;
    // NEAR: Affiliate-Gebuehren der Frontends getrennt mitliefern (Anzeige als Zusatzzeile).
    const affR = p.key === 'near-intents' ? rohReihen['near-intents-affiliate'] : null;
    if (affR && affR.length && stichtag) {
      const x1 = summiereTage(affR, 1, stichtag), x7 = summiereTage(affR, 7, stichtag), x30 = summiereTage(affR, 30, stichtag);
      p.feesAffiliate = { d1: x1.tage ? x1.summe : null, d7: x7.tage ? x7.summe : null, d30: x30.tage ? x30.summe : null, basis: 'dune-near-affiliate-fees' };
    } else if (p.key === 'near-intents') p.feesAffiliate = null;
    if (!p.fees) continue;
  }

  return {
    asOfDay: stichtag,
    // Liegt bei mindestens einer Quelle schon ein spaeterer Tag vor, steht hier welcher --
    // und welche Quellen ihn noch nicht haben.
    naechsterTag: (neuesterTag && neuesterTag > stichtag) ? neuesterTag : null,
    wartetAuf: nachzuegler,
    veraltetSeit,
    sources: { thorchain: 'vanaheimex', thorchainFallback: 'midgard', chainflip: 'defillama', 'near-intents': nearDune.tage.size ? 'dune-near' : 'defillama',
               maya: 'maya-midgard', mayaFallback: 'defillama' },
    // Maya-Tage, fuer die Mayas Midgard nichts hatte und DefiLlama einspringen musste.
    mayaLlamaTage,
    mayaMidgardFehler: mayaFehler,
    // Tage, deren Wert aus den Stundenwerten stammt, weil die Tagesreihe leer war.
    thorchainStundenTage: thorStundenTage,
    // Tage, die aus der Tagesreihe von vanaheimex stammen (Normalfall).
    thorchainVanaheimexTage: thorVanaTage,
    // Tage, fuer die vanaheimex nichts hatte und Midgard (Liquify) einspringen musste.
    thorchainMidgardTage: thorMidgardTage,
    thorchainGebuehrenMidgardTage: thorGebuehrenMidgardTage,
    // Gebuehrentage, die aus der vanaheimex-Reihe stammen.
    thorchainGebuehrenTage: thorGebuehrenTage,
    // Tag, der notfalls mit dem rollierenden 24h-Wert von vanaheimex gefuellt wurde.
    thorchainNotfallQuelle: thorNotfall ? { tag: thorNotfall, quelle: 'vanaheimex-24h' } : null,
    
    thorNodePoolSplit: midgardSplitRoh,
    protocols: protokolle,
    fetchedAt: Date.now(),
  };
}


// =====================================================================================
// NEAR INTENTS AUS DUNE (NEARs eigene Datensaetze) -- genauere Gebuehren
//
// DefiLlama meldet fuer NEAR Intents nur Brutto-Gebuehren (Protokollgebuehr + Affiliate-
// Gebuehren der Frontends unter EINEM Label). Auf Dune liegen beide getrennt:
//   dune.near.dataset_near_intents_protocol_fees  (amount_fee, USD)  -> Protokollgebuehr
//   dune.near.dataset_near_intents_fees           (fee, USD)         -> Affiliate-Gebuehren
//   dune.near.dataset_near_intents_metrics        (volume_amount_usd) -> Volumen (dieselbe
//                                                    Quelle, die DefiLlamas Volumen nutzt)
// Die Protokollgebuehr ist das sauberste Gegenstueck zu THORChains liquidityFees (beide ohne
// Frontend-Gebuehren). Der Spread der Solver steckt -- wie ueberall -- nicht darin.
//
// Abruf ueber die Dune-API ("Execute SQL", keine gespeicherte Abfrage noetig), Schluessel im
// Secret DUNE_API_KEY. Hoechstens ein Lauf pro ~20 Stunden (die Datensaetze kommen ohnehin
// taeglich); ist eine Ausfuehrung nach ~60 s nicht fertig, wird sie im naechsten Cron-Lauf
// abgeholt statt neu gestartet. Ergebnisse dauerhaft in D1 (near_dune_daily).
// =====================================================================================
const DUNE_API = 'https://api.dune.com/api/v1';
const NEAR_DUNE_INTERVALL_MS = 20 * 60 * 60 * 1000;
// SPARSAM (gemeldet: DUNE_HTTP_402 "would exceed your configured datapoint limit per billing
// cycle"): Dune rechnet Ergebnis-Datenpunkte ab (Zeilen x Spalten). Erstlauf nur 35 Tage, danach
// je Lauf die letzten 4 Tage -- die Karte braucht hoechstens 30 Tage, aeltere bleiben in D1.
// Drei Spalten statt vier (Frontend-Gebuehren werden nicht mehr gebraucht).
const NEAR_DUNE_TAGE_ERSTLAUF = 35, NEAR_DUNE_TAGE_FOLGE = 4;
// Nach einem Fehler nicht bei jedem Cron-Lauf erneut versuchen (sonst Dauerfeuer bei 402).
const NEAR_DUNE_FEHLER_PAUSE_MS = 6 * 60 * 60 * 1000;
let nearDuneTabelleOk = false;
let nearDune = { tage: new Map(), at: 0 };

async function sichereNearDuneTabelle(env) {
  if (nearDuneTabelleOk) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS near_dune_daily (
      day TEXT PRIMARY KEY, volume_usd REAL, protocol_fees_usd REAL, affiliate_fees_usd REAL, updated_at INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS near_dune_meta (
      id INTEGER PRIMARY KEY, last_ok INTEGER, pending_exec TEXT, pending_since INTEGER, last_error TEXT)`),
  ]);
  nearDuneTabelleOk = true;
}

const nearDuneSql = (tage) => `
WITH p AS (
  SELECT CAST(substr(CAST(date_at AS varchar), 1, 10) AS date) AS d, SUM(CAST(amount_fee AS double)) AS v
  FROM dune.near.dataset_near_intents_protocol_fees GROUP BY 1
), m AS (
  SELECT CAST(substr(CAST(date_at AS varchar), 1, 10) AS date) AS d, SUM(CAST(volume_amount_usd AS double)) AS v
  FROM dune.near.dataset_near_intents_metrics GROUP BY 1
)
SELECT CAST(m.d AS varchar) AS day, m.v AS volume_usd, p.v AS protocol_fees_usd
FROM m LEFT JOIN p ON p.d = m.d
WHERE m.d >= current_date - INTERVAL '${Math.max(2, Math.floor(tage))}' DAY
ORDER BY 1`;

async function duneJson(env, pfad, opts = {}) {
  const res = await fetchWithTimeout(`${DUNE_API}${pfad}`, {
    method: opts.method || 'GET',
    headers: { 'X-DUNE-API-KEY': env.DUNE_API_KEY, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    timeoutMs: opts.timeoutMs || 15000,
  });
  let j = null; try { j = await res.json(); } catch (e) { j = null; }
  if (!res.ok) throw new Error(`DUNE_HTTP_${res.status}${j && j.error ? ': ' + String(j.error).slice(0, 160) : ''}`);
  return j;
}

async function syncNearDune(env) {
  if (!env || !env.DUNE_API_KEY || !env.DB) return;
  await sichereNearDuneTabelle(env);
  const meta = (await env.DB.prepare('SELECT * FROM near_dune_meta WHERE id = 1').first()) || {};
  const jetzt = Date.now();
  const merke = (felder) => env.DB.prepare(
    `INSERT INTO near_dune_meta (id, last_ok, pending_exec, pending_since, last_error) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_ok = excluded.last_ok, pending_exec = excluded.pending_exec,
       pending_since = excluded.pending_since, last_error = excluded.last_error`
  ).bind(felder.last_ok ?? meta.last_ok ?? null, felder.pending_exec ?? null, felder.pending_since ?? null, felder.last_error ?? null).run();

  // Fehler-Pause: last_error gesetzt und letzter Versuch juenger als die Pause -> nichts tun.
  const versuch = await env.DB.prepare("SELECT last_ok AS t FROM near_dune_meta WHERE id = 2").first().catch(() => null);
  if (!meta.pending_exec && meta.last_error && versuch && jetzt - Number(versuch.t || 0) < NEAR_DUNE_FEHLER_PAUSE_MS) return;
  const merkeVersuch = () => env.DB.prepare(
    `INSERT INTO near_dune_meta (id, last_ok) VALUES (2, ?) ON CONFLICT(id) DO UPDATE SET last_ok = excluded.last_ok`
  ).bind(jetzt).run().catch(() => {});
  let execId = meta.pending_exec || null;
  // Haengt eine Ausfuehrung laenger als 2 Stunden, neu starten.
  if (execId && jetzt - (Number(meta.pending_since) || 0) > 2 * 60 * 60 * 1000) execId = null;
  if (!execId) {
    if (meta.last_ok && jetzt - Number(meta.last_ok) < NEAR_DUNE_INTERVALL_MS) return;
    const vorhanden = await env.DB.prepare('SELECT COUNT(*) AS c FROM near_dune_daily').first();
    const tage = (Number(vorhanden && vorhanden.c) || 0) >= 28 ? NEAR_DUNE_TAGE_FOLGE : NEAR_DUNE_TAGE_ERSTLAUF;
    await merkeVersuch();
    try {
      const r = await duneJson(env, '/sql/execute', { method: 'POST', body: { sql: nearDuneSql(tage) } }); // ohne "performance": Dune lehnte 'medium' ab ("Invalid performance tier")
      execId = r && r.execution_id;
      if (!execId) throw new Error('DUNE_KEINE_EXECUTION_ID');
      await merke({ pending_exec: execId, pending_since: jetzt });
    } catch (e) {
      await merke({ last_error: e?.message || String(e) });
      console.warn('[rune-rewards-backend] Dune NEAR: Start fehlgeschlagen:', e?.message || String(e));
      return;
    }
  }
  // Bis ~60 s auf das Ergebnis warten (Warten auf fetch zaehlt nicht als CPU-Zeit).
  let zustand = null;
  for (let i = 0; i < 12; i++) {
    try { zustand = await duneJson(env, `/execution/${execId}/status`); } catch (e) { zustand = null; }
    const st = zustand && zustand.state;
    if (st === 'QUERY_STATE_COMPLETED') break;
    if (st === 'QUERY_STATE_FAILED' || st === 'QUERY_STATE_CANCELLED' || st === 'QUERY_STATE_EXPIRED') {
      await merke({ last_error: 'DUNE_' + st });
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!zustand || zustand.state !== 'QUERY_STATE_COMPLETED') return; // naechster Lauf holt ab
  let rows = [];
  try {
    const erg = await duneJson(env, `/execution/${execId}/results?limit=1000`, { timeoutMs: 20000 });
    rows = (erg && erg.result && Array.isArray(erg.result.rows)) ? erg.result.rows : [];
  } catch (e) {
    await merke({ pending_exec: execId, pending_since: Number(meta.pending_since) || jetzt, last_error: e?.message || String(e) });
    return;
  }
  const zahl = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const stmts = rows.filter((r) => /^\d{4}-\d{2}-\d{2}/.test(String(r.day || ''))).map((r) => env.DB.prepare(
    `INSERT OR REPLACE INTO near_dune_daily (day, volume_usd, protocol_fees_usd, affiliate_fees_usd, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(String(r.day).slice(0, 10), zahl(r.volume_usd), zahl(r.protocol_fees_usd), null, jetzt));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await merke({ last_ok: jetzt, pending_exec: null, pending_since: null, last_error: null });
  nearDune.at = 0; // beim naechsten Abruf neu aus D1 laden
  dexVolumeCache = null;
}

// Laedt die gespeicherten Tage in den Speicher (fuer baueDexVergleich, das keinen env hat).
async function ladeNearDune(env) {
  if (!env || !env.DB) return;
  if (nearDune.at && Date.now() - nearDune.at < 10 * 60 * 1000) return;
  try {
    await sichereNearDuneTabelle(env);
    const r = await env.DB.prepare('SELECT * FROM near_dune_daily ORDER BY day DESC LIMIT 60').all();
    const m = new Map();
    for (const z of (r.results || [])) m.set(String(z.day), { vol: z.volume_usd, prot: z.protocol_fees_usd, aff: z.affiliate_fees_usd });
    nearDune = { tage: m, at: Date.now() };
  } catch (e) { /* ohne Dune-Daten geht es mit DefiLlama weiter */ }
}

let dexVolumeCache = null; 
const DEX_VOLUME_CACHE_MS = 10 * 60 * 1000; 

function baueDexVergleichCached() {
  if (dexVolumeCache && Date.now() - dexVolumeCache.atMs < DEX_VOLUME_CACHE_MS) return dexVolumeCache.promise;
  const promise = baueDexVergleich();
  promise.catch(() => { if (dexVolumeCache && dexVolumeCache.promise === promise) dexVolumeCache = null; });
  dexVolumeCache = { promise, atMs: Date.now() };
  return promise;
}

const DEX_VOLUME_STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// VERGANGENE TAGE FESTHALTEN (gemeldet: "dann springt es manchmal rueber zu Liquify").
//
// Midgard hat Vorrang, vanaheimex fuellt Luecken. Liquifys Tagesaggregation haengt derzeit
// unregelmaessig: sobald sie fuer einen Moment wieder Werte liefert, gewann sie -- und ein
// laengst abgeschlossener Tag sprang zwischen zwei Zahlen hin und her.
//
// Deshalb gilt jetzt: Was ein Tag beim ersten Mal bekommen hat, behaelt er. Nur der HEUTIGE
// Tag darf sich noch aendern, denn der waechst ja noch. Grundlage ist der zuletzt geschriebene
// Stand aus dem Zwischenspeicher -- dafuer braucht es keine neue Tabelle.
function haltAlteTageFest(neu, alt) {
  if (!alt || !Array.isArray(alt.protocols) || !Array.isArray(neu.protocols)) return neu;
  const heute = utcDayString(Date.now());
  const altNach = new Map(alt.protocols.map((p) => [p.key, p]));

  const mische = (neueReihe, alteReihe) => {
    if (!Array.isArray(neueReihe) || !Array.isArray(alteReihe) || !alteReihe.length) return neueReihe;
    const frueher = new Map(alteReihe.map((e) => [e.day, e]));
    return neueReihe.map((e) => {
      if (!e || e.day >= heute) return e;            // laufender Tag bleibt beweglich
      const a = frueher.get(e.day);
      if (!a || a.volume == null) return e;          // frueher kein Wert -> neuen nehmen
      // vanaheimex hat Vorrang: Ein frueher festgehaltener Midgard-Wert (ohne quelle oder
      // 'midgard') wird durch einen vanaheimex-Wert ersetzt -- aber nie umgekehrt. Faellt
      // vanaheimex kurz aus, bleibt der Tag also bei seinem vanaheimex-Wert stehen.
      if (e.quelle === 'vanaheimex-tag' && a.quelle !== 'vanaheimex-tag' && e.volume != null) return e;
      // Dasselbe fuer Maya: Ein Wert aus Mayas Midgard ersetzt einen frueher von DefiLlama
      // festgehaltenen Tag, nie umgekehrt.
      if (e.quelle === 'maya-midgard' && a.quelle !== 'maya-midgard' && e.volume != null) return e;
      // Und fuer NEAR: Dune (NEARs eigener Datensatz) ersetzt frueher festgehaltene DefiLlama-Tage.
      if (e.quelle === 'dune-near' && a.quelle !== 'dune-near' && e.volume != null) return e;
      return a;                                       // sonst: beim ersten Wert bleiben
    });
  };

  const stichtag = neu.asOfDay;

  for (const p of neu.protocols) {
    const a = altNach.get(p.key);
    if (!a) continue;
    const vorherSerie = p.series;
    const vorherFees = p.feeSeries;
    p.series = mische(p.series, a.series);
    // Wurde die Berechnungsgrundlage geaendert (z. B. Chainflip ohne Gas/Broker), duerfen die
    // festgehaltenen alten Tageswerte nicht zurueckkommen -- sonst bliebe die alte Zahl stehen.
    if (p.feeBasis && a.feeBasis === p.feeBasis) p.feeSeries = mische(p.feeSeries, a.feeSeries);

    // Summen neu bilden, sonst passten d1/d7/d30 nicht mehr zu den festgehaltenen Tagen.
    if (stichtag && p.series !== vorherSerie) {
      const s1 = summiereTage(p.series, 1, stichtag);
      const s7 = summiereTage(p.series, 7, stichtag);
      const s30 = summiereTage(p.series, 30, stichtag);
      const wert = (x) => (x.tage === 0 && x.ohneWert > 0) ? null : x.summe;
      p.d1 = wert(s1); p.d7 = wert(s7); p.d30 = wert(s30);
      p.days1 = s1.tage; p.days7 = s7.tage; p.days30 = s30.tage;
    }
    if (stichtag && p.feeSeries && p.fees && p.feeSeries !== vorherFees) {
      const f1 = summiereTage(p.feeSeries, 1, stichtag);
      const f7 = summiereTage(p.feeSeries, 7, stichtag);
      const f30 = summiereTage(p.feeSeries, 30, stichtag);
      const wert = (x) => (x.tage === 0 && x.ohneWert > 0) ? null : x.summe;
      p.fees = { ...p.fees, d1: wert(f1), d7: wert(f7), d30: wert(f30),
                 days1: f1.tage, days7: f7.tage, days30: f30.tage };
    }
  }
  return neu;
}

async function handleDexVolume(request, env, ctx) {
  try {
    await ladeNearDune(env);
    // Noch keine Dune-Daten, aber ein Schluessel da: den Abruf im Hintergrund anstossen, statt
    // auf den naechsten Cron-Lauf zu warten (syncNearDune drosselt sich selbst).
    if (env.DUNE_API_KEY && !nearDune.tage.size && ctx && ctx.waitUntil) ctx.waitUntil(syncNearDune(env).catch(() => {}));
    const daten = await baueDexVergleichCached();
    // Zuletzt ausgelieferten Stand lesen, um vergangene Tage daraus zu uebernehmen.
    try {
      const vorher = await env.DB.prepare('SELECT payload FROM dex_volume_cache WHERE id = 1').first();
      if (vorher && vorher.payload) haltAlteTageFest(daten, JSON.parse(vorher.payload));
    } catch (e) {/* ohne Vorstand einfach die neuen Werte nehmen */}
    const brauchbar = daten.protocols.some((p) => p.d1 != null);
    if (brauchbar) {
      const schreiben = env.DB.prepare(
        `INSERT INTO dex_volume_cache (id, payload, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).bind(JSON.stringify(daten), Date.now()).run().catch((e) => {
        console.warn('[rune-rewards-backend] dex_volume_cache-Schreiben fehlgeschlagen (Migration ausgeführt?):', e?.message || String(e));
      });
      if (ctx && ctx.waitUntil) ctx.waitUntil(schreiben); else await schreiben;
      // Kurzer Dune-Zustand fuer die Karte (warum NEAR noch "DefiLlama" zeigt).
      let nearDuneInfo = { keySet: !!env.DUNE_API_KEY, days: nearDune.tage.size };
      try {
        await sichereNearDuneTabelle(env);
        const meta = await env.DB.prepare('SELECT last_ok, pending_exec, last_error FROM near_dune_meta WHERE id = 1').first();
        if (meta) nearDuneInfo = { ...nearDuneInfo, lastOk: meta.last_ok || null, pending: !!meta.pending_exec, lastError: meta.last_error ? String(meta.last_error).slice(0, 200) : null };
      } catch (e) {}
      return json({ ...daten, stale: false, nearDune: nearDuneInfo, workerVersion: WORKER_VERSION }, env);
    }
    throw new Error('ALL_PROTOCOLS_FAILED');
  } catch (e) {
    console.warn('[rune-rewards-backend] /dex-volume fehlgeschlagen, versuche Stale-Cache:', e?.message || String(e));
    try {
      const row = await env.DB.prepare('SELECT payload, updated_at FROM dex_volume_cache WHERE id = 1').first();
      if (row && row.payload && (Date.now() - row.updated_at) < DEX_VOLUME_STALE_MAX_AGE_MS) {
        return json({ ...JSON.parse(row.payload), stale: true, staleSince: row.updated_at }, env);
      }
    } catch (e2) {  }
    return json({ error: 'DEX_VOLUME_UNAVAILABLE', message: e?.message || String(e) }, env, 503);
  }
}

const COINGECKO_BASES = ['https://api.coingecko.com/api/v3'];

const CRYPTOCOMPARE_BASES = ['https://min-api.cryptocompare.com'];

async function fetchRuneOhlcMax() {
  
  try {
    const j = await fetchFromBases(CRYPTOCOMPARE_BASES, '/data/v2/histoday?fsym=RUNE&tsym=USD&allData=true', { timeoutMs: 15000 });
    const reihe = j && j.Data && Array.isArray(j.Data.Data) ? j.Data.Data : null;
    if (reihe && reihe.length) {
      const kerzen = reihe
        .filter((k) => k && Number(k.close) > 0 && Number(k.open) > 0)
        .map((k) => [Number(k.time) * 1000, Number(k.open), Number(k.high), Number(k.low), Number(k.close)])
        .filter((k) => k.every(Number.isFinite))
        .sort((a, b) => a[0] - b[0]);
      if (kerzen.length > 100) return kerzen;
    }
  } catch (e) {
    console.warn('[rune-rewards-backend] /rune-history: CryptoCompare nicht erreichbar:', e?.message || String(e));
  }

  try {
    const roh = await fetchFromBases(COINGECKO_BASES, '/coins/thorchain/ohlc?vs_currency=usd&days=max', { timeoutMs: 15000 });
    if (Array.isArray(roh) && roh.length) {
      const kerzen = roh
        .filter((k) => Array.isArray(k) && k.length >= 5 && Number.isFinite(Number(k[0])) && Number(k[4]) > 0)
        .map((k) => [Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4])])
        .sort((a, b) => a[0] - b[0]);
      if (kerzen.length) return kerzen;
    }
  } catch (e) {  }

  const mc = await fetchFromBases(COINGECKO_BASES, '/coins/thorchain/market_chart?vs_currency=usd&days=max&interval=daily', { timeoutMs: 15000 });
  const preise = mc && Array.isArray(mc.prices) ? mc.prices : null;
  if (!preise || !preise.length) throw new Error('COINGECKO_NO_PRICES');
  const proTag = new Map();
  for (const p of preise) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const ms = Number(p[0]), kurs = Number(p[1]);
    if (!Number.isFinite(ms) || !(kurs > 0)) continue;
    proTag.set(Date.parse(new Date(ms).toISOString().slice(0, 10) + 'T00:00:00.000Z'), kurs);
  }
  const tage = [...proTag.entries()].sort((a, b) => a[0] - b[0]);
  if (!tage.length) throw new Error('COINGECKO_NO_DAYS');
  return tage.map(([ms, schluss], i) => {
    const open = i > 0 ? tage[i - 1][1] : schluss;
    return [ms, open, Math.max(open, schluss), Math.min(open, schluss), schluss];
  });
}

let runeHistoryCache = null; 
const RUNE_HISTORY_CACHE_MS = 24 * 60 * 60 * 1000;

async function handleRuneHistory(request, env, ctx) {
  try {
    if (!runeHistoryCache || Date.now() - runeHistoryCache.atMs > RUNE_HISTORY_CACHE_MS) {
      const promise = fetchRuneOhlcMax();
      promise.catch(() => { if (runeHistoryCache && runeHistoryCache.promise === promise) runeHistoryCache = null; });
      runeHistoryCache = { promise, atMs: Date.now() };
    }
    const candles = await runeHistoryCache.promise;
    if (!candles.length) throw new Error('COINGECKO_EMPTY');
    const payload = { source: candles.length > 100 ? 'cryptocompare' : 'coingecko', candles, firstMs: candles[0][0], lastMs: candles[candles.length - 1][0] };
    const schreiben = env.DB.prepare(
      `INSERT INTO rune_history_cache (id, payload, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
    ).bind(JSON.stringify(payload), Date.now()).run().catch((e) => {
      console.warn('[rune-rewards-backend] rune_history_cache-Schreiben fehlgeschlagen (Migration ausgeführt?):', e?.message || String(e));
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(schreiben); else await schreiben;
    return json({ ...payload, stale: false }, env);
  } catch (e) {
    console.warn('[rune-rewards-backend] /rune-history fehlgeschlagen, versuche Cache:', e?.message || String(e));
    try {
      const row = await env.DB.prepare('SELECT payload, updated_at FROM rune_history_cache WHERE id = 1').first();
      
      if (row && row.payload) return json({ ...JSON.parse(row.payload), stale: true, staleSince: row.updated_at }, env);
    } catch (e2) {  }
    return json({ error: 'RUNE_HISTORY_UNAVAILABLE', message: e?.message || String(e) }, env, 503);
  }
}

// ── ENTWICKLUNGSSTAND VON THORCHAIN (GitLab + Netz-Version) ──────────────────
//
// THORNode wird auf GitLab entwickelt; das GitHub-Repo ist nur ein Spiegel. Hier werden
// Releases, Merge Requests und Meilensteine geholt, auf das Noetige eingedampft und fuer
// 15 Minuten abgelegt.
//
// Warum ueber den Worker und nicht direkt aus dem Browser: sonst teilt sich jeder Besucher
// GitLabs Rate-Limit nach IP, und wir waeren darauf angewiesen, dass GitLab fuer diese
// Endpunkte CORS erlaubt. So gibt es genau EINEN Abrufer, und der Token bleibt serverseitig.
//
// Dazu kommt die im Netz AKTIVE Version aus /thorchain/version. THORChain schaltet eine neue
// Version erst frei, wenn die Supermajoritaet der Nodes sie faehrt -- die Luecke zwischen
// "im Repo fertig" und "im Netz live" ist die eigentliche Aussage dieser Seite.
const GITLAB_API = 'https://gitlab.com/api/v4/projects/thorchain%2Fthornode';
// SCHEMA-VERSION DES ZWISCHENSPEICHERS.
//
// Gemeldet: nach dem Deploy stand ueberall "nichts erfasst" und das stabile Release war leer.
// Ursache: der Cache haelt die Antwort 15 Minuten -- nach einem Worker-Update wurde also
// weiter die ALTE Nutzlast ausgeliefert, der die neuen Felder schlicht fehlten. Die Version
// wird mitgespeichert; passt sie nicht, gilt der Eintrag als ungueltig und wird neu geholt.
// Bei jeder Aenderung an der Form von baueThornodeTimeline hochzaehlen.
const TIMELINE_SCHEMA = 15;
const TIMELINE_FRESH_MS = 15 * 60 * 1000;
const TIMELINE_STALE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function gitlabJson(env, pfad) {
  // Der Token ist OPTIONAL. Ohne ihn funktioniert alles, nur mit knapperem Limit -- lege in
  // den Worker-Variablen GITLAB_TOKEN an (Read-only, Scope read_api), wenn es eng wird.
  const tok = env && env.GITLAB_TOKEN;
  const res = await fetchWithTimeout(`${GITLAB_API}${pfad}`, {
    // 8 s statt 12: Alle Seiten laufen jetzt parallel, die Gesamtdauer ist also die der
    // langsamsten Einzelanfrage. Ein haengender Aufruf darf die ganze Antwort nicht ueber das
    // Zeitlimit des Browsers schieben.
    timeoutMs: 8000,
    headers: {
      'x-client-id': 'rune-rewards-backend',
      ...(tok ? { 'PRIVATE-TOKEN': tok } : {}),
    },
  });
  if (!res.ok) throw new Error(`GITLAB_HTTP_${res.status} (${pfad})`);
  return res.json();
}

const alsMs = (s) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };

// Release-Kandidaten (rc/beta/alpha) sind KEINE fertigen Releases. Sie als "neuestes Release"
// dem Netz gegenueberzustellen meldete faelschlich "gebaut, noch nicht live", obwohl das Netz
// auf dem neuesten stabilen Stand lief.
const istVorab = (v) => /-(rc|beta|alpha|pre)/i.test(String(v || ''));

// ── RELEASE-MERGE-REQUESTS ─────────────────────────────────────────────────
//
// Das staerkste Signal ueberhaupt, und es ging bisher in der MR-Liste unter: Wenn ein MR
// einen Zweig wie "mainnet-3.20.3" nach "mainnet" bringt, wird GERADE ein Release ausgerollt.
// Beispiel aus dem Repo: !5100 "Release 3.20.3 — Bifrost-only patch", offen, mainnet-3.20.3
// -> mainnet.
//
// Erkannt wird ueber drei Wege, weil nicht jeder Release-MR alle erfuellt:
//   Zielzweig mainnet/stagenet  -- der zuverlaessigste
//   Quellzweig mainnet-X.Y.Z    -- greift auch, wenn das Ziel mal abweicht
//   Titel "Release X.Y.Z"       -- greift, wenn die Zweige anders heissen
function istReleaseMr(m) {
  const ziel = String((m && m.target_branch) || '');
  const titel = String((m && m.title) || '');
  // NUR das ZIEL entscheidet. Die frueheren Regeln ueber den Quellzweig waren zu weit:
  // "release-3.18-stagenet-prep -> develop" ist Vorbereitung, kein Ausrollen, wurde aber als
  // Release erkannt und stand dann als offener MR von vor 128 Tagen ganz oben. Ausgerollt
  // wird ausschliesslich NACH mainnet oder stagenet.
  if (/^(mainnet|stagenet)$/i.test(ziel)) return true;
  // Ausnahme: ein ausdruecklich so betitelter Release-MR, auch wenn er woanders hin geht.
  if (/^release[\s:-]+v?\d+\.\d+\.\d+/i.test(titel)) return true;
  return false;
}

function versionAus(m) {
  const quellen = [(m && m.source_branch) || '', (m && m.title) || ''];
  for (const q of quellen) {
    const t2 = String(q).match(/(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/i);
    if (t2) return t2[1];
  }
  return null;
}

// RELEASE-NOTIZEN AUS DER MR-BESCHREIBUNG.
//
// Der Text eines Release-MRs enthaelt das, was den Leser eigentlich interessiert: eine
// Tabelle "| MR | Fix |" mit den enthaltenen Aenderungen, dazu ein bis zwei Saetze und der
// Meilenstein. Das stand bisher nur auf GitLab.
//
// Bewusst keine echte Markdown-Verarbeitung -- nur Tabellenzeilen und Aufzaehlungen werden
// herausgezogen. Was dem Muster nicht entspricht, landet im Vorspann statt verloren zu gehen.
function releaseNotizen(beschreibung) {
  const zeilen = String(beschreibung || '').split('\n');
  const enthalten = [];
  const vorspann = [];
  let meilenstein = null;
  for (const roh of zeilen) {
    const z = roh.trim();
    if (!z) continue;
    const ms = z.match(/milestone\s+([\w.\-]+)/i);
    if (ms && !meilenstein) meilenstein = ms[1];
    if (z.startsWith('|')) {
      const zellen = z.replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
      if (!zellen.length) continue;
      if (zellen.every((x) => /^:?-{2,}:?$/.test(x))) continue;      // Trennzeile
      if (/^(mr|fix|change|description)$/i.test(zellen[0])) continue; // Kopfzeile
      const nr = (zellen[0].match(/!(\d+)/) || [])[1] || null;
      const text = String(zellen[1] || zellen[0]).replace(/[`*]/g, '').trim();
      if (text) enthalten.push({ mr: nr, text: text.slice(0, 180) });
      continue;
    }
    if (/^[-*+]\s+/.test(z)) {
      const text = z.replace(/^[-*+]\s+/, '').replace(/[`*]/g, '').trim();
      const nr = (z.match(/!(\d+)/) || [])[1] || null;
      if (text) enthalten.push({ mr: nr, text: text.slice(0, 180) });
      continue;
    }
    if (/^#/.test(z)) continue;
    if (vorspann.join(' ').length < 220) vorspann.push(z.replace(/[`*]/g, ''));
  }
  return {
    vorspann: vorspann.join(' ').slice(0, 260) || null,
    meilenstein,
    enthalten: enthalten.slice(0, 25),
    gesamt: enthalten.length,
  };
}

function mrKompakt(m) {
  return {
    iid: m && m.iid,
    // Fuer die Release-Erkennung -- ohne die Zweige laesst sich ein Release-MR nicht von
    // einem beliebigen Feature-MR unterscheiden.
    ziel: (m && m.target_branch) || null,
    quelle: (m && m.source_branch) || null,
    zustand: (m && m.state) || null,
    release: istReleaseMr(m) ? (versionAus(m) || true) : null,
    erstelltMs: alsMs(m && m.created_at),
    titel: titelKlar((m && m.title) || ''),
    thema: themaVon((m && m.title) || ''),
    beobachtet: beobachtetVon((m && m.title) || ''),
    rauschen: istRauschen((m && m.title) || ''),
    autor: (m && m.author && m.author.name) || null,
    datumMs: alsMs((m && (m.merged_at || m.updated_at)) || null),
    entwurf: !!(m && (m.draft || m.work_in_progress)),
    url: (m && m.web_url) || null,
    visualReview: visualReviewVon(m),
  };
}
// VISUAL REVIEW (Son of Odin, Okt. 2026: Skill thorchain/misc/visual-review, ueber den Bot Huginn
// an jede MR gehaengt): eine verstaendliche, bebilderte Erklaerung der Aenderung. Gesucht wird in
// der MR-Beschreibung eine Zeile mit "visual review" und dem ersten Link darin, sonst ein Link,
// dessen Adresse "visual" enthaelt. Format noch nicht bestaetigt -- deshalb bewusst grosszuegig.
function visualReviewVon(m) {
  const txt = String((m && m.description) || '');
  if (!txt) return null;
  const linkIn = z => { const t = z.match(/\]\((https?:\/\/[^)\s]+)\)/) || z.match(/(https?:\/\/[^\s)<>"']+)/); return t ? t[1] : null; };
  for (const zeile of txt.split(/\r?\n/)) {
    if (/visual[\s_-]*review/i.test(zeile)) { const u = linkIn(zeile); if (u) return u.slice(0, 400); }
  }
  const alle = txt.match(/https?:\/\/[^\s)<>"']+/g) || [];
  const v = alle.find(u => /visual/i.test(u));
  return v ? v.slice(0, 400) : null;
}

// Mehrere Seiten holen. Eine einzige Seite mit 20 Eintraegen deckte nur wenige Tage ab --
// gemeldet: "es sind eindeutig zu wenig Updates, jeden Tag passieren Sachen".
// ALLE SEITEN GLEICHZEITIG, nicht nacheinander.
//
// Hier lag die eigentliche Regression: Die Schleife holte Seite 1, dann 2, dann 3 -- jede mit
// 12 s Zeitlimit, also bis zu 36 s allein fuer die MRs. Der Browser bricht nach 15 s ab, und
// die Seite meldete "nicht verfuegbar". Vorher gab es nur vier parallele Aufrufe, entsprechend
// schnell. Da die Seitenzahl ohnehin fest ist, kostet paralleles Holen nichts und die Dauer
// faellt auf die einer einzigen Anfrage.
async function gitlabSeitenParallel(env, pfadFuer, seiten) {
  const roh = await Promise.allSettled(
    Array.from({ length: seiten }, (_, i) => gitlabJson(env, pfadFuer(i + 1)))
  );
  const out = [];
  // DOPPELTE HERAUSFILTERN. Beim parallelen Holen werden alle Seiten gleichzeitig angefragt;
  // aendert sich die Liste in diesem Moment (ein neuer MR/Commit kommt dazu), verschiebt sich
  // der Seitenschnitt und derselbe Eintrag kann auf zwei Seiten liegen. Sequenziell war das
  // unwahrscheinlicher, parallel ist es ein echtes Rennen -- und doppelte Eintraege wuerden
  // sowohl die Liste als auch die Zaehlung je Release verfaelschen.
  const gesehen = new Set();
  for (const r of roh) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue; // gescheiterte Seite ueberspringen
    for (const e of r.value) {
      const id = e && (e.id != null ? 'i' + e.id : (e.iid != null ? 'm' + e.iid : (e.short_id || e.sha || null)));
      if (id) {
        if (gesehen.has(id)) continue;
        gesehen.add(id);
      }
      out.push(e);
    }
  }
  return out;
}

function gitlabMrSeiten(env, state, seiten) {
  return gitlabSeitenParallel(env,
    (s) => `/merge_requests?state=${state}&order_by=updated_at&sort=desc&per_page=100&page=${s}`,
    seiten);
}

// COMMITS AUF develop.
//
// Gemeldet: "da wurde vor 22 Minuten etwas geaendert, suchst du richtig?" -- nein, tat ich
// nicht. Releases, Tags, MRs und Meilensteine sagen nichts ueber die TAEGLICHE Bewegung:
// gearbeitet wird in Commits auf dem Entwicklungszweig (bei THORNode heisst der `develop`,
// die CI laeuft auf develop/stagenet/mainnet). Ein MR wird vielleicht alle paar Tage gemergt,
// ein Commit faellt mehrmals taeglich. Ohne diesen Aufruf war die Seite strukturell blind
// fuer genau das, was gefragt war.
const DEV_BRANCH = 'develop';

function gitlabCommits(env, seiten) {
  return gitlabSeitenParallel(env,
    (s) => `/repository/commits?ref_name=${DEV_BRANCH}&per_page=100&page=${s}`,
    seiten);
}

// ── EINORDNUNG FUER LESER, DIE NICHT ENTWICKELN ────────────────────────────
//
// Gemeldet: "fasse die wichtigsten Sachen zusammen, das versteht sonst keiner". Rohtitel wie
// "bifrost: guard against nil utxo" sagen einem Investor nichts. Hier werden sie ueber
// Stichwoerter in Themen einsortiert und von Konventions-Praefixen befreit.
//
// WICHTIG, WAS DAS IST UND WAS NICHT: eine Stichwort-Heuristik, kein Textverstaendnis. Sie
// liegt bei eindeutigen Titeln richtig und bei kreativen daneben. Deshalb wird nichts
// weggeworfen -- alles ohne Treffer landet in "sonstiges" und bleibt sichtbar.
const THEMEN = [
  { key: 'handel',  re: /\b(swap|quote|slip|slippage|fee|gebuehr|price|trade|order|streaming|affiliate)\b/i },
  // Die neuen Ketten gehoeren hier ausdruecklich hinein: ohne "monero"/"zcash"/"frost" landete
  // ausgerechnet die XMR-Arbeit unter "Sonstiges", obwohl sie eine Chain-Anbindung ist.
  { key: 'chains',  re: /\b(bifrost|chain|evm|utxo|btc|bitcoin|eth|ethereum|solana|sol|base|avax|bsc|doge|ltc|bch|xrp|gaia|atom|cosmos|client|rpc|scanner|monero|xmr|zcash|zec|frost|serai|tao|bittensor)\b/i },
  { key: 'nodes',   re: /\b(node|churn|bond|validator|tss|keygen|keysign|jail|vault|asgard|yggdrasil|consensus|slash)\b/i },
  { key: 'pools',   re: /\b(pool|liquidity|lp|savers|lending|loan|borrow|collateral|depth|rune)\b/i },
  { key: 'fehler',  re: /\b(fix|bug|panic|nil|crash|revert|hotfix|regression|leak|deadlock)\b/i },
  { key: 'tempo',   re: /\b(perf|performance|optimi[sz]|cache|speed|faster|memory|alloc|index)\b/i },
  { key: 'wartung', re: /\b(test|tests|ci|lint|chore|docs|doc|bump|deps|dependency|refactor|cleanup|typo|changelog|makefile)\b/i },
];

// Reihenfolge zaehlt: "fix" gewinnt gegen "wartung", damit ein Bugfix im Testcode nicht als
// Wartung durchgeht. Deshalb wird in dieser Liste von oben nach unten geprueft -- ausser bei
// Wartung, die nur greift, wenn sonst nichts passt.
// ── BEOBACHTETE THEMEN ("Highlights") ──────────────────────────────────────
//
// Auf Wunsch hervorgehoben: XMR (das wichtigste), ZEC, BLO, THORKit. Diese Arbeiten gehen
// sonst zwischen hundert Commits unter, obwohl sie fuer einen Investor die eigentliche
// Nachricht sind.
//
// Die Muster orientieren sich daran, wie im Repo TATSAECHLICH geschrieben wird, nicht am
// Tickersymbol allein: Die Monero-Arbeit laeuft ueber FROST-Signaturen und den serai-Signer,
// entsprechend heissen die Titel oft "frost" oder "serai" ohne das Wort XMR. Nur auf "xmr" zu
// pruefen haette einen Grossteil davon verfehlt.
//
// prio bestimmt die Reihenfolge in der Anzeige (kleiner = weiter oben).
const BEOBACHTET = [
  { key: 'xmr',     prio: 1, re: /\b(xmr|monero|frost|serai|key.?image|ringct|subaddress)\b/i },
  { key: 'zec',     prio: 2, re: /\b(zec|zcash|shielded|orchard|sapling|zip\d*)\b/i },
  { key: 'thorkit', prio: 3, re: /\b(thorkit|thor-kit)\b/i },
  // BLO: mir ist nicht bekannt, wofuer das steht. Bewusst ENG gefasst (nur als eigenes Wort
  // oder Ticker), damit es nicht wahllos Treffer erzeugt. Sobald klar ist, was gemeint ist,
  // gehoert hier das richtige Muster hin -- so, wie bei XMR auch frost/serai noetig waren.
  { key: 'blo',     prio: 4, re: /\b(blo|\$blo)\b/i },
];

function beobachtetVon(titel) {
  const s2 = String(titel || '');
  for (const b of BEOBACHTET) if (b.re.test(s2)) return b.key;
  return null;
}

function themaVon(titel) {
  const s2 = String(titel || '');
  // DAS PRAEFIX GEWINNT. Ohne das landete "test: extend swap sim tolerance" bei Handel,
  // "chore: bump cosmos-sdk" bei Chains und "docs: fix typo" bei Fehlerbehebung -- die
  // Stichwortsuche griff im Text, obwohl der Autor die Art der Aenderung vorne hingeschrieben
  // hat. Wer sein Commit mit test:/chore:/docs: kennzeichnet, meint genau das.
  const pre = s2.match(/^(feat|fix|chore|docs|test|refactor|perf|ci|build|style)(\([^)]*\))?\s*:/i);
  if (pre) {
    const k = pre[1].toLowerCase();
    if (k === 'test' || k === 'chore' || k === 'docs' || k === 'ci' || k === 'build' || k === 'style' || k === 'refactor') return 'wartung';
    if (k === 'perf') return 'tempo';
    // feat/fix sagen nichts ueber den BEREICH -- dafuer zaehlt weiter der Text unten.
  }
  for (const th of THEMEN) {
    if (th.key === 'wartung') continue;
    if (th.re.test(s2)) return th.key;
  }
  const w = THEMEN.find((t) => t.key === 'wartung');
  if (w.re.test(s2)) return 'wartung';
  return 'sonstiges';
}

// "fix(bifrost): guard against nil utxo" -> "Guard against nil utxo"
function titelKlar(roh) {
  let x = String(roh || '').trim();
  x = x.replace(/^(feat|fix|chore|docs|test|refactor|perf|ci|build|style)(\([^)]*\))?\s*:\s*/i, '');
  x = x.replace(/^[a-z0-9_\-\/]{2,20}\s*:\s*/i, '');   // "bifrost: ", "x/thorchain: "
  x = x.replace(/\s*\(!?\d+\)\s*$/, '');               // angehaengte MR-Nummer
  if (x) x = x.charAt(0).toUpperCase() + x.slice(1);
  return x.slice(0, 160);
}

// Reine Maschinen-Commits interessieren niemanden ausserhalb des Repos.
const istRauschen = (t2) => /^(merge branch|merge remote|revert "merge|bump version|update changelog)/i.test(String(t2 || ''));

function themenZaehlen(liste) {
  const z = {};
  for (const e of liste) z[e.thema] = (z[e.thema] || 0) + 1;
  // Absteigend, damit der Schwerpunkt vorne steht.
  return Object.entries(z).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n }));
}

function commitKompakt(c) {
  // title ist die erste Zeile der Commit-Nachricht -- genau die Kurzfassung, die hier zaehlt.
  return {
    sha: String((c && c.short_id) || '').slice(0, 12) || null,
    titel: titelKlar(String((c && (c.title || c.message)) || '').split('\n')[0]),
    thema: themaVon(String((c && (c.title || c.message)) || '')),
    beobachtet: beobachtetVon(String((c && (c.title || c.message)) || '')),
    rauschen: istRauschen(String((c && (c.title || c.message)) || '')),
    autor: (c && (c.author_name)) || null,
    datumMs: alsMs(c && (c.committed_date || c.created_at)),
    url: (c && c.web_url) || null,
  };
}

async function baueThornodeTimeline(env) {
  const [relR, tagR, mergedR, offenR, meilenR, versionR, commitsR, netzR, blockR, poolsR] = await Promise.allSettled([
    gitlabJson(env, '/releases?per_page=30'),
    gitlabJson(env, '/repository/tags?per_page=40'),
    // 3 Seiten = bis zu 300 gemergte MRs. Das deckt mehrere Monate ab und reicht, um jedem
    // Release seinen Inhalt zuzuordnen.
    gitlabMrSeiten(env, 'merged', 3),
    gitlabMrSeiten(env, 'opened', 1),
    gitlabJson(env, '/milestones?state=active&per_page=10'),
    fetchFromBases(getThornodeBases(), '/thorchain/version'),
    gitlabCommits(env, 2),
    fetchFromBases(getThornodeBases(), '/thorchain/network'),
    fetchFromBases(getThornodeBases(), '/thorchain/lastblock'),
    fetchFromBases(getThornodeBases(), '/thorchain/pools'),
  ]);

  // Jede Teilquelle einzeln festhalten. Vorher verschwand ein Fehlschlag lautlos und die
  // Seite meldete nur "nicht verfuegbar" -- ohne jeden Hinweis, WELCHE Abfrage gescheitert
  // ist. Bei sieben GitLab-Aufrufen ist das nicht diagnostizierbar.
  const fehler = [];
  const w = (r, name) => {
    if (r.status === 'fulfilled' && r.value) return r.value;
    const grund = r.status === 'rejected' ? (r.reason?.message || String(r.reason)) : 'leer';
    fehler.push(name + ': ' + String(grund).slice(0, 120));
    return null;
  };

  // Releases bevorzugt aus /releases; wenn dort nichts steht (THORChain taggt nicht immer
  // ueber die Release-Funktion), aus den Tags. Sonst bliebe die Hauptansicht leer.
  let releases = [];
  const rel = w(relR, 'releases');
  if (Array.isArray(rel) && rel.length) {
    releases = rel.map((r) => ({
      version: r.tag_name || r.name || null,
      datumMs: alsMs(r.released_at || r.created_at),
      notiz: String(r.description || '').trim().slice(0, 400) || null,
    }));
  } else {
    const tags = w(tagR, 'tags');
    if (Array.isArray(tags)) {
      releases = tags.map((t) => ({
        version: t.name || null,
        datumMs: alsMs(t.commit && (t.commit.created_at || t.commit.committed_date)),
        notiz: String((t.release && t.release.description) || '').trim().slice(0, 400) || null,
      }));
    }
  }
  releases = releases.filter((r) => r.version).sort((a, b) => (b.datumMs || 0) - (a.datumMs || 0));

  const merged = (w(mergedR, 'merged') || []).map(mrKompakt)
    .filter((m) => m.datumMs)
    .sort((a, b) => b.datumMs - a.datumMs);

  // WAS STECKT IM UPDATE: jedem Release die MRs zuordnen, die zwischen dem VORIGEN Release und
  // diesem gemergt wurden. Das ist der Inhalt der Version, ohne dass jemand Release-Notizen
  // pflegen muss -- THORChain tut das nur sporadisch.
  for (let i = 0; i < releases.length; i++) {
    const bis = releases[i].datumMs;
    const von = releases[i + 1] ? releases[i + 1].datumMs : 0;
    if (!bis) { releases[i].aenderungen = []; releases[i].anzahl = 0; continue; }
    const drin = merged.filter((m) => m.datumMs > von && m.datumMs <= bis);
    releases[i].anzahl = drin.length;
    // Fuer die Kurzfassung: Rauschen und reine Wartung raus, der Rest nach Thema gezaehlt.
    // Die Gesamtzahl oben bleibt die ECHTE Zahl -- gekuerzt wird nur, was gezeigt wird.
    const relevant = drin.filter((m) => !m.rauschen && m.thema !== 'wartung');
    releases[i].themen = themenZaehlen(relevant)
      .sort((a, b) => (a.key === 'sonstiges' ? 1 : 0) - (b.key === 'sonstiges' ? 1 : 0) || b.n - a.n);
    // 6 fuer die Kurzansicht, aber 30 werden mitgeliefert -- sonst kann das Aufklappen von
    // "+N weitere" nichts anzeigen, weil die Eintraege gar nicht erst beim Browser ankommen.
    releases[i].kern = relevant.slice(0, 30);
    releases[i].aenderungen = drin.filter((m) => !m.rauschen).slice(0, 25);
    releases[i].vorab = istVorab(releases[i].version);
  }

  const ver = w(versionR, 'version');
  const netzVersion = (ver && (ver.current || ver.next)) || null;
  // Fuer den Vergleich zaehlt nur das neueste STABILE Release.
  const neuestesStabil = releases.find((r) => !r.vorab) || null;
  const neuesterKandidat = releases.find((r) => r.vorab) || null;
  const kandidatIstNeuer = !!(neuesterKandidat && neuestesStabil
    && (neuesterKandidat.datumMs || 0) > (neuestesStabil.datumMs || 0));

  const meilen = w(meilenR, 'milestones');

  // Offene Release-MRs zuerst (da passiert es gerade), danach die zuletzt gemergten.
  //
  // MIT ALTERSGRENZE. Ohne sie standen dort offene MRs von vor 128 Tagen und gemergte von vor
  // 95 Tagen unter der Ueberschrift "Release wird ausgerollt" -- das Gegenteil der Aussage.
  // Ein Release-MR, der seit drei Wochen offen ist, wird nicht gerade ausgerollt; er liegt.
  const TAG = 24 * 60 * 60 * 1000;
  const OFFEN_MAX = 21 * TAG;   // laenger offen = liegengeblieben, keine Nachricht mehr
  const MERGED_MAX = 14 * TAG;  // laenger her = Geschichte, steht ohnehin in der Release-Liste
  const offeneMrAlle = (w(offenR, 'opened') || []).map(mrKompakt);
  const jetzt2 = Date.now();
  // Die Beschreibung kommt in der MR-Liste bereits mit -- kein zusaetzlicher Abruf noetig.
  const mitNotizen = (roh, offen) => (m) => {
    const q = roh.find((x) => x && x.iid === m.iid);
    return { ...m, offen, notizen: releaseNotizen(q && q.description) };
  };
  const rohOffen = w(offenR, 'opened') || [];
  const rohMerged = w(mergedR, 'merged') || [];
  const releaseMrs = [
    ...offeneMrAlle
      .filter((m) => m.release && m.datumMs && (jetzt2 - m.datumMs) <= OFFEN_MAX)
      .map(mitNotizen(rohOffen, true)),
    ...merged
      .filter((m) => m.release && m.datumMs && (jetzt2 - m.datumMs) <= MERGED_MAX)
      .slice(0, 2)
      .map(mitNotizen(rohMerged, false)),
  ].slice(0, 3);

  // ── POOL-STATUS: DER EIGENTLICHE FORTSCHRITT ─────────────────────────────
  //
  // Code-Aenderungen zaehlen sagt nichts darueber, ob man etwas TAUSCHEN kann. Die 3.20
  // aktivierte XMR und ZEC im Code -- ohne Pool ist trotzdem kein Handel moeglich, und
  // genau das war Wochen nach dem Release noch der Fall, waehrend Schlagzeilen "live"
  // meldeten. Die Kette beantwortet das eindeutig:
  //
  //   kein Eintrag         -- Pool noch nicht angelegt, nicht handelbar
  //   Staged               -- angelegt, aber noch nicht freigeschaltet
  //   Available            -- handelbar, Tiefe sagt wie gut
  //
  // Nur fuer die beobachteten Ketten; THORKit und BLO sind keine Ketten und bekommen nichts.
  const POOL_KETTE = { xmr: 'XMR', zec: 'ZEC', tao: 'TAO' };
  const poolListe = w(poolsR, 'pools');
  const poolStatus = {};
  if (Array.isArray(poolListe)) {
    for (const [key, kette] of Object.entries(POOL_KETTE)) {
      const pl = poolListe.find((x) => x && typeof x.asset === 'string' && x.asset.toUpperCase().startsWith(kette + '.'));
      poolStatus[key] = pl
        ? {
            asset: String(pl.asset),
            status: String(pl.status || ''),
            // balance_rune kommt in 1e8-Einheiten wie ueberall bei THORChain.
            tiefeRune: (Number(pl.balance_rune) || 0) / 1e8,
          }
        : null; // ausdruecklich null = geprueft und nicht vorhanden
    }
  }

  // ── COUNTDOWN ────────────────────────────────────────────────────────────
  //
  // GitLab kennt KEIN Release-Datum -- es gibt dort schlicht kein Feld dafuer. Was es gibt,
  // ist das Faelligkeitsdatum eines Meilensteins: ein Plan, kein Termin.
  //
  // Der belastbare Zeitpunkt kommt aus der Kette: THORChain schaltet eine neue Version beim
  // CHURN frei, und next_churn_height gegen die aktuelle Blockhoehe ist eine harte Zahl.
  // Bei ~6 s je Block ergibt das einen echten Countdown.
  //
  // WICHTIG fuer die Anzeige: Der Churn ist das FENSTER, in dem ein Update live gehen KANN --
  // keine Zusage, dass es dann geschieht. Freigeschaltet wird erst, wenn die Supermajoritaet
  // der Nodes die neue Version faehrt. Genauso muss es beschriftet werden.
  const netz = w(netzR, 'network');
  const bl = w(blockR, 'lastblock');
  let jetztHoehe = 0;
  try {
    const arr = Array.isArray(bl) ? bl : (bl ? [bl] : []);
    jetztHoehe = parseInt((arr[0] && arr[0].thorchain) || '0', 10) || 0;
  } catch (e) { jetztHoehe = 0; }
  const zielHoehe = Number(netz && netz.next_churn_height) || 0;
  const BLOCK_MS = 6000;
  let churn = null;
  if (zielHoehe && jetztHoehe && zielHoehe > jetztHoehe) {
    const bloecke = zielHoehe - jetztHoehe;
    churn = {
      jetztHoehe, zielHoehe, bloecke,
      // Als Zeitpunkt, nicht als Restdauer: der Browser rechnet selbst herunter und bleibt
      // auch dann richtig, wenn die Antwort 15 Minuten im Zwischenspeicher lag.
      etaMs: Date.now() + bloecke * BLOCK_MS,
      // Churn angehalten? Dann ist jeder Countdown irrefuehrend.
      angehalten: Number(netz && netz.mimir && netz.mimir.HALTCHURNING) > 0,
    };
  }
  // Der Plan aus GitLab, falls gepflegt -- getrennt ausgewiesen, damit niemand ihn mit dem
  // Churn-Zeitpunkt verwechselt.
  const meilensteinFaellig = (Array.isArray(meilen) ? meilen : [])
    .map((m) => ({ titel: String((m && m.title) || '').slice(0, 120), faelligMs: alsMs(m && m.due_date) }))
    .filter((m) => m.faelligMs)
    .sort((a, b) => a.faelligMs - b.faelligMs)[0] || null;

  const commits = (w(commitsR, 'commits') || []).map(commitKompakt)
    .filter((c) => c.datumMs)
    .sort((a, b) => b.datumMs - a.datumMs);
  // Zeitpunkt der letzten Bewegung ueberhaupt -- damit die Seite zeigen kann, wie frisch der
  // Stand ist, statt nur eine Liste ohne Bezug.
  // HIGHLIGHTS: alles aus BEOBACHTET, ueber den ganzen geholten Zeitraum (nicht nur 14 Tage --
  // eine XMR-Arbeit von vor drei Wochen ist immer noch die Nachricht). Je Thema Anzahl,
  // juengster Zeitpunkt und die drei aktuellsten Eintraege.
  const alleEintraege = [...commits, ...merged, ...((w(offenR, 'opened2') || []).map(mrKompakt))]
    .filter((e) => e.beobachtet && !e.rauschen);
  const highlights = BEOBACHTET.map((b) => {
    const drin = alleEintraege.filter((e) => e.beobachtet === b.key)
      .sort((a, c) => (c.datumMs || 0) - (a.datumMs || 0));
    if (!drin.length) return null;
    return {
      key: b.key, prio: b.prio, anzahl: drin.length,
      letzteMs: drin[0].datumMs || null,
      eintraege: drin.slice(0, 3),
    };
  }).filter(Boolean).sort((a, b2) => a.prio - b2.prio);

  // ── WER ARBEITET GERADE WORAN ────────────────────────────────────────────
  //
  // Gewuenscht: "hervorheben welcher dev am hustlen ist und welcher viele wichtige Sachen
  // erledigt". Gezaehlt wird ueber die letzten 30 Tage, getrennt nach:
  //   gesamt  -- alles (auch Wartung)
  //   wichtig -- ohne Wartung und ohne Merge-Rauschen
  //   fokus   -- Arbeiten an den beobachteten Integrationen (XMR, ZEC, ...)
  //
  // EINSCHRAENKUNG, die die Anzeige auch benennen muss: Das ist ein Mengenmass, kein
  // Wertmass. Ein einzelner MR, der eine ganze Chain anbindet, zaehlt genauso wie ein
  // Einzeiler. Die Sortierung nach "wichtig" und "fokus" mildert das, hebt es aber nicht auf.
  // Eine WOCHE statt einem Monat: "wer baut gerade" soll den aktuellen Stand zeigen. Ueber
  // 30 Tage stand oben, wer irgendwann im letzten Monat viel getan hat -- auch wenn er seit
  // zwei Wochen nichts mehr macht.
  const DEV_TAGE = 7;
  const seit30 = Date.now() - DEV_TAGE * 24 * 60 * 60 * 1000;
  const proDev = new Map();
  // OFFENE ARBEIT ZAEHLT MIT -- getrennt ausgewiesen.
  //
  // Gemeldet als Frage: "wo guckst du hin?" -- bis hierher nur auf Commits und GEMERGTE MRs.
  // Damit fiel die gesamte Spalte "In Arbeit" aus der Bewertung: Wer ein Dutzend Entwuerfe
  // offen hat und noch nichts gemergt, erschien als untaetig. Gerade die XMR-Arbeit laeuft
  // aber ueber genau solche offenen MRs.
  //
  // Warum trotzdem GETRENNT und nicht einfach dazuaddiert: Ein offener MR ist angefangen,
  // nicht erledigt. Beides in einen Topf zu werfen wuerde "hat viel vor" mit "hat viel
  // geliefert" verwechseln. Deshalb eine eigene Zahl, und in der Sortierung geringer
  // gewichtet als fertige Arbeit.
  const quellen = [
    ...commits.map((e) => ({ e, offen: false })),
    ...merged.map((e) => ({ e, offen: false })),
    ...offeneMrAlle.map((e) => ({ e, offen: true })),
  ];
  for (const { e, offen } of quellen) {
    if (!e.autor || !e.datumMs || e.datumMs < seit30 || e.rauschen) continue;
    let d = proDev.get(e.autor);
    if (!d) { d = { name: e.autor, gesamt: 0, wichtig: 0, fokus: 0, offen: 0, letzteMs: 0, themen: {} }; proDev.set(e.autor, d); }
    if (e.datumMs > d.letzteMs) d.letzteMs = e.datumMs;
    if (e.thema && e.thema !== 'wartung') d.themen[e.thema] = (d.themen[e.thema] || 0) + 1;
    // ALLES ZAEHLT. Vorher fiel Wartung (Tests, CI, Abhaengigkeiten, Dokumentation) aus der
    // Bewertung -- wer die Testabdeckung in Ordnung haelt, erschien als weniger aktiv als
    // jemand mit derselben Menge Feature-Arbeit. Fuer "wer arbeitet gerade viel" ist das die
    // falsche Unterscheidung: Es ist alles Arbeit.
    d.gesamt++;
    if (e.beobachtet) d.fokus++;
    if (offen) { d.offen++; continue; }
    d.wichtig++;
  }
  const devs = [...proDev.values()]
    .map((d) => ({
      ...d,
      // Schwerpunkt dieses Entwicklers -- sagt mehr als eine nackte Zahl.
      thema: Object.entries(d.themen).sort((a, b) => b[1] - a[1]).map(([k]) => k)[0] || null,
      themen: undefined,
    }))
    // Fokus-Arbeit wiegt schwerer, danach die Menge der nicht-Wartungs-Beitraege.
    // Fokus-Arbeit dreifach, fertige Arbeit einfach, offene Arbeit halb -- angefangen zaehlt,
    // aber weniger als geliefert.
    // Fokus-Arbeit (XMR, ZEC ...) wiegt dreifach, fertige Arbeit einfach, offene halb.
    .sort((a, b) => (b.fokus * 3 + b.wichtig + b.offen * 0.5) - (a.fokus * 3 + a.wichtig + a.offen * 0.5))
    .slice(0, 6);

  // SCHWERPUNKT SEIT DEM LETZTEN RELEASE, nicht "letzte 14 Tage".
  //
  // Gemeldet: "Focus last 14d macht auch keinen Sinn" -- zu Recht. 14 Tage war eine frei
  // gegriffene Zahl, die zu nichts auf der Seite passte: Die Releases darunter liegen mal 8,
  // mal 20 Tage auseinander, also zeigte das Fenster je nach Zufall einen Teil eines Releases
  // oder anderthalb. "Seit dem letzten Release" beantwortet dagegen eine echte Frage: Was ist
  // seither passiert, also was steckt im naechsten Update?
  const letztesReleaseMs = releases.length ? (releases[0].datumMs || 0) : 0;
  // Ohne Release-Datum bleibt der 14-Tage-Rueckfall, sonst haette die Karte gar keinen Inhalt.
  const seitMs = letztesReleaseMs || (Date.now() - 14 * 24 * 60 * 60 * 1000);
  const frisch = [...commits, ...merged]
    .filter((e) => e.datumMs >= seitMs && !e.rauschen && e.thema !== 'wartung');
  // "sonstiges" ans ENDE: Es ist der Rest-Eimer der Heuristik und stand allein wegen seiner
  // Menge auf Platz zwei -- ueber Themen, die tatsaechlich etwas aussagen.
  const themenAktuell = themenZaehlen(frisch)
    .sort((a, b) => (a.key === 'sonstiges' ? 1 : 0) - (b.key === 'sonstiges' ? 1 : 0) || b.n - a.n);

  const letzteAktivitaetMs = Math.max(
    commits.length ? commits[0].datumMs : 0,
    merged.length ? merged[0].datumMs : 0
  ) || null;

  return {
    schema: TIMELINE_SCHEMA,
    fehler,
    themenAktuell,
    // Ab wann gezaehlt wurde -- die Anzeige muss den Zeitraum benennen koennen, statt eine
    // Zahl ohne Bezug hinzustellen.
    themenSeitMs: seitMs,
    themenSeitRelease: !!letztesReleaseMs,
    highlights,
    poolStatus,
    // Ohne Pool-Liste bleibt poolStatus leer -- die Anzeige muss "unbekannt" von
    // "geprueft, nicht vorhanden" unterscheiden koennen.
    poolsGeprueft: Array.isArray(poolListe),
    devs,
    churn,
    meilensteinFaellig,
    aktivitaet14: frisch.length,
    netzVersion,
    branch: DEV_BRANCH,
    commits: commits.slice(0, 150),
    letzteAktivitaetMs,
    stabilVersion: neuestesStabil ? neuestesStabil.version : null,
    kandidatVersion: kandidatIstNeuer ? neuesterKandidat.version : null,
    releases,
    merged: merged.slice(0, 120),
    offen: offeneMrAlle.sort((a, b) => (b.datumMs || 0) - (a.datumMs || 0)).slice(0, 60),
    releaseMrs,
    meilensteine: (Array.isArray(meilen) ? meilen : []).map((m) => ({
      titel: String((m && m.title) || '').slice(0, 120),
      url: (m && m.web_url) || null,
    })),
    fetchedAt: Date.now(),
  };
}

async function handleThornodeTimeline(request, env, ctx) {
  // Erst der Cache: er entscheidet, ob ueberhaupt jemand GitLab anfassen muss.
  let zeile = null;
  try {
    zeile = await env.DB.prepare('SELECT payload, updated_at FROM thornode_timeline_cache WHERE id = 1').first();
  } catch (e) {
    console.warn('[rune-rewards-backend] thornode_timeline_cache nicht lesbar (Migration ausgeführt?):', e?.message || String(e));
  }
  // ?fresh=1 umgeht den Cache -- zum Nachsehen nach einem Deploy, ohne 15 Minuten zu warten.
  let frischErzwungen = false;
  try { frischErzwungen = new URL(request.url).searchParams.get('fresh') === '1'; } catch (e) {  }

  const passt = (roh) => {
    try {
      const d = JSON.parse(roh);
      return (d && d.schema === TIMELINE_SCHEMA) ? d : null;
    } catch (e) { return null; }
  };

  // ERST AUSLIEFERN, DANN ERNEUERN.
  //
  // Gemeldet: "manchmal laedt GitLab zu lange". Vorher galt der Cache nur als brauchbar,
  // solange er FRISCH war -- danach wartete der Browser auf neun GitLab-Abrufe, also je nach
  // Tagesform mehrere Sekunden bis zum Zeitlimit. Dabei aendert sich der Entwicklungsstand
  // nicht in Sekunden: Ein 20 Minuten alter Stand ist allemal besser als ein Ladekreis.
  //
  // Jetzt: Liegt ueberhaupt ein brauchbarer Eintrag vor, geht der SOFORT raus. Ist er nicht
  // mehr frisch, laeuft die Erneuerung danach im Hintergrund (waitUntil) und der naechste
  // Aufruf sieht den neuen Stand. Gewartet wird nur noch, wenn gar nichts da ist.
  const erneuern = () => baueThornodeTimeline(env).then((d) => {
    const ok = d.releases.length || d.merged.length || d.commits.length || d.netzVersion;
    if (!ok) return;
    return env.DB.prepare(
      `INSERT INTO thornode_timeline_cache (id, payload, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
    ).bind(JSON.stringify(d), Date.now()).run();
  }).catch((e) => {
    console.warn('[rune-rewards-backend] /thornode-timeline Hintergrund-Erneuerung fehlgeschlagen:', e?.message || String(e));
  });

  if (!frischErzwungen && zeile && zeile.payload) {
    const d = passt(zeile.payload);
    if (d) {
      const alter = Date.now() - zeile.updated_at;
      if (alter >= TIMELINE_FRESH_MS && alter < TIMELINE_STALE_MAX_AGE_MS) {
        // Nicht mehr frisch, aber brauchbar: ausliefern UND im Hintergrund nachziehen.
        if (ctx && ctx.waitUntil) ctx.waitUntil(erneuern());
      }
      if (alter < TIMELINE_STALE_MAX_AGE_MS) {
        return json({ ...d, stale: alter >= TIMELINE_FRESH_MS, staleSince: zeile.updated_at }, env);
      }
    }
    // Falsche Schema-Version oder uralt: nichts Brauchbares -> unten live holen.
  }

  try {
    const daten = await baueThornodeTimeline(env);
    // Nur ablegen, wenn wirklich etwas drinsteht -- sonst ueberschreibt ein kurzer GitLab-
    // Ausfall einen brauchbaren Cache mit einer leeren Huelle.
    // Teilweise Daten sind besser als keine: solange irgendetwas da ist, wird ausgeliefert
    // (die Seite zeigt, was sie hat). Nur wenn ALLES leer blieb, gilt es als Fehlschlag --
    // und dann mit den Einzelgruenden, nicht als nacktes TIMELINE_EMPTY.
    const brauchbar = daten.releases.length || daten.merged.length || daten.commits.length || daten.netzVersion;
    if (!brauchbar) {
      const e = new Error('TIMELINE_EMPTY');
      e.detail = daten.fehler;
      throw e;
    }
    // Das Ablegen darf die Antwort NIE verhindern: env.DB.prepare() wirft synchron, wenn die
    // Tabelle fehlt (Migration noch nicht gelaufen) -- das lief am .catch() der Promise vorbei
    // und liess den ganzen Endpunkt auf 503 kippen, obwohl die Daten fertig vorlagen. Jetzt
    // ist der Cache reine Kür: ohne Tabelle läuft die Seite, nur eben ohne Zwischenspeicher.
    try {
      const schreiben = env.DB.prepare(
        `INSERT INTO thornode_timeline_cache (id, payload, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).bind(JSON.stringify(daten), Date.now()).run().catch((e) => {
        console.warn('[rune-rewards-backend] thornode_timeline_cache-Schreiben fehlgeschlagen (Migration ausgeführt?):', e?.message || String(e));
      });
      if (ctx && ctx.waitUntil) ctx.waitUntil(schreiben); else await schreiben;
    } catch (e) {
      console.warn('[rune-rewards-backend] thornode_timeline_cache nicht beschreibbar (Migration ausgeführt?):', e?.message || String(e));
    }
    return json({ ...daten, stale: false }, env);
  } catch (e) {
    console.warn('[rune-rewards-backend] /thornode-timeline fehlgeschlagen, versuche Stale-Cache:', e?.message || String(e));
    if (zeile && zeile.payload && (Date.now() - zeile.updated_at) < TIMELINE_STALE_MAX_AGE_MS) {
      // Auch hier nur, wenn die Form passt -- eine alte Nutzlast ist schlimmer als keine,
      // weil die Seite sie stillschweigend als leer darstellt.
      const d = passt(zeile.payload);
      if (d) return json({ ...d, stale: true, staleSince: zeile.updated_at }, env);
    }
    return json({ error: 'TIMELINE_UNAVAILABLE', message: e?.message || String(e), detail: e?.detail || null }, env, 503);
  }
}

const MEMOLESS_UPSTREAM_DEFAULT = 'https://api.thorchain.org/memoless/api/v1';
const MEMOLESS_ALLOWED_PATHS = new Set(['assets', 'register', 'preflight']);

async function handleMemoless(request, env) {
  const url = new URL(request.url);
  const sub = url.pathname.replace(/^\/memoless\/?/, '').replace(/\/+$/, '');
  if (!MEMOLESS_ALLOWED_PATHS.has(sub)) {
    return json({ error: 'NOT_FOUND' }, env, 404);
  }

  if (sub === 'assets' && !(env && env.MEMOLESS_ASSETS_UPSTREAM_ONLY)) {
    try {
      const pools = await fetchFromBases(getThornodeBases(), '/thorchain/pools');
      const liste = (Array.isArray(pools) ? pools : []).filter(pl => pl && pl.asset);
      if (liste.length) {
        return json({
          success: true,
          assets: liste.map(pl => ({
            asset: String(pl.asset),
            
            status: String(pl.status || 'Available'),
          })),
        }, env);
      }
    } catch (e) {  }
  }

  // EIGENE INSTANZ ZUERST, OEFFENTLICHER DIENST ALS RUECKFALL.
  //
  // Hintergrund: Der oeffentliche Dienst auf api.thorchain.org haengt beim Registrieren sein
  // eigenes Affiliate "uws" (1 bps) an jeden Swap-Memo -- das ist dort eine Betreiber-
  // Einstellung (INJECT_AFFILIATE_IN_SWAPS / AFFILIATE_THORNAME), belegt durch Midgard und den
  // Quellcode (github.com/familiarcow/thorchain-memoless-api). Wer nur "runewatch" im Memo will,
  // betreibt eine eigene Instanz mit INJECT_AFFILIATE_IN_SWAPS=false.
  //
  //   MEMOLESS_UPSTREAM   Adresse der eigenen Instanz, z.B. https://.../api/v1
  //   MEMOLESS_API_KEY    (Secret) wird NUR an die eigene Instanz als "x-api-key" geschickt
  //
  // Ist die eigene Instanz nicht erreichbar, weicht der Worker auf den oeffentlichen Dienst aus,
  // damit Swaps nie am eigenen Server scheitern -- "uws" steht dann nur in diesem Notfall im
  // Memo. Das Ausweichen ist gefahrlos, weil die App die Vorpruefung mit Asset + Referenz
  // aufruft: Die Referenz steht on-chain, JEDE Instanz kann sie pruefen, egal welche
  // registriert hat.
  //
  // Zeitbudget: Die App wartet 20 s. Eigene Instanz hoechstens 8 s, danach oeffentlich 11 s.
  const eigene = env && env.MEMOLESS_UPSTREAM ? String(env.MEMOLESS_UPSTREAM).replace(/\/+$/, '') : null;
  const body = request.method === 'POST' ? await request.text() : undefined;
  const versuche = [];
  if (eigene && eigene !== MEMOLESS_UPSTREAM_DEFAULT) {
    const kopf = { 'Content-Type': 'application/json' };
    if (env.MEMOLESS_API_KEY) kopf['x-api-key'] = String(env.MEMOLESS_API_KEY);
    versuche.push({ name: 'own', basis: eigene, headers: kopf, timeoutMs: 8000 });
  }
  versuche.push({
    name: 'public', basis: MEMOLESS_UPSTREAM_DEFAULT,
    headers: { 'Content-Type': 'application/json' },
    timeoutMs: versuche.length ? 11000 : 15000
  });

  // Ausweichen nur bei Fehlern, die an der INSTANZ liegen: nicht erreichbar, Zeitlimit,
  // Serverfehler, Drosselung, falscher Schluessel. Ein 400 (ungueltige Anfrage) wuerde der
  // oeffentliche Dienst genauso ablehnen -- dort bleibt die Antwort der eigenen Instanz stehen.
  const weichAus = (status) => status >= 500 || status === 401 || status === 403 || status === 429;
  let letzterFehler = null;
  for (let i = 0; i < versuche.length; i++) {
    const v = versuche[i];
    const istLetzter = i === versuche.length - 1;
    try {
      const res = await fetchWithTimeout(`${v.basis}/${sub}${url.search || ''}`, {
        method: request.method, headers: v.headers, body, timeoutMs: v.timeoutMs
      });
      if (!istLetzter && weichAus(res.status)) {
        console.warn(`[rune-rewards-backend] memoless ${sub}: eigene Instanz HTTP ${res.status}, weiche auf oeffentlichen Dienst aus`);
        continue;
      }
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          // Welche Instanz geantwortet hat -- zum Nachpruefen, ob der Rueckfall gegriffen hat.
          'X-Memoless-Upstream': v.name,
          ...corsHeaders(env),
        },
      });
    } catch (e) {
      letzterFehler = e;
      if (!istLetzter) {
        console.warn(`[rune-rewards-backend] memoless ${sub}: eigene Instanz nicht erreichbar (${e?.message || e}), weiche aus`);
        continue;
      }
    }
  }
  const e = letzterFehler;
  const code = e?.name === 'AbortError' ? 'MEMOLESS_TIMEOUT' : 'MEMOLESS_UPSTREAM_FAILED';
  return json({ error: { code, message: e?.message || String(e) } }, env, 502);
}

// SLASH-CHECK (auf Wunsch: "es gab Slashes, Bonder haben RUNE verloren, Refund kommt mit 3.21 --
// welche Nodes sind betroffen?"). Gleiche Methode wie die THORChain-Devs in den Refund-Migrationen
// ("bond-diff" zwischen zwei Blockhoehen): Bond jeder Node bei `from` und bei `to` vergleichen.
// Waehrend eines Halts ist der Churn pausiert, Rewards landen erst beim Churn im Bond -- ein
// Rueckgang ohne Status-/Anbieterwechsel ist deshalb praktisch immer ein Slash. Zusaetzlich je
// Node die Bond Provider mit ihrem Verlust (die Bonder, die den Refund bekommen sollen).
async function handleSlashCheck(request, env) {
  const url = new URL(request.url);
  const from = parseInt(url.searchParams.get('from') || '', 10);
  let to = parseInt(url.searchParams.get('to') || '', 10);
  if (!Number.isFinite(from) || from <= 0) return json({ error: { code: 'BAD_FROM', message: 'from (Blockhoehe) fehlt' } }, env, 400);
  try {
    // Vaults zum START (vor dem Vorfall): wer war Mitglied welches Asgard-Vaults? Ein Double Spend
    // wird nur den Mitgliedern des Vaults angelastet, der die Auszahlung signiert hat.
    const [a, b, vaults] = await Promise.all([
      fetchNodesAtHeight(from),
      Number.isFinite(to) && to > 0 ? fetchNodesAtHeight(to) : fetchNodes(),
      fetchFromBases(getThornodeBases({ needsHeight: true }), `/thorchain/vaults/asgard?height=${from}`).catch(() => []),
    ]);
    const vaultVonPub = new Map();
    for (const v of (Array.isArray(vaults) ? vaults : [])) for (const m of (v.membership || [])) vaultVonPub.set(m, v);
    const bondOf = n => Number(n && n.total_bond) / 1e8 || 0;
    const provOf = n => {
      const m = new Map();
      for (const p of ((n && n.bond_providers && n.bond_providers.providers) || [])) m.set(p.bond_address, Number(p.bond) / 1e8 || 0);
      return m;
    };
    const vorher = new Map((Array.isArray(a) ? a : []).map(n => [n.node_address, n]));
    const out = [];
    let summe = 0;
    for (const n of (Array.isArray(b) ? b : [])) {
      const v = vorher.get(n.node_address);
      if (!v) continue;
      const diff = bondOf(n) - bondOf(v);
      if (!(diff < -0.01)) continue;
      const pv = provOf(v), pn = provOf(n);
      // Anbieterwechsel (jemand hat abgezogen) ist kein Slash -> markieren statt verschweigen
      const anbieterWeg = [...pv.keys()].filter(k => !pn.has(k));
      const bonder = [...pn.entries()].map(([addr, jetzt]) => ({ addr, verlust: jetzt - (pv.get(addr) || 0) }))
        .filter(x => x.verlust < -0.01).sort((x, y) => x.verlust - y.verlust);
      const pub = (v.pub_key_set && v.pub_key_set.secp256k1) || (n.pub_key_set && n.pub_key_set.secp256k1) || null;
      const vault = pub ? vaultVonPub.get(pub) : null;
      out.push({
        vault: vault ? vault.pub_key : null,
        node: n.node_address, operator: n.node_operator_address, status: n.status, statusVorher: v.status,
        bondVorher: bondOf(v), bondJetzt: bondOf(n), diff, bonder, unsicher: anbieterWeg.length > 0 || v.status !== n.status,
      });
      if (!(anbieterWeg.length > 0 || v.status !== n.status)) summe += diff;
    }
    out.sort((x, y) => x.diff - y.diff);
    // Zusammenfassung je Vault: wie viele seiner Mitglieder haben (sicher) Bond verloren?
    const vListe = (Array.isArray(vaults) ? vaults : []).map(v => {
      const treffer = out.filter(x => x.vault === v.pub_key && !x.unsicher);
      const addr = c => ((v.addresses || []).find(x => String(x.chain).toUpperCase() === c) || {}).address || null;
      return { pub_key: v.pub_key, status: v.status, mitglieder: (v.membership || []).length, betroffen: treffer.length,
        verlust: treffer.reduce((s2, x) => s2 + x.diff, 0), btc: addr('BTC'),
        adressen: Object.fromEntries((v.addresses || []).map(x => [String(x.chain).toUpperCase(), x.address])) };
    }).filter(v => v.betroffen > 0).sort((x, y) => x.verlust - y.verlust);
    return new Response(JSON.stringify({ from, to: Number.isFinite(to) && to > 0 ? to : null, nodes: out, summe, vaults: vListe }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...corsHeaders(env) },
    });
  } catch (e) {
    return json({ error: { code: 'SLASH_CHECK_FAILED', message: e?.message || String(e) } }, env, 502);
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
      if (url.pathname === '/slash-check') {
        return await handleSlashCheck(request, env);
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
      if (url.pathname === '/ops') {
        try { return await handleOps(request, env); } catch (e) { return json({ error: e?.message || String(e) }, env, 500); }
      }
      if (url.pathname === '/ops-quelle') {
        // QUELLEN VON devops.thorchain.org FINDEN (gefragt: "die nehmen sich die Infos irgendwo
        // her -- finde es"): Laedt die Seite, alle eingebundenen Skripte und sucht darin nach
        // Datenadressen (fetch-Aufrufe, .json-Dateien, /api/-Pfade, GitLab-, THORNode- und
        // RPC-Adressen). Gibt eine Liste zurueck; probiert gefundene Adressen auf derselben Seite
        // kurz an (Status + Anfang der Antwort), damit man sieht, was davon Daten liefert.
        try {
          const basis = 'https://devops.thorchain.org';
          const r = await fetchWithTimeout(basis + '/', { timeoutMs: 12000, headers: { 'User-Agent': 'rune.watch-ops-finder' } });
          const html = await r.text();
          const skripte = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map(m => new URL(m[1], basis).toString());
          const texte = [{ quelle: '/', inhalt: html }];
          for (const sUrl of skripte.slice(0, 12)) {
            try { const rs = await fetchWithTimeout(sUrl, { timeoutMs: 12000 }); texte.push({ quelle: sUrl, inhalt: await rs.text() }); } catch (e) {}
          }
          const muster = [
            /fetch\(\s*[`"']([^`"']+)[`"']/g,
            /["'`](\/[A-Za-z0-9_\-\/.]*\.json[^"'`]*)["'`]/g,
            /["'`](\/api\/[^"'`\s]*)["'`]/g,
            /["'`](https?:\/\/[^"'`\s]*(?:gitlab|thornode|ninerealms|liquify|rpc|midgard|\.json|\/api\/)[^"'`\s]*)["'`]/g,
          ];
          const funde = new Map();
          for (const tx of texte) for (const mu of muster) for (const m of tx.inhalt.matchAll(mu)) {
            const roh = m[1]; if (!roh || roh.length > 300) continue;
            let abs; try { abs = new URL(roh, basis).toString(); } catch (e) { continue; }
            if (!funde.has(abs)) funde.set(abs, { url: abs, gefundenIn: tx.quelle });
          }
          const liste = [...funde.values()];
          // gleiche Seite kurz anprobieren
          for (const f of liste.filter(x => x.url.startsWith(basis)).slice(0, 15)) {
            try {
              const rp = await fetchWithTimeout(f.url, { timeoutMs: 8000 });
              const tx = await rp.text();
              f.status = rp.status; f.typ = rp.headers.get('content-type'); f.anfang = tx.slice(0, 300);
            } catch (e) { f.fehler = e?.message || String(e); }
          }
          // Zweite Stufe: Die Seite hat KEINE externen Skripte (alles inline, 200+ KB) --
          // also die eingebetteten Skripte/Daten untersuchen und gaengige /api/-Pfade anprobieren.
          const inline = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].map((m, i) => ({
            nr: i, attr: m[1].trim().slice(0, 120), laenge: m[2].length, anfang: m[2].trim().slice(0, 160) }));
          const apiTeile = [...new Set([...html.matchAll(/["'`](\/api\/[^"'`\s)]*)/g)].map(m => m[1]))];
          const schluessel = ['tasks', 'TASKS', 'steps', 'stagenet', 'upgrade', 'milestone', 'labels', 'progress', 'updates'];
          const stellen = {};
          for (const k of schluessel) { const i = html.indexOf(k); if (i >= 0) stellen[k] = html.slice(Math.max(0, i - 120), i + 200).replace(/\s+/g, ' '); }
          const proben = {};
          for (const pfad of ['/api/feed.json', '/api/tasks.json', '/api/status.json', '/api/state.json', '/api/chain.json', '/api/upgrade.json', '/api/data.json', '/api/mrs.json', '/api/gitlab.json', '/api/tasks', '/api/status', '/api/state', '/data.json', '/tasks.json', '/status.json']) {
            try { const rp = await fetchWithTimeout(basis + pfad, { timeoutMs: 6000 }); const tx = await rp.text(); proben[pfad] = { status: rp.status, typ: rp.headers.get('content-type'), anfang: tx.slice(0, 220) }; }
            catch (e) { proben[pfad] = { fehler: e?.message || String(e) }; }
          }
          // Dritte Stufe: Aufgaben und Upgrade stehen als fertiges HTML in der Seite (die Skripte
          // sind nur Bedienung). Fuer den Nachbau eines Lesers: je ein Ausschnitt der Bausteine.
          const ausschnitt = (marke, len) => { const i = html.indexOf(marke); return i < 0 ? null : html.slice(i, i + len); };
          const html_bausteine = {
            upgrade: ausschnitt('upg-seg', 2500),
            allview: ausschnitt('id="allview"', 300),
            task: ausschnitt('class="task', 3500),
            focus: ausschnitt('id="stage"', 2500),
            chain: ausschnitt('CHAIN', 1500),
          };
          if (url.searchParams.get('teil')) return json({ teil: html_bausteine[url.searchParams.get('teil')] || null }, env);
          // Freie Suche: ?suche=TEXT&n=1&len=3000 -> Ausschnitt ab dem n-ten Vorkommen (0 = erstes)
          // und die Zahl aller Vorkommen. Als reiner Text, damit er gut lesbar ist.
          if (url.searchParams.get('suche')) {
            const q = url.searchParams.get('suche'), n = Number(url.searchParams.get('n') || 0), len = Math.min(8000, Number(url.searchParams.get('len') || 3000));
            const pos = []; let i = -1; while ((i = html.indexOf(q, i + 1)) >= 0 && pos.length < 500) pos.push(i);
            const ab = pos[Math.min(n, pos.length - 1)];
            const text = ab == null ? '(nicht gefunden)' : html.slice(ab, ab + len);
            return new Response(`Vorkommen: ${pos.length}\n\n` + text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(env) } });
          }
          return json({ seite: basis, htmlLaenge: html.length, html_bausteine, skripte, inline, apiTeile, stellen, proben, funde: liste.filter(f => !/merge_requests\/\d+$/.test(f.url)), mrAnzahl: liste.filter(f => /merge_requests\/\d+$/.test(f.url)).length }, env);
        } catch (e) { return json({ error: e?.message || String(e) }, env, 500); }
      }
      if (url.pathname === '/near-dune-status') {
        // Diagnose fuer den Dune-Abruf: Schluessel gesetzt? Letzter Erfolg, laufende Ausfuehrung,
        // letzter Fehler, Zahl der gespeicherten Tage. Kein Schluessel/keine Daten werden gezeigt.
        try {
          await sichereNearDuneTabelle(env);
          const meta = await env.DB.prepare('SELECT * FROM near_dune_meta WHERE id = 1').first();
          const n = await env.DB.prepare('SELECT COUNT(*) AS c, MIN(day) AS von, MAX(day) AS bis FROM near_dune_daily').first();
          return json({ keySet: !!env.DUNE_API_KEY, lastOk: meta && meta.last_ok ? new Date(Number(meta.last_ok)).toISOString() : null,
            pendingExec: !!(meta && meta.pending_exec), lastError: (meta && meta.last_error) || null,
            days: Number(n && n.c) || 0, from: (n && n.von) || null, to: (n && n.bis) || null, workerVersion: WORKER_VERSION }, env);
        } catch (e) { return json({ error: e?.message || String(e) }, env, 500); }
      }
      if (url.pathname === '/dex-volume') {
        return await handleDexVolume(request, env, ctx);
      }
      if (url.pathname === '/rune-history') {
        return await handleRuneHistory(request, env, ctx);
      }
      if (url.pathname === '/thornode-timeline') {
        return await handleThornodeTimeline(request, env, ctx);
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
      if (url.pathname === '/node-epochs') {
        return await handleNodeEpochs(request, env);
      }
      // Nachholen von Hand beschleunigen (Cron laeuft hoechstens jede Minute): jeder Aufruf holt
      // bis zu 15 weitere Tage. Antwort nennt den Stand.
      if (url.pathname === '/rujira-tcy-nachholen') {
        try {
          const n = Math.min(15, Math.max(1, Number(url.searchParams.get('tage')) || 10));
          await syncRujiraTcyDaily(env, n).catch(() => {});
          await syncRujiraKursEreignisse(env, 8).catch(() => {});
          const c = await env.DB.prepare('SELECT COUNT(*) AS n, MIN(tag) AS von FROM rujira_tcy_daily').first();
          const k = await env.DB.prepare('SELECT COUNT(*) AS n, MIN(tag) AS von FROM rujira_tcy_kurs').first();
          const f = await env.DB.prepare("SELECT v FROM rujira_tcy_state WHERE k = 'kurs_fertig'").first();
          return json({ ok: true, tage: Number(c?.n) || 0, aeltester: c?.von || null,
            kursTage: Number(k?.n) || 0, kursAeltester: k?.von || null, kursFertig: !!f }, env);
        } catch (e) { return json({ error: e?.message || String(e) }, env, 500); }
      }
      // Node-Liste fuer "Beispiel ansehen": nur die noetigen Felder, 10 Minuten zwischengespeichert.
      if (url.pathname === '/nodes-raw') {
        try {
          if (!globalThis.__rwNodesRaw || Date.now() - globalThis.__rwNodesRaw.t > 600000) {
            const n = await fetchFromBases(getThornodeBases(), '/thorchain/nodes');
            if (Array.isArray(n)) globalThis.__rwNodesRaw = { t: Date.now(), d: n.map(x => ({ status: x.status, slash_points: x.slash_points, node_operator_address: x.node_operator_address,
              bond_providers: { providers: ((x.bond_providers && x.bond_providers.providers) || []).map(p => ({ bond_address: p.bond_address, bond: p.bond })) } })) };
          }
          return json(globalThis.__rwNodesRaw ? globalThis.__rwNodesRaw.d : [], env);
        } catch (e) { return json({ error: e?.message || String(e) }, env, 500); }
      }
      if (url.pathname === '/rujira-brune-history') {
        try {
          if (url.searchParams.get('neu') === '1') { try { await Promise.race([syncRujiraBruneKurs(env, 10), new Promise(r => setTimeout(r, 20000))]); } catch (e) {} }
          return await handleRujiraBruneHistory(request, env);
        } catch (e) { return json({ error: e?.message || String(e) }, env, 500); }
      }
      if (url.pathname === '/analyse/swaps.csv') {
        try { return await handleAnalyseSwapsCsv(request, env, url); } catch (e) { return json({ error: e?.message || String(e) }, env, 500); }
      }
      if (url.pathname === '/analyse/volumen-kurs') {
        try { return await handleAnalyseVolumenKurs(request, env, url); } catch (e) { return json({ error: e?.message || String(e) }, env, 500); }
      }
      if (url.pathname.startsWith('/push/')) {
        try { return await handlePush(request, env, url); } catch (e) { return json({ error: e?.message || String(e) }, env, 500); }
      }
      if (url.pathname === '/donation-history') {
        try {
          let diag = null;
          if (url.searchParams.get('neu') === '1') { try { diag = await syncDonationHistory(env, true); } catch (e) { diag = { fehler: e?.message || String(e) }; } }
          return await handleDonationHistory(request, env, diag);
        } catch (e) { return json({ error: e?.message || String(e) }, env, 500); }
      }
      if (url.pathname === '/tcy-native-ref') {
        try { return await handleTcyNativeRef(request, env); } catch (e) { return json({ error: e?.message || String(e) }, env, 500); }
      }
      if (url.pathname === '/rujira-tcy-history') {
        try { return await handleRujiraTcyHistory(request, env); } catch (e) { return json({ error: e?.message || String(e) }, env, 500); }
      }
      if (url.pathname === '/node-scores') {
        return await handleNodeScores(request, env);
      }
      if (url.pathname === '/runebond-nodes') {
        return await handleRunebondNodes(request, env, ctx);
      }
      if (url.pathname === '/is-owner') {
        return await handleIsOwner(request, env);
      }
      if (url.pathname === '/click') {
        return await handleClick(request, env, ctx);
      }
      if (url.pathname === '/stats') {
        return await handleStats(request, env);
      }
      if (url.pathname === '/analyse/markt') {
        return await handleMarkt(request, env);
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

const NODE_HISTORY_MIN_INTERVAL_MS = 30 * 60 * 1000;

const NODE_HISTORY_CHURNS_BACK = 50;
const NODE_HISTORY_PER_RUN = 2;

const JAIL_HISTORY_DAYS = 90;
const JAIL_HISTORY_MAX = 500;

async function syncNodeHistory(env) {
  let zeile = null;
  try {
    zeile = await env.DB.prepare('SELECT payload, updated_at FROM recent_swaps_snapshot WHERE id = 1').first();
  } catch (e) { return; }

  let payload = {};
  try { payload = zeile && zeile.payload ? JSON.parse(zeile.payload) : {}; } catch (e) { payload = {}; }
  const zuletzt = Number(payload.nodeHistoryAt) || 0;
  if (Date.now() - zuletzt < NODE_HISTORY_MIN_INTERVAL_MS) return;

  let nodes;
  try {
    nodes = await fetchNodes();
  } catch (e) {
    console.warn('[rune-rewards-backend] Node-Verlauf: Abruf fehlgeschlagen:', e?.message || String(e));
    return;
  }
  const liste = Array.isArray(nodes) ? nodes : (nodes && nodes.nodes) || [];
  const aktiv = liste
    .filter(n => String(n?.status || '').toLowerCase() === 'active')
    .map(n => String(n?.node_address || '').toLowerCase())
    .filter(Boolean);
  if (!aktiv.length) return;

  // ------------------------------------------------------------------
  // JAIL-VERLAUF
  //
  // /thorchain/nodes zeigt nur den Ist-Zustand: Ist die Sperre abgelaufen, verschwindet jede
  // Spur. Eine Node, die bei jedem zweiten Churn beim Keysign scheitert, sieht dazwischen
  // tadellos aus.
  //
  // Deshalb wird bei jedem Durchgang der Jail-Zustand mit dem vorigen verglichen und nur die
  // AENDERUNG festgehalten -- ein Ereignis je neuer Sperre, keine Momentaufnahmen.
  const jetztMs = Date.now();
  const alteSperren = (payload.jailState && typeof payload.jailState === 'object') ? payload.jailState : {};
  const neueSperren = {};
  const ereignisse = Array.isArray(payload.jailEvents) ? payload.jailEvents.slice() : [];
  for (const n of liste) {
    const adr = String(n?.node_address || '').toLowerCase();
    if (!adr) continue;
    const bis = Number(n?.jail?.release_height) || 0;
    if (bis <= 0) continue;
    neueSperren[adr] = bis;
    // Neue Sperre = hoehere release_height als zuletzt gesehen. Eine gleichbleibende Hoehe
    // ist dieselbe Sperre und darf nicht mehrfach gezaehlt werden.
    if (bis > (Number(alteSperren[adr]) || 0)) {
      ereignisse.push({ a: adr, r: String(n?.jail?.reason || '').slice(0, 60), t: jetztMs });
    }
  }
  const grenze = jetztMs - JAIL_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const jailEvents = ereignisse
    .filter(e => e && Number(e.t) >= grenze)
    .slice(-JAIL_HISTORY_MAX);
  const jailNeu = jailEvents.length !== (Array.isArray(payload.jailEvents) ? payload.jailEvents.length : 0);

  // --- GESCHEITERTE CHURN-VERSUCHE ---
  //
  // THORChain setzt next_churn_height auf einen NEUEN, hoeheren Block, wenn ein Churn nicht
  // zustande kommt (etwa weil die Keygen-Runde scheitert). Von aussen sieht das aus, als
  // springe der Countdown grundlos -- die App wirkte dadurch fehlerhaft.
  let churnVersuche = (Array.isArray(payload.churnAttempts) ? payload.churnAttempts : [])
    .filter(e => e && (Date.now() - (Number(e.t) || 0)) <= 7 * 24 * 60 * 60 * 1000);
  let zielHoehe = Number(payload.churnTargetHeight) || 0;
  let letzteChurnHoehe = Number(payload.lastChurnHeight) || 0;
  try {
    const netz = await fetchFromBases(getThornodeBases(), '/thorchain/network');
    const ziel = Number(netz && netz.next_churn_height) || 0;
    const letzte = Number(netz && netz.last_churn_height) || 0;
    
    const churnLaeuft = !(Number(netz && netz.mimir && netz.mimir.HALTCHURNING) > 0);
    const fensterVorab = Date.now() - 20 * 60 * 1000;
    const belege = (Array.isArray(payload.jailEvents) ? payload.jailEvents : [])
      .filter(e => e && Number(e.t) >= fensterVorab && /key(gen|sign)/i.test(String(e.r || '')));
    // Die Jail-Belege sind ZUSATZ, keine Pflicht: Ein Churn kann sich auch ohne Sperren
    // verschieben. Die Bedingung "Ziel steigt, kein Churn, nicht angehalten" ist fuer sich
    // aussagekraeftig.
    if (ziel && zielHoehe && ziel > zielHoehe && letzte === letzteChurnHoehe && churnLaeuft) {
      const schuldige = [...new Set(belege.map(e => String(e.a)))].slice(0, 40);
      // KLASSIFIZIERUNG: keygen (Schluesselerzeugung gescheitert -- der schwerere Fall),
      // keysign (verpasste Signaturen) oder ohne (niemand gesperrt -> Vorbedingung fehlte).
      // Keygen hat Vorrang, wenn beides auftritt.
      const gruende = belege.map(e => String(e.r || '').toLowerCase());
      const art = gruende.some(g => g.includes('keygen')) ? 'keygen'
        : gruende.some(g => g.includes('keysign')) ? 'keysign'
        : 'ohne';
      churnVersuche.push({
        t: Date.now(), von: zielHoehe, bis: ziel, nodes: schuldige, art,
        verschoben: ziel - zielHoehe,
      });
    }
    if (ziel) zielHoehe = ziel;
    if (letzte) letzteChurnHoehe = letzte;
  } catch (e) {  }

  const bekannt = new Set(Array.isArray(payload.knownActiveNodes) ? payload.knownActiveNodes : []);
  const vorher = bekannt.size;
  const erstBefuellung = vorher === 0;
  for (const a of aktiv) bekannt.add(a);

  const erledigt = new Set(Array.isArray(payload.historyHeightsDone) ? payload.historyHeightsDone : []);
  let offeneHoehen = [];
  try {
    const churns = await fetchChurns();
    const churnListe = Array.isArray(churns) ? churns : [];
    offeneHoehen = churnListe
      .map(c => Number(c && c.height))
      .filter(h => Number.isFinite(h) && h > 1)
      .sort((a, b) => b - a)                 
      .slice(0, NODE_HISTORY_CHURNS_BACK);

    const juengste = churnListe.length ? Math.max(...churnListe.map(c => Number(c && c.height) || 0)) : 0;
    let jetztHoehe = 0;
    try {
      const bl = await fetchFromBases(getThornodeBases(), '/thorchain/lastblock');
      const arr = Array.isArray(bl) ? bl : [bl];
      jetztHoehe = parseInt(arr[0] && arr[0].thorchain || '0', 10) || 0;
    } catch (e) {  }
    if (juengste && jetztHoehe && jetztHoehe > juengste + 20000) {
      const SCHRITT = 40000;
      for (let h = juengste + SCHRITT; h < jetztHoehe; h += SCHRITT) {
        offeneHoehen.push(h);
      }
    }

    offeneHoehen = offeneHoehen
      .filter(h => Number.isFinite(h) && h > 1 && !erledigt.has(h))
      .sort((a, b) => b - a);
  } catch (e) {
    console.warn('[rune-rewards-backend] Node-Verlauf: Churn-Liste nicht abrufbar:', e?.message || String(e));
  }

  for (const h of offeneHoehen.slice(0, NODE_HISTORY_PER_RUN)) {
    try {
      
      const alteNodes = await fetchNodesAtHeight(h - 1);
      const alteListe = Array.isArray(alteNodes) ? alteNodes : (alteNodes && alteNodes.nodes) || [];
      for (const n of alteListe) {
        if (String(n?.status || '').toLowerCase() !== 'active') continue;
        const a = String(n?.node_address || '').toLowerCase();
        if (a) bekannt.add(a);
      }
      erledigt.add(h);
    } catch (e) {
      console.warn('[rune-rewards-backend] Node-Verlauf: Hoehe', h, 'nicht abrufbar:', e?.message || String(e));
      
      break;
    }
  }

  const hoehenNeu = erledigt.size !== (Array.isArray(payload.historyHeightsDone) ? payload.historyHeightsDone.length : 0);
  if (bekannt.size === vorher && !hoehenNeu && !jailNeu && zuletzt) return;

  const neu = {
    ...payload,
    knownActiveNodes: [...bekannt],
    jailState: neueSperren,
    jailEvents,
    historyHeightsDone: [...erledigt],
    
    historyPending: Math.max(0, offeneHoehen.length - NODE_HISTORY_PER_RUN),
    
    nodeHistoryHeights: erledigt.size,
    churnAttempts: churnVersuche.slice(-50),
    churnTargetHeight: zielHoehe,
    lastChurnHeight: letzteChurnHoehe,
    churnHeightsAt: Date.now(),
    nodeHistoryAt: Date.now(),
    
    nodeHistorySince: payload.nodeHistorySince || Date.now(),
    nodeHistorySeeded: erstBefuellung ? true : !!payload.nodeHistorySeeded,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO recent_swaps_snapshot (id, payload, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
    ).bind(JSON.stringify(neu), Date.now()).run();
  } catch (e) {
    console.warn('[rune-rewards-backend] Node-Verlauf: Schreiben fehlgeschlagen:', e?.message || String(e));
  }
}

// CACHE VORWAERMEN.
//
// Der Cron laeuft ohnehin. Wenn er den Entwicklungsstand gleich mitzieht, ist der Eintrag im
// Normalfall immer frisch und KEIN Besucher wartet je auf GitLab -- auch der erste nicht.
// Ohne das traf immer derjenige die kalte Stelle, der zufaellig nach Ablauf der 15 Minuten
// als Erster die Seite oeffnete.
const TIMELINE_WARM_MS = 10 * 60 * 1000;

async function waermeTimeline(env) {
  try {
    const zeile = await env.DB.prepare('SELECT updated_at FROM thornode_timeline_cache WHERE id = 1').first();
    if (zeile && (Date.now() - Number(zeile.updated_at)) < TIMELINE_WARM_MS) return;
    const d = await baueThornodeTimeline(env);
    if (!(d.releases.length || d.merged.length || d.commits.length || d.netzVersion)) return;
    await env.DB.prepare(
      `INSERT INTO thornode_timeline_cache (id, payload, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
    ).bind(JSON.stringify(d), Date.now()).run();
  } catch (e) {
    // Darf den restlichen Cron-Durchgang nicht stoppen.
    console.warn('[rune-rewards-backend] Timeline-Vorwaermen fehlgeschlagen:', e?.message || String(e));
  }
}


// =====================================================================================
// NODE-EPOCHEN: DAUERHAFTE HISTORIE JE NODE UND CHURN
//
// Grundlage fuer eine Node-Bewertung ("mit welchem Node haetten Bonder am meisten verdient,
// welcher ist am zuverlaessigsten?"). THORNode zeigt nur den Ist-Zustand; was in frueheren
// Epochen war (Fee, Slash-Punkte, Ertrag, warum eine Node rausflog), geht verloren. Deshalb
// wird fuer JEDEN Churn eine Zeile je Node gespeichert -- ohne Ablaufdatum.
//
// Eine Zeile (node, churn_height) beschreibt die Epoche, die mit diesem Churn ENDETE:
//   - Kennzahlen am letzten Block davor (H-1): Bond, Operator-Fee, Slash-Punkte, Ertrag der
//     Epoche (current_award, wird beim Churn ausgezahlt), Zahl der Bond-Provider, Version.
//   - Status davor (H-1) und danach (H+1) -> Ein- und Austritte.
//   - Bei Austritt der wahrscheinliche Grund: Austrittswunsch, erzwungen, Sperre, schlechteste
//     (meiste Slash-Punkte), niedrigster Bond, aelteste -- so waehlt THORChain beim Churn aus.
// Gespeichert werden nur Nodes, die vor ODER nach dem Churn aktiv waren.
//
// Befuellung: je Cron-Lauf EIN Churn (2 Archiv-Abfragen), neueste zuerst, danach rueckwaerts
// bis zum Anfang der Midgard-Churnliste. Fehlt ein Block im Archiv, wird er nach 3 Versuchen
// uebersprungen (Tabelle node_epochs_meta).
//
// Die Tabellen legt der Worker selbst an. Wer es lieber von Hand macht (D1-Console):
//   CREATE TABLE IF NOT EXISTS node_epochs (
//     node TEXT NOT NULL, churn_height INTEGER NOT NULL, churn_time INTEGER, epoch_secs INTEGER,
//     status_before TEXT, status_after TEXT, bond REAL, fee_bps INTEGER, slash_points INTEGER,
//     reward REAL, providers INTEGER, jailed INTEGER, version TEXT, out_reason TEXT,
//     active_since INTEGER, PRIMARY KEY (node, churn_height));
//   CREATE INDEX IF NOT EXISTS idx_node_epochs_height ON node_epochs(churn_height);
//   CREATE TABLE IF NOT EXISTS node_epochs_meta (
//     churn_height INTEGER PRIMARY KEY, status TEXT NOT NULL, tries INTEGER NOT NULL, at INTEGER);
// =====================================================================================
const NODE_EPOCHS_MAX_TRIES = 3;
let nodeEpochTabellenOk = false;

async function sichereNodeEpochTabellen(env) {
  if (nodeEpochTabellenOk) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_epochs (
      node TEXT NOT NULL, churn_height INTEGER NOT NULL, churn_time INTEGER, epoch_secs INTEGER,
      status_before TEXT, status_after TEXT, bond REAL, fee_bps INTEGER, slash_points INTEGER,
      reward REAL, providers INTEGER, jailed INTEGER, version TEXT, out_reason TEXT,
      active_since INTEGER, PRIMARY KEY (node, churn_height))`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_node_epochs_height ON node_epochs(churn_height)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_epochs_meta (
      churn_height INTEGER PRIMARY KEY, status TEXT NOT NULL, tries INTEGER NOT NULL, at INTEGER)`),
  ]);
  nodeEpochTabellenOk = true;
}

const nodeListe = x => (Array.isArray(x) ? x : (x && x.nodes) || []);
const nodeStatus = n => String(n?.status || '').toLowerCase();
const runeAus = v => { const z = Number(v); return Number.isFinite(z) ? z / 1e8 : null; };

// Austrittsgrund einer Node, die vor dem Churn aktiv war und danach nicht mehr.
function austrittsGrund(n, aktivVorher, hoehe) {
  if (n?.forced_to_leave) return 'forced';
  if (n?.requested_to_leave) return 'leave';
  if ((Number(n?.jail?.release_height) || 0) > hoehe) return 'jail';
  if (!aktivVorher.length) return 'other';
  const slash = x => Number(x?.slash_points) || 0;
  const bond = x => Number(x?.total_bond ?? x?.bond) || 0;
  const seit = x => Number(x?.active_block_height) || 0;
  if (slash(n) > 0 && slash(n) >= Math.max(...aktivVorher.map(slash))) return 'worst';
  if (bond(n) <= Math.min(...aktivVorher.map(bond))) return 'lowbond';
  if (seit(n) > 0 && seit(n) <= Math.min(...aktivVorher.map(seit).filter(v => v > 0))) return 'oldest';
  return 'other';
}

async function syncNodeEpochs(env) {
  await sichereNodeEpochTabellen(env);
  const churns = nodeListe(await fetchChurns())
    .map(c => ({ h: Number(c?.height), t: Math.round(Number(c?.date) / 1e6) }))
    .filter(c => Number.isFinite(c.h) && c.h > 1 && Number.isFinite(c.t))
    .sort((a, b) => a.h - b.h);
  if (churns.length < 2) return;
  const meta = await env.DB.prepare('SELECT churn_height, status, tries FROM node_epochs_meta').all();
  const bekannt = new Map((meta.results || []).map(r => [Number(r.churn_height), r]));
  // Neueste zuerst; die allererste Churn-Hoehe hat keine Vorgaenger-Epoche.
  const offen = [];
  for (let i = churns.length - 1; i >= 1; i--) {
    const m = bekannt.get(churns[i].h);
    if (m && (m.status === 'done' || Number(m.tries) >= NODE_EPOCHS_MAX_TRIES)) continue;
    offen.push({ ...churns[i], vorher: churns[i - 1], tries: m ? Number(m.tries) : 0 });
    if (offen.length >= 1) break;
  }
  for (const c of offen) {
    const merke = status => env.DB.prepare(
      `INSERT INTO node_epochs_meta (churn_height, status, tries, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(churn_height) DO UPDATE SET status = excluded.status, tries = excluded.tries, at = excluded.at`
    ).bind(c.h, status, c.tries + 1, Date.now()).run();
    let vor, nach;
    try {
      vor = nodeListe(await fetchNodesAtHeight(c.h - 1));
      nach = nodeListe(await fetchNodesAtHeight(c.h + 1));
    } catch (e) {
      await merke('failed');
      console.warn('[rune-rewards-backend] Node-Epochen: Hoehe', c.h, 'nicht abrufbar:', e?.message || String(e));
      continue;
    }
    if (!vor.length || !nach.length) { await merke('failed'); continue; }
    const statusNach = new Map(nach.map(n => [String(n?.node_address || '').toLowerCase(), nodeStatus(n)]));
    const aktivVorher = vor.filter(n => nodeStatus(n) === 'active');
    const epochSecs = Math.max(0, Math.round((c.t - c.vorher.t) / 1000));
    const zeilen = [];
    for (const n of vor) {
      const adr = String(n?.node_address || '').toLowerCase();
      if (!adr) continue;
      const sv = nodeStatus(n), sn = statusNach.get(adr) || 'gone';
      if (sv !== 'active' && sn !== 'active') continue;
      const bp = n?.bond_providers || {};
      zeilen.push(env.DB.prepare(
        `INSERT OR REPLACE INTO node_epochs (node, churn_height, churn_time, epoch_secs, status_before, status_after,
           bond, fee_bps, slash_points, reward, providers, jailed, version, out_reason, active_since)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        adr, c.h, c.t, epochSecs, sv, sn,
        runeAus(n?.total_bond ?? n?.bond), Number(bp.node_operator_fee) || 0, Number(n?.slash_points) || 0,
        sv === 'active' ? runeAus(n?.current_award) : 0,
        Array.isArray(bp.providers) ? bp.providers.length : 0,
        (Number(n?.jail?.release_height) || 0) > c.h - 1 ? 1 : 0,
        String(n?.version || '').slice(0, 20),
        sv === 'active' && sn !== 'active' ? austrittsGrund(n, aktivVorher, c.h - 1) : null,
        Number(n?.active_block_height) || null
      ));
    }
    // D1 begrenzt die Groesse eines Batches -- in Paketen schreiben.
    for (let i = 0; i < zeilen.length; i += 50) await env.DB.batch(zeilen.slice(i, i + 50));
    await merke('done');
    nodeScoresCache = null;
  }
}

// GET /node-epochs?node=thor1...&limit=200 -- alle Epochen einer Node, neueste zuerst.
async function handleNodeEpochs(request, env) {
  await sichereNodeEpochTabellen(env);
  const url = new URL(request.url);
  const node = String(url.searchParams.get('node') || '').toLowerCase().trim();
  if (!/^thor1[0-9a-z]{20,90}$/.test(node)) return json({ error: 'BAD_NODE' }, env, 400);
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
  const r = await env.DB.prepare(
    'SELECT * FROM node_epochs WHERE node = ? ORDER BY churn_height DESC LIMIT ?'
  ).bind(node, limit).all();
  return json({ node, epochs: r.results || [] }, env);
}

// GET /node-scores?epochs=30 -- Kennzahlen je Node ueber die letzten N Churns:
//   activeEpochs, apyBonder (Ertrag nach Operator-Fee je Bond, aufs Jahr gerechnet, Mittel
//   ueber die aktiven Epochen), avgSlash, avgFeeBps, churnOuts je Grund, jailedEpochs.
// Dazu die Abdeckung (wie viele Churns schon eingelesen sind).
let nodeScoresCache = null;
const NODE_SCORES_CACHE_MS = 10 * 60 * 1000;
async function handleNodeScores(request, env) {
  await sichereNodeEpochTabellen(env);
  const url = new URL(request.url);
  const n = Math.min(500, Math.max(1, Number(url.searchParams.get('epochs')) || 30));
  if (nodeScoresCache && nodeScoresCache.n === n && Date.now() - nodeScoresCache.at < NODE_SCORES_CACHE_MS) {
    return json(nodeScoresCache.data, env);
  }
  const hoehen = await env.DB.prepare(
    'SELECT DISTINCT churn_height FROM node_epochs ORDER BY churn_height DESC LIMIT ?'
  ).bind(n).all();
  const hs = (hoehen.results || []).map(r => Number(r.churn_height));
  const gesamt = await env.DB.prepare(
    "SELECT COUNT(*) AS c, MIN(churn_height) AS von FROM node_epochs_meta WHERE status = 'done'"
  ).first();
  const daten = { epochs: hs.length, fromHeight: hs.length ? Math.min(...hs) : null, toHeight: hs.length ? Math.max(...hs) : null,
    coverage: { churnsDone: Number(gesamt?.c) || 0, oldestHeight: Number(gesamt?.von) || null }, nodes: [] };
  if (hs.length) {
    const r = await env.DB.prepare(
      `SELECT node,
         SUM(status_before = 'active') AS activeEpochs,
         AVG(CASE WHEN status_before = 'active' AND bond > 0 AND epoch_secs > 0
                  THEN reward * (1 - fee_bps / 10000.0) / bond * 31536000.0 / epoch_secs END) AS apyBonder,
         AVG(CASE WHEN status_before = 'active' THEN slash_points END) AS avgSlash,
         AVG(CASE WHEN status_before = 'active' THEN fee_bps END) AS avgFeeBps,
         SUM(CASE WHEN status_before = 'active' THEN reward ELSE 0 END) AS rewardTotal,
         SUM(jailed) AS jailedEpochs,
         SUM(COALESCE(out_reason, '') = 'leave') AS outLeave, SUM(COALESCE(out_reason, '') = 'forced') AS outForced,
         SUM(COALESCE(out_reason, '') = 'jail') AS outJail, SUM(COALESCE(out_reason, '') = 'worst') AS outWorst,
         SUM(COALESCE(out_reason, '') = 'lowbond') AS outLowBond, SUM(COALESCE(out_reason, '') = 'oldest') AS outOldest,
         SUM(COALESCE(out_reason, '') = 'other') AS outOther,
         SUM(status_before != 'active' AND status_after = 'active') AS churnIns,
         MAX(churn_height) AS lastSeen
       FROM node_epochs WHERE churn_height >= ? GROUP BY node ORDER BY apyBonder DESC`
    ).bind(Math.min(...hs)).all();
    daten.nodes = (r.results || []).map(z => ({
      ...z,
      apyBonder: z.apyBonder != null ? Math.round(z.apyBonder * 10000) / 100 : null, // in %
      avgSlash: z.avgSlash != null ? Math.round(z.avgSlash) : null,
      avgFeeBps: z.avgFeeBps != null ? Math.round(z.avgFeeBps) : null,
      rewardTotal: z.rewardTotal != null ? Math.round(z.rewardTotal) : 0,
    }));
  }
  nodeScoresCache = { n, at: Date.now(), data: daten };
  return json(daten, env);
}

// =====================================================================================
// RUJIRA TCY TAGESWERTE (fuer genaue Vergleiche nativ vs. Rujira in der TCY-Karte)
//
// Je Tag (UTC) ein Datensatz des Rujira-TCY-Staking-Vertrags:
//   stake  = sein nativer TCY-Stake (/thorchain/tcy_staker/{vertrag})
//   shares/size = status.liquid_bond_shares / liquid_bond_size -> Kurs 1 sTCY = size/shares TCY
// Aktueller Tag bei jedem Cron-Lauf; dazu rueckwaerts bis Anfang Aug. 2025 nachgeholt, je
// Lauf bis zu RUJIRA_TAGE_JE_LAUF Tage (Archivabfragen ueber ?height bzw. Hoehen-Header).
// Vertrag: gleiche code_id wie der RUJI-Staking-Vertrag, config.bond_denom == "tcy".
// GET /rujira-tcy-history -> { vertrag, tage: [{ tag, ms, height, stake, kurs }] }
// =====================================================================================
const RUJI_STAKING_VERTRAG = 'thor13g83nn5ef4qzqeafp0508dnvkvm0zqr3sj7eefcn5umu65gqluusrml5cr';
const RUJIRA_TCY_START_MS = Date.UTC(2025, 6, 31); // erste Einzahlung laut Midgard
const RUJIRA_TAGE_JE_LAUF = 10; // je Cron-Lauf; zusaetzlich /rujira-tcy-nachholen
let rujiraTcyVertragCache = null;
let rujiraTabellenOk = false;

async function sichereRujiraTabellen(env) {
  if (rujiraTabellenOk) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS rujira_tcy_daily (
      tag TEXT PRIMARY KEY, ms INTEGER, height INTEGER, stake REAL, shares REAL, size REAL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS rujira_tcy_meta (
      tag TEXT PRIMARY KEY, tries INTEGER NOT NULL, at INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS rujira_tcy_kurs (
      tag TEXT PRIMARY KEY, ms INTEGER, kurs REAL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS rujira_tcy_state (k TEXT PRIMARY KEY, v TEXT)`),
  ]);
  // Einmalig nach diesem Update: gesperrte Tage (3 Fehlversuche) wieder freigeben -- vorher
  // scheiterte der ganze Tag, wenn nur die Vertragsabfrage auf alter Hoehe fehlschlug.
  const fl = await env.DB.prepare("SELECT v FROM rujira_tcy_state WHERE k = 'reset1'").first();
  if (!fl) {
    await env.DB.prepare("DELETE FROM rujira_tcy_meta WHERE tag NOT LIKE 'vertrag:%'").run();
    await env.DB.prepare("INSERT OR REPLACE INTO rujira_tcy_state (k, v) VALUES ('reset1', '1')").run();
  }
  rujiraTabellenOk = true;
}
const b64Json = o => btoa(JSON.stringify(o));
async function wasmSmart(vertrag, anfrage, hoehe) {
  const opts = hoehe ? { headers: { 'x-cosmos-block-height': String(hoehe), 'x-client-id': 'rune-rewards-backend' } } : {};
  const j = await fetchFromBases(getThornodeBases({ needsHeight: !!hoehe }), `/cosmwasm/wasm/v1/contract/${vertrag}/smart/${b64Json(anfrage)}`, opts);
  return j && j.data != null ? j.data : null;
}
async function findeRujiraTcyVertrag(env) {
  if (rujiraTcyVertragCache) return rujiraTcyVertragCache;
  try {
    const m = await env.DB.prepare("SELECT tag FROM rujira_tcy_meta WHERE tag LIKE 'vertrag:%'").first();
    if (m && m.tag) { rujiraTcyVertragCache = m.tag.slice(8); return rujiraTcyVertragCache; }
  } catch (e) {}
  const info = await fetchFromBases(getThornodeBases(), `/cosmwasm/wasm/v1/contract/${RUJI_STAKING_VERTRAG}`);
  const codeId = Number(info && info.contract_info && info.contract_info.code_id);
  if (!codeId) return null;
  for (const id of [codeId, codeId + 1, codeId - 1, codeId + 2, codeId - 2]) {
    let liste = null;
    try { liste = await fetchFromBases(getThornodeBases(), `/cosmwasm/wasm/v1/code/${id}/contracts?pagination.limit=200`); } catch (e) { continue; }
    for (const a of (liste && liste.contracts) || []) {
      try {
        const cfg = await wasmSmart(a, { config: {} });
        if (cfg && String(cfg.bond_denom).toLowerCase() === 'tcy' && cfg.revenue_denom != null) {
          rujiraTcyVertragCache = a;
          await env.DB.prepare('INSERT OR REPLACE INTO rujira_tcy_meta (tag, tries, at) VALUES (?, 0, ?)').bind('vertrag:' + a, Date.now()).run();
          return a;
        }
      } catch (e) {}
    }
  }
  return null;
}
async function rujiraTagesWert(vertrag, hoehe) {
  const pfadStake = `/thorchain/tcy_staker/${vertrag}` + (hoehe ? `?height=${hoehe}` : '');
  // Beide Abfragen unabhaengig: Vertragsabfragen auf alter Hoehe liefert das Archiv nicht
  // immer (der Kurs kommt dann aus den Einzahlungs-Ereignissen, siehe syncRujiraKursEreignisse).
  const [st, stake] = await Promise.all([
    wasmSmart(vertrag, { status: {} }, hoehe).catch(() => null),
    fetchFromBases(getThornodeBases({ needsHeight: !!hoehe }), pfadStake).catch(() => null),
  ]);
  const shares = Number(st && st.liquid_bond_shares) / 1e8, size = Number(st && st.liquid_bond_size) / 1e8;
  const stakeTcy = (Number(stake && stake.amount) || 0) / 1e8;
  if (!(shares > 0 && size > 0) && !(stakeTcy > 0)) throw new Error('RUJIRA_TAG_LEER');
  return { shares: shares > 0 ? shares : null, size: size > 0 ? size : null, stake: stakeTcy > 0 ? stakeTcy : null };
}
async function syncRujiraTcyDaily(env, tageJeLauf = RUJIRA_TAGE_JE_LAUF) {
  await sichereRujiraTabellen(env);
  const vertrag = await findeRujiraTcyVertrag(env);
  if (!vertrag) return;
  const lb = await fetchFromBases(getThornodeBases(), '/thorchain/lastblock');
  const h = Array.isArray(lb) ? Math.max(0, ...lb.map(x => Number(x && x.thorchain) || 0)) : Number(lb && lb.thorchain) || 0;
  if (!h) return;
  const jetzt = Date.now();
  const tagVon = ms => new Date(ms).toISOString().slice(0, 10);
  const vorhanden = new Set(((await env.DB.prepare('SELECT tag FROM rujira_tcy_daily').all()).results || []).map(r => r.tag));
  const versuche = new Map(((await env.DB.prepare("SELECT tag, tries FROM rujira_tcy_meta WHERE tag NOT LIKE 'vertrag:%'").all()).results || []).map(r => [r.tag, Number(r.tries)]));
  const speichere = async (tag, ms, hoehe, w) => env.DB.prepare(
    'INSERT OR REPLACE INTO rujira_tcy_daily (tag, ms, height, stake, shares, size) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(tag, ms, hoehe, w.stake, w.shares, w.size).run();
  // Heute (aktueller Stand, ueberschreibt den Tageswert)
  try { await speichere(tagVon(jetzt), jetzt, h, await rujiraTagesWert(vertrag, null)); } catch (e) {}
  // Rueckwaerts nachholen: Tage ohne Eintrag, hoechstens 3 Versuche je Tag.
  let erledigt = 0;
  for (let k = 1; erledigt < tageJeLauf; k++) {
    const ms = jetzt - k * 86400000;
    if (ms < RUJIRA_TCY_START_MS) break;
    const tag = tagVon(ms);
    if (vorhanden.has(tag) || (versuche.get(tag) || 0) >= 3) continue;
    const hoehe = h - k * 14400;
    erledigt++;
    try { await speichere(tag, ms, hoehe, await rujiraTagesWert(vertrag, hoehe)); }
    catch (e) {
      await env.DB.prepare('INSERT OR REPLACE INTO rujira_tcy_meta (tag, tries, at) VALUES (?, ?, ?)').bind(tag, (versuche.get(tag) || 0) + 1, jetzt).run();
    }
  }
}
// KURS AUS EINZAHLUNGEN: Jede liquid.bond-Einzahlung gibt Anteile zum aktuellen Kurs aus, also
// gilt Kurs = amount / shares (Midgard: type contract, metadata.contract.attributes). Rueckwaerts
// seitenweise ueber alle Aufrufe des Vertrags, Fortschritt in rujira_tcy_state. Je Tag zaehlt die
// spaeteste Einzahlung. Unabhaengig vom Archiv.
async function syncRujiraKursEreignisse(env, seiten = 6) {
  await sichereRujiraTabellen(env);
  const vertrag = await findeRujiraTcyVertrag(env);
  if (!vertrag) return;
  const st = await env.DB.prepare("SELECT v FROM rujira_tcy_state WHERE k = 'kurs_token'").first();
  const fertig = await env.DB.prepare("SELECT v FROM rujira_tcy_state WHERE k = 'kurs_fertig'").first();
  const speichere = (ms, kurs) => env.DB.prepare(
    `INSERT INTO rujira_tcy_kurs (tag, ms, kurs) VALUES (?, ?, ?)
     ON CONFLICT(tag) DO UPDATE SET ms = excluded.ms, kurs = excluded.kurs WHERE excluded.ms > rujira_tcy_kurs.ms`
  ).bind(new Date(ms).toISOString().slice(0, 10), ms, kurs).run();
  const seite = async token => {
    const j = await fetchFromBases(getMidgardBases(), `/actions?address=${vertrag}&type=contract&limit=50${token ? `&nextPageToken=${token}` : ''}`);
    for (const act of (j && j.actions) || []) {
      const c = act && act.metadata && act.metadata.contract;
      // Einzahlung: Kurs = amount/shares; Auszahlung: Kurs = returned/shares (beides laut
      // SharePool-Code des Vertrags, Rundung nur in der letzten 1e8-Stelle).
      const typ = String(c && c.contractType || '');
      const bond = /rujira-staking\/liquid\.bond$/.test(typ), unbond = /rujira-staking\/liquid\.unbond$/.test(typ);
      if (!bond && !unbond) continue;
      const a = Number(c.attributes && (bond ? c.attributes.amount : c.attributes.returned)), sh = Number(c.attributes && c.attributes.shares);
      const ms = Math.round(Number(act.date) / 1e6);
      if (a > 0 && sh > 0 && ms > 0) await speichere(ms, a / sh);
    }
    return (j && j.meta && j.meta.nextPageToken) || null;
  };
  // Neueste Seite immer (neue Einzahlungen), danach rueckwaerts weiter.
  await seite(null);
  if (fertig) return;
  let token = st && st.v || null;
  if (!token) token = await seite(null);
  for (let i = 0; i < seiten && token; i++) token = await seite(token);
  await env.DB.prepare("INSERT OR REPLACE INTO rujira_tcy_state (k, v) VALUES ('kurs_token', ?)").bind(token || '').run();
  if (!token) await env.DB.prepare("INSERT OR REPLACE INTO rujira_tcy_state (k, v) VALUES ('kurs_fertig', '1')").run();
}
async function handleRujiraTcyHistory(request, env) {
  await sichereRujiraTabellen(env);
  const [r, k] = await Promise.all([
    env.DB.prepare('SELECT tag, ms, height, stake, shares, size FROM rujira_tcy_daily ORDER BY tag ASC').all(),
    env.DB.prepare('SELECT tag, ms, kurs FROM rujira_tcy_kurs ORDER BY tag ASC').all(),
  ]);
  const map = new Map();
  for (const z of (r.results || [])) map.set(z.tag, { tag: z.tag, ms: z.ms, height: z.height, stake: z.stake || null, kurs: z.shares > 0 ? z.size / z.shares : null });
  for (const z of (k.results || [])) {
    const e = map.get(z.tag) || { tag: z.tag, ms: z.ms, height: null, stake: null, kurs: null };
    if (!(e.kurs > 0)) e.kurs = z.kurs;
    map.set(z.tag, e);
  }
  const tage = [...map.values()].sort((a, b) => a.tag < b.tag ? -1 : 1);
  return json({ vertrag: rujiraTcyVertragCache, tage }, env);
}

// =====================================================================================
// NATIVE TCY-RENDITE JE TCY (Referenz aus echten nativen Stakern, kein Rujira-Umweg)
//
// Gesucht: wie viel RUNE ein nativ gestakter TCY an jedem Tag bekam. Dafuer werden grosse
// native Staker mit UNVERAENDERTEM Bestand gesucht (keine tcy_stake/tcy_unstake/tcy_claim-Aktion
// seit TCY_REF_START, Vertraege ausgenommen). Deren Auszahlungen (Midgard /tcy/distribution)
// geteilt durch ihren Bestand ergeben exakt die Auszahlung je TCY.
// Neu berechnet hoechstens alle 6 Stunden. GET /tcy-native-ref -> { referenz, tage: [{tag, ms, runeProTcy}] }
// =====================================================================================
const TCY_REF_START_MS = Date.UTC(2025, 6, 20);
const TCY_REF_ZIEL = 8, TCY_REF_PRUEF_JE_LAUF = 10;
let tcyRefTabellenOk = false;
async function sichereTcyRefTabellen(env) {
  if (tcyRefTabellenOk) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tcy_ref_kandidat (addr TEXT PRIMARY KEY, ok INTEGER, stake REAL, at INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tcy_native_ref (tag TEXT PRIMARY KEY, ms INTEGER, rune_pro_tcy REAL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tcy_ref_state (k TEXT PRIMARY KEY, v TEXT)`),
  ]);
  tcyRefTabellenOk = true;
}
async function syncTcyNativeReferenz(env, erzwingen = false) {
  await sichereTcyRefTabellen(env);
  const zuletzt = await env.DB.prepare("SELECT v FROM tcy_ref_state WHERE k = 'at'").first();
  const okZahl = await env.DB.prepare('SELECT COUNT(*) AS n FROM tcy_ref_kandidat WHERE ok = 1').first();
  if (!erzwingen && zuletzt && Date.now() - Number(zuletzt.v) < 6 * 3600e3 && Number(okZahl?.n) >= TCY_REF_ZIEL) return;
  // 1) Kandidaten pruefen (groesste native Staker zuerst)
  if (Number(okZahl?.n) < TCY_REF_ZIEL) {
    const roh = await fetchFromBases(getThornodeBases(), '/thorchain/tcy_stakers');
    const liste = (Array.isArray(roh) ? roh : (roh && (roh.tcy_stakers || roh.stakers)) || [])
      .map(x => ({ addr: String(x.address || ''), stake: Number(x.amount) / 1e8 }))
      .filter(x => /^thor1[0-9a-z]{38}$/.test(x.addr) && x.stake > 0)   // nur normale Adressen, keine Vertraege
      .sort((a, b) => b.stake - a.stake).slice(0, 150);
    const geprueft = new Set(((await env.DB.prepare('SELECT addr FROM tcy_ref_kandidat').all()).results || []).map(r => r.addr));
    let n = 0;
    for (const k of liste) {
      if (geprueft.has(k.addr)) continue;
      if (n++ >= TCY_REF_PRUEF_JE_LAUF) break;
      let ok = 0;
      try {
        const j = await fetchFromBases(getMidgardBases(), `/actions?address=${k.addr}&type=tcy_stake,tcy_unstake,tcy_claim&limit=50`);
        const akt = (j && j.actions) || [];
        const spaet = akt.some(a => Math.round(Number(a.date) / 1e6) >= TCY_REF_START_MS);
        ok = akt.length > 0 && !spaet ? 1 : 0;
      } catch (e) { continue; }
      await env.DB.prepare('INSERT OR REPLACE INTO tcy_ref_kandidat (addr, ok, stake, at) VALUES (?, ?, ?, ?)').bind(k.addr, ok, k.stake, Date.now()).run();
    }
  }
  // 2) Auszahlungen der gueltigen Referenz-Staker zusammenrechnen
  const refs = ((await env.DB.prepare('SELECT addr, stake FROM tcy_ref_kandidat WHERE ok = 1 ORDER BY stake DESC LIMIT ?').bind(TCY_REF_ZIEL).all()).results || []);
  if (!refs.length) return;
  // Erst je Adresse laden, dann GEGENPRUEFEN: Die Auszahlung je TCY seit Start muss bei allen
  // Referenz-Stakern gleich sein. Weicht eine Adresse mehr als 2 % vom Median ab (z. B. weil
  // sich ihr Bestand doch auf einem nicht erfassten Weg geaendert hat), faellt sie raus.
  const daten = [];
  for (const r of refs) {
    let j = null;
    try { j = await fetchFromBases(getMidgardBases(), `/tcy/distribution/${r.addr}`); } catch (e) { continue; }
    const ds = ((j && j.distributions) || []).map(x => ({ ms: Number(x.date) * 1000, rune: Number(x.amount) / 1e8 })).filter(x => x.ms > 0 && x.rune >= 0);
    const summe = ds.filter(x => x.ms >= TCY_REF_START_MS).reduce((q, x) => q + x.rune, 0);
    if (ds.length && r.stake > 0) daten.push({ addr: r.addr, stake: r.stake, ds, proTcy: summe / r.stake });
  }
  const sortiert = daten.map(x => x.proTcy).sort((a, b) => a - b);
  const median = sortiert.length ? sortiert[Math.floor(sortiert.length / 2)] : 0;
  const gueltig = daten.filter(x => median > 0 && Math.abs(x.proTcy / median - 1) <= 0.02);
  for (const x of daten) if (!gueltig.includes(x)) await env.DB.prepare('UPDATE tcy_ref_kandidat SET ok = 2 WHERE addr = ?').bind(x.addr).run();
  const proTag = new Map(); let stakeSumme = 0;
  for (const x of gueltig) {
    stakeSumme += x.stake;
    for (const d of x.ds) {
      const tag = new Date(d.ms).toISOString().slice(0, 10);
      const e = proTag.get(tag) || { ms: d.ms, rune: 0 };
      e.rune += d.rune; proTag.set(tag, e);
    }
  }
  const streuung = gueltig.length > 1 ? Math.max(...gueltig.map(x => Math.abs(x.proTcy / median - 1))) : null;
  if (!(stakeSumme > 0)) return;
  const st = [];
  for (const [tag, e] of proTag) st.push(env.DB.prepare('INSERT OR REPLACE INTO tcy_native_ref (tag, ms, rune_pro_tcy) VALUES (?, ?, ?)').bind(tag, e.ms, e.rune / stakeSumme));
  for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO tcy_ref_state (k, v) VALUES ('at', ?)").bind(String(Date.now())),
    env.DB.prepare("INSERT OR REPLACE INTO tcy_ref_state (k, v) VALUES ('ref', ?)").bind(JSON.stringify({ adressen: gueltig.length, verworfen: daten.length - gueltig.length, stake: stakeSumme, maxAbweichung: streuung })),
  ]);
}
async function handleTcyNativeRef(request, env) {
  await sichereTcyRefTabellen(env);
  const url = new URL(request.url);
  if (url.searchParams.get('neu') === '1') { try { await syncTcyNativeReferenz(env, true); } catch (e) {} }
  const [r, ref] = await Promise.all([
    env.DB.prepare('SELECT tag, ms, rune_pro_tcy FROM tcy_native_ref ORDER BY tag ASC').all(),
    env.DB.prepare("SELECT v FROM tcy_ref_state WHERE k = 'ref'").first(),
  ]);
  return json({ referenz: ref ? JSON.parse(ref.v) : null, tage: (r.results || []).map(z => ({ tag: z.tag, ms: z.ms, runeProTcy: z.rune_pro_tcy })) }, env);
}

// =====================================================================================
// SPENDEN-VERLAUF (oeffentlich, ohne Absender): jede einzelne Spende mit Zeitpunkt, Betrag
// und Dollarwert ZUM ZEITPUNKT der Spende.
//   RUNE/THOR: Midgard /actions an DONATION_THOR_ADDRESS (send und Swaps mit diesem Ziel;
//              Format send: in = Absender, out = Empfaenger, laut echten Midgard-Antworten)
//   USDC (ETH): eth_getLogs Transfer-Ereignisse an DONATION_ETH_ADDRESS, rueckwaerts in Bloecken
//   ETH:        kein Verzeichnis eingehender ETH-Zahlungen -> jede Erhoehung des Guthabens wird
//               mit Zeitpunkt gespeichert (ab Einbau)
// Preise: Midgard /history/depths/ETH.ETH (runePriceUSD, assetPriceUSD) je Tag.
// GET /donation-history -> { monate: [{ monat, usd, eintraege: [{ ms, asset, betrag, usd, tx, chain }] }] }
// =====================================================================================
const DON_START_MS = Date.UTC(2026, 7, 1);
const ERC20_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
let donTabellenOk = false;
async function sichereDonTabellen(env) {
  if (donTabellenOk) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS donation_history (id TEXT PRIMARY KEY, ms INTEGER, asset TEXT, betrag REAL, usd REAL, chain TEXT, tx TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS donation_state (k TEXT PRIMARY KEY, v TEXT)`),
  ]);
  donTabellenOk = true;
}
const donState = async (env, k) => { const r = await env.DB.prepare('SELECT v FROM donation_state WHERE k = ?').bind(k).first(); return r ? r.v : null; };
const donStateSet = (env, k, v) => env.DB.prepare('INSERT OR REPLACE INTO donation_state (k, v) VALUES (?, ?)').bind(k, String(v)).run();
// Tagespreise (RUNE und ETH in USD) fuer einen Zeitraum, je Tag (UTC).
async function donPreise(vonMs, bisMs) {
  const von = Math.floor(vonMs / 1000) - 86400, bis = Math.ceil(bisMs / 1000) + 86400;
  // Zuerst mit Zeitraum; liefert Midgard dafuer nichts, die letzten 400 Tage (count) -- das deckt
  // alle Spenden seit Start ab und wird von jeder Midgard-Version unterstuetzt.
  let j = await fetchFromBases(getMidgardBases(), `/history/depths/ETH.ETH?interval=day&from=${von}&to=${bis}`).catch(() => null);
  if (!j || !Array.isArray(j.intervals) || !j.intervals.length) j = await fetchFromBases(getMidgardBases(), `/history/depths/ETH.ETH?interval=day&count=400`).catch(() => null);
  const m = new Map();
  for (const iv of (j && j.intervals) || []) {
    const tag = new Date(Number(iv.startTime) * 1000).toISOString().slice(0, 10);
    // Midgard liefert kein runePriceUSD in der Pool-Historie: RUNE in USD = ETH-Preis in USD / ETH-Preis in RUNE.
    const ethUsd = Number(iv.assetPriceUSD) || null, ethInRune = Number(iv.assetPrice) || null;
    m.set(tag, { rune: ethUsd && ethInRune ? ethUsd / ethInRune : null, eth: ethUsd });
  }
  return m;
}
// TAGESKURS EINES BELIEBIGEN COINS ueber seinen THORChain-Pool (assetPriceUSD je Tag).
// Secured (BTC-BTC), Trade (BTC~BTC) und Synth (BTC/BTC) werden auf den Pool BTC.BTC abgebildet,
// ERC-20 ueber Symbol + Vertrag (ETH.USDT-0XDAC1...).
function donPoolVon(asset, vertrag) {
  const a = String(asset || '').toUpperCase();
  if (vertrag) return `ETH.${a}-${String(vertrag).toUpperCase()}`;
  if (/^THOR\./.test(a)) return a;                              // THOR.TCY, THOR.RUJI ...
  const m = a.match(/^([A-Z0-9]+)[-~\/](.+)$/);                  // BTC-BTC, ETH~USDC-0X.., BTC/BTC
  if (m) return `${m[1]}.${m[2]}`;
  return a.includes('.') ? a : null;
}
const donPoolCache = new Map();
async function donPoolPreis(pool, ms) {
  if (!pool) return null;
  if (!donPoolCache.has(pool)) {
    const j = await fetchFromBases(getMidgardBases(), `/history/depths/${encodeURIComponent(pool)}?interval=day&count=400`).catch(() => null);
    const m = new Map();
    for (const iv of (j && j.intervals) || []) m.set(new Date(Number(iv.startTime) * 1000).toISOString().slice(0, 10), Number(iv.assetPriceUSD) || null);
    donPoolCache.set(pool, m);
  }
  const m = donPoolCache.get(pool);
  for (let d = 0; d <= 3; d++) { const v = m.get(new Date(ms - d * 86400000).toISOString().slice(0, 10)); if (v) return v; }
  return null;
}
const preisAm = (m, ms, art) => {
  for (let d = 0; d <= 3; d++) {   // genauer Tag, sonst bis zu 3 Tage davor (laufender Tag fehlt oft noch)
    const e = m.get(new Date(ms - d * 86400000).toISOString().slice(0, 10));
    if (e && e[art]) return e[art];
  }
  return null;
};
async function donEintrag(env, id, ms, asset, betrag, usd, chain, tx) {
  await env.DB.prepare('INSERT OR IGNORE INTO donation_history (id, ms, asset, betrag, usd, chain, tx) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, Math.round(ms), asset, betrag, usd, chain, tx || null).run();
}
// EXPLORER-ABFRAGE (Etherscan-kompatibel): mit ETHERSCAN_API_KEY zuerst Etherscan V2 (eigenes,
// verlaessliches Kontingent), sonst/zusaetzlich Blockscout. Blockscout und oeffentliche RPCs
// drosseln Cloudflare-Worker oft (429, gemeldet), deshalb wird nur alle 3 Stunden abgefragt.
// Etherscan erlaubt im kostenlosen Plan 3 Abfragen pro Sekunde (gemeldet: "Max calls per sec
// rate limit reached (3/sec)") -> Abfragen nacheinander, mindestens 450 ms Abstand, bei Limit
// einmal kurz warten und wiederholen.
let donEtherscanZuletzt = 0;
async function donExplorer(env, action, adr) {
  const fehler = [];
  if (env.ETHERSCAN_API_KEY) {
    for (let versuch = 0; versuch < 3; versuch++) {
      const warte = donEtherscanZuletzt + 700 - Date.now();
      if (warte > 0) await new Promise(x => setTimeout(x, warte));
      donEtherscanZuletzt = Date.now();
      try {
        const r = await fetchWithTimeout(`https://api.etherscan.io/v2/api?chainid=1&module=account&action=${action}&address=${adr}&sort=desc&page=1&offset=200&apikey=${env.ETHERSCAN_API_KEY}`, { timeoutMs: 12000 });
        const j = await r.json();
        if (Array.isArray(j.result)) return { liste: j.result, quelle: 'etherscan' };
        if (String(j.message || '').toLowerCase().includes('no transactions')) return { liste: [], quelle: 'etherscan' };
        const msg = String(j.result || j.message || r.status);
        if (/rate limit/i.test(msg)) { await new Promise(x => setTimeout(x, 1500 * (versuch + 1))); continue; }
        fehler.push('ETHERSCAN_' + msg); break;
      } catch (e) { fehler.push('ETHERSCAN_' + (e?.message || e)); break; }
    }
    if (!fehler.length) fehler.push('ETHERSCAN_rate_limit');
  }
  for (let versuch = 0; versuch < 2; versuch++) {
    try {
      const r = await fetchWithTimeout(`https://eth.blockscout.com/api?module=account&action=${action}&address=${adr}&sort=desc&page=1&offset=200`, { timeoutMs: 12000 });
      if (r.status === 429) { fehler.push('BLOCKSCOUT_HTTP_429'); await new Promise(x => setTimeout(x, 1500)); continue; }
      if (!r.ok) { fehler.push('BLOCKSCOUT_HTTP_' + r.status); break; }
      const j = await r.json();
      if (Array.isArray(j.result)) return { liste: j.result, quelle: 'blockscout' };
      if (String(j.message || '').toLowerCase().includes('no transactions')) return { liste: [], quelle: 'blockscout' };
      fehler.push('BLOCKSCOUT_' + (j.message || 'leer')); break;
    } catch (e) { fehler.push('BLOCKSCOUT_' + (e?.message || e)); break; }
  }
  throw new Error(fehler.join(' / '));
}
async function syncDonationHistory(env, erzwingen = false) {
  await sichereDonTabellen(env);
  const jetzt = Date.now();
  const diag = { version: WORKER_VERSION, thor: { aktionen: 0, funde: 0, fehler: null }, usdc: { bereiche: 0, funde: 0, fehler: null }, eth: { fehler: null } };
  // --- THOR (RUNE und andere native Coins an die THOR-Adresse) ---
  try {
    let token = '', seiten = 0; const funde = [];
    const bekannt = await donState(env, 'thor_bis');
    while (seiten++ < 6) {
      const j = await fetchFromBases(getMidgardBases(), `/actions?address=${DONATION_THOR_ADDRESS}&limit=50${token ? `&nextPageToken=${token}` : ''}`);
      let alt = false;
      diag.thor.aktionen += ((j && j.actions) || []).length;
      for (const a of (j && j.actions) || []) {
        const ms = Number(a.date) / 1e6;
        if (bekannt && ms <= Number(bekannt)) { alt = true; continue; }
        if (a.status && a.status !== 'success') continue;
        if ((a.in || []).some(i => i && i.address === DONATION_THOR_ADDRESS)) continue; // eigene Ausgaenge
        for (const o of (a.out || [])) {
          if (!o || o.address !== DONATION_THOR_ADDRESS) continue;
          for (const c of o.coins || []) funde.push({ ms, asset: String(c.asset || ''), betrag: Number(c.amount) / 1e8, tx: o.txID || (a.in && a.in[0] && a.in[0].txID) || '' });
        }
      }
      token = j && j.meta && j.meta.nextPageToken;
      if (!token || alt) break;
    }
    diag.thor.funde = funde.length;
    if (funde.length) {
      const preise = await donPreise(Math.min(...funde.map(f => f.ms)), jetzt);
      for (const f of funde) {
        const runeUsd = preisAm(preise, f.ms, 'rune');
        let usd = /^THOR\.RUNE$/i.test(f.asset) ? (runeUsd ? f.betrag * runeUsd : null) : null;
        if (usd == null) { const p = await donPoolPreis(donPoolVon(f.asset), f.ms); if (p) usd = f.betrag * p; }
        await donEintrag(env, 'thor:' + f.tx + ':' + f.asset, f.ms, f.asset.replace(/^THOR\./, ''), f.betrag, usd, 'THOR', f.tx);
      }
      await donStateSet(env, 'thor_bis', Math.max(...funde.map(f => f.ms)));
    } else if (!bekannt) await donStateSet(env, 'thor_bis', 0);
  } catch (e) { diag.thor.fehler = e?.message || String(e); console.warn('[spenden] THOR', e?.message || e); }
  const ethZuletzt = Number(await donState(env, 'eth_at')) || 0;
  const ethDran = erzwingen || Date.now() - ethZuletzt > 3 * 3600e3;
  if (!ethDran) { diag.usdc.uebersprungen = true; diag.eth.uebersprungen = true; }
  if (ethDran) {
  await donStateSet(env, 'eth_at', Date.now());
  // --- TOKEN (USDC, USDT, DAI und andere ERC-20) ueber Blockscout tokentx: komplette Historie auf
  //     einen Schlag. Stablecoins zaehlen 1:1 in USD. Rueckfall bei Blockscout-Fehler: eth_getLogs (nur USDC).
  let tokenOk = false;
  try {
    const adr = DONATION_ETH_ADDRESS.toLowerCase();
    const ex = await donExplorer(env, 'tokentx', adr);
    const j = { result: ex.liste };
    const STABIL = /^(USDC|USDT|DAI|USDS|PYUSD|FDUSD|USDE)$/i;
    let n = 0;
    for (const x of j.result) {
      if (String(x.to || '').toLowerCase() !== adr) continue;
      const ms = Number(x.timeStamp) * 1000;
      if (!(ms >= DON_START_MS)) continue;
      const dez = Number(x.tokenDecimal) || 18;
      const betrag = Number(BigInt(x.value || '0')) / Math.pow(10, dez);
      if (!(betrag > 0)) continue;
      const sym = String(x.tokenSymbol || 'TOKEN').toUpperCase().slice(0, 12);
      let usdTok = STABIL.test(sym) ? betrag : null;
      if (usdTok == null) { const p = await donPoolPreis(donPoolVon(sym, x.contractAddress), ms); if (p) usdTok = betrag * p; }
      await donEintrag(env, 'tok:' + x.hash + ':' + (x.logIndex || x.transactionIndex || ''), ms, sym, betrag, usdTok, 'ETH', x.hash);
      n++;
    }
    diag.usdc.funde = n; diag.usdc.quelle = ex.quelle; tokenOk = true;
    // Eintraege der alten Log-Suche entfernen, damit nichts doppelt zaehlt.
    await env.DB.prepare("DELETE FROM donation_history WHERE id LIKE 'usdc:%'").run();
  } catch (e) { diag.usdc.blockscoutFehler = e?.message || String(e); }
  if (!tokenOk) {
  try {
    const rpc = async (method, params) => {
      const r = await fetchWithTimeout(ETH_RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), timeoutMs: 10000 });
      const j = await r.json(); if (j.error) throw new Error(j.error.message || 'RPC'); return j.result;
    };
    const kopf = parseInt(await rpc('eth_blockNumber', []), 16);
    const zielTopic = '0x' + DONATION_ETH_ADDRESS.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const startBlock = kopf - Math.ceil((jetzt - DON_START_MS) / 12000);
    let unten = Number(await donState(env, 'usdc_unten')) || kopf;   // bis hierhin rueckwaerts gescannt
    let oben = Number(await donState(env, 'usdc_oben')) || kopf;     // ab hier vorwaerts neu
    const bereiche = [];
    if (kopf > oben) bereiche.push([oben + 1, kopf]);
    for (let i = 0; i < 4 && unten > startBlock; i++) { const von = Math.max(startBlock, unten - 9000); bereiche.push([von, unten - 1]); unten = von; }
    const blockZeit = new Map();
    diag.usdc.bereiche = bereiche.length;
    for (const [von, bis] of bereiche) {
      if (bis < von) continue;
      const logs = await rpc('eth_getLogs', [{ address: USDC_CONTRACT_ADDRESS, topics: [ERC20_TRANSFER, null, zielTopic], fromBlock: '0x' + von.toString(16), toBlock: '0x' + bis.toString(16) }]);
      for (const l of logs || []) {
        const bn = parseInt(l.blockNumber, 16);
        if (!blockZeit.has(bn)) { const b = await rpc('eth_getBlockByNumber', ['0x' + bn.toString(16), false]); blockZeit.set(bn, parseInt(b.timestamp, 16) * 1000); }
        const betrag = parseInt(l.data, 16) / 1e6;
        diag.usdc.funde++;
        await donEintrag(env, 'usdc:' + l.transactionHash + ':' + parseInt(l.logIndex, 16), blockZeit.get(bn), 'USDC', betrag, betrag, 'ETH', l.transactionHash);
      }
    }
    await donStateSet(env, 'usdc_unten', unten);
    await donStateSet(env, 'usdc_oben', kopf);
  } catch (e) { diag.usdc.fehler = e?.message || String(e); console.warn('[spenden] USDC', e?.message || e); }
  }
  // --- ETH: komplette Historie ueber Blockscout (oeffentliche, Etherscan-kompatible Schnittstelle,
  //     ohne Schluessel). Normale Ueberweisungen (txlist) UND interne (txlistinternal) -- Letztere
  //     sind z. B. ETH, die per THORChain-Swap ueber den Router ankommen. Rueckfall, falls
  //     Blockscout nicht antwortet: Guthaben-Erhoehungen ab jetzt (wie bisher).
  try {
    const adr = DONATION_ETH_ADDRESS.toLowerCase();
    let quelleEth = null;
    const holen = async action => { const ex = await donExplorer(env, action, adr); quelleEth = ex.quelle; return ex.liste; };
    const normal = await holen('txlist');
    const intern = await holen('txlistinternal').catch(() => []);
    const funde = [...normal.map(x => ({ ...x, _art: 'n' })), ...intern.map(x => ({ ...x, _art: 'i' }))]
      .filter(x => String(x.to || '').toLowerCase() === adr && String(x.isError || '0') === '0' && BigInt(x.value || '0') > 0n)
      .map(x => ({ ms: Number(x.timeStamp) * 1000, betrag: Number(BigInt(x.value)) / 1e18, tx: x.hash || x.transactionHash, art: x._art, idx: x.traceId || x.index || '' }))
      .filter(x => x.ms >= DON_START_MS);
    diag.eth.funde = funde.length;
    if (funde.length) {
      const preise = await donPreise(Math.min(...funde.map(f => f.ms)), jetzt);
      for (const f of funde) {
        const p = preisAm(preise, f.ms, 'eth');
        await donEintrag(env, 'eth:' + f.tx + ':' + f.art + f.idx, f.ms, 'ETH', f.betrag, p ? f.betrag * p : null, 'ETH', f.tx);
      }
    }
    // Alte Eintraege aus der Guthaben-Methode entfernen, sobald die echte Historie da ist.
    await env.DB.prepare("DELETE FROM donation_history WHERE id LIKE 'eth:%' AND tx IS NULL").run();
    diag.eth.quelle = quelleEth;
  } catch (e) {
    diag.eth.blockscoutFehler = e?.message || String(e);
    try {
      const eth = await fetchDonationEthBalance();
      const letzt = await donState(env, 'eth_letzt');
      if (eth != null && letzt != null && eth > Number(letzt) + 1e-9) {
        const p = await fetchEthUsdPrice().catch(() => null);
        const delta = eth - Number(letzt);
        await donEintrag(env, 'eth:' + jetzt, jetzt, 'ETH', delta, p ? delta * p : null, 'ETH', null);
      }
      if (eth != null) await donStateSet(env, 'eth_letzt', eth);
      diag.eth.quelle = 'guthaben';
    } catch (e2) { diag.eth.fehler = e2?.message || String(e2); }
  }
  }
  // Dollarwerte nachtragen, die beim Einsammeln fehlten (z. B. vor dieser Korrektur).
  try {
    const offen = ((await env.DB.prepare("SELECT id, ms, asset, betrag FROM donation_history WHERE usd IS NULL AND asset IN ('RUNE', 'ETH') LIMIT 200").all()).results || []);
    if (offen.length) {
      const preise = await donPreise(Math.min(...offen.map(o => o.ms)), jetzt);
      for (const o of offen) {
        const p = preisAm(preise, o.ms, o.asset === 'RUNE' ? 'rune' : 'eth');
        if (p) await env.DB.prepare('UPDATE donation_history SET usd = ? WHERE id = ?').bind(o.betrag * p, o.id).run();
      }
      diag.nachgetragen = offen.length;
    }
  } catch (e) { diag.preisFehler = e?.message || String(e); }
  return diag;
}
async function handleDonationHistory(request, env, diag = null) {
  await sichereDonTabellen(env);
  const r = await env.DB.prepare('SELECT ms, asset, betrag, usd, chain, tx FROM donation_history ORDER BY ms DESC LIMIT 500').all();
  const monate = new Map();
  for (const z of r.results || []) {
    const monat = new Date(z.ms).toISOString().slice(0, 7);
    const m = monate.get(monat) || { monat, usd: 0, eintraege: [] };
    m.usd += Number(z.usd) || 0;
    m.eintraege.push({ ms: z.ms, asset: z.asset, betrag: z.betrag, usd: z.usd, chain: z.chain, tx: z.tx });
    monate.set(monat, m);
  }
  const antwort = json(diag ? { monate: [...monate.values()], diag } : { monate: [...monate.values()] }, env);
  try { antwort.headers.set('Cache-Control', 'no-store'); } catch (e) {}
  return antwort;
}

// =====================================================================================
// WEB PUSH (Etappe 1): Meldungen auch bei geschlossener App.
// Themen: halt (Chain-Halts an/aus), ops (Bond Yield freigeschaltet, XMR handelbar), preis
// (RUNE ueber/unter eigener Grenze), spende (nur Betreiber). Versand nach RFC 8291 (aes128gcm)
// mit VAPID (RFC 8292) -- nur WebCrypto, kein Zusatzdienst. Das VAPID-Schluesselpaar erzeugt der
// Worker beim ersten Bedarf selbst und legt es in D1 ab (Tabelle push_state).
// Endpunkte: GET /push/public-key, POST /push/subscribe, POST /push/unsubscribe, POST /push/test
// =====================================================================================
let pushTabellenOk = false;
async function sicherePushTabellen(env) {
  if (pushTabellenOk) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_subs (id TEXT PRIMARY KEY, endpoint TEXT, p256dh TEXT, auth TEXT, prefs TEXT, lang TEXT, besitzer INTEGER, at INTEGER, fails INTEGER DEFAULT 0, zustand TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_state (k TEXT PRIMARY KEY, v TEXT)`),
  ]);
  // Etappe 2: Adressen je Abo (fuer persoenliche Meldungen). Spalte bei bestehender Tabelle nachruesten.
  try { await env.DB.prepare('ALTER TABLE push_subs ADD COLUMN adressen TEXT').run(); } catch (e) { /* gibt es schon */ }
  pushTabellenOk = true;
}
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDecode = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const pushState = async (env, k) => { const r = await env.DB.prepare('SELECT v FROM push_state WHERE k = ?').bind(k).first(); return r ? r.v : null; };
const pushStateSet = (env, k, v) => env.DB.prepare('INSERT OR REPLACE INTO push_state (k, v) VALUES (?, ?)').bind(k, String(v)).run();
let vapidCache = null;
async function vapidSchluessel(env) {
  if (vapidCache) return vapidCache;
  await sicherePushTabellen(env);
  let roh = await pushState(env, 'vapid');
  if (!roh) {
    const paar = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const priv = await crypto.subtle.exportKey('jwk', paar.privateKey);
    const pub = await crypto.subtle.exportKey('raw', paar.publicKey);
    roh = JSON.stringify({ priv, pub: b64u(pub) });
    await pushStateSet(env, 'vapid', roh);
  }
  const { priv, pub } = JSON.parse(roh);
  const key = await crypto.subtle.importKey('jwk', priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  vapidCache = { key, pub };
  return vapidCache;
}
async function vapidJwt(env, endpoint) {
  const { key, pub } = await vapidSchluessel(env);
  const aud = new URL(endpoint).origin;
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const kopf = enc({ typ: 'JWT', alg: 'ES256' });
  const inhalt = enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:' + ((env && env.PUSH_KONTAKT) || 'maxkalinowski@gmx.de') });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(kopf + '.' + inhalt));
  return { jwt: kopf + '.' + inhalt + '.' + b64u(sig), pub };
}
async function hkdf(salt, ikm, info, laenge) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, laenge * 8));
}
const verbinde = (...teile) => { const n = teile.reduce((q, t) => q + t.length, 0); const u = new Uint8Array(n); let o = 0; for (const t of teile) { u.set(t, o); o += t.length; } return u; };
// Verschluesselung einer Nachricht fuer ein Abo (RFC 8291, ein Datensatz).
async function pushVerschluesseln(sub, nutzlast) {
  const uaPub = b64uDecode(sub.p256dh), auth = b64uDecode(sub.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const geteilt = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const te = new TextEncoder();
  const ikm = await hkdf(auth, geteilt, verbinde(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const klar = verbinde(te.encode(nutzlast), new Uint8Array([2]));
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const geheim = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, klar));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return verbinde(salt, rs, new Uint8Array([asPub.length]), asPub, geheim);
}
async function pushSenden(env, sub, nachricht) {
  const koerper = await pushVerschluesseln(sub, JSON.stringify(nachricht));
  const { jwt, pub } = await vapidJwt(env, sub.endpoint);
  // WICHTIGES SOFORT (Halt, Slash, Node raus): Urgency "high" -- iPhones stellen "normal" im
  // Energiesparmodus oder bei wenig Akku teils erst spaeter oder gar nicht zu.
  const dringend = /^rw-(halt|bond|slash|node)/.test(String(nachricht && nachricht.tag || '')) || /halt|slash/i.test(String(nachricht && nachricht.text || ''));
  const r = await fetch(sub.endpoint, { method: 'POST', body: koerper, headers: {
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: dringend ? 'high' : 'normal',
    Authorization: `vapid t=${jwt}, k=${pub}` } });
  if (r.status === 404 || r.status === 410) { await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(sub.id).run(); return 'weg'; }
  // Fehler merken (Status + Zeit), damit man im Push-Status sieht, WARUM nichts ankommt.
  if (!r.ok) { let txt = ''; try { txt = (await r.text()).slice(0, 120); } catch (e) {} await env.DB.prepare('UPDATE push_subs SET fails = fails + 1 WHERE id = ?').bind(sub.id).run(); await pushStateSet(env, 'letzterFehler', JSON.stringify({ at: Date.now(), status: r.status, txt, host: new URL(sub.endpoint).host })).catch(() => {}); return 'fehler ' + r.status; }
  await env.DB.prepare('UPDATE push_subs SET fails = 0 WHERE id = ?').bind(sub.id).run();
  return 'ok';
}
const pushId = async endpoint => b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))).slice(0, 32);
async function handlePush(request, env, url) {
  await sicherePushTabellen(env);
  if (url.pathname === '/push/public-key') return json({ key: (await vapidSchluessel(env)).pub }, env);
  if (request.method !== 'POST') return json({ error: 'POST_ONLY' }, env, 405);
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: 'BAD_JSON' }, env, 400); }
  const sub = body.subscription || {};
  if (!sub.endpoint || !/^https:\/\//.test(sub.endpoint)) return json({ error: 'NO_ENDPOINT' }, env, 400);
  const id = await pushId(sub.endpoint);
  if (url.pathname === '/push/unsubscribe') {
    await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(id).run();
    return json({ ok: true }, env);
  }
  if (url.pathname === '/push/subscribe') {
    const keys = sub.keys || {};
    if (!keys.p256dh || !keys.auth) return json({ error: 'NO_KEYS' }, env, 400);
    // Betreiber-Pruefung wie /is-owner: nur das Ergebnis wird gespeichert, keine Adressen.
    const aus = getStatsExcludedAddresses(env);
    const besitzer = (Array.isArray(body.adressen) ? body.adressen : []).some(a => aus.has(String(a || '').trim().toLowerCase())) ? 1 : 0;
    const p = body.prefs || {};
    const prefs = JSON.stringify({ halt: !!p.halt, ops: !!p.ops, preis: !!p.preis, spende: !!p.spende && !!besitzer,
      churn: !!p.churn, node: !!p.node, bond: !!p.bond, thorname: !!p.thorname, woche: p.woche !== false, tcy: p.tcy !== false,
      preisOben: Number(p.preisOben) > 0 ? Number(p.preisOben) : null, preisUnten: Number(p.preisUnten) > 0 ? Number(p.preisUnten) : null });
    // Nur THORChain-Adressen, nur wenn persoenliche Themen an sind, hoechstens 20.
    const persoenlich = !!(p.churn || p.node || p.bond || p.thorname || p.woche !== false || p.tcy !== false);
    const adr = persoenlich ? [...new Set((Array.isArray(body.adressen) ? body.adressen : []).map(a => String(a || '').trim().toLowerCase()).filter(a => isValidThorAddress(a)))].slice(0, 20) : [];
    await env.DB.prepare(`INSERT INTO push_subs (id, endpoint, p256dh, auth, prefs, lang, besitzer, at, fails, zustand, adressen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET fails = 0, p256dh = excluded.p256dh, auth = excluded.auth, prefs = excluded.prefs, lang = excluded.lang, besitzer = excluded.besitzer, at = excluded.at, adressen = excluded.adressen`)
      .bind(id, sub.endpoint, keys.p256dh, keys.auth, prefs, body.lang === 'de' ? 'de' : 'en', besitzer, Date.now(), JSON.stringify(adr)).run();
    return json({ ok: true, besitzer: !!besitzer }, env);
  }
  if (url.pathname === '/push/test') {
    const row = await env.DB.prepare('SELECT * FROM push_subs WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'NOT_SUBSCRIBED' }, env, 404);
    const de = row.lang === 'de';
    const erg = await pushSenden(env, row, { titel: 'rune.watch', text: de ? 'Push funktioniert. So sehen Meldungen bei geschlossener App aus.' : 'Push works. This is how notifications look with the app closed.', tag: 'rw-push-test' });
    return json({ ok: erg === 'ok', ergebnis: erg }, env);
  }
  return json({ error: 'NOT_FOUND' }, env, 404);
}
// Versand an alle Abos eines Themas; text kann eine Funktion (lang, prefs, row) sein.
async function pushAnThema(env, thema, baue) {
  const r = await env.DB.prepare('SELECT * FROM push_subs WHERE fails < 20').all();
  let n = 0;
  for (const row of r.results || []) {
    let p = {}; try { p = JSON.parse(row.prefs || '{}'); } catch (e) {}
    if (!p[thema]) continue;
    const nachricht = baue(row.lang === 'de', p, row);
    if (!nachricht) continue;
    try { if ((await pushSenden(env, row, nachricht)) === 'ok') n++; } catch (e) {}
  }
  return n;
}
// CRON: Ereignisse erkennen und verschicken.
async function syncPush(env) {
  await sicherePushTabellen(env);
  const anzahl = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs').first();
  if (!Number(anzahl && anzahl.n)) return;
  // 1) HALTS: Chains mit Handel- oder Chain-Halt laut inbound_addresses + globale Mimir-Halts.
  try {
    const [inb, mimir, lb] = await Promise.all([
      fetchFromBases(getThornodeBases(), '/thorchain/inbound_addresses').catch(() => null),
      fetchFromBases(getThornodeBases(), '/thorchain/mimir').catch(() => null),
      fetchFromBases(getThornodeBases(), '/thorchain/lastblock').catch(() => null),
    ]);
    if (Array.isArray(inb) && mimir) {
      // GLEICHE ERKENNUNG WIE IN DER APP (gemeldet: "Halts sind gar nicht erschienen" -- die App
      // zeigte "Chain halted: GAIA, SOL", der Worker sah nichts). Der Worker pruefte nur
      // inbound_addresses (halted / chain_trading_paused) und den nicht existierenden Schluessel
      // HALTSIGNINGGLOBAL. Halts per Mimir je Chain (HALT<C>CHAIN, HALT<C>TRADING, HALTSIGNING<C>,
      // SOLVENCYHALT<C>CHAIN) und LP-Pausen blieben unsichtbar. Mimir-Werte > 1 sind Blockhoehen:
      // aktiv erst ab dieser Hoehe (wie in der App).
      const H = Array.isArray(lb) ? Math.max(0, ...lb.map(x => Number(x && x.thorchain) || 0)) : 0;
      const M = {}; for (const [k, v] of Object.entries(mimir)) M[String(k).toUpperCase()] = Number(v);
      const aktiv = v => Number.isFinite(v) && v > 0 && (v <= 1 || !H || v <= H);
      const jetzt = new Set();
      for (const c of inb) {
        const C = String(c && c.chain || '').toUpperCase(); if (!C) continue;
        if (c.halted || c.chain_trading_paused || c.chain_lp_actions_paused
          || ['SOLVENCYHALT' + C + 'CHAIN', 'HALT' + C + 'CHAIN', 'HALT' + C + 'TRADING', 'HALTSIGNING' + C].some(k => aktiv(M[k]))) jetzt.add(C);
      }
      if (['HALTCHAINGLOBAL', 'HALTTRADING', 'HALTSIGNING'].some(k => aktiv(M[k])) || inb.some(x => x && x.global_trading_paused)
        || (Number.isFinite(M.NODEPAUSECHAINGLOBAL) && H && M.NODEPAUSECHAINGLOBAL > H)) jetzt.add('GLOBAL');
      const altRoh = await pushState(env, 'halts');
      const alt = altRoh ? new Set(JSON.parse(altRoh)) : null;
      if (alt) {
        const neu = [...jetzt].filter(x => !alt.has(x)), frei = [...alt].filter(x => !jetzt.has(x));
        // ERNEUT VERSUCHEN statt still verlieren: Ging an niemanden etwas raus, obwohl es Abos
        // fuer Halts gibt, bleibt der alte Stand gespeichert -- der naechste Lauf versucht es nochmal.
        const haltAbos = (await env.DB.prepare("SELECT prefs FROM push_subs WHERE fails < 20").all()).results.filter(r => { try { return JSON.parse(r.prefs || '{}').halt; } catch (e) { return false; } }).length;
        let gesendet = 0;
        if (neu.length) gesendet += await pushAnThema(env, 'halt', de => ({ titel: 'THORChain', text: neu.includes('GLOBAL') ? (de ? 'Handel netzweit angehalten' : 'Trading halted network-wide') : (de ? `Angehalten: ${neu.join(', ')}` : `Halted: ${neu.join(', ')}`), tag: 'rw-halt-' + neu.join('-') }));
        if (frei.length) gesendet += await pushAnThema(env, 'halt', de => ({ titel: 'THORChain', text: frei.includes('GLOBAL') ? (de ? 'Handel l\u00e4uft wieder' : 'Trading resumed') : (de ? `Wieder aktiv: ${frei.join(', ')}` : `Active again: ${frei.join(', ')}`), tag: 'rw-frei-' + frei.join('-') }));
        if ((neu.length || frei.length) && haltAbos > 0 && gesendet === 0) console.warn('[push] Halt-Meldung an niemanden zugestellt, neuer Versuch im naechsten Lauf');
        else await pushStateSet(env, 'halts', JSON.stringify([...jetzt]));
      } else await pushStateSet(env, 'halts', JSON.stringify([...jetzt]));
      // 2) UPDATES: Bond Yield freigeschaltet
      const by = Number(mimir.BONDYIELDENABLED) > 0;
      const byAlt = await pushState(env, 'bondyield');
      if (byAlt === '0' && by) await pushAnThema(env, 'ops', de => ({ titel: 'THORChain', text: de ? 'Bond Yield ist freigeschaltet. Du kannst jetzt einen Teil deiner Rewards auszahlen lassen.' : 'Bond Yield is enabled. You can now have part of your rewards paid out.', tag: 'rw-bondyield' }));
      await pushStateSet(env, 'bondyield', by ? '1' : '0');
    }
  } catch (e) { console.warn('[push] halts', e?.message || e); }
  // 3) UPDATES: XMR handelbar (Pool vorhanden, Status Available)
  try {
    const pools = await fetchFromBases(getThornodeBases(), '/thorchain/pools').catch(() => null);
    if (Array.isArray(pools)) {
      const xmr = pools.some(p => /^XMR\./.test(String(p.asset)) && String(p.status) === 'Available');
      const alt = await pushState(env, 'xmr');
      if (alt === '0' && xmr) await pushAnThema(env, 'ops', de => ({ titel: 'THORChain', text: de ? 'Monero (XMR) ist jetzt handelbar.' : 'Monero (XMR) is now tradable.', tag: 'rw-xmr' }));
      await pushStateSet(env, 'xmr', xmr ? '1' : '0');
    }
  } catch (e) {}
  // 4) PREIS-ALARM je Abo (RUNE in USD, Midgard)
  try {
    const st = await fetchFromBases(getMidgardBases(), '/stats').catch(() => null);
    const preis = Number(st && st.runePriceUSD);
    if (preis > 0) {
      const r = await env.DB.prepare('SELECT * FROM push_subs WHERE fails < 20').all();
      for (const row of r.results || []) {
        let p = {}; try { p = JSON.parse(row.prefs || '{}'); } catch (e) {}
        if (!p.preis) continue;
        let z = {}; try { z = JSON.parse(row.zustand || '{}'); } catch (e) {}
        const de = row.lang === 'de';
        const meldungen = [];
        if (p.preisOben > 0) { const d = preis >= p.preisOben; if (d && z.oben === false) meldungen.push({ titel: de ? `RUNE \u00fcber $${p.preisOben}` : `RUNE above $${p.preisOben}`, text: '$' + preis.toFixed(3), tag: 'rw-preis-oben' }); z.oben = d; }
        if (p.preisUnten > 0) { const d = preis <= p.preisUnten; if (d && z.unten === false) meldungen.push({ titel: de ? `RUNE unter $${p.preisUnten}` : `RUNE below $${p.preisUnten}`, text: '$' + preis.toFixed(3), tag: 'rw-preis-unten' }); z.unten = d; }
        for (const m of meldungen) { try { await pushSenden(env, row, m); } catch (e) {} }
        await env.DB.prepare('UPDATE push_subs SET zustand = ? WHERE id = ?').bind(JSON.stringify(z), row.id).run();
      }
    }
  } catch (e) { console.warn('[push] preis', e?.message || e); }
  // 5) SPENDEN (nur Betreiber-Abos)
  try {
    await sichereDonTabellen(env);
    const bis = Number(await pushState(env, 'spende_ms')) || 0;
    const neu = ((await env.DB.prepare('SELECT ms, asset, betrag, usd FROM donation_history WHERE ms > ? ORDER BY ms ASC').bind(bis).all()).results || []);
    if (bis && neu.length) {
      for (const e of neu) {
        await pushAnThema(env, 'spende', (de, p, row) => row.besitzer ? ({ titel: de ? 'Neue Spende \u2764' : 'New donation \u2764',
          text: '+' + Number(e.betrag).toLocaleString('en-US', { maximumFractionDigits: e.asset === 'ETH' ? 6 : 4 }) + ' ' + e.asset + (e.usd != null ? ' \u00b7 $' + Number(e.usd).toFixed(2) : ''), tag: 'rw-spende-' + e.ms }) : null);
      }
    }
    const max = neu.length ? Math.max(...neu.map(e => e.ms)) : bis;
    if (!bis) { const m = await env.DB.prepare('SELECT MAX(ms) AS m FROM donation_history').first(); await pushStateSet(env, 'spende_ms', Number(m && m.m) || 1); }
    else if (max > bis) await pushStateSet(env, 'spende_ms', max);
  } catch (e) { console.warn('[push] spende', e?.message || e); }
  // 6) PERSOENLICH (Etappe 2): Nodes, Bond, Rewards, THORName je Abo mit Adressen.
  try { await syncPushPersoenlich(env); } catch (e) { console.warn('[push] persoenlich', e?.message || e); }
}
const kurzNode = a => '\u2026' + String(a || '').slice(-4);
const runeTxt = x => Number(x).toLocaleString('en-US', { maximumFractionDigits: Math.abs(x) >= 100 ? 1 : 2 });
async function syncPushPersoenlich(env) {
  const r = await env.DB.prepare("SELECT * FROM push_subs WHERE fails < 20 AND adressen IS NOT NULL AND adressen != '[]'").all();
  const subs = r.results || [];
  if (!subs.length) return;
  const nodes = await fetchFromBases(getThornodeBases(), '/thorchain/nodes').catch(() => null);
  if (!Array.isArray(nodes)) return;
  // Letzter Churn (Midgard): Hoehe als Kennung, um Rewards dem Churn zuzuordnen.
  const churns = await fetchFromBases(getMidgardBases(), '/churns').catch(() => null);
  const churnH = Array.isArray(churns) && churns[0] ? String(churns[0].height) : null;
  const st = await fetchFromBases(getMidgardBases(), '/stats').catch(() => null);
  const preis = Number(st && st.runePriceUSD) || null;
  const heute = new Date().toISOString().slice(0, 10);
  for (const row of subs) { try { await pushEinAbo(env, row, nodes, churnH, preis, heute); } catch (e) { console.warn('[push] Abo', row.id, e?.message || e); } }
}
// EIN ABO (eigene Funktion, damit ein Fehler bei einem Abo nicht alle folgenden stoppt -- vorher
// brach die ganze Schleife ab, und alle spaeteren Abos bekamen in diesem Durchgang nichts).
async function pushEinAbo(env, row, nodes, churnH, preis, heute) {
  {
    let p = {}, z = {}, adr = [];
    try { p = JSON.parse(row.prefs || '{}'); } catch (e) {}
    try { z = JSON.parse(row.zustand || '{}'); } catch (e) {}
    try { adr = JSON.parse(row.adressen || '[]'); } catch (e) {}
    if (!adr.length) return;
    const de = row.lang === 'de';
    const meldungen = [];
    const alt = z.nodes || null;            // { node: { s: status, b: bond des Providers, l: leave } }
    const neu = {};
    for (const n of nodes) {
      const prov = ((n.bond_providers && n.bond_providers.providers) || []).filter(x => adr.includes(String(x.bond_address || '').toLowerCase()));
      if (!prov.length) continue;
      const bond = prov.reduce((q, x) => q + Number(x.bond || 0) / 1e8, 0);
      // JE ADRESSE merken (gemeldet: "keine RUNE verloren und trotzdem Slash-Meldung", 1.228 RUNE):
      // Aendert sich die Adressliste des Abos (eine Wallet fehlt kurz, anderes Geraet meldet weniger
      // Wallets), sank die SUMME -- das sah aus wie ein Slash. Verglichen wird jetzt nur, was bei
      // denselben Adressen passiert ist. tb = Gesamt-Bond der Node zum Gegencheck.
      const pa = {};
      for (const x of prov) pa[String(x.bond_address).toLowerCase()] = Number(x.bond || 0) / 1e8;
      neu[n.node_address] = { s: n.status, b: bond, l: !!n.requested_to_leave, pa, tb: Number(n.total_bond || 0) / 1e8 };
    }
    if (alt) {
      let rewardSumme = 0;
      const churnNeu = churnH && z.churn && churnH !== z.churn;
      for (const [na, v] of Object.entries(neu)) {
        const a = alt[na];
        if (!a) continue;
        if (p.node && a.s !== v.s) {
          if (v.s === 'Active') meldungen.push({ titel: 'rune.watch', text: de ? `Deine Node ${kurzNode(na)} ist wieder aktiv` : `Your node ${kurzNode(na)} is active again`, tag: 'rw-node-' + na });
          else if (a.s === 'Active') meldungen.push({ titel: 'rune.watch', text: de ? `Deine Node ${kurzNode(na)} ist nicht mehr aktiv (${v.s})` : `Your node ${kurzNode(na)} is no longer active (${v.s})`, tag: 'rw-node-' + na });
        }
        if (p.node && v.l && !a.l) meldungen.push({ titel: 'rune.watch', text: de ? `Deine Node ${kurzNode(na)}: Austritt angefragt` : `Your node ${kurzNode(na)}: leave requested`, tag: 'rw-leave-' + na });
        // Nur gemeinsame Adressen vergleichen; alte Eintraege ohne Aufschluesselung -> kein Slash-Test.
        const gemeinsam = a.pa ? Object.keys(v.pa || {}).filter(k => k in a.pa) : [];
        const delta = a.pa ? gemeinsam.reduce((q, k) => q + (v.pa[k] - a.pa[k]), 0) : (churnNeu ? v.b - a.b : 0);
        // Ein echter Slash senkt auch den Gesamt-Bond der Node (mindestens um unseren Anteil).
        const nodeSank = a.tb > 0 && v.tb > 0 ? (a.tb - v.tb) >= Math.max(0.5, -delta * 0.9) : false;
        if (churnNeu && delta > 0) rewardSumme += delta;
        // Bond sinkt waehrend die Node aktiv ist und kein Churn war -> MOEGLICHER Slash.
        // BESTAETIGUNG NOETIG (gemeldet: Push "-1.800 RUNE", Slash-Check fand nichts): Die
        // THORNode-Server antworten nicht immer vom selben Stand -- besonders waehrend eines
        // Upgrades kann einer einen aelteren Bond liefern. Deshalb erst melden, wenn der niedrigere
        // Wert beim NAECHSTEN Lauf bestaetigt ist; bis dahin bleibt der alte Wert die Basis.
        else if (p.bond && !churnNeu && a.s === 'Active' && v.s === 'Active' && delta < -0.5 && nodeSank) {
          const offen = (z.slashVerdacht || {})[na];
          const vGem = gemeinsam.reduce((q, k) => q + v.pa[k], 0);
          if (offen && Math.abs(offen.b - vGem) < 0.5) {
            // PERSOENLICH: a.b/v.b sind die Summe DEINER Bond-Provider-Eintraege bei dieser Node,
            // nicht der Bond der ganzen Node -- die Meldung nennt also deinen eigenen Verlust.
            meldungen.push({ titel: de ? 'Slash bei deinem Bond' : 'Slash on your bond', text: (de ? 'Du hast ' : 'You lost ') + `${runeTxt(-delta)} RUNE` + (de ? ` verloren \u00b7 Node ${kurzNode(na)}` : ` \u00b7 node ${kurzNode(na)}`), tag: 'rw-slash-' + na + '-' + Math.round(v.b) });
            delete z.slashVerdacht[na];
          } else {
            z.slashVerdacht = { ...(z.slashVerdacht || {}), [na]: { b: vGem, t: Date.now() } };
            neu[na] = { ...v, b: a.b, pa: { ...(v.pa || {}), ...Object.fromEntries(gemeinsam.map(k => [k, a.pa[k]])) }, tb: a.tb };   // alte Werte als Basis, bis bestaetigt
          }
        }
        else if (z.slashVerdacht && z.slashVerdacht[na]) delete z.slashVerdacht[na];
      }
      // Provider nicht mehr dabei (Bond zurueckgezahlt).
      // Nur melden, wenn die Adresse noch im Abo ist -- sonst wurde nur eine Wallet entfernt.
      if (p.bond) for (const [na, a] of Object.entries(alt)) if (!neu[na] && a.b > 1 && (!a.pa || Object.keys(a.pa).some(k => adr.includes(k)))) meldungen.push({ titel: 'rune.watch', text: de ? `Bond von Node ${kurzNode(na)} zur\u00fcckgezahlt (${runeTxt(a.b)} RUNE)` : `Bond from node ${kurzNode(na)} returned (${runeTxt(a.b)} RUNE)`, tag: 'rw-refund-' + na });
      if (p.churn && rewardSumme > 0.01) meldungen.push({ titel: de ? 'Neue Bond-Rewards' : 'New bond rewards', text: '+' + runeTxt(rewardSumme) + ' RUNE' + (preis ? ' \u00b7 $' + (rewardSumme * preis).toFixed(2) : ''), tag: 'rw-churn-' + churnH });
    }
    // WOCHEN-REVIEW (gewuenscht): Rewards der Woche mitzaehlen und montags um 8:00 UTC eine
    // Zusammenfassung schicken -- Rewards in RUNE und $, Zahl der Churns, aktueller Bond, RUNE-Kurs
    // im Vergleich zur Vorwoche. Thema "woche" (Standard an).
    {
      const jetzt = new Date();
      const montag = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), jetzt.getUTCDate() - ((jetzt.getUTCDay() + 6) % 7)));
      const wocheKey = montag.toISOString().slice(0, 10);
      const bondJetzt = Object.values(neu).reduce((q, v) => q + (Number(v.b) || 0), 0);
      if (!z.woche) z.woche = { key: wocheKey, rune: 0, churns: 0, preis0: preis || null };
      if (alt && churnH && z.churn && churnH !== z.churn) {
        let r2 = 0;
        for (const [na, v] of Object.entries(neu)) { const a = alt[na]; if (a && v.b - a.b > 0) r2 += v.b - a.b; }
        if (r2 > 0.01) { z.woche.rune = (Number(z.woche.rune) || 0) + r2; z.woche.churns = (Number(z.woche.churns) || 0) + 1; }
      }
      const sendeZeit = montag.getTime() + 8 * 3600e3;
      if (z.woche.key !== wocheKey && Date.now() >= sendeZeit) {
        const w = z.woche;
        if (p.woche !== false && bondJetzt > 0) {
          const pr = preis && w.preis0 ? ((preis / w.preis0 - 1) * 100) : null;
          const teile = [];
          teile.push(w.rune > 0.01 ? `+${runeTxt(w.rune)} RUNE` + (preis ? ` ($${(w.rune * preis).toFixed(0)})` : '') + (de ? ` aus ${w.churns} Churn${w.churns === 1 ? '' : 's'}` : ` from ${w.churns} churn${w.churns === 1 ? '' : 's'}`)
                                 : (de ? 'Keine neuen Rewards (kein Churn)' : 'No new rewards (no churn)'));
          teile.push((de ? 'Bond ' : 'Bond ') + runeTxt(bondJetzt) + ' RUNE');
          if (preis) teile.push('RUNE $' + preis.toFixed(3) + (pr != null ? ` (${pr >= 0 ? '+' : ''}${pr.toFixed(1)} %)` : ''));
          meldungen.push({ titel: de ? 'Deine Woche bei THORChain' : 'Your week on THORChain', text: teile.join(' \u00b7 '), tag: 'rw-woche-' + w.key });
        }
        z.woche = { key: wocheKey, rune: 0, churns: 0, preis0: preis || null };
      }
    }
    z.nodes = neu;
    if (churnH) z.churn = churnH;
    // TCY-AUSZAHLUNG (gewuenscht): Einmal je neuem Auszahlungstag. Betrag = gestakte TCY aller
    // Adressen x RUNE je TCY dieses Tages (dieselbe Referenz wie die TCY-Karte: tcy_native_ref,
    // gemessen an nativen Stakern mit unveraendertem Bestand). Nur wenn wirklich etwas gestakt ist.
    if (p.tcy !== false && adr.length) {
      try {
        const ref = await env.DB.prepare('SELECT tag, rune_pro_tcy FROM tcy_native_ref ORDER BY tag DESC LIMIT 1').first().catch(() => null);
        if (ref && ref.tag && Number(ref.rune_pro_tcy) > 0 && z.tcyTag !== ref.tag) {
          let gestakt = 0;
          for (const a of adr) {
            const st = await fetchFromBases(getThornodeBases(), `/thorchain/tcy_staker/${a}`).catch(() => null);
            gestakt += Number(st && st.amount) / 1e8 || 0;
          }
          const erste = z.tcyTag == null;   // erster Lauf: nur merken, keine Meldung fuer alte Tage
          z.tcyTag = ref.tag;
          const rune = gestakt * Number(ref.rune_pro_tcy);
          if (!erste && gestakt > 0 && rune >= 0.01) {
            const usd = preis ? ` ($${(rune * preis).toFixed(rune * preis < 10 ? 2 : 0)})` : '';
            meldungen.push({ titel: de ? 'TCY-Auszahlung' : 'TCY payout',
              text: de ? `+${runeTxt(rune)} RUNE${usd} f\u00fcr ${runeTxt(gestakt)} gestakte TCY` : `+${runeTxt(rune)} RUNE${usd} for ${runeTxt(gestakt)} staked TCY`,
              tag: 'rw-tcy-' + ref.tag });
          }
        }
      } catch (e) {}
    }
    // THORName: einmal pro Tag pruefen, Meldung bei < 30 Tagen (einmal pro Name und Tag).
    if (p.thorname && z.tnTag !== heute) {
      z.tnTag = heute;
      try {
        const lb = await fetchFromBases(getThornodeBases(), '/thorchain/lastblock');
        const h = Array.isArray(lb) ? Math.max(...lb.map(x => Number(x && x.thorchain) || 0)) : 0;
        for (const a of adr) {
          const liste = await fetchFromBases(getMidgardBases(), `/thorname/owner/${a}`).catch(() => null);
          for (const nm of (Array.isArray(liste) ? liste : []).slice(0, 10)) {
            const info = await fetchFromBases(getThornodeBases(), `/thorchain/thorname/${encodeURIComponent(nm)}`).catch(() => null);
            const ex = Number(info && info.expire_block_height);
            if (!ex || !h) continue;
            const tage = (ex - h) * 6 / 86400;
            if (tage > 0 && tage < 30) meldungen.push({ titel: 'THORName', text: de ? `\u201e${nm}\u201c l\u00e4uft in etwa ${Math.ceil(tage)} Tagen ab` : `"${nm}" expires in about ${Math.ceil(tage)} days`, tag: 'rw-tn-' + nm });
          }
        }
      } catch (e) {}
    }
    for (const m of meldungen.slice(0, 5)) { try { await pushSenden(env, row, m); } catch (e) {} }
    await env.DB.prepare('UPDATE push_subs SET zustand = ? WHERE id = ?').bind(JSON.stringify(z), row.id).run();
  }
}

// =====================================================================================
// ANALYSE: Beeinflusst das Swap-Volumen den RUNE-Kurs?   GET /analyse/volumen-kurs?tage=365
// Daten (Midgard, je Tag): toRuneVolume (Kauf von RUNE), toAssetVolume (Verkauf von RUNE),
// runePriceUSD; BTC-Kurs aus /history/depths/BTC.BTC. Rechnung:
//   r  = log-Rendite RUNE, b = log-Rendite BTC, beta = cov(r,b)/var(b)
//   e  = Ueberrendite = r - beta*b   (Marktbewegung herausgerechnet)
//   n  = Netto-Richtung = (Kauf - Verkauf) / (Kauf + Verkauf)   (-1 .. +1)
//   g  = Volumen-Wachstum = log(Gesamtvolumen / Vortag)
// Tests: Korrelationen gleichzeitig und um 1 Tag versetzt (beide Richtungen) und ein einfacher
// Granger-Test (erklaert n von gestern die Ueberrendite von heute ueber e von gestern hinaus?).
// =====================================================================================
function anaKorr(x, y) {
  const n = Math.min(x.length, y.length); if (n < 10) return { r: null, n };
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  const t = r * Math.sqrt((n - 2) / Math.max(1e-12, 1 - r * r));
  const p = 2 * (1 - anaNormCdf(Math.abs(t)));
  return { r, n, p };
}
function anaNormCdf(z) { const t = 1 / (1 + 0.2316419 * z); const d = 0.3989423 * Math.exp(-z * z / 2); return 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); }
// OLS-Residuenquadratsumme fuer y ~ 1 + X (X: Liste von Spalten), per Normalgleichungen.
function anaRss(y, X) {
  const n = y.length, k = X.length + 1;
  const A = Array.from({ length: k }, () => Array(k).fill(0)), v = Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const row = [1, ...X.map(c => c[i])];
    for (let a = 0; a < k; a++) { v[a] += row[a] * y[i]; for (let b = 0; b < k; b++) A[a][b] += row[a] * row[b]; }
  }
  // Gauss-Elimination
  for (let c = 0; c < k; c++) {
    let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [v[c], v[p]] = [v[p], v[c]];
    if (Math.abs(A[c][c]) < 1e-15) return null;
    for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let b = c; b < k; b++) A[r][b] -= f * A[c][b]; v[r] -= f * v[c]; }
  }
  const beta = v.map((x, i) => x / A[i][i]);
  let rss = 0;
  for (let i = 0; i < n; i++) { const row = [1, ...X.map(c => c[i])]; const yh = row.reduce((s, x, j) => s + x * beta[j], 0); rss += (y[i] - yh) ** 2; }
  return { rss, beta };
}
// BINANCE-TAGESKURSE (wie die App): Schlusskurs je UTC-Tag. Erst die oeffentliche Markt-Daten-
// Spiegelung (data-api.binance.vision, ohne Laendersperre), dann api.binance.com. Max. 1000 je Abfrage.
// Liefert { tage: Map(tag -> Schlusskurs), quelle, fehler[] }. Reihenfolge: Binance direkt (wie die
// App) -> CryptoCompare mit Kursen von Binance (e=Binance, USDT) -> CryptoCompare-Durchschnitt.
// Grund (gemeldet: "keine Binance-Daten"): Binance lehnt Anfragen von Cloudflare-Servern oft ab.
async function anaBinanceTage(symbol, vonMs) {
  const fehler = [];
  const tage = new Map();
  for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
    try {
      let start = vonMs;
      for (let runde = 0; runde < 10 && start < Date.now(); runde++) {
        // Kurze Wartezeit: Binance antwortet Cloudflare oft gar nicht -- nicht 12 s haengen bleiben.
        const r = await fetchWithTimeout(`${host}/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${start}&limit=1000`, { timeoutMs: 5000 });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const k = await r.json();
        if (!Array.isArray(k) || !k.length) break;
        for (const c of k) tage.set(new Date(Number(c[0])).toISOString().slice(0, 10), Number(c[4]));
        start = Number(k[k.length - 1][0]) + 86400000;
        if (k.length < 1000) break;
      }
      if (tage.size) return { tage, quelle: 'Binance', fehler };
    } catch (e) { fehler.push(host.replace('https://', '') + ': ' + (e?.message || e)); tage.clear(); }
  }
  const fsym = symbol.replace(/USDT$/, '');
  for (const variante of [{ e: 'Binance', tsym: 'USDT', name: 'Binance via CryptoCompare' }, { e: null, tsym: 'USD', name: 'CryptoCompare (Durchschnitt)' }]) {
    try {
      let bisTs = Math.floor(Date.now() / 1000);
      for (let runde = 0; runde < 6; runde++) {
        const q = `/data/v2/histoday?fsym=${fsym}&tsym=${variante.tsym}&limit=2000&toTs=${bisTs}` + (variante.e ? `&e=${variante.e}` : '');
        const r = await fetchWithTimeout('https://min-api.cryptocompare.com' + q, { timeoutMs: 12000 });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const liste = j && j.Data && Array.isArray(j.Data.Data) ? j.Data.Data : null;
        if (!liste) throw new Error((j && j.Message) || 'leer');
        let aelteste = Infinity;
        for (const c of liste) { if (Number(c.close) > 0) tage.set(new Date(Number(c.time) * 1000).toISOString().slice(0, 10), Number(c.close)); aelteste = Math.min(aelteste, Number(c.time)); }
        if (!Number.isFinite(aelteste) || aelteste * 1000 <= vonMs) break;
        bisTs = aelteste - 86400;
      }
      if (tage.size) return { tage, quelle: variante.name, fehler };
    } catch (e) { fehler.push(variante.name + ': ' + (e?.message || e)); tage.clear(); }
  }
  return { tage, quelle: null, fehler };
}
// CSV-EXPORT der THORChain-Swaps je Tag (Midgard), fuer die Auswertung ausserhalb des Workers.
// GET /analyse/swaps.csv?ab=2020-09-01   Spalten in RUNE (nicht 1e8).
async function handleAnalyseSwapsCsv(request, env, url) {
  const abParam = url.searchParams.get('ab') || '2020-09-01';
  const jetztS = Math.floor(Date.now() / 1000);
  const vonS = /^\d{4}-\d{2}-\d{2}$/.test(abParam) ? Math.floor(Date.parse(abParam + 'T00:00:00Z') / 1000) : jetztS - 400 * 86400;
  const alle = new Map();
  for (let von = vonS; von < jetztS; von += 390 * 86400) {
    const bis = Math.min(jetztS, von + 390 * 86400);
    const j = await fetchFromBases(getMidgardBases(), `/history/swaps?interval=day&from=${von}&to=${bis}`).catch(() => null);
    for (const iv of (j && j.intervals) || []) alle.set(String(iv.startTime), iv);
  }
  const zeilen = [...alle.values()].sort((a, b) => Number(a.startTime) - Number(b.startTime));
  const z = v => (Number(v || 0) / 1e8).toFixed(4);
  const csv = ['date,toRuneVolume,toAssetVolume,totalVolume,toRuneCount,toAssetCount,totalCount,runePriceUSD_midgard']
    .concat(zeilen.map(iv => [new Date(Number(iv.startTime) * 1000).toISOString().slice(0, 10), z(iv.toRuneVolume), z(iv.toAssetVolume), z(iv.totalVolume), iv.toRuneCount || 0, iv.toAssetCount || 0, iv.totalCount || 0, iv.runePriceUSD || ''].join(',')))
    .join('\n');
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="thorchain-swaps-1D.csv"', 'Cache-Control': 'no-store' } });
}
async function handleAnalyseVolumenKurs(request, env, url) {
  // ZEITRAUM: ?tage=365 (Standard) ODER ?ab=2021-01-01 (beliebig weit zurueck). Midgard liefert
  // hoechstens 400 Tage je Abfrage -> lange Zeitraeume in Bloecken zu 390 Tagen holen.
  const abParam = url.searchParams.get('ab');
  const jetztS = Math.floor(Date.now() / 1000);
  const tage = Math.max(60, Math.min(730, Number(url.searchParams.get('tage')) || 365));
  const vonS = abParam && /^\d{4}-\d{2}-\d{2}$/.test(abParam) ? Math.floor(Date.parse(abParam + 'T00:00:00Z') / 1000) : jetztS - (tage + 2) * 86400;
  const holeAlle = async pfad => {
    const alle = [];
    for (let von = vonS; von < jetztS; von += 390 * 86400) {
      const bis = Math.min(jetztS, von + 390 * 86400);
      const j = await fetchFromBases(getMidgardBases(), `${pfad}?interval=day&from=${von}&to=${bis}`).catch(() => null);
      for (const iv of (j && j.intervals) || []) alle.push(iv);
    }
    const gesehen = new Set();
    return { intervals: alle.filter(iv => { const k = String(iv.startTime); if (gesehen.has(k)) return false; gesehen.add(k); return true; }) };
  };
  const sw = await holeAlle('/history/swaps');
  // KURSE VON BINANCE (gewuenscht: "wie meine App"), nicht aus den THORChain-Pools: Ein Swap
  // verschiebt den Pool-Preis zwangslaeufig -- mit dem Pool-Kurs waere ein Teil des Ergebnisses
  // reine Mechanik. Binance bildet den Handel ausserhalb von THORChain ab.
  const [runeK, btcK] = await Promise.all([anaBinanceTage('RUNEUSDT', vonS * 1000), anaBinanceTage('BTCUSDT', vonS * 1000)]);
  const runeB = runeK.tage, btcB = btcK.tage;
  const tagVon = ts => new Date(ts * 1000).toISOString().slice(0, 10);
  const zeilen = ((sw && sw.intervals) || []).map(iv => {
    const tag = tagVon(Number(iv.startTime));
    return { t: Number(iv.startTime), tag, p: runeB.get(tag), btc: btcB.get(tag),
      kauf: Number(iv.toRuneVolume || 0) / 1e8, verkauf: Number(iv.toAssetVolume || 0) / 1e8, gesamt: Number(iv.totalVolume || 0) / 1e8 };
  }).filter(z => z.p > 0 && z.btc > 0 && z.gesamt > 0).sort((a, b) => a.t - b.t);
  if (zeilen.length && Date.now() / 1000 - zeilen[zeilen.length - 1].t < 86400) zeilen.pop();
  // NUR ECHTE AUFEINANDERFOLGENDE TAGE: Rendite nur, wenn der Vortag vorhanden ist (sonst wuerde
  // ueber Luecken hinweg gerechnet); "gestern" ist immer der Kalendertag davor.
  const r = [], b = [], n = [], g = [], jahr = [], tagIdx = [];
  for (let i = 1; i < zeilen.length; i++) {
    if (zeilen[i].t - zeilen[i - 1].t !== 86400) continue;
    jahr.push(new Date(zeilen[i].t * 1000).getUTCFullYear());
    tagIdx.push(Math.round(zeilen[i].t / 86400));
    r.push(Math.log(zeilen[i].p / zeilen[i - 1].p)); b.push(Math.log(zeilen[i].btc / zeilen[i - 1].btc));
    const k = zeilen[i].kauf, v = zeilen[i].verkauf; n.push(k + v > 0 ? (k - v) / (k + v) : 0);
    g.push(Math.log(zeilen[i].gesamt / zeilen[i - 1].gesamt));
  }
  // MARKT-KOPPLUNG JE JAHR (statt einer fuer alles): Ueberrendite e mit dem beta des eigenen Jahres.
  const betaVon = idx => { const rr = idx.map(i => r[i]), bb = idx.map(i => b[i]); const mr = rr.reduce((a, x) => a + x, 0) / rr.length, mb = bb.reduce((a, x) => a + x, 0) / bb.length; let c = 0, v = 0; for (let j = 0; j < rr.length; j++) { c += (rr[j] - mr) * (bb[j] - mb); v += (bb[j] - mb) ** 2; } return v ? c / v : 0; };
  const jahre = [...new Set(jahr)].sort();
  const betaJahr = new Map(jahre.map(J => [J, betaVon(jahr.map((x, i) => x === J ? i : -1).filter(i => i >= 0))]));
  const beta = betaVon(r.map((_, i) => i));
  const e = r.map((x, i) => x - betaJahr.get(jahr[i]) * b[i]);
  const absE = e.map(Math.abs);
  // Paare "gestern -> heute" nur fuer wirklich aufeinanderfolgende Tage
  const paare = []; for (let i = 1; i < e.length; i++) if (tagIdx[i] - tagIdx[i - 1] === 1) paare.push(i);
  const tests = {
    gleichzeitig: anaKorr(n, e),
    nGesternEHeute: anaKorr(paare.map(i => n[i - 1]), paare.map(i => e[i])),
    eGesternNHeute: anaKorr(paare.map(i => e[i - 1]), paare.map(i => n[i])),
    volumenUndBewegung: anaKorr(g, absE),
    marktKopplung: anaKorr(r, b),
  };
  const y = paare.map(i => e[i]), e1 = paare.map(i => e[i - 1]), n1 = paare.map(i => n[i - 1]);
  const klein = anaRss(y, [e1]), gross = anaRss(y, [e1, n1]);
  let granger = null;
  if (klein && gross && gross.rss > 0) {
    const dfz = y.length - 3, F = (klein.rss - gross.rss) / (gross.rss / dfz);
    granger = { F, p: 2 * (1 - anaNormCdf(Math.sqrt(Math.max(0, F)))), koeff: gross.beta[2] };
  }
  const jeJahr = jahre.map(J => {
    const pj = paare.filter(i => jahr[i] === J);
    const idx = jahr.map((x, i) => x === J ? i : -1).filter(i => i >= 0);
    return { jahr: J, tage: idx.length, beta: betaJahr.get(J), lag: anaKorr(pj.map(i => n[i - 1]), pj.map(i => e[i])), markt: anaKorr(idx.map(i => r[i]), idx.map(i => b[i])) };
  });
  const kursQuelle = runeK.quelle && btcK.quelle ? (runeK.quelle === btcK.quelle ? runeK.quelle : `RUNE: ${runeK.quelle}, BTC: ${btcK.quelle}`) : 'keine Kursdaten';
  const kursFehler = [...runeK.fehler.map(x => 'RUNE ' + x), ...btcK.fehler.map(x => 'BTC ' + x)];
  const daten = { tage: r.length, kursQuelle, kursFehler, jeJahr, von: zeilen[0] && new Date(zeilen[0].t * 1000).toISOString().slice(0, 10), bis: zeilen.length && new Date(zeilen[zeilen.length - 1].t * 1000).toISOString().slice(0, 10), beta, tests, granger };
  if (url.searchParams.get('format') === 'json') return json(daten, env);
  if (!r.length) return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:14px system-ui;background:#0b1117;color:#e6eef2;padding:18px"><h3>Keine Daten</h3><p>Kursquelle: ${kursQuelle}</p><pre style="white-space:pre-wrap;color:#9aa">${kursFehler.join('\n') || '—'}</pre><p>Swap-Tage von Midgard: ${((sw && sw.intervals) || []).length}</p></body>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  const f = (x, d = 3) => x == null ? '—' : Number(x).toFixed(d);
  const sig = p => p == null ? '' : p < 0.01 ? '<b style="color:#2dd4bf">deutlich</b>' : p < 0.05 ? '<b style="color:#2dd4bf">ja</b>' : p < 0.1 ? 'schwach' : '<span style="opacity:.6">nein</span>';
  const zeile = (titel, frage, t) => `<tr><td>${titel}<div class="h">${frage}</div></td><td class="z">${f(t.r)}</td><td class="z">${t.p != null ? f(t.p, 3) : '—'}</td><td class="z">${sig(t.p)}</td></tr>`;
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Volumen vs. RUNE-Kurs</title>
<style>body{font:14px/1.5 Inter,system-ui,sans-serif;background:#0b1117;color:#e6eef2;margin:0;padding:18px;max-width:760px}h1{font-size:18px}table{width:100%;border-collapse:collapse;margin:12px 0}td,th{padding:8px 6px;border-bottom:1px solid #1f2b35;text-align:left;vertical-align:top}th{color:#6b7c87;font-weight:600;font-size:12px}.z{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.h{color:#6b7c87;font-size:12px}.box{background:#111a22;border:1px solid #1f2b35;border-radius:12px;padding:12px 14px;margin:12px 0}</style></head><body>
<h1>Beeinflusst das Swap-Volumen den RUNE-Kurs?</h1>
<div class="h">${daten.tage} Tage, ${daten.von} bis ${daten.bis} · Volumen: Midgard · Kurse: ${kursQuelle} (Tagesschluss UTC) · nur aufeinanderfolgende Tage · Marktbewegung (BTC) je Jahr herausgerechnet, gesamt &beta; = ${f(beta, 2)}</div>
<table><tr><th>Test</th><th class="z">Korr.</th><th class="z">p</th><th class="z">Zusammenhang?</th></tr>
${zeile('Netto-Kaufdruck &amp; Kurs am selben Tag', 'Mehr RUNE gekauft als verkauft &rarr; steigt RUNE am selben Tag (ueber den Markt hinaus)?', tests.gleichzeitig)}
${zeile('Kaufdruck gestern &rarr; Kurs heute', 'Laeuft der Kaufdruck dem Kurs voraus? (Hinweis auf Ursache)', tests.nGesternEHeute)}
${zeile('Kurs gestern &rarr; Kaufdruck heute', 'Oder laeuft umgekehrt der Kurs dem Kaufdruck voraus?', tests.eGesternNHeute)}
${zeile('Volumen-Anstieg &amp; Kursbewegung', 'Gehen Tage mit mehr Volumen mit groesseren Kursbewegungen einher (egal welche Richtung)?', tests.volumenUndBewegung)}
${zeile('RUNE &amp; BTC (Vergleich)', 'Wie stark haengt RUNE am Gesamtmarkt?', tests.marktKopplung)}
</table>
${jeJahr.length > 1 ? `<table><tr><th>Jahr</th><th class="z">Tage</th><th class="z">Kaufdruck gestern &rarr; Kurs heute</th><th class="z">p</th><th class="z">RUNE &amp; BTC</th><th class="z">&beta;</th></tr>${jeJahr.map(J => `<tr><td>${J.jahr}</td><td class="z">${J.tage}</td><td class="z">${f(J.lag.r)}</td><td class="z">${J.lag.p != null ? f(J.lag.p) : '—'} ${sig(J.lag.p)}</td><td class="z">${f(J.markt.r, 2)}</td><td class="z">${f(J.beta, 2)}</td></tr>`).join('')}</table>` : ''}
<div class="box"><b>Granger-Test</b> (sagt der Kaufdruck von gestern die Ueberrendite von heute voraus, zusaetzlich zur Rendite von gestern?)<br>
F = ${granger ? f(granger.F, 2) : '—'} · p &asymp; ${granger ? f(granger.p, 3) : '—'} · ${granger ? sig(granger.p) : ''}</div>
<div class="box h">Lesehilfe: Korrelation von -1 bis +1 (0 = kein Zusammenhang). p unter 0,05 = vermutlich kein Zufall. Ein Zusammenhang ist noch kein Beweis fuer eine Ursache: News, Halts oder Marktpanik koennen beides gleichzeitig treiben. Tageswerte; Effekte innerhalb eines Tages (Arbitrage) sieht man hier nicht.</div>
<div class="h">Als JSON: ?format=json · anderer Zeitraum: ?tage=180 oder ?ab=2021-01-01</div>
</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// =====================================================================================
// bRUNE AUF RUJIRA (Liquid Bonded RUNE): RUNE 1:1 -> bRUNE, bRUNE staken (Auszahlung in RUNE)
// oder Auto-Compound -> ybRUNE (x/staking-x/brune). Gleicher Staking-Vertragstyp wie RUJI/TCY,
// config.bond_denom == "x/brune". Kurs 1 ybRUNE = amount/shares bRUNE aus den liquid.bond-
// Einzahlungen aller Nutzer (wie sTCY), dazu der aktuelle Stand aus status.
// GET /rujira-brune-history -> { vertrag, jetzt: { kurs }, tage: [{ tag, ms, kurs }] }
// =====================================================================================
let rujiraBruneVertragCache = null;
let bruneTabellenOk = false;
async function sichereBruneTabellen(env) {
  if (bruneTabellenOk) return;
  await sichereRujiraTabellen(env);
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS rujira_brune_kurs (tag TEXT PRIMARY KEY, ms INTEGER, kurs REAL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS rujira_brune_state (k TEXT PRIMARY KEY, v TEXT)`),
  ]);
  bruneTabellenOk = true;
}
async function findeRujiraBruneVertrag(env) {
  if (rujiraBruneVertragCache) return rujiraBruneVertragCache;
  await sichereBruneTabellen(env);
  const m = await env.DB.prepare("SELECT v FROM rujira_brune_state WHERE k = 'vertrag'").first();
  if (m && m.v) { rujiraBruneVertragCache = m.v; return m.v; }
  const merke = async a => { rujiraBruneVertragCache = a; await env.DB.prepare("INSERT OR REPLACE INTO rujira_brune_state (k, v) VALUES ('vertrag', ?)").bind(a).run(); return a; };
  const passt = async a => { try { const cfg = await wasmSmart(a, { config: {} }); return !!(cfg && /brune/i.test(String(cfg.bond_denom))); } catch (e) { return false; } };
  // SCHNELL (gemeldet: Zeitueberschreitung): Der Staking-Vertrag haelt fast alle bRUNE (laut
  // Richliste ~4,9 Mio.). Also die groessten Besitzer der Denom x/brune pruefen, statt alle
  // Vertraege eines Code-Typs einzeln abzufragen.
  try {
    const j = await fetchFromBases(getThornodeBases(), `/cosmos/bank/v1beta1/denom_owners/${encodeURIComponent('x/brune')}?pagination.limit=200`);
    const liste = ((j && j.denom_owners) || []).map(o => ({ a: String(o.address || ''), n: Number(o.balance && o.balance.amount) || 0 }))
      .filter(o => o.a.length > 50).sort((x, y) => y.n - x.n).slice(0, 6);   // Vertragsadressen sind lang
    for (const o of liste) if (await passt(o.a)) return merke(o.a);
  } catch (e) {}
  const info = await fetchFromBases(getThornodeBases(), `/cosmwasm/wasm/v1/contract/${RUJI_STAKING_VERTRAG}`);
  const codeId = Number(info && info.contract_info && info.contract_info.code_id);
  if (!codeId) return null;
  const bis = Date.now() + 15000;   // Notweg mit Zeitlimit
  for (const id of [codeId, codeId + 1, codeId - 1]) {
    let liste = null;
    try { liste = await fetchFromBases(getThornodeBases(), `/cosmwasm/wasm/v1/code/${id}/contracts?pagination.limit=200`); } catch (e) { continue; }
    for (const a of (liste && liste.contracts) || []) {
      if (Date.now() > bis) return null;
      if (await passt(a)) return merke(a);
    }
  }
  return null;
}
async function syncRujiraBruneKurs(env, seiten = 6) {
  await sichereBruneTabellen(env);
  const vertrag = await findeRujiraBruneVertrag(env);
  if (!vertrag) return;
  const st = await env.DB.prepare("SELECT v FROM rujira_brune_state WHERE k = 'kurs_token'").first();
  const fertig = await env.DB.prepare("SELECT v FROM rujira_brune_state WHERE k = 'kurs_fertig'").first();
  const speichere = (ms, kurs) => env.DB.prepare(
    `INSERT INTO rujira_brune_kurs (tag, ms, kurs) VALUES (?, ?, ?)
     ON CONFLICT(tag) DO UPDATE SET ms = excluded.ms, kurs = excluded.kurs WHERE excluded.ms > rujira_brune_kurs.ms`
  ).bind(new Date(ms).toISOString().slice(0, 10), ms, kurs).run();
  const seite = async token => {
    const j = await fetchFromBases(getMidgardBases(), `/actions?address=${vertrag}&type=contract&limit=50${token ? `&nextPageToken=${token}` : ''}`);
    for (const act of (j && j.actions) || []) {
      const c = act && act.metadata && act.metadata.contract;
      const typ = String(c && c.contractType || '');
      const bond = /rujira-staking\/liquid\.bond$/.test(typ), unbond = /rujira-staking\/liquid\.unbond$/.test(typ);
      if (!bond && !unbond) continue;
      const a = Number(c.attributes && (bond ? c.attributes.amount : c.attributes.returned)), sh = Number(c.attributes && c.attributes.shares);
      const ms = Math.round(Number(act.date) / 1e6);
      if (a > 0 && sh > 0 && ms > 0) await speichere(ms, a / sh);
    }
    return (j && j.meta && j.meta.nextPageToken) || null;
  };
  await seite(null);
  // Aktueller Stand aus dem Vertrag (auch an Tagen ohne Einzahlung)
  try {
    const s = await wasmSmart(vertrag, { status: {} });
    const sh = Number(s && s.liquid_bond_shares), sz = Number(s && s.liquid_bond_size);
    if (sh > 0 && sz > 0) await speichere(Date.now(), sz / sh);
  } catch (e) {}
  if (fertig) return;
  let token = st && st.v || null;
  if (!token) token = await seite(null);
  for (let i = 0; i < seiten && token; i++) token = await seite(token);
  await env.DB.prepare("INSERT OR REPLACE INTO rujira_brune_state (k, v) VALUES ('kurs_token', ?)").bind(token || '').run();
  if (!token) await env.DB.prepare("INSERT OR REPLACE INTO rujira_brune_state (k, v) VALUES ('kurs_fertig', '1')").run();
}
async function handleRujiraBruneHistory(request, env) {
  await sichereBruneTabellen(env);
  const r = await env.DB.prepare('SELECT tag, ms, kurs FROM rujira_brune_kurs ORDER BY tag ASC').all();
  let jetzt = null;
  try {
    const v = await findeRujiraBruneVertrag(env);
    const s = v ? await wasmSmart(v, { status: {} }) : null;
    const sh = Number(s && s.liquid_bond_shares), sz = Number(s && s.liquid_bond_size);
    if (sh > 0 && sz > 0) jetzt = { kurs: sz / sh, groesse: sz / 1e8 };
  } catch (e) {}
  const fertig = await env.DB.prepare("SELECT v FROM rujira_brune_state WHERE k = 'kurs_fertig'").first();
  return json({ vertrag: rujiraBruneVertragCache, jetzt, kursFertig: !!fertig, tage: r.results || [] }, env);
}

async function runRefreshCycle(env) {
  // Jeder Schritt einzeln abgesichert (gemeldet: "bei NEAR steht immer noch DefiLlama"): Warf
  // vorher einer der ersten Schritte einen Fehler, liefen alle folgenden in diesem Durchgang gar
  // nicht -- auch der Dune-Abruf. Dune steht jetzt vorn; gedrosselt kostet er nur eine D1-Abfrage.
  const schritt = async (name, fn) => { try { await fn(); } catch (e) { console.warn(`[rune-rewards-backend] ${name}:`, e?.message || String(e)); } };
  // PUSH ZUERST (gemeldet: "Notifications noch nicht zuverlaessig"): Push lief als einer der
  // letzten Schritte. Jeder Cron-Durchgang hat ein festes Budget an Unteranfragen und Laufzeit;
  // verbrauchten die Schritte davor (Dune, Swap-Paare, Node-Historie, TCY ...) viel davon,
  // scheiterten die Push-Abrufe und -Sendungen still -- mal kam eine Meldung, mal nicht.
  await schritt('Push', () => syncPush(env));
  await schritt('Dune NEAR', () => syncNearDune(env));
  await schritt('Churns', () => refreshChurnsCache(env));
  await schritt('Swap-Paare', () => collectSwapPairStats(env));
  await schritt('Node-Historie', () => syncNodeHistory(env));
  await schritt('Node-Epochen', () => syncNodeEpochs(env));
  await schritt('Rujira TCY', () => syncRujiraTcyDaily(env));
  await schritt('Rujira TCY Kurs', () => syncRujiraKursEreignisse(env));
  await schritt('TCY native Referenz', () => syncTcyNativeReferenz(env));
  await schritt('Spenden-Verlauf', () => syncDonationHistory(env));
  await schritt('bRUNE-Kurs', () => syncRujiraBruneKurs(env));
  await schritt('Timeline', () => waermeTimeline(env));

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
  
  if (!Array.isArray(raw)) raw = [];

  const known = await env.DB.prepare('SELECT MAX(height) as maxHeight FROM churns_cache').first();
  const knownHeight = known?.maxHeight || 0;

  const fresh = raw
    .map((c) => ({ height: parseInt(c.height, 10), dateMs: Math.floor(parseInt(c.date, 10) / 1e6) }))
    .filter((c) => c.height && c.dateMs && c.height > knownHeight);

  try {
    const netz = await fetchFromBases(getThornodeBases(), '/thorchain/network');
    const letzte = Number(netz && netz.last_churn_height) || 0;
    const hoechste = Math.max(knownHeight, ...fresh.map(c => c.height), 0);
    if (letzte && letzte > hoechste) {
      const bekannteZeit = raw
        .map(c => ({ h: parseInt(c.height, 10), t: Math.floor(parseInt(c.date, 10) / 1e6) }))
        .filter(c => c.h && c.t)
        .sort((a, b) => b.h - a.h)[0];
      const datum = bekannteZeit
        ? bekannteZeit.t + (letzte - bekannteZeit.h) * 6000
        : Date.now();
      fresh.push({ height: letzte, dateMs: Math.min(datum, Date.now()) });
      console.log('[rune-rewards-backend] Churn-Hoehe aus /thorchain/network ergaenzt:', letzte);
    }
  } catch (e) {
    console.warn('[rune-rewards-backend] Netzwerk-Hoehe nicht abrufbar:', e?.message || String(e));
  }

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
