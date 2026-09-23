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

// Midgard bleibt fuehrend; vanaheimex fuellt fehlende oder leere Tage und liefert den laufenden
// Tag, den Midgard derzeit gar nicht befuellt.
//
// SCHLUESSEL IST startTime, NICHT endTime (gemeldet: "der aktuelle Balken fehlt"). Beim
// laufenden Tag setzt Midgard endTime auf Mitternacht, vanaheimex auf JETZT -- ueber endTime
// verglichen landeten beide Eintraege nebeneinander in der Reihe, der leere von Midgard als
// letzter. Genau der wurde dann als letzter Balken gezeichnet: null.
function mischeTagesreihe(midgard, vana) {
  if (!vana || !vana.length) return midgard;
  if (!midgard || !midgard.intervals || !midgard.intervals.length) return { intervals: vana, meta: (midgard && midgard.meta) || null };
  const hatWert = (iv) => Number(iv && iv.totalCount) > 0;
  const nachStart = new Map();
  for (const iv of midgard.intervals) nachStart.set(String(iv.startTime), iv);
  for (const iv of vana) {
    const vorhanden = nachStart.get(String(iv.startTime));
    if (!vorhanden || !hatWert(vorhanden)) nachStart.set(String(iv.startTime), iv);
  }
  const zusammen = [...nachStart.values()].sort((a, b) => Number(a.startTime) - Number(b.startTime));
  return { ...midgard, intervals: zusammen };
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
    const [hourResult, dayResult, vanaResult] = await Promise.allSettled([
      fetchVolumeInterval('hour', 24),
      fetchVolumeInterval('day', 30),
      fetchVanaheimexSwapIntervals(),
    ]);
    const tage = dayResult.status === 'fulfilled' ? dayResult.value : null;
    const vana = vanaResult.status === 'fulfilled' ? vanaResult.value : null;
    return {
      hour: hourResult.status === 'fulfilled' ? hourResult.value : null,
      hourError: hourResult.status === 'rejected' ? (hourResult.reason?.message || String(hourResult.reason)) : null,
      day: mischeTagesreihe(tage, vana),
      dayError: dayResult.status === 'rejected' ? (dayResult.reason?.message || String(dayResult.reason)) : null,
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
  return json({ ...result.data, stale: result.stale, staleSince: result.staleSince || null }, env);
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

const MAX_WALLETS_PAYLOAD_BYTES = 200_000;

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

const MAX_SWAP_HISTORY_PAYLOAD_BYTES = 200_000;

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
    if (!roh) throw letzterFehler || new Error('KEINE_QUELLE');
    // Antwort ist {data: [...]} oder direkt ein Array -- beides zulassen.
    const liste = Array.isArray(roh) ? roh : (Array.isArray(roh?.data) ? roh.data : []);
    const eintraege = liste
      .filter((e) => e && e.nodeAddress && !e.isDelisted)
      .map((e) => ({
        addr: String(e.nodeAddress).toLowerCase(),
        name: e.name || null,
        minRune: Number(e.minRune) || null,
        maxRune: Number(e.maxRune) || null,
        fee: Number.isFinite(Number(e.feePercentage)) ? Number(e.feePercentage) : null,
        providers: Number.isFinite(Number(e.bondProvidersCount)) ? Number(e.bondProvidersCount) : null,
      }));
    // "base" steht mit in der Antwort -- so ist beim Nachsehen sofort klar, welche Adresse
    // tatsaechlich geantwortet hat.
    const daten = { listings: eintraege, fetchedAt: jetzt, base: basisGenutzt, error: null };
    runebondCache = { at: jetzt, data: daten };
    return json(daten, env);
  } catch (e) {
    // Faellt weich aus: die Node-Karte zeigt dann einfach keine Markierungen.
    const daten = { listings: [], fetchedAt: jetzt, error: String(e?.message || e) };
    runebondCache = { at: jetzt - (RUNEBOND_CACHE_MS - 60000), data: daten };
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
const CLICK_TARGETS = new Set(['runebond']);

async function handleClick(request, env, ctx) {
  const url = new URL(request.url);
  const target = String(url.searchParams.get('t') || '').toLowerCase();
  // Antwort immer 204, auch bei unbekanntem Ziel: der Klick des Nutzers soll nie an einer
  // Fehlermeldung haengen bleiben, das Ziel oeffnet ja parallel.
  if (!CLICK_TARGETS.has(target) || !env.DB) return new Response(null, { status: 204 });
  const token = url.searchParams.get('v');
  const now = Date.now();
  const sauber = token && VISITOR_TOKEN_RE.test(token) ? token : null;
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(
      env.DB.prepare('INSERT INTO outbound_clicks (target, token, day, at) VALUES (?, ?, ?, ?)')
        .bind(target, sauber, utcDayString(now), now)
        .run()
        .catch((e) => console.warn('[rune-rewards-backend] Klick nicht gezaehlt (Migration 3?):', e?.message || String(e)))
    );
  }
  return new Response(null, { status: 204 });
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
    klick1Row, klick30Row, klickGesamtRow, klickGeraeteRow,
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
  };
  // Anteil in Prozent, eine Nachkommastelle. Nenner = alle Geraete im selben Zeitraum.
  const walletPct = (n, total) => (n == null || !total) ? null : Math.round((n / total) * 1000) / 10;
  stats.walletShareLast1d = walletPct(stats.visitorsWithWalletLast1d, stats.visitorsLast1d);
  stats.walletShareLast30d = walletPct(stats.visitorsWithWalletLast30d, stats.visitorsLast30d);

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
</style>
</head>
<body>
  <h1>rune.watch — sync activity</h1>
  <div class="subtitle">Address based, across devices (not Cloudflare "visits") · recording <span id="v-since">${trackingHint}</span></div>

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
        ${tile('wshare30', 'With wallet – 30 days', stats.walletShareLast30d == null ? null : stats.walletShareLast30d + '%',
          stats.visitorsWithWalletLast30d == null ? 'no data yet' : `${stats.visitorsWithWalletLast30d} of ${stats.visitorsLast30d} devices` + (stats.visitorsWithWalletSince ? ` · recorded since ${deDate(stats.visitorsWithWalletSince)}` : ''))}
      </div>
      <div class="note">
        What is counted are <b>devices</b>, not people: phone and desktop of the same person are
        two. Anyone who clears browser data or browses privately counts again on the next visit —
        so the number is more of an upper bound. It is based on a random id the browser itself
        generates and stores in localStorage; no IP, no fingerprint, no cookie, no link to a
        wallet.
        <br><br>
        The difference to page 1: there only users <b>with a wallet entered</b> are counted — only
        those sync at all. Here every visit counts, including people who only look at the chart.
        The two numbers will never match.
        <br><br>
        "With wallet": the browser additionally reports only a yes/no, whether a wallet is entered
        on that device — never which one. The share shows how many visitors take the step from
        looking to entering. It is only recorded from the update onwards; earlier days count as
        "without wallet", so the 30-day value is too low at first.
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
  dots.forEach(d => d.addEventListener('click', () => {
    pager.scrollTo({ left: pager.clientWidth * Number(d.dataset.page), behavior: 'smooth' });
  }));
  pager.addEventListener('scroll', () => {
    const i = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
    dots.forEach((d, j) => d.classList.toggle('active', j === i));
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

const DEX_PROTOCOLS = [
  { key: 'chainflip', name: 'Chainflip', slug: 'chainflip' },
  { key: 'near-intents', name: 'NEAR Intents', slug: 'near-intents' },
];
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
  ]);

  const reihen = {};
  const fehler = {};
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
  const llamaFees = {}, llamaSupply = {};
  // +5: davor stehen Midgard-Tageswerte, Midgard-Gebuehren, die Stundenwerte, die Tagesreihe
  // von vanaheimex und dessen 24h-Notnagel.
  DEX_PROTOCOLS.forEach((p, i) => {
    const r = roh[DEX_PROTOCOLS.length + 5 + i];
    if (r && r.status === 'fulfilled' && r.value) llamaFees[p.key] = r.value;
    const r2 = roh[DEX_PROTOCOLS.length + 5 + DEX_PROTOCOLS.length + i];
    if (r2 && r2.status === 'fulfilled' && r2.value) llamaSupply[p.key] = r2.value;
  });

  if (midgardReihe && midgardReihe.length) reihen['thorchain'] = midgardReihe.slice().sort((a, b) => a.day < b.day ? -1 : 1);
  else fehler['thorchain'] = 'MIDGARD_NO_DATA';

  // ZUERST die vollstaendige Tagesreihe von vanaheimex (Quelle der Balken auf thorchain.net):
  // ein echter, ganzer Tageswert ist verlaesslicher als zusammengezaehlte Stunden. Erst was
  // dort fehlt, wird anschliessend aus Midgards Stundenwerten gebildet.
  const thorVanaTage = [];
  if (reihen['thorchain'] && vanaheimexTage && vanaheimexTage.size) {
    reihen['thorchain'] = reihen['thorchain'].map((eintrag) => {
      if (eintrag.volume != null) return eintrag;
      const wert = vanaheimexTage.get(eintrag.day);
      if (!wert || !(wert.volumen > 0)) return eintrag;
      thorVanaTage.push(eintrag.day);
      return { day: eintrag.day, volume: wert.volumen, quelle: 'vanaheimex-tag' };
    });
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
  const stichtag = letzteTage.length ? letzteTage.sort()[0] : null;
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
    ? Object.entries(letzterTagJe).filter(([, d]) => d === stichtag).map(([k]) => k)
    : [];

  const ALLE = [{ key: 'thorchain', name: 'THORChain', source: 'midgard' },
    ...DEX_PROTOCOLS.map((p) => ({ key: p.key, name: p.name, source: 'defillama' }))];
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
      quelleProblem: luecken ? (p.source === 'midgard' ? 'midgard' : p.source) : null,
      tageOhneWert: luecken ? { d1: d1.ohneWert, d7: d7.ohneWert, d30: d30.ohneWert } : null,
      
      series: reihe.filter((e) => e.day <= stichtag).slice(-30),
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
  if (midgardFees && midgardFees.length) feeReihen['thorchain'] = midgardFees;
  // Fehlende Gebuehrentage aus derselben vanaheimex-Reihe (totalFees * Tageskurs), damit die
  // Spalte "Fees earned" nicht leer bleibt, waehrend Liquifys Tagesaggregation haengt.
  const thorGebuehrenTage = [];
  if (feeReihen['thorchain'] && vanaheimexTage && vanaheimexTage.size) {
    feeReihen['thorchain'] = feeReihen['thorchain'].map((eintrag) => {
      if (eintrag.volume != null) return eintrag;
      const wert = vanaheimexTage.get(eintrag.day);
      if (!wert || !(wert.gebuehren > 0)) return eintrag;
      thorGebuehrenTage.push(eintrag.day);
      return { day: eintrag.day, volume: wert.gebuehren, quelle: 'vanaheimex-tag' };
    });
  }
  for (const p of DEX_PROTOCOLS) {
    const supply = alsReihe(llamaSupply[p.key]);
    if (supply) feeReihen[p.key] = supply;
    const alles = alsReihe(llamaFees[p.key]);
    if (alles) feeAllReihen[p.key] = alles;
  }
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
      p.feeBasis = p.key === 'thorchain' ? 'midgard-liquidityFees' : 'defillama-supplySide';
    } else { p.fees = null; p.feeBasis = null; }
    
    const alles = feeAllReihen[p.key];
    if (alles && alles.length && stichtag) {
      const a1 = summiereTage(alles, 1, stichtag), a7 = summiereTage(alles, 7, stichtag), a30 = summiereTage(alles, 30, stichtag);
      p.feesAll = { d1: a1.summe, d7: a7.summe, d30: a30.summe };
    } else p.feesAll = null;
    if (!p.fees) continue;
  }

  return {
    asOfDay: stichtag,
    // Liegt bei mindestens einer Quelle schon ein spaeterer Tag vor, steht hier welcher --
    // und welche Quellen ihn noch nicht haben.
    naechsterTag: (neuesterTag && neuesterTag > stichtag) ? neuesterTag : null,
    wartetAuf: nachzuegler,
    sources: { thorchain: 'midgard', chainflip: 'defillama', 'near-intents': 'defillama' },
    // Tage, deren Wert aus den Stundenwerten stammt, weil die Tagesreihe leer war.
    thorchainStundenTage: thorStundenTage,
    // Tage, die aus der Tagesreihe von vanaheimex stammen.
    thorchainVanaheimexTage: thorVanaTage,
    // Gebuehrentage, die aus der vanaheimex-Reihe stammen.
    thorchainGebuehrenTage: thorGebuehrenTage,
    // Tag, der notfalls mit dem rollierenden 24h-Wert von vanaheimex gefuellt wurde.
    thorchainNotfallQuelle: thorNotfall ? { tag: thorNotfall, quelle: 'vanaheimex-24h' } : null,
    
    thorNodePoolSplit: midgardSplitRoh,
    protocols: protokolle,
    fetchedAt: Date.now(),
  };
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

async function handleDexVolume(request, env, ctx) {
  try {
    const daten = await baueDexVergleichCached();
    const brauchbar = daten.protocols.some((p) => p.d1 != null);
    if (brauchbar) {
      const schreiben = env.DB.prepare(
        `INSERT INTO dex_volume_cache (id, payload, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).bind(JSON.stringify(daten), Date.now()).run().catch((e) => {
        console.warn('[rune-rewards-backend] dex_volume_cache-Schreiben fehlgeschlagen (Migration ausgeführt?):', e?.message || String(e));
      });
      if (ctx && ctx.waitUntil) ctx.waitUntil(schreiben); else await schreiben;
      return json({ ...daten, stale: false }, env);
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
  };
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
  // Quellcode (github.com/familiarcow/thorchain-memoless-api). Wer nur "maxim" im Memo will,
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

async function runRefreshCycle(env) {
  await refreshChurnsCache(env);
  await collectSwapPairStats(env);
  await syncNodeHistory(env);
  await waermeTimeline(env);

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
