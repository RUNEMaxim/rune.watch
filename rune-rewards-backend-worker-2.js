// ============================================================================
// rune-rewards-backend — GEBÜNDELTE Version für den Cloudflare-Dashboard-Editor
// FIX 1: Poisoned-Zero-Check entfernt
// FIX 2: Sofort-Refresh bei jedem Abruf statt nur alle 5 Min. per Cron
// FIX 3: Refresh-Cooldown 3s
// FIX 4: /balance-Endpunkt - Balance+Bonded laufen server-seitig (kein CORS-Problem mehr)
// FIX 5: Dedizierter Liquify-Endpunkt (eigener API-Key) als bevorzugte THORNode-Quelle -- der
//        öffentliche, geteilte Gateway (viele anonyme Nutzer, evtl. mit internem Lastausgleich
//        über mehrere, nicht immer synchrone Instanzen) bleibt als Fallback.
// ============================================================================

const THORNODE_BASES = [
  'https://gateway.liquify.com/api=THORCHAIN_API87Q7KFF7BTVUWRKT',
  'https://gateway.liquify.com/chain/thorchain_api',
];

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
  const promise = fetchFromBases(THORNODE_BASES, '/thorchain/nodes');
  nodesCache = { promise, atMs: Date.now() };
  return promise;
}

function fetchNodeAtHeight(nodeAddress, height) {
  return fetchFromBases(THORNODE_BASES, `/thorchain/node/${nodeAddress}?height=${height}`);
}

function fetchChurns() {
  return fetchFromBases(MIDGARD_BASES, '/churns');
}

function fetchBalance(address) {
  return fetchFromBases(THORNODE_BASES, `/cosmos/bank/v1beta1/balances/${address}`);
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

async function handleBalance(request, env) {
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

  return json({
    address,
    balance,
    balanceError,
    bonded,
    totalActiveBondBase,
    accruedAward,
    matchedNodeAddresses,
    nodeBreakdown,
    nodesError,
  }, env);
}

// ----------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }
    const url = new URL(request.url);
    if (url.pathname === '/bond-history') {
      return handleBondHistory(request, env, ctx);
    }
    if (url.pathname === '/balance') {
      return handleBalance(request, env);
    }
    return json({ error: 'NOT_FOUND' }, env, 404);
  },

  async scheduled(event, env, ctx) {
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
