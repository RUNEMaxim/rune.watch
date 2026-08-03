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

async function fetchFromBases(bases, path, options = {}) {
  let lastError = null;
  for (const base of bases) {
    try {
      const res = await fetchWithTimeout(`${base}${path}`, {
        headers: { 'x-client-id': 'rune-rewards-backend', ...(options.headers || {}) },
        ...options,
      });
      if (!res.ok) {
        lastError = new Error(`HTTP_${res.status} (${base})`);
        continue;
      }
      return await res.json();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('ALL_BASES_FAILED');
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
  let lastError = null;
  for (const base of MIDGARD_BASES) {
    const url = `${base}/actions?address=${address}&type=${txType}&limit=50&offset=${offset}`;
    try {
      const res = await fetchWithTimeout(url, {
        headers: { 'x-client-id': 'rune-rewards-backend' },
      });
      if (!res.ok) {
        lastError = new Error(`HTTP_${res.status} (${base})`);
        continue;
      }
      return await res.json();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('ALL_BASES_FAILED');
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

  for (let page = 0; page < MAX_PAGES_PER_TYPE; page++) {
    const body = await fetchMidgardActionsPage(address, txType, offset);
    const actions = body?.actions || [];
    if (actions.length === 0) break;

    for (const a of actions) {
      if (a.type !== txType) continue;
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
    }

    if (actions.length < 50) break;
    offset += 50;
  }

  return { totalBase, earliestDateMs, found: matchedAny, nodeAddresses: [...nodeAddresses] };
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
    };
  } catch (e) {
    return { success: false, errorDetail: e?.message || String(e) };
  }
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
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
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

  const entries = (rows.results || []).map((r) => ({
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
// NEU: Kaufliste (Ø-Kaufpreis-Feature) geräteübergreifend speichern/laden, verknüpft mit der
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

async function handlePurchases(request, env, ctx) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address');
  if (!isValidThorAddress(address)) {
    return json({ error: 'INVALID_ADDRESS' }, env, 400);
  }

  if (request.method === 'GET') {
    const row = await env.DB
      .prepare('SELECT data, updated_at FROM user_purchases WHERE address = ?')
      .bind(address)
      .first();
    let purchases = [];
    if (row && row.data) {
      try { purchases = JSON.parse(row.data); } catch (e) { purchases = []; }
    }
    const deletedRows = await env.DB
      .prepare('SELECT deleted_id FROM user_purchases_deleted WHERE address = ?')
      .bind(address)
      .all();
    const deletedIds = new Set((deletedRows.results || []).map((r) => r.deleted_id));
    // Defensiv nochmal gegen die Tombstone-Liste filtern (falls ein alter Stand vor Einführung
    // dieser Tabelle noch tombstonete IDs enthält).
    if (deletedIds.size) purchases = purchases.filter((p) => !p.id || !deletedIds.has(p.id));
    return json({ address, purchases, updatedAt: row ? row.updated_at : null }, env);
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
      .prepare('SELECT data FROM user_purchases WHERE address = ?')
      .bind(address)
      .first();
    let existing = [];
    if (existingRow && existingRow.data) {
      try { existing = JSON.parse(existingRow.data); } catch (e) { existing = []; }
    }

    const isSameEntry = (a, b) =>
      Math.abs((a.date || 0) - (b.date || 0)) < 60000 &&
      Math.abs((a.amount || 0) - (b.amount || 0)) < 0.0001 &&
      Math.abs((a.priceUsd || 0) - (b.priceUsd || 0)) < 0.0001 &&
      (a.type || 'buy') === (b.type || 'buy');

    const merged = [...existing];
    for (const row of incoming) {
      if (!row || !Number.isFinite(row.amount) || !Number.isFinite(row.priceUsd)) continue;
      if (row.id && deletedIds.has(row.id)) continue; // bewusst gelöscht -- nicht wieder aufnehmen
      const alreadyThere = merged.some((p) => (p.id && row.id && p.id === row.id) || isSameEntry(p, row));
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
        `INSERT INTO user_purchases (address, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .bind(address, serialized, now)
      .run();
    return json({ address, updatedAt: now, purchases: finalList }, env);
  }

  return json({ error: 'METHOD_NOT_ALLOWED' }, env, 405);
}

// ----------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    currentEnv = env;
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }
    const url = new URL(request.url);
    if (url.pathname === '/bond-history') {
      return handleBondHistory(request, env, ctx);
    }
    if (url.pathname === '/balance') {
      return handleBalance(request, env, ctx);
    }
    if (url.pathname === '/purchases') {
      return handlePurchases(request, env, ctx);
    }
    return json({ error: 'NOT_FOUND' }, env, 404);
  },

  async scheduled(event, env, ctx) {
    currentEnv = env;
    ctx.waitUntil(runRefreshCycle(env));
  },
};

async function runRefreshCycle(env) {
  await refreshChurnsCache(env);

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
      try {
        const nodeResults = await Promise.all(
          nodeAddresses.map((nodeAddr) => fetchNodeAtHeight(nodeAddr, queryHeight))
        );
        rewardAmount = nodeResults.reduce((sum, node) => sum + computeAddressAwardFromNode(node, address), 0);
      } catch (e) {
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
