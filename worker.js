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
  // Auch fuer Abfragen MIT Blockhoehe die anderen Knoten als Rueckfall (gemeldet: Slash-Check
  // "HTTP_500 (gateway.liquify.com)" -- Liquify war die einzige Quelle; fiel sie aus, ging nichts).
  // Die Rueckfall-Knoten halten nicht unbedingt alte Staende vor, fuer die letzten Tage aber meist schon.
  bases.push('https://public-thornode.nativeswap.io');
  bases.push('https://thornode.thorchain.network');
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

// GUTHABEN AUF ANDEREN CHAINS (gewuenscht: "darstellen, wie viel BTC etc. auf der Wallet ist").
// Die App schickt die selbst eingetragenen BTC- und ETH-Adressen; der Worker fragt oeffentliche
// Schnittstellen ab, damit deren Betreiber die IP-Adresse der Nutzer NICHT sehen (nur die Adresse).
//   BTC: mempool.space (Rueckfall blockstream.info) -- bestaetigt + unbestaetigt, in BTC
//   ETH: oeffentliche RPC-Knoten -- natives ETH sowie USDC und USDT (balanceOf)
// Hoechstens 12 Adressen je Aufruf, Zwischenspeicher 60 s je Adresse.
const KETTEN_CACHE = new Map();
// Mehrere oeffentliche Knoten; manche lehnen Anfragen aus Rechenzentren (Cloudflare) ab oder sind
// zeitweise weg -- deshalb eine laengere Liste und als letzte Rueckfallebene Blockscout (siehe unten).
const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://eth.llamarpc.com', 'https://rpc.mevblocker.io', 'https://cloudflare-eth.com'];
const ETH_TOKENS = [
  { sym: 'USDC', contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', dec: 6, asset: 'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48' },
  { sym: 'USDT', contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', dec: 6, asset: 'ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7' },
];
const istBtcAdresse = (a) => /^(bc1[a-z0-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(a);
const istEthAdresse = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
async function btcGuthaben(adr) {
  for (const basis of ['https://mempool.space/api', 'https://blockstream.info/api']) {
    try {
      const r = await fetchWithTimeout(`${basis}/address/${adr}`, { timeoutMs: 8000 });
      if (!r.ok) continue;
      const j = await r.json();
      const c = j.chain_stats || {}, m = j.mempool_stats || {};
      const sats = (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0) + (m.funded_txo_sum || 0) - (m.spent_txo_sum || 0);
      return [{ asset: 'BTC.BTC', sym: 'BTC', menge: Math.max(0, sats) / 1e8 }];
    } catch (e) { /* naechste Quelle */ }
  }
  throw new Error('BTC_NICHT_ERREICHBAR');
}
let ETH_RPC_GUT = null; // zuletzt funktionierender Knoten zuerst
async function ethRpc(methode, params, spur) {
  const reihe = ETH_RPC_GUT ? [ETH_RPC_GUT, ...ETH_RPCS.filter((x) => x !== ETH_RPC_GUT)] : ETH_RPCS;
  for (const rpc of reihe) {
    try {
      const r = await fetchWithTimeout(rpc, { timeoutMs: 6000, method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'rune.watch/1.0 (+https://runewatch.org)' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: methode, params }) });
      if (!r.ok) { if (spur) spur.push(rpc + ' HTTP_' + r.status); continue; }
      const j = await r.json();
      if (j && typeof j.result === 'string') { ETH_RPC_GUT = rpc; return j.result; }
      if (spur) spur.push(rpc + ' ' + JSON.stringify(j && j.error || j).slice(0, 80));
    } catch (e) { if (spur) spur.push(rpc + ' ' + String(e && e.message || e).slice(0, 60)); }
  }
  const f = new Error('ETH_NICHT_ERREICHBAR'); f.spur = spur; throw f;
}
// RUECKFALL: Blockscout (oeffentlicher Explorer, ohne Schluessel) -- ETH und Token in einem Abruf.
async function ethUeberBlockscout(adr) {
  const r = await fetchWithTimeout(`https://eth.blockscout.com/api/v2/addresses/${adr}`, { timeoutMs: 8000, headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('BLOCKSCOUT_HTTP_' + r.status);
  const j = await r.json();
  const out = [{ asset: 'ETH.ETH', sym: 'ETH', menge: hexZuZahl('0x' + BigInt(j.coin_balance || '0').toString(16), 18) }];
  try {
    const t = await fetchWithTimeout(`https://eth.blockscout.com/api/v2/addresses/${adr}/token-balances`, { timeoutMs: 8000, headers: { accept: 'application/json' } });
    const liste = t.ok ? await t.json() : [];
    for (const tok of ETH_TOKENS) {
      const e = (Array.isArray(liste) ? liste : []).find((x) => x && x.token && String(x.token.address || x.token.address_hash || '').toLowerCase() === tok.contract);
      if (e && e.value) { const v = hexZuZahl('0x' + BigInt(e.value).toString(16), tok.dec); if (v > 0) out.push({ asset: tok.asset, sym: tok.sym, menge: v }); }
    }
  } catch (e) { /* Token auslassen */ }
  return out;
}
const hexZuZahl = (hex, dec) => { try { const v = BigInt(hex === '0x' ? '0x0' : hex); const teiler = 10n ** BigInt(dec); return Number(v / teiler) + Number(v % teiler) / Number(teiler); } catch (e) { return 0; } };
async function ethGuthaben(adr) {
  const a = adr.toLowerCase();
  const spur = [];
  let nativ;
  try { nativ = hexZuZahl(await ethRpc('eth_getBalance', [a, 'latest'], spur), 18); }
  catch (e) {
    try { return await ethUeberBlockscout(a); }
    catch (e2) { const f = new Error('ETH_NICHT_ERREICHBAR'); f.spur = [...spur, String(e2 && e2.message || e2)]; throw f; }
  }
  const out = [{ asset: 'ETH.ETH', sym: 'ETH', menge: nativ }];
  for (const t of ETH_TOKENS) {
    try {
      const data = '0x70a08231' + a.slice(2).padStart(64, '0');
      const v = hexZuZahl(await ethRpc('eth_call', [{ to: t.contract, data }, 'latest']), t.dec);
      if (v > 0) out.push({ asset: t.asset, sym: t.sym, menge: v });
    } catch (e) { /* Token auslassen */ }
  }
  return out;
}
// BONDER IM NETZ (gemeldet: Zahl in der Cockpit-Karte wich von der Statistikseite ab): dieselbe Zaehlung wie
// dort -- verschiedene Bond-Provider-Adressen ueber ALLE Nodes der Node-Liste. 10 Min. Zwischenspeicher.
let BONDER_CACHE = { at: 0, v: null };
async function handleBonderZahl(request, env) {
  if (BONDER_CACHE.v && Date.now() - BONDER_CACHE.at < 600000) return json(BONDER_CACHE.v, env);
  const nodes = await fetchFromBases(getThornodeBases(), '/thorchain/nodes').catch(() => null);
  if (!Array.isArray(nodes)) return json(BONDER_CACHE.v || { bonder: null }, env, BONDER_CACHE.v ? 200 : 502);
  const set = new Set();
  for (const n of nodes) for (const pr of ((n.bond_providers && n.bond_providers.providers) || [])) {
    const a = String(pr.bond_address || '').toLowerCase(); if (a) set.add(a);
  }
  const v = { bonder: set.size, at: Date.now() };
  BONDER_CACHE = { at: Date.now(), v };
  return json(v, env);
}

// KURZLINK ZU EINER NODE (gewuenscht: "den Link schoener machen"): runewatch.org/n/<name-oder-adressende>
// leitet auf die RUNEBond-Profilseite der Node weiter -- mit unserer Empfehlungs-Kennung, die im geteilten
// Link selbst nicht mehr zu sehen ist. Name z. B. "the-runecrafter", sonst die letzten Zeichen der Adresse.
const rwSlug = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
async function handleNodeKurzlink(request, env, ctx) {
  const url = new URL(request.url);
  const slug = rwSlug(decodeURIComponent(url.pathname.slice(3)));
  let liste = [];
  try {
    const r = await handleRunebondNodes(new Request(new URL('/runebond-nodes', url).toString()), env, ctx);
    const j = await r.json();
    liste = Array.isArray(j && j.listings) ? j.listings : (Array.isArray(j && j.nodes) ? j.nodes : []);
  } catch (e) {}
  const treffer = slug ? (liste.find((n) => n && n.name && rwSlug(n.name) === slug)
    || liste.find((n) => n && n.addr && String(n.addr).toLowerCase().endsWith(slug))) : null;
  let affiliate = String(env.RUNEBOND_AFFILIATE || '').split(',').map((x) => x.trim()).filter((x) => /^thor1/.test(x))[0] || '';
  if (!affiliate) {
    try {
      const tn = await fetchFromBases(getThornodeBases(), '/thorchain/thorname/runewatch');
      const al = tn && Array.isArray(tn.aliases) ? tn.aliases.find((x) => String(x.chain).toUpperCase() === 'THOR') : null;
      if (al && al.address) affiliate = al.address;
    } catch (e) {}
  }
  const ziel = new URL(treffer ? (treffer.profileUrl || `https://app.runebond.com/nodes/${treffer.addr}`) : 'https://app.runebond.com/');
  if (affiliate) { ziel.searchParams.set('ref', affiliate); ziel.searchParams.set('affiliate', affiliate); }
  ziel.searchParams.set('utm_source', 'rune.watch');
  ziel.searchParams.set('utm_medium', 'share');
  // als Klick zaehlen (Quelle "geteilter Link")
  try {
    const now = Date.now();
    const p = env.DB.prepare('INSERT INTO outbound_clicks (target, token, day, at, quelle) VALUES (?, ?, ?, ?, ?)').bind('runebond', 'kurzlink', utcDayString(now), now, 'geteilt').run().catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  } catch (e) {}
  return new Response(null, { status: 302, headers: { Location: ziel.toString(), 'Cache-Control': 'no-store' } });
}

// JAHRES-APY FUER DIE WILLKOMMENS-KARTE (gewuenscht: "meine Jahres-APY aus der App, fuer jeden neuen
// Besucher sichtbar"): Die App des Betreibers schickt ihre 12-Monats-APY (Durchschnitt der Churn-APYs)
// hierher; jeder Besucher liest sie. Angenommen wird sie nur fuer eine Betreiber-Adresse (dieselbe Liste
// wie STATS_EXCLUDED_ADDRESSES) und nur in einem plausiblen Bereich (1-60 %).
async function handleRwApy(request, env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS rw_einstellungen (k TEXT PRIMARY KEY, v TEXT, at INTEGER)').run();
  if (request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) { return json({ error: 'INVALID_BODY' }, env, 400); }
    const adr = String(b.address || '').trim().toLowerCase();
    const apy = Number(b.apy);
    if (!adr || !getStatsExcludedAddresses(env).has(adr)) return json({ error: 'FORBIDDEN' }, env, 403);
    if (!(apy >= 0.01 && apy <= 0.6)) return json({ error: 'IMPLAUSIBLE' }, env, 400);
    await env.DB.prepare('INSERT INTO rw_einstellungen (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
      .bind('jahres_apy', String(apy), Date.now()).run();
    return json({ ok: true }, env);
  }
  const row = await env.DB.prepare('SELECT v, at FROM rw_einstellungen WHERE k = ?').bind('jahres_apy').first().catch(() => null);
  return json({ apy: row ? Number(row.v) : null, at: row ? row.at : null }, env);
}

// MIDGARD UEBER DEN WORKER (gewuenscht, Option 1): Die App fragte Midgard bisher direkt aus dem Browser
// ab -- ohne Liquify-Schluessel (oefter Drosselung/Verzoegerung) und mit der IP der Nutzer. Jetzt geht die
// Swap-Suche ueber /mg/actions: der Worker nutzt die Schluessel-Instanz zuerst, Zwischenspeicher 30 s.
// Nur /actions mit den Parametern, die die App braucht.
const MG_CACHE = new Map();
let MG_PAUSE_BIS = 0; // nach 429 kurz Ruhe, statt Midgard weiter zu bedraengen
async function handleMidgardActions(request, env) {
  const url = new URL(request.url);
  const erlaubt = ['address', 'type', 'txType', 'limit', 'offset', 'affiliate', 'txid'];
  const q = new URLSearchParams();
  for (const k of erlaubt) { const v = url.searchParams.get(k); if (v != null && v !== '') q.set(k, String(v).slice(0, 120)); }
  if (!q.get('address') && !q.get('txid') && !q.get('affiliate')) return json({ error: 'MISSING_FILTER' }, env, 400);
  const lim = Math.min(50, Math.max(1, Number(q.get('limit')) || 50)); q.set('limit', String(lim));
  const schl = q.toString();
  const c = MG_CACHE.get(schl);
  if (c && Date.now() - c.at < 90000) return json(c.v, env);
  if (Date.now() < MG_PAUSE_BIS) return json(c ? c.v : { error: 'MIDGARD_UNAVAILABLE', detail: 'HTTP_429' }, env, c ? 200 : 503);
  let letzter = null;
  for (const basis of getMidgardBases()) {
    try {
      const r = await fetchWithTimeout(`${basis}/actions?${schl}`, { timeoutMs: 10000, headers: { 'x-client-id': 'rune-watch' } });
      if (!r.ok) { letzter = 'HTTP_' + r.status; if (r.status === 429) MG_PAUSE_BIS = Date.now() + 60000; continue; }
      const v = await r.json();
      MG_CACHE.set(schl, { at: Date.now(), v });
      if (MG_CACHE.size > 500) MG_CACHE.clear();
      return json(v, env);
    } catch (e) { letzter = String(e && e.message || e); }
  }
  return json({ error: 'MIDGARD_UNAVAILABLE', detail: letzter }, env, 502);
}

// SWAP PER TRANSAKTIONS-ID (gewuenscht, Option 2): direkt bei THORNode, ganz ohne Midgard -- dieselbe
// Quelle wie RuneScan. Liefert Eingang (Muenze, Menge, Absender), RUNE-Ausgaenge (an wen, wie viel),
// Block und Zeit.
const THOR_TX_CACHE = new Map(); // fertige Transaktionen aendern sich nicht mehr -> 6 Std. merken
async function handleThorTx(request, env) {
  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '').trim().toUpperCase().replace(/^0X/, '');
  if (!/^[0-9A-F]{64}$/.test(id)) return json({ error: 'INVALID_TX' }, env, 400);
  const c = THOR_TX_CACHE.get(id);
  if (c && Date.now() - c.at < 6 * 3600e3) return json(c.v, env);
  let d;
  try { d = await fetchFromBases(getThornodeBases(), `/thorchain/tx/details/${id}`); }
  catch (e) { return json({ error: 'THORNODE_UNAVAILABLE' }, env, 502); }
  const tx = (d && d.tx && d.tx.tx) || (d && Array.isArray(d.txs) && d.txs[0] && d.txs[0].tx) || {};
  const ein = (tx.coins || [])[0] || {};
  const outs = Array.isArray(d && d.out_txs) ? d.out_txs : [];
  const rune = outs.flatMap((o) => (o.coins || []).filter((c) => c.asset === 'THOR.RUNE').map((c) => ({ an: o.to_address, menge: Number(c.amount) / 1e8 })));
  const hoehe = Number(d && (d.finalised_height || d.consensus_height)) || null;
  let zeit = null;
  if (hoehe) {
    try {
      const b = await fetchFromBases(getThornodeBases(), `/cosmos/base/tendermint/v1beta1/blocks/${hoehe}`);
      const t = b && b.block && b.block.header && b.block.header.time;
      if (t) zeit = Date.parse(t);
    } catch (e) { /* Zeit fehlt dann */ }
  }
  const v = {
    id, von: ein.asset || null, menge: Number(ein.amount) / 1e8 || null, absender: tx.from_address || null,
    memo: tx.memo || null, rune, hoehe, zeit, fertig: outs.length > 0,
  };
  if (v.fertig) { THOR_TX_CACHE.set(id, { at: Date.now(), v }); if (THOR_TX_CACHE.size > 3000) THOR_TX_CACHE.clear(); }
  return json(v, env);
}

// ALLE SWAPS UEBER RUNE.WATCH (gewuenscht: "Swaps aller Nutzer sofort erkennen, das sieht man doch
// on-chain"): Jeder Swap ueber rune.watch traegt die Kennung "runewatch" im Memo (Affiliate, 0 bps).
// Midgard filtert danach (/actions?affiliate=runewatch). Der Worker fragt das hoechstens alle 45 s ab
// und liefert eine schlanke Liste -- ohne Adressen: Paar, Mengen, Zeit, Status, Eingangs-Transaktion
// (damit die App eigene Swaps erkennen kann).
const RW_AFFILIATE = 'runewatch';
let RW_SWAPS_CACHE = { at: 0, v: null };
async function handleRwSwaps(request, env) {
  // Altbestand der frueheren Swap-Historie auch hier einmal loeschen (falls /swap-history nie aufgerufen wird)
  if (!swapHistorieGeleert) {
    swapHistorieGeleert = true;
    try { await env.DB.prepare('DELETE FROM user_swap_history').run(); } catch (e) {}
  }
  // 3 Min. Zwischenspeicher; nach "429" (gedrosselt) 2 Min. Pause -- solange der letzte Stand (gemeldet: 429)
  if (RW_SWAPS_CACHE.v && Date.now() - RW_SWAPS_CACHE.at < 180000) return json(RW_SWAPS_CACHE.v, env);
  if (Date.now() < (RW_SWAPS_CACHE.pauseBis || 0)) return json(RW_SWAPS_CACHE.v || { swaps: [], fehler: 'HTTP_429', pause: true }, env);
  let actions = null, fehler = null;
  // RuneScan findet die Swaps ueber die Kennung (Screenshot: "runewatch uws"). Mehrere Abfrage-Varianten, die
  // erste mit Ergebnis gilt: mit/ohne Typ-Filter, Name und THOR-Adresse des THORNames.
  const varianten = [`affiliate=${RW_AFFILIATE}&type=swap`, `affiliate=${RW_AFFILIATE}`];
  try {
    const tn = await fetchFromBases(getThornodeBases(), '/thorchain/thorname/' + RW_AFFILIATE);
    const al = tn && Array.isArray(tn.aliases) ? tn.aliases.find((x) => String(x.chain).toUpperCase() === 'THOR') : null;
    if (al && al.address) varianten.push(`affiliate=${al.address}`);
  } catch (e) {}
  suche: for (const q of varianten) {
    for (const basis of getMidgardBases()) {
      try {
        const r = await fetchWithTimeout(`${basis}/actions?${q}&limit=50`, { timeoutMs: 9000, headers: { 'x-client-id': 'rune-watch' } });
        if (!r.ok) { fehler = 'HTTP_' + r.status; if (r.status === 429) RW_SWAPS_CACHE.pauseBis = Date.now() + 120000; continue; }
        const j = await r.json();
        const liste = Array.isArray(j && j.actions) ? j.actions.filter((a) => a && (a.type === 'swap' || !a.type)) : null;
        if (liste && liste.length) { actions = liste; break suche; }
        if (liste && !actions) actions = [];
      } catch (e) { fehler = String(e && e.message || e); }
    }
  }
  const ausDb = []; // (keine gespeicherten Swaps mehr -- nur oeffentliche Blockchain-Daten)
  if (!actions) return json(RW_SWAPS_CACHE.v || { swaps: [], fehler }, env, 200);
  actions = actions || [];
  const ohneAff = (g) => (Array.isArray(g) ? g : []).filter((x) => x && !x.affiliate);
  const swaps = actions.map((a) => {
    const ein = ohneAff(a.in)[0] || (a.in || [])[0] || {};
    const raus = ohneAff(a.out).flatMap((g) => g.coins || []);
    const e = (ein.coins || [])[0] || {};
    // Ausgang: das, was NICHT die Eingangs-Muenze ist (bei Erstattungen gleich der Eingang)
    // GROESSTE Ausgabe (gemeldet: "0.1962 ETH -> 0.0697 RUNE"): Kleinstbetraege wie Gebuehren-Anteile an
    // andere Adressen standen vorn und wurden als Ergebnis genommen.
    // Groesster Ausgang UEBER ALLE Ausgaenge, auch die als Affiliate markierten (gemeldet: wieder 0.0697 -- das ist die
    // Gebuehr an den Memoless-Dienst "uws"; Midgard markiert die Ausgaenge nicht verlaesslich). Die Gebuehr ist stets winzig
    // gegen den eigentlichen Erhalt, der groesste Ausgang ist also immer der Erhalt.
    const alleRaus = (Array.isArray(a.out) ? a.out : []).flatMap((g) => (g && g.coins) || []);
    const o = alleRaus.filter((c) => c.asset !== e.asset).sort((x, y) => Number(y.amount) - Number(x.amount))[0] || raus[0] || {};
    return {
      tx: ein.txID || null,
      von: e.asset || null, menge: Number(e.amount) / 1e8 || null,
      nach: o.asset || null, erhalten: Number(o.amount) / 1e8 || null,
      zeit: a.date ? Math.floor(Number(a.date) / 1e6) : null,
      status: a.status || null,
    };
  }).filter((x) => x.tx && x.zeit);
  // zusammenfuehren: gleiche Eingangs-Transaktion = derselbe Swap; groesste erhaltene Menge gewinnt
  const nachTx = new Map();
  for (const x of [...swaps, ...ausDb]) {
    if (!x.tx || !x.zeit) continue;
    const k = String(x.tx).toLowerCase();
    const a = nachTx.get(k);
    if (!a) { nachTx.set(k, { ...x }); continue; }
    a.von = a.von || x.von; a.nach = a.nach || x.nach; a.menge = a.menge || x.menge;
    a.erhalten = Math.max(a.erhalten || 0, x.erhalten || 0) || null;
  }
  const alleSwaps = [...nachTx.values()].sort((a, b) => b.zeit - a.zeit).slice(0, 40);
  const v = { swaps: alleSwaps, at: Date.now() };
  RW_SWAPS_CACHE = { at: Date.now(), v, pauseBis: 0 };
  return json(v, env);
}

// EINGETRAGENE BTC-/ETH-ADRESSEN GERAETEUEBERGREIFEND (wie Wallets/Kaeufe am ersten thor1-Wallet
// verankert). Ganze Liste, die neuere gewinnt (Zeitstempel des Geraets).
async function handleChainAddrs(request, env, ctx) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address');
  if (!isValidThorAddress(address)) return json({ error: 'INVALID_ADDRESS' }, env, 400);
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS user_chain_addrs (address TEXT PRIMARY KEY, data TEXT, updated_at INTEGER)').run();
  const row = await env.DB.prepare('SELECT data, updated_at FROM user_chain_addrs WHERE address = ?').bind(address).first();
  if (request.method === 'GET') {
    let liste = []; try { liste = row && row.data ? JSON.parse(row.data) : []; } catch (e) { liste = []; }
    return json({ adressen: liste, updatedAt: row ? row.updated_at : 0 }, env);
  }
  if (request.method === 'POST') {
    let body = {}; try { body = await request.json(); } catch (e) { return json({ error: 'INVALID_BODY' }, env, 400); }
    const liste = (Array.isArray(body.adressen) ? body.adressen : []).map((a) => String(a || '').trim())
      .filter((a) => istBtcAdresse(a) || istEthAdresse(a)).slice(0, 12);
    const zeit = Number(body.updatedAt) || Date.now();
    if (row && Number(row.updated_at) > zeit) return json({ adressen: JSON.parse(row.data || '[]'), updatedAt: row.updated_at, veraltet: true }, env);
    await env.DB.prepare('INSERT INTO user_chain_addrs (address, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .bind(address, JSON.stringify(liste), zeit).run();
    return json({ adressen: liste, updatedAt: zeit }, env);
  }
  return json({ error: 'METHOD_NOT_ALLOWED' }, env, 405);
}
// NETZWERKGEBUEHR FUERS EINZAHLEN (gefragt: "kann man sagen, wie viel ETH- bzw. BTC-Gebuehren man zahlt?"):
// THORChain nennt je Chain einen empfohlenen Gebuehrensatz (inbound_addresses: gas_rate, BTC in sat/vByte,
// ETH in gwei). Geschaetzt wird eine einfache Ueberweisung an die Einzahlungsadresse:
//   BTC: Satz x typische Groesse je Adressart (bc1q 150, bc1p 160, 3... 175, 1... 230 vByte)
//   ETH: Satz x 21.000 Gas (normale ETH-Ueberweisung)
// GENAUER (THORChains Satz ist bewusst grosszuegig gepolstert, $0,67 statt real ~$0,05): zuerst der
// aktuelle Marktsatz -- BTC: mempool.space "halbe Stunde", ETH: eth_gasPrice +20 % --, THORChains
// Satz nur als Rueckfall.
let INBOUND_CACHE = { at: 0, v: null };
async function gebuehrSaetze() {
  if (INBOUND_CACHE.v && Date.now() - INBOUND_CACHE.at < 120000) return INBOUND_CACHE.v;
  const v = {};
  try {
    const ib = await fetchFromBases(getThornodeBases(), '/thorchain/inbound_addresses');
    for (const x of Array.isArray(ib) ? ib : []) if (x && x.chain && Number(x.gas_rate) > 0) v[String(x.chain).toUpperCase()] = Number(x.gas_rate);
  } catch (e) { /* Rueckfall fehlt dann */ }
  try {
    const r = await fetchWithTimeout('https://mempool.space/api/v1/fees/recommended', { timeoutMs: 6000 });
    const j = r.ok ? await r.json() : null;
    if (j && Number(j.halfHourFee) > 0) v.BTC = Number(j.halfHourFee);
  } catch (e) {}
  try {
    const gwei = hexZuZahl(await ethRpc('eth_gasPrice', []), 9);
    if (gwei > 0) v.ETH = Math.max(0.05, gwei * 1.2);
  } catch (e) {}
  INBOUND_CACHE = { at: Date.now(), v };
  return v;
}
function gebuehrFuer(kette, adr, saetze) {
  const r = saetze && saetze[kette];
  if (!(r > 0)) return null;
  if (kette === 'BTC') {
    const vb = /^bc1q/.test(adr) ? 150 : /^bc1p/.test(adr) ? 160 : /^3/.test(adr) ? 175 : 230;
    return { menge: (r * vb) / 1e8, satz: r, einheit: 'sat/vB' };
  }
  if (kette === 'ETH') return { menge: (r * 21000) / 1e9, satz: r, einheit: 'gwei' };
  return null;
}
async function handleChainBalances(request, env) {
  const url = new URL(request.url);
  const liste = String(url.searchParams.get('addrs') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12);
  const ergebnis = [];
  let saetze = null;
  try { saetze = await gebuehrSaetze(); } catch (e) { saetze = null; }
  await Promise.all(liste.map(async (adr) => {
    const kette = istBtcAdresse(adr) ? 'BTC' : istEthAdresse(adr) ? 'ETH' : null;
    if (!kette) { ergebnis.push({ adresse: adr, fehler: 'UNBEKANNTES_FORMAT' }); return; }
    const k = kette + ':' + adr.toLowerCase();
    const c = KETTEN_CACHE.get(k);
    if (c && Date.now() - c.at < 60000) { ergebnis.push({ ...c.v, gebuehr: gebuehrFuer(kette, adr, saetze) }); return; }
    try {
      const guthaben = kette === 'BTC' ? await btcGuthaben(adr) : await ethGuthaben(adr);
      const v = { adresse: adr, kette, guthaben };
      KETTEN_CACHE.set(k, { at: Date.now(), v });
      if (KETTEN_CACHE.size > 2000) KETTEN_CACHE.clear();
      ergebnis.push({ ...v, gebuehr: gebuehrFuer(kette, adr, saetze) });
    } catch (e) { ergebnis.push({ adresse: adr, kette, fehler: String(e && e.message || e), details: e && e.spur ? e.spur.slice(0, 8) : undefined }); }
  }));
  return json({ adressen: ergebnis }, env);
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

async function fetchNodesAtHeight(height) {
  // Einzelne Hoehen liefern bei Liquify gelegentlich HTTP 500 -- dann die direkt folgenden Bloecke
  // versuchen (ein paar Sekunden Unterschied aendern beim Bond nichts).
  let letzter = null;
  for (const h of [height, height + 1, height + 5]) {
    try {
      const r = await fetchFromBases(getThornodeBases({ needsHeight: true }), `/thorchain/nodes?height=${h}`);
      if (Array.isArray(r) && r.length) return r;
    } catch (e) { letzter = e; }
  }
  throw letzter || new Error('NODES_AT_HEIGHT_EMPTY');
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
    recordVisitor(env, ctx, request);
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

    // MONATSBASIS NICHT MEHR AUF 0, WENN EIN ABRUF FEHLSCHLAEGT (gemeldet: "Tips this month $0.01,
    // obwohl keine Spende"): Schlug zum Monatswechsel der Abruf einer Waehrung fehl, wurde ihre Basis
    // auf 0 gesetzt -- spaeter zaehlte dann der ganze Restbestand der Adresse als "Spende". Jetzt
    // steht -1 fuer "noch unbekannt" und wird mit dem ersten erfolgreichen Abruf ersetzt.
    const basis = (alt, aktuell) => (alt == null || alt < 0) ? (aktuell ?? -1) : alt;
    const baselineRune = sameMonth ? basis(row.baseline_rune, currentRune) : (currentRune ?? -1);
    const baselineUsdc = sameMonth ? basis(row.baseline_usdc, currentUsdc) : (currentUsdc ?? -1);
    const baselineEth = sameMonth ? basis(row.baseline_eth, currentEth) : (currentEth ?? -1);

    await env.DB.prepare(
      `INSERT INTO donation_tracking (id, month, baseline_rune, baseline_usdc, baseline_eth, last_balance_rune, last_balance_usdc, last_balance_eth, last_eth_usd_price, last_balance_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET month = excluded.month, baseline_rune = excluded.baseline_rune, baseline_usdc = excluded.baseline_usdc, baseline_eth = excluded.baseline_eth, last_balance_rune = excluded.last_balance_rune, last_balance_usdc = excluded.last_balance_usdc, last_balance_eth = excluded.last_balance_eth, last_eth_usd_price = excluded.last_eth_usd_price, last_balance_at = excluded.last_balance_at, updated_at = excluded.updated_at`
    ).bind(month, baselineRune, baselineUsdc, baselineEth, currentRune, currentUsdc, currentEth, ethUsdPrice, Date.now(), Date.now()).run();
  } catch (e) {
    console.warn('[rune-rewards-backend] /donation-progress Hintergrund-Refresh fehlgeschlagen:', e?.message || String(e));
  }
}

// Zuwachs seit Monatsbeginn; unbekannte Basis (-1 bzw. null) zaehlt als "noch kein Zuwachs".
function seitBasis(aktuell, basis) {
  if (aktuell == null || basis == null || basis < 0) return 0;
  return Math.max(0, aktuell - basis);
}

function receivedEthUsdFrom(row) {
  if (row.last_balance_eth == null || row.last_eth_usd_price == null) return 0;
  const receivedEth = seitBasis(row.last_balance_eth, row.baseline_eth);
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
      const receivedRune = seitBasis(row.last_balance_rune, row.baseline_rune);
      const receivedUsdc = seitBasis(row.last_balance_usdc, row.baseline_usdc);
      // receivedEth in ETH (nicht nur in $): Die App erkennt neue Spenden daran -- der $-Wert steigt auch,
      // wenn nur der ETH-Kurs steigt, und loeste dann Konfetti ohne Spende aus.
      const receivedEth = row.last_balance_eth == null ? 0 : seitBasis(row.last_balance_eth, row.baseline_eth);
      return json({ receivedRune, receivedUsdc, receivedEthUsd: receivedEthUsdFrom(row), receivedEth, month: currentMonth }, env);
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
      ).bind(currentMonth, currentRune ?? -1, currentUsdc ?? -1, currentEth ?? -1, currentRune, currentUsdc, currentEth, ethUsdPrice, Date.now(), Date.now()).run();
      return json({ receivedRune: 0, receivedUsdc: 0, receivedEthUsd: 0, receivedEth: 0, month: currentMonth }, env);
    }

    const gleich = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-8);
    const unveraendert = gleich(currentRune, row.last_balance_rune)
      && gleich(currentUsdc, row.last_balance_usdc)
      && gleich(currentEth, row.last_balance_eth)
      && gleich(ethUsdPrice, row.last_eth_usd_price);
    const letzterSchreibvorgang = Number(row.last_balance_at) || 0;
    // Unbekannte Monatsbasis (-1) mit dem ersten erfolgreichen Abruf nachtragen.
    const nachtragen = (b, c) => ((b == null || b < 0) && c != null) ? c : b;
    const bRune = nachtragen(row.baseline_rune, currentRune), bUsdc = nachtragen(row.baseline_usdc, currentUsdc), bEth = nachtragen(row.baseline_eth, currentEth);
    const basisNeu = bRune !== row.baseline_rune || bUsdc !== row.baseline_usdc || bEth !== row.baseline_eth;
    if (!unveraendert || basisNeu || Date.now() - letzterSchreibvorgang > 3600000) {
      await env.DB.prepare(
        `UPDATE donation_tracking SET baseline_rune = ?, baseline_usdc = ?, baseline_eth = ?, last_balance_rune = ?, last_balance_usdc = ?, last_balance_eth = ?, last_eth_usd_price = ?, last_balance_at = ? WHERE id = 1`
      ).bind(bRune, bUsdc, bEth, currentRune, currentUsdc, currentEth, ethUsdPrice, Date.now()).run();
    }

    const receivedRune = seitBasis(currentRune, bRune);
    const receivedUsdc = seitBasis(currentUsdc, bUsdc);
    const receivedEth = seitBasis(currentEth, bEth);
    const receivedEthUsd = ethUsdPrice != null ? receivedEth * ethUsdPrice : 0;
    return json({ receivedRune, receivedUsdc, receivedEthUsd, receivedEth, month: currentMonth }, env);
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
// /volume ruft dagegen jeder Besucher auf. Wie dort gezaehlt wird, steht direkt darunter.
//
// Kosten: EIN Schreibvorgang je Geraet und Tag (INSERT OR IGNORE). Auch bei einem Nutzer, der
// die Seite hundertmal am Tag oeffnet, bleibt es bei genau einer Zeile.

// ZAEHLUNG OHNE GERAETESPEICHER (§ 25 TDDDG, gewuenscht: "mach 1"). Frueher schickte die App eine
// Zufallskennung aus ihrem localStorage mit (?v=...) und ein Ja/Nein "Wallet auf dem Geraet" (?w=1).
// Beides braucht in Deutschland eine Einwilligung, weil es auf dem Geraet gespeichert bzw. ausgelesen
// wird. Jetzt bildet der Worker den Code allein aus dem, was jede Anfrage ohnehin mitbringt:
//   SHA-256( Tagesgeheimnis | IP | User-Agent ), gekuerzt auf 32 Hex-Zeichen.
// Das Tagesgeheimnis ist eine Zufallszahl, die nur fuer den laufenden UTC-Tag in D1 liegt und danach
// geloescht wird -- ein alter Code laesst sich dann nicht mehr auf eine IP zurueckrechnen. IP und
// User-Agent werden nie gespeichert. Alte App-Fassungen, die noch v/w schicken, werden ignoriert.
// GRENZE: Der Code wechselt jeden Tag. "Geraete pro Tag" bleibt genau; Zaehlungen ueber mehrere Tage
// (7 Tage, 30 Tage, gesamt) zaehlen ein Geraet dagegen einmal JE TAG. Das Ja/Nein "mit Wallet" entfaellt.
const VISITOR_TOKEN_RE = /^[0-9a-f]{32}$/;
let tagesSalzCache = null; // { day, salz } -- spart den D1-Zugriff innerhalb einer Worker-Instanz
async function tagesSalz(env, day) {
  if (tagesSalzCache && tagesSalzCache.day === day) return tagesSalzCache.salz;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS visitor_salz (day TEXT PRIMARY KEY, salz TEXT NOT NULL)').run();
  const zufall = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare('INSERT OR IGNORE INTO visitor_salz (day, salz) VALUES (?, ?)').bind(day, zufall).run();
  const row = await env.DB.prepare('SELECT salz FROM visitor_salz WHERE day = ?').bind(day).first();
  await env.DB.prepare('DELETE FROM visitor_salz WHERE day <> ?').bind(day).run(); // Vortage vergessen
  tagesSalzCache = { day, salz: row && row.salz };
  return tagesSalzCache.salz;
}
async function tagesZaehlcode(env, request, day) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!ip) return null;
  const ua = request.headers.get('User-Agent') || '';
  const salz = await tagesSalz(env, day);
  if (!salz) return null;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salz + '|' + ip + '|' + ua));
  return [...new Uint8Array(hash)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function recordVisitor(env, ctx, request) {
  if (!env.DB || !ctx || typeof ctx.waitUntil !== 'function' || !request) return;
  const now = Date.now();
  const day = utcDayString(now);
  ctx.waitUntil((async () => {
    try {
      const token = await tagesZaehlcode(env, request, day);
      if (!token || !VISITOR_TOKEN_RE.test(token)) return;
      await env.DB.prepare('INSERT OR IGNORE INTO visitor_days (token, day, first_seen_at) VALUES (?, ?, ?)')
        .bind(token, day, now).run();
    } catch (e) {
      console.warn('[rune-rewards-backend] recordVisitor fehlgeschlagen:', e?.message || String(e));
    }
  })());
}

// ADRESSEN IN DER NUTZUNGSSTATISTIK PSEUDONYMISIERT (gewuenscht, "wie RUNEBond"). Statt der Wallet-
// Adresse speichern sync_activity_days / _counts / _art einen Code: "h:" + HMAC-SHA256(Schluessel,
// Adresse), gekuerzt auf 32 Hex-Zeichen. Der Schluessel liegt als geheime Worker-Variable
// STATS_SCHLUESSEL vor und darf NIE geaendert werden -- dieselbe Adresse ergibt so immer denselben Code,
// alle Zaehlungen (Tage, 7/30 Tage, Wiederkehr, Kohorten, aktiv/passiv, Marktanalyse) bleiben exakt.
// Wer nur die Datenbank sieht, sieht keine Adresse mehr. Rechtlich ist das Pseudonymisierung: mit dem
// Schluessel laesst sich zu einer BEKANNTEN Adresse der Code bilden (genau das tut die Marktanalyse).
// Ohne Variable bleibt alles wie bisher (Klartext); sobald sie gesetzt ist, wandelt statsMigrieren die
// vorhandenen Zeilen einmalig um.
const STATS_TABELLEN = ['sync_activity_days', 'sync_activity_counts', 'sync_activity_art'];
let statsSchluesselCache = null; // { roh, key }
async function statsSchluessel(env) {
  // trim(): ein beim Einfuegen mitkopierter Zeilenumbruch darf den Schluessel nicht veraendern.
  const roh = env && env.STATS_SCHLUESSEL ? String(env.STATS_SCHLUESSEL).trim() : '';
  if (!roh) return null;
  if (statsSchluesselCache && statsSchluesselCache.roh === roh) return statsSchluesselCache.key;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(roh), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  statsSchluesselCache = { roh, key };
  return key;
}
async function statsCode(env, adresse) {
  const a = String(adresse || '').trim().toLowerCase();
  if (!a || a.startsWith('h:')) return a;
  const key = await statsSchluessel(env);
  if (!key) return a;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(a));
  return 'h:' + [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const statsCodes = (env, liste) => Promise.all([...liste].map((a) => statsCode(env, a)));
let statsMigriert = false;
async function statsMigrieren(env) {
  if (statsMigriert || !env.DB || !(await statsSchluessel(env))) return;
  for (const t of STATS_TABELLEN) {
    for (let runde = 0; runde < 200; runde++) {
      let rows;
      try { rows = ((await env.DB.prepare(`SELECT DISTINCT address FROM ${t} WHERE address LIKE 'thor1%' LIMIT 100`).all()).results) || []; }
      catch (e) { break; } // Tabelle gibt es (noch) nicht
      if (!rows.length) break;
      const stmts = [];
      for (const r of rows) {
        const code = await statsCode(env, r.address);
        // OR IGNORE + DELETE: falls fuer denselben Tag schon eine Zeile mit Code existiert, gewinnt diese.
        stmts.push(env.DB.prepare(`UPDATE OR IGNORE ${t} SET address = ? WHERE address = ?`).bind(code, r.address));
        stmts.push(env.DB.prepare(`DELETE FROM ${t} WHERE address = ?`).bind(r.address));
      }
      await env.DB.batch(stmts);
    }
  }
  statsMigriert = true;
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
  ctx.waitUntil((async () => {
    let code;
    try { await statsMigrieren(env); code = await statsCode(env, address); }
    catch (e) { console.warn('[rune-rewards-backend] Stats-Code:', e?.message || e); return; }
    if (art) {
      try {
        if (!syncArtTabelleOk) { await env.DB.prepare('CREATE TABLE IF NOT EXISTS sync_activity_art (address TEXT, day TEXT, aktiv INTEGER DEFAULT 0, passiv INTEGER DEFAULT 0, PRIMARY KEY (address, day))').run(); syncArtTabelleOk = true; }
        await env.DB.prepare(`INSERT INTO sync_activity_art (address, day, aktiv, passiv) VALUES (?, ?, ?, ?)
          ON CONFLICT(address, day) DO UPDATE SET aktiv = aktiv + excluded.aktiv, passiv = passiv + excluded.passiv`)
          .bind(code, day, art === 'aktiv' ? 1 : 0, art === 'passiv' ? 1 : 0).run();
      } catch (e) { console.warn('[rune-rewards-backend] sync_activity_art:', e?.message || e); }
    }
    await Promise.all([
      env.DB.prepare('INSERT OR IGNORE INTO sync_activity_days (address, day, first_seen_at) VALUES (?, ?, ?)')
        .bind(code, day, now).run()
        .catch((e) => { console.error('[rune-rewards-backend] recordSyncActivity (dedup) failed:', e && e.message || e); }),
      env.DB.prepare(`INSERT INTO sync_activity_counts (address, day, count) VALUES (?, ?, 1)
         ON CONFLICT(address, day) DO UPDATE SET count = count + 1`)
        .bind(code, day).run()
        .catch((e) => { console.error('[rune-rewards-backend] recordSyncActivity (count) failed:', e && e.message || e); }),
    ]);
  })());
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

// KAEUFE MIT TRANSAKTION NUR EINMAL (gemeldet: "auf dem PC stimmt der Durchschnittspreis, auf dem
// Handy nicht -- dort andere DEX-Kaeufe"): Jedes Geraet hat erkannte On-Chain-Kaeufe mit EIGENER,
// zufaelliger ID angelegt. Derselbe Swap stand dadurch mehrfach in der Liste, und ein auf einem Geraet
// geloeschter DEX-Kauf kam vom anderen mit neuer ID zurueck. Jetzt:
//  - gleiche Transaktion (txId) = derselbe Kauf, nur der erste bleibt,
//  - Loeschmarke "tx:<txId>" gilt fuer jede Kopie dieser Transaktion, egal mit welcher ID.
function kaeufeBereinigen(liste, deletedIds) {
  const gesehen = new Set();
  return liste.filter((p) => {
    if (!p) return false;
    if (p.id && deletedIds.has(p.id)) return false;
    const tx = p.txId ? String(p.txId).toLowerCase() : null;
    if (tx) {
      if (deletedIds.has('tx:' + tx) || gesehen.has(tx)) return false;
      gesehen.add(tx);
    }
    return true;
  });
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
    purchases = kaeufeBereinigen(purchases, deletedIds);
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
    // WIEDERHERGESTELLT: Ein bewusst wieder uebernommener DEX-Kauf hebt seine Loeschmarke "tx:<txId>"
    // auf (nur solche Marken -- normale ID-Loeschungen bleiben endgueltig).
    const restoredIds = Array.isArray(body.restoredIds) ? body.restoredIds.filter((x) => typeof x === 'string' && x.startsWith('tx:')).slice(0, 500) : [];
    if (restoredIds.length) {
      const weg = env.DB.prepare('DELETE FROM user_purchases_deleted WHERE address = ? AND deleted_id = ?');
      await env.DB.batch(restoredIds.map((x) => weg.bind(address, x)));
    }

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
    const finalList = kaeufeBereinigen(merged, deletedIds);

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

// WALLET-NAMEN UND PROFILBILDER GERAETEUEBERGREIFEND (gemeldet: "die Wallet-Namen und Profilbilder
// sind auf anderen Geraeten nicht zu sehen"). Bisher lagen beide nur im localStorage des Geraets;
// /wallets glich nur die Adressliste ab. Jetzt pro (Anker, Wallet) eine Zeile mit Name und Bild,
// jeweils mit dem Zeitpunkt der letzten Aenderung auf dem Geraet: der NEUERE Stand gewinnt, je Feld
// getrennt. Leerer Wert mit Zeitstempel = entfernt (damit "Bild entfernen" auch anderswo greift).
// Die Tabelle legt sich selbst an -- keine Migration noetig. Aeltere App-Fassungen schicken kein
// "profiles" mit und lassen die Profile damit unberuehrt.
const MAX_PROFIL_NAME = 40;
const MAX_PROFIL_BILD = 60_000;   // 128-px-JPEG als data:-URL, real meist 5-15 kB
const MAX_PROFILE_JE_ANFRAGE = 50;
async function walletProfileTabelle(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS user_wallet_profiles (address TEXT NOT NULL, wallet TEXT NOT NULL, label TEXT NOT NULL DEFAULT \'\', label_at INTEGER NOT NULL DEFAULT 0, bild TEXT NOT NULL DEFAULT \'\', bild_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (address, wallet))').run();
}
async function walletProfileLesen(env, address) {
  await walletProfileTabelle(env);
  const rows = ((await env.DB.prepare('SELECT wallet, label, label_at, bild, bild_at FROM user_wallet_profiles WHERE address = ?').bind(address).all()).results) || [];
  const out = {};
  for (const r of rows) out[r.wallet] = { label: r.label || '', labelAt: Number(r.label_at) || 0, bild: r.bild || '', bildAt: Number(r.bild_at) || 0 };
  return out;
}
async function walletProfileSchreiben(env, address, profiles, erlaubt) {
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return;
  const jetzt = Date.now() + 5 * 60 * 1000; // Zeitstempel aus der Zukunft (falsche Geraeteuhr) kappen
  const zeilen = [];
  for (const [wallet, p] of Object.entries(profiles).slice(0, MAX_PROFILE_JE_ANFRAGE)) {
    if (typeof wallet !== 'string' || !wallet.trim() || wallet.length > 128 || !p || typeof p !== 'object') continue;
    if (erlaubt && !erlaubt.has(wallet)) continue; // nur Wallets, die (noch) in der Liste stehen
    let label = typeof p.label === 'string' ? p.label.trim().slice(0, MAX_PROFIL_NAME) : '';
    let labelAt = Math.min(Number(p.labelAt) || 0, jetzt);
    let bild = typeof p.bild === 'string' ? p.bild : '';
    let bildAt = Math.min(Number(p.bildAt) || 0, jetzt);
    // Nur echte Bilder als data:-URL annehmen; zu grosse/fremde Werte verwerfen (Feld bleibt unveraendert).
    if (bild && (bild.length > MAX_PROFIL_BILD || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(bild))) { bild = ''; bildAt = 0; }
    if (labelAt <= 0 && bildAt <= 0) continue;
    zeilen.push([wallet, label, Math.max(0, labelAt), bild, Math.max(0, bildAt)]);
  }
  if (!zeilen.length) return;
  await walletProfileTabelle(env);
  const stmt = env.DB.prepare(
    `INSERT INTO user_wallet_profiles (address, wallet, label, label_at, bild, bild_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(address, wallet) DO UPDATE SET
       label    = CASE WHEN excluded.label_at > user_wallet_profiles.label_at THEN excluded.label ELSE user_wallet_profiles.label END,
       label_at = MAX(user_wallet_profiles.label_at, excluded.label_at),
       bild     = CASE WHEN excluded.bild_at > user_wallet_profiles.bild_at THEN excluded.bild ELSE user_wallet_profiles.bild END,
       bild_at  = MAX(user_wallet_profiles.bild_at, excluded.bild_at)`
  );
  await env.DB.batch(zeilen.map((z) => stmt.bind(address, ...z)));
}

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
    let profiles = {};
    try { profiles = await walletProfileLesen(env, address); } catch (e) { profiles = {}; }
    return json({
      address,
      wallets,
      deletedAddrs: [...deletedAddrs],
      profiles,
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
      // Name und Bild einer entfernten Wallet gleich mit vom Server nehmen.
      try {
        await walletProfileTabelle(env);
        const delP = env.DB.prepare('DELETE FROM user_wallet_profiles WHERE address = ? AND wallet = ?');
        await env.DB.batch(newlyDeletedOhne.map((w) => delP.bind(address, w)));
      } catch (e) {}
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
    // Profile (Name/Bild) nach der Liste schreiben; ein Fehler hier darf den Listen-Sync nicht kippen.
    let profiles;
    try {
      if (body.profiles) await walletProfileSchreiben(env, address, body.profiles, new Set(merged));
      profiles = await walletProfileLesen(env, address);
    } catch (e) { profiles = undefined; }
    return json({ address, updatedAt: now, wallets: merged, deletedAddrs: [...deletedAddrs], profiles }, env);
  }

  return json({ error: 'METHOD_NOT_ALLOWED' }, env, 405);
}

// DATEN LOESCHEN (gewuenscht: "ich will, dass man seine Wallet loeschen kann"). Entfernt ALLES, was
// rune.watch zu den angegebenen Adressen als Sync-Schluessel gespeichert hat: Wallet-Liste samt
// Loesch-/Wiederherstellungsmarken, Namen und Profilbilder, Kaufliste, Chart-Zeichnungen, Swap-Verlauf
// und die Aktivitaetszaehler der Statistik. Dazu die Zwischenspeicher, die der Server zu diesen Adressen
// aus oeffentlichen Chain-Daten anlegt (Bond-Verlauf, Kontostand) -- sie sind zwar oeffentlich ableitbar,
// haengen aber an der Adresse und werden bei einem erneuten Aufruf einfach neu berechnet.
// Bewusst kein recordSyncActivity hier: sonst entstuende sofort wieder ein Eintrag.
const LOESCH_TABELLEN = [
  'user_wallet_lists', 'user_wallet_lists_deleted', 'user_wallet_lists_restored', 'user_wallet_profiles',
  'user_purchases', 'user_purchases_deleted', 'user_chart_drawings', 'user_chart_drawings_deleted',
  'user_swap_history', 'sync_activity_days', 'sync_activity_counts', 'sync_activity_art',
  'balance_cache', 'user_chain_addrs',
  ['tracked_addresses', 'bond_address'], ['bond_history_rows', 'bond_address'],
];
async function handleDatenLoeschen(request, env) {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, env, 405);
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: 'INVALID_BODY' }, env, 400); }
  const adressen = [...new Set((Array.isArray(body.adressen) ? body.adressen : []).map((a) => String(a || '').trim().toLowerCase()))]
    .filter((a) => isValidThorAddress(a)).slice(0, 50);
  if (!adressen.length) return json({ error: 'INVALID_ADDRESS' }, env, 400);
  const geloescht = {};
  const codes = await statsCodes(env, adressen); // Statistik speichert Codes statt Adressen
  for (const eintrag of LOESCH_TABELLEN) {
    const [t, spalte] = Array.isArray(eintrag) ? eintrag : [eintrag, 'address'];
    const werte = STATS_TABELLEN.includes(t) ? [...new Set([...adressen, ...codes])] : adressen;
    // Jede Tabelle einzeln: fehlt eine (noch nie benutzt), sollen die anderen trotzdem geloescht werden.
    try {
      const stmt = env.DB.prepare(`DELETE FROM ${t} WHERE ${spalte} = ?`);
      const res = await env.DB.batch(werte.map((a) => stmt.bind(a)));
      geloescht[t] = (res || []).reduce((n, r) => n + ((r && r.meta && r.meta.changes) || 0), 0);
    } catch (e) {
      if (!/no such table/i.test(String(e && e.message || e))) return json({ error: 'DELETE_FAILED', tabelle: t }, env, 500);
    }
  }
  return json({ ok: true, adressen, geloescht }, env);
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

// EMPFANGENE MENGE MITSPEICHERN (gewuenscht: "bitte auch die Menge anzeigen"): Spalte out_amount,
// legt sich bei Bedarf selbst an (aeltere Datenbanken haben sie noch nicht).
let swapOutSpalteOk = false;
async function swapOutSpalte(env) {
  if (swapOutSpalteOk) return;
  try { await env.DB.prepare('ALTER TABLE user_swap_history ADD COLUMN out_amount TEXT').run(); } catch (e) { /* gibt es schon */ }
  swapOutSpalteOk = true;
}
// KEINE SWAPS MEHR IM WORKER (gewuenscht: "keine Swaps oder Aehnliches im Worker speichern, alles oeffentlich"):
// Die Swap-Historie wird nicht mehr gespeichert; vorhandene Eintraege loescht der Worker beim ersten Aufruf.
// GET liefert eine leere Liste, POST nimmt nichts an. Die Liste "Swaps via rune.watch" kommt nur noch aus
// oeffentlichen Blockchain-Daten (Midgard, Kennung "runewatch").
let swapHistorieGeleert = false;
async function handleSwapHistory(request, env, ctx) {
  if (!swapHistorieGeleert) {
    swapHistorieGeleert = true;
    try { await env.DB.prepare('DELETE FROM user_swap_history').run(); } catch (e) {}
  }
  if (request.method === 'GET') return json({ swaps: [] }, env);
  if (request.method === 'POST') return json({ saved: 0 }, env);
  return json({ error: 'METHOD_NOT_ALLOWED' }, env, 405);
}
async function handleSwapHistoryAlt(request, env, ctx) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address');
  if (!isValidThorAddress(address)) {
    return json({ error: 'INVALID_ADDRESS' }, env, 400);
  }
  recordSyncActivity(env, ctx, address, request);

  await swapOutSpalte(env);
  if (request.method === 'GET') {
    const rows = await env.DB
      .prepare('SELECT swap_id, from_asset, to_asset, amount, out_amount, destination, track_status, in_tx_id, out_tx_id, resolved_at, registered_at FROM user_swap_history WHERE address = ? ORDER BY COALESCE(resolved_at, registered_at) DESC LIMIT 50')
      .bind(address)
      .all();
    return json({
      address,
      swaps: (rows.results || []).map((r) => ({
        id: r.swap_id,
        fromAsset: r.from_asset,
        toAsset: r.to_asset,
        amount: r.amount,
        trackOutAmount: r.out_amount != null && r.out_amount !== '' ? Number(r.out_amount) : null,
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
         (address, swap_id, from_asset, to_asset, amount, out_amount, destination, track_status, in_tx_id, out_tx_id, resolved_at, registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const outTxt = s => (Number.isFinite(Number(s.trackOutAmount)) && Number(s.trackOutAmount) > 0 ? String(Number(s.trackOutAmount)) : null);
      // Bestehende Zeilen ohne Menge nachtragen (INSERT OR IGNORE laesst sie sonst unveraendert).
      const nach = env.DB.prepare('UPDATE user_swap_history SET out_amount = ? WHERE address = ? AND swap_id = ? AND (out_amount IS NULL OR out_amount = \'\')');
      // Bestehende Eintraege AKTUALISIEREN: Ein frueher falsch zugeordneter Swap bekommt so seine richtige
      // Einzahlung (in_tx_id) -- sonst blieb auf anderen Geraeten die falsche stehen und der Swap fiel beim
      // Entdoppeln weg (gemeldet: "3 Swaps, aber nur 2 gezeigt"). Getrennte UPDATEs, unabhaengig vom
      // Schluessel der Tabelle.
      const txNeu = env.DB.prepare('UPDATE user_swap_history SET in_tx_id = ?, out_tx_id = COALESCE(?, out_tx_id), resolved_at = COALESCE(?, resolved_at) WHERE address = ? AND swap_id = ? AND (in_tx_id IS NULL OR in_tx_id <> ?)');
      const mitTx = valid.filter(s => s.trackInTxId);
      if (mitTx.length) { try { await env.DB.batch(mitTx.map(s => txNeu.bind(s.trackInTxId, s.trackOutTxId || null, Number.isFinite(s.resolvedAtMs) ? s.resolvedAtMs : null, address, s.id, s.trackInTxId))); } catch (e) {} }
      const mitMenge = valid.filter(s => outTxt(s));
      if (mitMenge.length) { try { await env.DB.batch(mitMenge.map(s => nach.bind(outTxt(s), address, s.id))); } catch (e) {} }
      await env.DB.batch(valid.map((s) => stmt.bind(
        address,
        s.id,
        s.fromAsset || null,
        s.toAsset || null,
        s.amount != null ? String(s.amount) : null,
        outTxt(s),
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

// OFFIZIELLE INTEGRATORS-API (RUNEBond, Nov. 2026: "wir aendern die interne API wegen Junk-Traffic,
// nutzt fuer Integrationen die Integrators-API"). GET /v1/runebond/listed-nodes mit Header x-api-key
// (Pfade und Header laut @runebond/integrators-client 0.4.0). Liefert nur die Listing-Bedingungen;
// Status und Bond Provider kommen wie vorgesehen von THORNode. Der Schluessel liegt als geheime
// Worker-Variable RUNEBOND_API_KEY vor -- NIE im Code (das Repository ist oeffentlich).
const RUNEBOND_INTEGRATORS_BASE = 'https://integrators.runebond.com';
async function runebondVonIntegrators(env) {
  const basis = String((env && env.RUNEBOND_INTEGRATORS_BASE) || RUNEBOND_INTEGRATORS_BASE).replace(/\/+$/, '');
  const res = await fetchWithTimeout(basis + '/v1/runebond/listed-nodes', {
    timeoutMs: 8000, headers: { accept: 'application/json', 'x-api-key': String(env.RUNEBOND_API_KEY).trim() },
  });
  if (!res.ok) throw new Error('integrators HTTP_' + res.status);
  const j = await res.json();
  const liste = Array.isArray(j && j.nodes) ? j.nodes : [];
  if (!liste.length) throw new Error('integrators LEER');
  let nachAddr = new Map();
  try {
    const nodes = await fetchNodes();
    nachAddr = new Map((Array.isArray(nodes) ? nodes : []).map(n => [String(n.node_address).toLowerCase(), n]));
  } catch (e) { /* ohne THORNode: Liste trotzdem ausliefern, nur ohne Status/Provider */ }
  const basisEinheit = v => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x / 1e8 : null; };
  const listings = liste.filter(e => e && e.nodeAddress).map(e => {
    const addr = String(e.nodeAddress).toLowerCase();
    const n = nachAddr.get(addr);
    const prov = (n && n.bond_providers && n.bond_providers.providers) || [];
    const ts = e.listedAt ? Date.parse(e.listedAt) : NaN;
    return {
      addr,
      name: e.name || null,
      minRune: basisEinheit(e.minBond),
      maxRune: null,
      fee: Number.isFinite(Number(e.feeBps)) ? Number(e.feeBps) / 100 : null, // 2000 bps = 20 %
      providers: n ? prov.length : null,
      target: basisEinheit(e.targetTotalBond),
      status: n ? String(n.status || '') : null,
      yieldGuard: false,
      maxTimeToLeave: null,
      listedAt: Number.isFinite(ts) ? ts : null,
      logoUrl: e.logoUrl || null,
      profileUrl: e.profileUrl || null,
      source: 'integrators',
    };
  });
  return { listings, base: basis };
}

async function handleRunebondNodes(request, env, ctx) {
  const jetzt = Date.now();
  if (runebondCache.data && jetzt - runebondCache.at < RUNEBOND_CACHE_MS) {
    return json(runebondCache.data, env);
  }
  // 1. Wahl: offizielle Integrators-API (mit Schluessel). Faellt sie aus, geht es wie bisher weiter
  //    (alte oeffentliche API, dann die Listing-Memos direkt von der Chain).
  let integratorsFehler = null;
  if (env && env.RUNEBOND_API_KEY) {
    try {
      const r = await runebondVonIntegrators(env);
      const daten = { listings: r.listings, fetchedAt: jetzt, base: r.base, error: null };
      runebondCache = { at: jetzt, data: daten };
      runebondLetzteGute = daten;
      return json(daten, env);
    } catch (e) { integratorsFehler = String(e && e.message || e); }
  }
  const kandidaten = (env && env.RUNEBOND_API_BASE)
    ? [String(env.RUNEBOND_API_BASE).replace(/\/+$/, '')]
    : RUNEBOND_API_BASES;
  const kopf = { accept: 'application/json' };
  // Optionaler Schluessel fuer die Integrators-API (integrators.runebond.com verlangt einen).
  // (Kein Schluessel mehr an die alte API -- der Integrators-Schluessel gehoert nur zu integrators.runebond.com.)
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
      const daten = { listings: c.listings, fetchedAt: jetzt, base: 'chain (' + c.gelesen + ' Memos)', error: null, apiFehler: letzterFehler ? String(letzterFehler.message || letzterFehler) : null, integratorsFehler };
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
const WORKER_VERSION = '2026-11-14-1045'; // bei jedem Worker-Update mitziehen (zeigt die Statistikseite unten an)
const CLICK_TARGETS = new Set(['runebond']);
const CLICK_QUELLEN = new Set(['banner', 'node', 'liste', 'karte', 'node-oben', 'frei', 'liste-fenster']);
let klickSpalteGeprueft = false;

async function handleClick(request, env, ctx) {
  const url = new URL(request.url);
  const target = String(url.searchParams.get('t') || '').toLowerCase();
  // Antwort immer 204, auch bei unbekanntem Ziel: der Klick des Nutzers soll nie an einer
  // Fehlermeldung haengen bleiben, das Ziel oeffnet ja parallel.
  if (!CLICK_TARGETS.has(target) || !env.DB) return new Response(null, { status: 204 });
  const now = Date.now();
  // Tages-Zaehlcode wie bei recordVisitor (keine Geraetekennung mehr, siehe dort).
  let sauber = null;
  try { sauber = await tagesZaehlcode(env, request, utcDayString(now)); } catch (e) { sauber = null; }
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
  // Statistik-Adressen sind Codes (siehe statsCode): Abgleich deshalb ueber Codes -- Wallet-Listen und
  // Bonder-Adressen werden mit demselben Schluessel umgerechnet. Ohne Schluessel ist Code = Adresse.
  await statsMigrieren(env).catch(() => {});
  const rwCodes = new Set(await statsCodes(env, rw));
  try {
    const rows = await env.DB.prepare('SELECT DISTINCT address FROM sync_activity_days').all();
    for (const r of (rows.results || [])) { const a = String(r.address || '').toLowerCase(); if (a.startsWith('thor1') || a.startsWith('h:')) rwCodes.add(await statsCode(env, a)); }
  } catch (e) {}
  const bonderCodes = new Map();
  for (const [a, v] of bonder) bonderCodes.set(await statsCode(env, a), v);
  let rwBonder = 0, rwBond = 0;
  for (const c of rwCodes) if (bonderCodes.has(c)) { rwBonder++; rwBond += bonderCodes.get(c); }
  erg.runeWatch = {
    adressen: rwCodes.size,
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

async function handleStats(request, env, ctx) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.STATS_ACCESS_KEY || key !== env.STATS_ACCESS_KEY) {
    return json({ error: 'UNAUTHORIZED' }, env, 401);
  }

  const now = Date.now();
  const day1 = utcDayString(now);
  const day7 = utcDayString(now - 7 * 24 * 60 * 60 * 1000);
  const day30 = utcDayString(now - 30 * 24 * 60 * 60 * 1000);

  await statsMigrieren(env).catch(() => {});
  const exclRoh = [...getStatsExcludedAddresses(env)];
  const excl = [...new Set([...exclRoh, ...(await statsCodes(env, exclRoh))])];
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
    // SEIT DER ZAEHLUNG OHNE GERAETESPEICHER wechselt der Code taeglich -- "verschiedene Geraete in 7/30
    // Tagen" waere nicht mehr aussagekraeftig. Stattdessen: Geraete-Tage der letzten 7 bzw. 30 VOLLEN
    // Tage (ohne den laufenden). Geteilt durch die Tage ergibt das den Schnitt Geraete pro Tag -- das ist
    // vor und nach der Umstellung gleich gezaehlt (je Geraet und Tag eine Zeile).
    env.DB.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT day) AS t FROM visitor_days WHERE day >= ? AND day < ?').bind(day7, day1).first().catch(() => ({ n: null })),
    env.DB.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT day) AS t FROM visitor_days WHERE day >= ? AND day < ?').bind(day30, day1).first().catch(() => ({ n: null })),
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
    // ALLES GESAMT (gewuenscht: "81 total, aber 41 Klicks -- es sollte alles in total sein")
    env.DB.prepare("SELECT COALESCE(quelle, '-') AS q, COUNT(*) AS n FROM outbound_clicks WHERE target = 'runebond' GROUP BY q ORDER BY n DESC").all().catch(() => ({ results: null })),
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
    // Schnitt Geraete pro Tag (volle Tage); Tage ohne Aufzeichnung zaehlen nicht mit.
    visitorsAvgDay7: vis7Row && vis7Row.t > 0 ? Math.round(vis7Row.n / vis7Row.t * 10) / 10 : null,
    visitorsAvgDay30: vis30Row && vis30Row.t > 0 ? Math.round(vis30Row.n / vis30Row.t * 10) / 10 : null,
    visitorsSince: visSinceRow?.d ?? null,
    runebondClicksLast1d: klick1Row?.n ?? null,
    runebondClicksLast30d: klick30Row?.n ?? null,
    runebondClicksTotal: klickGesamtRow?.n ?? null,
    runebondClicksBySource30d: klickQuellenRows && Array.isArray(klickQuellenRows.results) ? klickQuellenRows.results : null,
    // SCHNELL (gemeldet: "Statistikseite oeffnet sehr langsam"): letzten Stand sofort, Auffrischung im Hintergrund;
    // ohne Stand hoechstens 3 s warten.
    liveTest: await liveBilanz(env),
    botStand: await botStand(env),
    laufLive: await rwLaufInfo(env, 'live'),
    laufBot: await rwLaufInfo(env, 'bot'),
    botModell4h: await botModell(env, '4h'),
    botModell1d: await botModell(env, '1d'),
    botLernlauf4h: await rwLaufInfo(env, 'lernen4h'),
    botLernlauf1d: await rwLaufInfo(env, 'lernen1d'),
    botLive: await botLiveBilanz(env),
    runebondRef: await (async () => {
      const alt = runebondRefCache.data;
      const frisch = runebondEmpfehlungen(env).catch(() => null);
      if (alt) { if (ctx && ctx.waitUntil) ctx.waitUntil(frisch); return alt; }
      const r = await Promise.race([frisch, new Promise((res) => setTimeout(() => res(null), 3000))]);
      if (!r && ctx && ctx.waitUntil) ctx.waitUntil(frisch);
      return r;
    })(),
  };

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

  // MARKT (THORChain-Adressen, Bonder, TCY ...) als dritte Seite (gewuenscht): aus dem 12-h-Speicher von
  // /analyse/markt; fehlt er oder ist er aelter als 24 h, wird er hier neu gerechnet (~10-25 s).
  let markt = null;
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS markt_cache (k TEXT PRIMARY KEY, v TEXT, at INTEGER)').run();
    const c = await env.DB.prepare('SELECT v, at FROM markt_cache WHERE k = ?').bind('markt').first();
    // SCHNELL: vorhandenen Stand (auch aelteren) sofort zeigen; ist er aelter als 24 h oder fehlt, wird im
    // HINTERGRUND neu gerechnet (dauerte bisher 10-25 s im Seitenaufruf).
    if (c) markt = JSON.parse(c.v);
    if (!c || Date.now() - c.at >= 24 * 3600e3) {
      const u = new URL(request.url); u.pathname = '/analyse/markt'; u.searchParams.set('neu', '1'); u.searchParams.set('format', 'json');
      const neu = handleMarkt(new Request(u.toString()), env).catch(() => null);
      if (ctx && ctx.waitUntil) ctx.waitUntil(neu);
    }
  } catch (e) { markt = null; }

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
  @font-face { font-family: Figtree; src: url('https://runewatch.org/fonts/figtree.woff2') format('woff2'); font-weight: 300 900; font-display: swap; }
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 48px;
    background: #121212; color: #ffffff;
    font-family: Figtree, -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
  }
  h1 {
    font-size: 22px; font-weight: 800; letter-spacing: -0.01em;
    color: #ffffff; margin: 0 0 4px;
  }
  .subtitle { font-size: 12.5px; color: #8a8a8a; margin-bottom: 22px; }
  .grid {
    display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;
    max-width: 480px;
  }
  .tile {
    background: #181818;
    border: none; border-radius: 8px; padding: 16px 14px;
  }
  .tile-value {
    font-size: 28px; font-weight: 800; font-family: Figtree, -apple-system, sans-serif;
    color: #ffffff; line-height: 1.1;
    transition: opacity 0.15s ease;
  }
  .tile-label { font-size: 12px; color: #b3b3b3; margin-top: 6px; }
  .tile-hint { font-size: 10.5px; color: #7a7a7a; margin-top: 3px; }
  .tile.wide { grid-column: 1 / -1; }
  /* UEBERSICHTLICHER (gewuenscht): Abschnitte mit kleiner Ueberschrift statt einer langen Kachel-Wand */
  .sec { grid-column: 1 / -1; font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: #8a8a8a; margin: 14px 0 -2px; display: flex; align-items: center; gap: 8px; }
  .sec:first-child { margin-top: 0; }
  .sec::after { content: ''; flex: 1; height: 1px; background: #2a2a2a; }
  .tile { padding: 14px 13px; }
  .tile-value { font-size: 26px; }
  .tile-hint { line-height: 1.4; }
  .version { font-size: 10.5px; color: #6a6a6a; margin-top: 6px; }
  /* Abschnitte mit drei Kacheln: die dritte ueber die volle Breite, statt allein halb leer */
  .tile:has(#v-avgreq), .tile:has(#v-rate), .tile:has(#v-rbconv) { grid-column: 1 / -1; }
  .tile-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  /* Festes Zeitraum-Etikett -- sieht aus wie ein Auswahlfeld, ist aber bewusst nicht
     bedienbar: Aktive Adressen und Requests zeigen beide 24h. */
  .tile-period {
    background: #242424; color: #b3b3b3; border: 1px solid #2a2a2a; border-radius: 6px;
    font-size: 10.5px; font-weight: 600; padding: 3px 6px;
  }
  .refresh {
    margin-top: 22px; font-size: 11.5px; color: #7a7a7a;
    display: flex; align-items: center; gap: 6px;
  }
  .dot {
    width: 6px; height: 6px; border-radius: 50%; background: #1ed760; flex-shrink: 0;
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .depth-row {
    display: grid; grid-template-columns: 56px 1fr 42px 40px; align-items: center; gap: 8px;
    margin-bottom: 8px; font-size: 12px;
  }
  .depth-label { color: #b3b3b3; }
  .depth-bar-track {
    height: 8px; border-radius: 4px; background: #2a2a2a; overflow: hidden;
  }
  .depth-bar-fill {
    height: 100%; border-radius: 4px; background: #1ed760;
    transition: width 0.2s ease;
  }
  .depth-pct { color: #ffffff; font-weight: 600; text-align: right; }
  .depth-count { color: #7a7a7a; font-size: 10.5px; }
  /* Zwei Seiten nebeneinander, horizontal wischbar (Snap). Am Handy ein Karussell, am PC
     funktionieren die Punkte unten als Navigation. */
  /* WIE IN DER APP (gewuenscht): Reiter bzw. Wischen wechseln die Seite mit kurzer Gleit-Animation --
     kein freies horizontales Scrollen mehr, bei dem halbe Seiten nebeneinander standen. */
  .pager {
    display: block; overflow: hidden; touch-action: pan-y;
    scrollbar-width: none; -webkit-overflow-scrolling: touch;
  }
  .pager::-webkit-scrollbar { display: none; }
  .page { display: none; }
  .page.aktiv { display: block; animation: seiteRein 0.24s ease-out; }
  .page.aktiv.von-links { animation-name: seiteReinL; }
  @keyframes seiteRein { from { opacity: 0; transform: translateX(28px); } to { opacity: 1; transform: none; } }
  @keyframes seiteReinL { from { opacity: 0; transform: translateX(-28px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .page.aktiv { animation: none; } }
  .page-title {
    font-size: 11px; color: #8a8a8a; margin: 0 0 10px; letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .dots { display: flex; gap: 7px; justify-content: center; margin: 20px 0 0; }
  .dot-nav {
    width: 7px; height: 7px; border-radius: 50%; background: #2a2a2a; border: none;
    padding: 0; cursor: pointer; transition: background 0.15s ease;
  }
  .dot-nav.active { background: #1ed760; }
  .note {
    font-size: 11.5px; color: #8a8a8a; line-height: 1.55; margin-top: 14px;
    border-left: 2px solid #2a2a2a; padding-left: 11px; max-width: 480px;
  }
  .swipe-hint { font-size: 10.5px; color: #6a6a6a; text-align: center; margin-top: 8px; }
  /* REITER OBEN (gemeldet: auf der ersten Seite sah man nicht, dass man wischen kann). Bleibt
     beim Scrollen oben stehen und zeigt, welche Seite gerade offen ist. */
  .tabs { position: sticky; top: 0; z-index: 5; display: flex; gap: 6px; padding: 8px 0; margin: 0 0 14px; background: #121212; }
  .tab-nav { flex: 0 0 auto; height: 32px; padding: 0 14px; border: none; border-radius: 999px; background: #2a2a2a; color: #ffffff;
    font: 700 13px/1 Figtree, Inter, system-ui, sans-serif; cursor: pointer; transition: background .15s, color .15s; }
  .tab-nav.active { background: #ffffff; color: #000000; }
  .tab-nav:hover:not(.active) { color: #ffffff; }
</style>
</head>
<body>
  <h1>rune.watch stats</h1>
  <div class="subtitle">Address based, across devices (not Cloudflare "visits") · recording <span id="v-since">${trackingHint}</span></div>

  <div class="tabs" role="tablist">
    <button class="tab-nav active" data-page="0" role="tab">Addresses</button>
    <button class="tab-nav" data-page="1" role="tab">Visitors</button>
    <button class="tab-nav" data-page="2" role="tab">Market</button>
  </div>

  <div class="pager" id="pager">
    <section class="page">
      <div class="page-title">1 · Addresses (wallet entered)</div>
      <div class="grid">
        <div class="sec">Last 24 hours</div>
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
        ${tile('avgreq', 'Ø requests per active address', stats.activeLast1d > 0 ? Math.round((stats.totalRequestsLast1d / stats.activeLast1d) * 10) / 10 : '—', 'last 24h, per address active in those 24h')}
        <div class="sec">All time</div>
        ${tile('total', 'Addresses total', stats.totalUniqueAddressesEver, trackingHint)}
        ${tile('returning', 'Returning – all time', stats.returningAllTime, 'synced on ≥2 separate days since recording began')}
        ${tile('rate', 'Retention rate', stats.retentionRateAllTime == null ? '—' : stats.retentionRateAllTime + '%', 'share of returning addresses among all addresses')}
        <div class="sec">Engagement</div>
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
          const zelle = v => v == null ? '<td></td>' : `<td style="text-align:center; padding:4px 2px; border-radius:5px; background:rgba(30,215,96,${Math.max(0.06, v / 100 * 0.85)}); color:${v > 45 ? '#000000' : 'inherit'}; font-variant-numeric:tabular-nums;">${Math.round(v)}</td>`;
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
        <div class="sec">Devices</div>
        ${tile('vis1', 'Devices – today', stats.visitorsLast1d, 'distinct devices today (UTC)')}
        ${tile('vis7', '\u00d8 devices per day – 7 days', stats.visitorsAvgDay7, 'average of the last 7 full days')}
        ${tile('vis30', '\u00d8 devices per day – 30 days', stats.visitorsAvgDay30, 'average of the last 30 full days')}
        <div class="tile wide" style="font-size:12px;color:var(--muted,#888);line-height:1.5">Counted without storing anything on the device (daily changing code). Devices can be counted per day, but not across several days \u2013 multi-day totals, returning devices and \u201cwith wallet\u201d were removed. Returning users: see the Addresses tab.</div>
        <!-- Wallet-Anteil entfernt: wird ohne Geraetespeicher nicht mehr erfasst. -->
        <div class="sec">RUNEBond</div>
        ${stats.runebondRef && stats.runebondClicksTotal > 0 ? tile('rbconv', 'Clicks that became a request', Math.round(stats.runebondRef.anfragen / stats.runebondClicksTotal * 1000) / 10 + ' %',
          `${stats.runebondRef.anfragen} whitelist request${stats.runebondRef.anfragen === 1 ? '' : 's'} from ${stats.runebondClicksTotal} clicks \u00b7 ${stats.runebondRef.gebondet} bonded`) : ''}
        ${tile('rbref', 'Bonders via rune.watch', stats.runebondRef ? stats.runebondRef.gebondet : null,
          stats.runebondRef ? `${stats.runebondRef.runeGebondet.toLocaleString('en-US')} RUNE bonded \u00b7 ${stats.runebondRef.anfragen} whitelist request${stats.runebondRef.anfragen === 1 ? '' : 's'} \u00b7 ${stats.runebondRef.wallets} wallet${stats.runebondRef.wallets === 1 ? '' : 's'}` : 'RUNEBond data not available')}
        ${tile('rb1', 'RUNEBond clicks', stats.runebondClicksTotal,
          stats.runebondClicksLast1d == null ? 'no data yet' : `${stats.runebondClicksLast1d} in the last 24h`)}
        ${(() => {
          // Aufteilung nach Herkunft: gross die Summe (30 Tage), darunter je Quelle eine Zeile.
          // Vorher stand die ganze Aufzaehlung als "Zahl" in der grossen Schrift der Kachel.
          const rows = stats.runebondClicksBySource30d;
          const namen = { banner: 'Banner (top of the app)', node: 'Node window – button below', 'node-oben': 'Node window – open slot bar', liste: 'RUNEBond × RUNE.WATCH list', 'liste-fenster': 'List – "All nodes on RUNEBond"', karte: 'Bond card', frei: 'Hint: unbonded RUNE (bonders)', '-': 'before sources were recorded' };
          if (!rows || !rows.length) return tile('rbsrc', 'Clicks by source', null, 'no data yet');
          const summe = rows.reduce((a, r) => a + (Number(r.n) || 0), 0);
          const zeilen = rows.map(r => `${namen[r.q] || r.q}: <b>${Number(r.n) || 0}</b>`).join('<br>');
          return tile('rbsrc', 'Clicks by source', summe, zeilen);
        })()}
        <div class="sec">Chart analysis \u00b7 live test</div>
        ${(() => {
          const L = stats.liveTest;
          if (!L || !L.n) return tile('live0', 'Signals recorded', null, 'starts with the next 4h candle \u00b7 RUNE, BTC, ETH, SOL');
          const seit = new Date(L.seit).toISOString().slice(0, 10);
          const zeile = (name, a) => a ? `${name}: after bullish ${a.bullUp ?? '\u2013'} % up (${a.bullN}) \u00b7 after bearish ${a.bearDown ?? '\u2013'} % down (${a.bearN}) \u00b7 base ${a.basisUp} % up \u00b7 Brier ${a.brier} (random ${a.brierZufall})` : `${name}: waiting for results`;
          return tile('live1', 'Signals recorded', L.n, `since ${seit}`) +
            tile('live2', 'Hit rates so far', L.kurz ? L.kurz.n : null, [zeile('1 day / 3 days', L.kurz), zeile('3 / 7 days', L.mittel), zeile('7 / 14 days', L.lang)].join('<br>')) +
            tile('live3', 'Phase signals (new engine)', L.phasenSig ? L.phasenSig.n : null, L.phasenSig && L.phasenSig.ausgewertet ? `${L.phasenSig.treffer} % correct after 3 days (4H) / 7 days (1D) \u00b7 ${L.phasenSig.ausgewertet} evaluated \u00b7 backtest: 56\u201365 %` : 'signals appear only in special situations \u00b7 waiting for results');
        })()}
        <div class="sec">Learning bot \u00b7 step 1: collecting</div>
        ${(() => { const B = stats.botStand || {}; return tile('bot1', 'Cases collected', B.faelle || null,
          `${B.mitErgebnis || 0} with known outcome \u00b7 history loaded ${B.historieFertig || 0} / ${B.historieGesamt || 16} (four per hour)`); })()}
        ${(() => { const zeile = (n, L) => !L ? `${n}: not run yet` :
            `${n}: last run ${new Date(L.at).toISOString().slice(11, 16)} UTC \u00b7 ${L.ms} ms` + (L.fehler ? ` \u00b7 ERROR ${String(L.fehler).slice(0, 80)}` : '') + (L.einzelFehler && L.einzelFehler.length ? ` \u00b7 ${L.einzelFehler.length} issues: ${String(L.einzelFehler[0]).slice(0, 80)}` : ' \u00b7 ok');
          return tile('bot2', 'Run status', null, zeile('Live', stats.laufLive) + '<br>' + zeile('Bot', stats.laufBot)); })()}
        ${(() => { const pct = v => v == null ? '\u2013' : (100 * v).toFixed(1) + ' %';
          const m = (name, M, L) => { if (M && M.modell) return `${name}: model from ${new Date(M.at).toISOString().slice(0, 10)} \u00b7 test hit rate ${pct(M.test.treffer)} (base ${pct(Math.max(M.basis, 1 - M.basis))}) \u00b7 Brier ${M.test.brier} vs ${M.test.brierBasis}` + (M.gelernt && M.gelernt.length ? ` \u00b7 learned: ${M.gelernt.join(', ')}` : '');
            const e = L && L.ergebnis; return `${name}: ` + (e && e.uebernommen === false ? `not adopted (${e.test ? 'Brier ' + e.test.brier + ' vs base ' + e.test.brierBasis : ''})` : L && L.fehler ? 'ERROR ' + L.fehler : 'not trained yet'); };
          const B = stats.botLive || {};
          return tile('bot3', 'Step 2: model', null, m('4H', stats.botModell4h, stats.botLernlauf4h) + '<br>' + m('Daily', stats.botModell1d, stats.botLernlauf1d) +
            `<br>Live predictions: ${B.n || 0} \u00b7 evaluated ${B.ausgewertet || 0}` + (B.ausgewertet ? ` \u00b7 ${pct(B.treffer)} correct` : '')); })()}
      </div>
    </section>
    <section class="page">
      <div class="page-title">3 · THORChain market (addresses, not people)</div>
      ${markt ? (() => {
        const f = n => n == null ? '\u2014' : Number(n).toLocaleString('en-US');
        const b = markt.bonder || {}, g = b.nachGroesse || {}, rw = markt.runeWatch || {}, nd = markt.nodes || {};
        const maxK = Math.max(1, ...Object.values(g));
        const zeile = (l, n) => `<div class="depth-row"><div class="depth-label">${l}</div><div class="depth-bar-track"><div class="depth-bar-fill" style="width:${Math.round((n || 0) / maxK * 100)}%"></div></div><div style="text-align:right;">${f(n)}</div><div></div></div>`;
        return `<div class="grid">
          <div class="sec">Bonding</div>
          ${tile('m-bonder', 'Bonders', f(b.adressen), 'bond provider addresses, all nodes')}
          ${tile('m-rw', 'rune.watch bonders', f(rw.davonBonder), (rw.anteilAnBondern != null ? rw.anteilAnBondern + ' % of all bonders' : ''))}
          ${tile('m-bond', 'Share of total bond', rw.anteilAmBond != null ? rw.anteilAmBond + ' %' : '\u2014', f(rw.bondRUNE) + ' of ' + f(b.bondRUNE) + ' RUNE')}
          ${tile('m-ops', 'Node operators', f(nd.betreiber), f(nd.aktiv) + ' active of ' + f(nd.gesamt) + ' nodes')}
          <div class="tile wide"><div class="tile-label" style="margin-top:0; margin-bottom:10px;">Bonders by size (RUNE)</div>
            ${zeile('< 1k', g['unter 1.000'])}${zeile('1k\u201310k', g['1.000-10.000'])}${zeile('10k\u2013100k', g['10.000-100.000'])}${zeile('> 100k', g['ueber 100.000'])}
          </div>
          <div class="sec">Holders</div>
          ${tile('m-tcys', 'TCY stakers', f(markt.tcyGestakt && markt.tcyGestakt.adressen), 'staked TCY, native')}
          ${tile('m-tcyw', 'TCY in wallets', f(markt.tcyHalter && markt.tcyHalter.adressenGesamt), f(markt.tcyHalter && markt.tcyHalter.abMindestmenge) + ' with \u2265 1 TCY')}
          ${tile('m-brune', 'bRUNE / ybRUNE', f(markt.bruneHalter && markt.bruneHalter.adressenGesamt) + ' / ' + f(markt.ybruneHalter && markt.ybruneHalter.adressenGesamt), 'holder addresses')}
          ${tile('m-pool', 'RUNEPool', f(markt.runePool && markt.runePool.adressen), 'provider addresses')}
          ${tile('m-rune', 'RUNE accounts', f(markt.runeHalter && markt.runeHalter.adressenGesamt), f(markt.runeHalter && markt.runeHalter.abMindestmenge) + ' with \u2265 10 RUNE' + (markt.runeHalter && !markt.runeHalter.vollstaendig ? ' (counted part)' : ''))}
          ${tile('m-rwall', 'rune.watch addresses', f(rw.adressen), 'entered in rune.watch')}
        </div>
        <div class="tile-hint" style="margin-top:8px;">As of ${String(markt.stand || '').replace('T', ' ').slice(0, 16)} UTC \u00b7 refreshed every 12\u201324 h \u00b7 exchanges and contracts count as single addresses.</div>`;
      })() : '<div class="tile-hint">Market data not available right now.</div>'}
    </section>
  </div>

  <div class="dots">
    <button class="dot-nav active" data-page="0" aria-label="Page 1: addresses"></button>
    <button class="dot-nav" data-page="1" aria-label="Page 2: visitors"></button>
    <button class="dot-nav" data-page="2" aria-label="Page 3: market"></button>
  </div>

  <div class="refresh"><span class="dot"></span><span id="stamp">As of ${new Date().toLocaleString('en-GB', { timeZone: 'UTC' })} UTC · updating live</span></div>
  <div class="version">Worker ${WORKER_VERSION}</div>
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
    setText('v-vis7', latestStats.visitorsAvgDay7 == null ? '\u2014' : latestStats.visitorsAvgDay7);
    setText('v-vis30', latestStats.visitorsAvgDay30 == null ? '\u2014' : latestStats.visitorsAvgDay30);
    setText('v-rb1', latestStats.runebondClicksTotal == null ? '—' : latestStats.runebondClicksTotal);
    setText('h-rb1', latestStats.runebondClicksLast1d == null ? 'no data yet' : latestStats.runebondClicksLast1d + ' in the last 24h');
    if (latestStats.runebondRef) { setText('v-rbref', latestStats.runebondRef.gebondet); setText('h-rbref', latestStats.runebondRef.runeGebondet.toLocaleString('en-US') + ' RUNE bonded \u00b7 ' + latestStats.runebondRef.anfragen + ' whitelist request' + (latestStats.runebondRef.anfragen === 1 ? '' : 's') + ' \u00b7 ' + latestStats.runebondRef.wallets + ' wallet' + (latestStats.runebondRef.wallets === 1 ? '' : 's')); }
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
  const seiten = [...pager.querySelectorAll('.page')];
  let aktiv = 0;
  function zeige(i) {
    if (i < 0 || i >= seiten.length || i === aktiv && seiten[i].classList.contains('aktiv')) return;
    const vonLinks = i < aktiv;
    seiten.forEach((sp, j) => { sp.classList.toggle('aktiv', j === i); sp.classList.toggle('von-links', j === i && vonLinks); });
    dots.forEach((d, j) => d.classList.toggle('active', j === i));
    tabs.forEach((d, j) => d.classList.toggle('active', j === i));
    aktiv = i;
    const oben = pager.getBoundingClientRect().top + window.scrollY - 70;
    if (window.scrollY > oben) window.scrollTo({ top: Math.max(0, oben), behavior: 'smooth' });
  }
  [...dots, ...tabs].forEach(d => d.addEventListener('click', () => zeige(Number(d.dataset.page))));
  // Wischen wie in der App: deutlich waagerecht (> 50 px und mehr als senkrecht) -> naechste/vorige Seite
  let sx = 0, sy = 0, wisch = false;
  pager.addEventListener('touchstart', e => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; wisch = true; }, { passive: true });
  pager.addEventListener('touchend', e => {
    if (!wisch) return; wisch = false;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) zeige(aktiv + (dx < 0 ? 1 : -1));
  }, { passive: true });
  seiten.forEach((sp, j) => sp.classList.toggle('aktiv', j === 0));

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

const DEX_VOLUME_STALE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 Tage: lieber aeltere Zahlen als "nicht verfuegbar" (gemeldet)

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
      if (url.pathname.startsWith('/n/')) {
        return await handleNodeKurzlink(request, env, ctx);
      }
      if (url.pathname === '/rb-pruefung') {
        // NACHPRUEFEN (gemeldet: "die Zahlen koennen nicht stimmen"): oeffentliche Rohdaten der RUNEBond-Zaehlung --
        // wie viele Anfragen RUNEBond liefert, wie viele Memos geprueft sind, Beispiel-Memos und unsere Kennungen.
        const erg = await runebondEmpfehlungen(env).catch(e => ({ fehler: String(e && e.message || e) }));
        return json({ ergebnis: erg, beispiele: RB_PRUEF_BEISPIELE.slice(0, 12), apiSchluessel: !!env.RUNEBOND_API_KEY, affiliateVariable: String(env.RUNEBOND_AFFILIATE || '') }, env);
      }
      if (url.pathname === '/bot-prognose') {
        const coin = String(url.searchParams.get('coin') || 'RUNE').toUpperCase(), iv = url.searchParams.get('ebene') === '1d' ? '1d' : '4h';
        if (!RW_BOT_COINS.includes(coin)) return json({ error: 'UNKNOWN_COIN' }, env, 400);
        const [pr, live] = await Promise.all([botPrognose(env, coin, iv), botLiveBilanz(env)]);
        return json({ ...pr, live }, env);
      }
      if (url.pathname === '/bot-historie' && request.method === 'POST') {
        // Lange Historie vom Browser (Backtest-Seite) annehmen: der Browser darf Binance abrufen, Cloudflare nicht.
        if (!env.STATS_ACCESS_KEY || url.searchParams.get('key') !== env.STATS_ACCESS_KEY) return json({ error: 'UNAUTHORIZED' }, env, 401);
        const b = await request.json().catch(() => null);
        const coin = b && String(b.coin || '').toUpperCase(), iv = b && b.ebene;
        if (!b || !RW_BOT_COINS.includes(coin) || !RW_BOT_EBENEN[iv] || !Array.isArray(b.kerzen) || b.kerzen.length < 240 || b.kerzen.length > 4000) return json({ error: 'BAD_REQUEST' }, env, 400);
        const k = b.kerzen.map(x => ({ date: Number(x[0]), open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] }))
          .filter(x => x.date > 0 && x.close > 0).sort((a, c) => a.date - c.date);
        await botSammlerTabellen(env);
        const rows = rwBotMerkmale(k, RW_BOT_EBENEN[iv].h, 0);
        await rwBotSchreiben(env, coin, iv, rows);
        await env.DB.prepare('INSERT OR REPLACE INTO bot_status (k, v) VALUES (?, ?)').bind('hist:' + coin + ':' + iv, 'fertig').run();
        return json({ ok: true, coin, ebene: iv, faelle: rows.length }, env);
      }
      if (url.pathname === '/bot-pruefung') {
        // Sofort einen Lauf ausloesen und Fehler sehen (nur mit Statistik-Schluessel).
        if (!env.STATS_ACCESS_KEY || url.searchParams.get('key') !== env.STATS_ACCESS_KEY) return json({ error: 'UNAUTHORIZED' }, env, 401);
        if (url.searchParams.get('lernen') === '1') {
          const l4 = await rwDiagLauf(env, 'lernen4h', () => botLernen(env, '4h'));
          const l1 = await rwDiagLauf(env, 'lernen1d', () => botLernen(env, '1d'));
          return json({ lernen4h: l4, lernen1d: l1, prognoseRUNE: await botPrognose(env, 'RUNE', '4h') }, env);
        }
        const live = await rwDiagLauf(env, 'live', () => liveMitschreiber(env));
        const bot = await rwDiagLauf(env, 'bot', () => botSammler(env));
        return json({ live, bot, stand: await botStand(env), liveBilanz: await liveBilanz(env) }, env);
      }
      if (url.pathname === '/bonder-zahl') {
        return await handleBonderZahl(request, env);
      }
      if (url.pathname === '/rw-apy') {
        return await handleRwApy(request, env);
      }
      if (url.pathname === '/mg/actions') {
        return await handleMidgardActions(request, env);
      }
      if (url.pathname === '/thor-tx') {
        return await handleThorTx(request, env);
      }
      if (url.pathname === '/rw-swaps') {
        return await handleRwSwaps(request, env);
      }
      if (url.pathname === '/chain-addrs') {
        return await handleChainAddrs(request, env, ctx);
      }
      if (url.pathname === '/chain-balances') {
        return await handleChainBalances(request, env);
      }
      if (url.pathname === '/podcast') {
        // THORCHAIN-PODCAST fuer den Player in der App: Folgenliste aus dem oeffentlichen RSS-Feed
        // (rss.com). Der Browser darf den Feed wegen CORS nicht selbst lesen, deshalb holt ihn der
        // Worker und gibt eine kleine Liste zurueck; zwischengespeichert fuer 1 Stunde.
        await sicherePushTabellen(env);
        const erg = await podcastFolgen(env, url.searchParams.get('fresh') === '1');
        return json(erg || { error: 'NO_FEED' }, env, erg ? 200 : 502);
      }
      if (url.pathname === '/chain-halts') {
        // WANN WURDEN CHAINS ANGEHALTEN? (Halt-Verlauf der letzten 30 Tage, aus Mimir)
        await sichereHaltTabelle(env);
        const r = await env.DB.prepare('SELECT key, start, zeit, zuletzt, aktiv FROM halt_verlauf ORDER BY start DESC').all();
        return json({ halts: ((r && r.results) || []).map(z => ({ key: z.key, ...haltArt(z.key), hoehe: z.start, zeit: z.zeit, aktiv: !!z.aktiv })) }, env);
      }
      if (url.pathname === '/node-leaves') {
        // WANN HAT EINE NODE ZUM ERSTEN MAL "LEAVE" GEDRUECKT? (fuer die Node-Karte der App)
        await sichereLeaveTabelle(env);
        const r = await env.DB.prepare('SELECT addr, hoehe, zeit, exakt FROM node_leave').all();
        const out = {};
        for (const z of (r && r.results) || []) out[z.addr] = { hoehe: z.hoehe, zeit: z.zeit, exakt: !!z.exakt };
        return json({ leaves: out }, env);
      }
      if (url.pathname === '/mimir-votes') {
        // OFFENE MIMIR-ABSTIMMUNGEN fuer die App (Uebersicht "Offene Abstimmungen").
        await sicherePushTabellen(env);
        const erg = await offeneAbstimmungen(env, null, url.searchParams.get('fresh') === '1');
        return json(erg || { error: 'NO_DATA' }, env, erg ? 200 : 502);
      }
      if (url.pathname === '/purchases') {
        return await handlePurchases(request, env, ctx);
      }
      if (url.pathname === '/wallets') {
        return await handleWallets(request, env, ctx);
      }
      if (url.pathname === '/daten-loeschen') {
        return await handleDatenLoeschen(request, env);
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
        return await handleStats(request, env, ctx);
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
    // EIGENER MINUTEN-TAKT FUER PUSH (gemeldet: "alles sehr zeitversetzt"): Push lief nur im
    // grossen Durchgang. Mit einem zweiten Cron "* * * * *" in wrangler.toml laeuft er jede Minute
    // allein (schnell, kein Dune/Swap-Paare davor); der grosse Durchgang bleibt wie er ist.
    if (event && event.cron === '* * * * *') {
      // LIVE-MITSCHREIBER + LERNENDER BOT in eigenen Aufrufen (gemeldet: "keine Ergebnisse"): vorher liefen sie
      // vorn im grossen Durchgang und teilten sich dessen Budget. Jetzt: Minute 30 = Live-Signale,
      // Minuten 33/38/43/48 = Bot (Historie also 4 Paare pro Stunde, danach laufend).
      ctx.waitUntil(rwPlanLaeufe(env));
      ctx.waitUntil((async () => {
        const t0 = Date.now();
        try { await syncPush(env); } catch (e) { console.warn('[push] minute', e?.message || e); }
        // Danach alle 6 Sekunden (feste Zeitpunkte ab Minutenbeginn), bis kurz vor dem naechsten Lauf.
        for (let k = 1; k < 10; k++) {
          const ziel = t0 + k * 6000;
          if (ziel > t0 + 54000) break;
          const warten = ziel - Date.now();
          if (warten > 0) await new Promise(r => setTimeout(r, warten));
          if (Date.now() - t0 > 56000) break;
          try { await syncPushSchnell(env); } catch (e) { console.warn('[push] 6s', e?.message || e); }
        }
      })());
      return;
    }
    ctx.waitUntil(runRefreshCycle(env));
    // FIX (gemeldet: "Run status" blieb stehen): falls kein Minuten-Takt eingerichtet ist, laufen die Bot-Teile
    // hier mit -- sie pruefen selbst, ob sie faellig sind.
    ctx.waitUntil(rwPlanLaeufe(env));
  },
};
// Faelligkeit statt fester Minuten: funktioniert mit jedem Cron-Takt (minuetlich oder stuendlich).
let rwPlanLaeuftGerade = false;
async function rwPlanLaeufe(env) {
  if (rwPlanLaeuftGerade) return; rwPlanLaeuftGerade = true;
  try {
    const alter = async n => { const L = await rwLaufInfo(env, n); return L ? Date.now() - L.at : Infinity; };
    if (await alter('live') > 55 * 60e3) await rwDiagLauf(env, 'live', () => liveMitschreiber(env));
    if (await alter('bot') > 14 * 60e3) await rwDiagLauf(env, 'bot', () => botSammler(env));
    for (const iv of ['4h', '1d']) {
      const M = await botModell(env, iv), a = await alter('lernen' + iv);
      // woechentlich neu lernen; ohne Modell taeglich ein neuer Versuch
      if (a > 7 * 864e5 || (!M && a > 864e5)) await rwDiagLauf(env, 'lernen' + iv, () => botLernen(env, iv));
    }
  } catch (e) { console.warn('[plan]', e && e.message); }
  finally { rwPlanLaeuftGerade = false; }
}

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
  // ZEITVERSATZ (gemeldet: "alles sehr zeitversetzt"): iPhones stellen "normal" gebuendelt und
  // spaeter zu. Jetzt ist alles "high" ausser dem Wochen-Review und dem Test.
  const tagStr = String(nachricht && nachricht.tag || '');
  const dringend = !/^rw-(woche|push-test)/.test(tagStr);
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
      churn: !!p.churn, node: !!p.node, bond: !!p.bond, thorname: !!p.thorname, woche: p.woche !== false, tcy: p.tcy !== false, abst: p.abst !== false,
      preisOben: Number(p.preisOben) > 0 ? Number(p.preisOben) : null, preisUnten: Number(p.preisUnten) > 0 ? Number(p.preisUnten) : null });
    // Nur THORChain-Adressen, nur wenn persoenliche Themen an sind, hoechstens 20.
    const persoenlich = !!(p.churn || p.node || p.bond || p.thorname || p.woche !== false || p.tcy !== false || p.abst !== false);
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
    // Neue Podcast-Folge: AUTOMATISCH fuer alle (gewuenscht) -- nur wer es ausdruecklich abgeschaltet hat, nicht
    if (thema === 'podcast' ? p.podcast === false : !p[thema]) continue;
    const nachricht = baue(row.lang === 'de', p, row);
    if (!nachricht) continue;
    try { if ((await pushSenden(env, row, nachricht)) === 'ok') n++; } catch (e) {}
  }
  return n;
}
// CRON: Ereignisse erkennen und verschicken.
// HALTS + UPDATES SCHNELL (gemeldet: "Chain Halts, THORChain Updates sind sehr zeitversetzt, meistens
// minutenlang -- ich will sofortige Meldung"): Cron laeuft hoechstens einmal pro Minute. Fuer diese
// zeitkritischen Themen prueft der Minuten-Takt deshalb zusaetzlich alle 15 Sekunden (4 Pruefungen
// je Minute) -- nur Halts und Updates, mit wenigen Abrufen. Andere Themen bleiben im Minutentakt.
async function syncHaltsOps(env) {
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
}
async function syncPreisAlarm(env) {
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
        const zNeu = JSON.stringify(z);
        if (zNeu !== (row.zustand || '')) await env.DB.prepare('UPDATE push_subs SET zustand = ? WHERE id = ?').bind(zNeu, row.id).run();
      }
    }
  } catch (e) { console.warn('[push] preis', e?.message || e); }
}
// 6-SEKUNDEN-TAKT (gewuenscht: "jede Einstellung jede Sekunde pruefen" -- sinnvoll ist einmal je
// THORChain-Block, also etwa alle 6 Sekunden; oefter aendert sich der Zustand nicht). Prueft alle
// zeitkritischen Themen: Halts, Updates, Preis, Nodes, Slash, Rewards, Abstimmungen. Spenden laufen
// im Minutentakt (sie kommen aus dem grossen Durchgang).
async function syncPushSchnell(env) {
  await sicherePushTabellen(env);
  const anzahl = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs').first();
  if (!Number(anzahl && anzahl.n)) return;
  try { await syncHaltsOps(env); } catch (e) { console.warn('[push] halts 6s', e?.message || e); }
  try { await syncPreisAlarm(env); } catch (e) { console.warn('[push] preis 6s', e?.message || e); }
  try { await syncPushPersoenlich(env); } catch (e) { console.warn('[push] persoenlich 6s', e?.message || e); }
}
async function syncPush(env) {
  await sicherePushTabellen(env);
  const anzahl = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs').first();
  if (!Number(anzahl && anzahl.n)) return;
  // Nicht doppelt laufen (Minuten-Takt + grosser Durchgang in derselben Minute): sonst koennte
  // dieselbe Meldung zweimal rausgehen.
  const zuletzt = Number(await pushState(env, 'pushLauf')) || 0;
  if (Date.now() - zuletzt < 45000) return;
  await pushStateSet(env, 'pushLauf', Date.now());
  // 1)-3) HALTS und THORCHAIN-UPDATES (eigene Funktion, laeuft im Minuten-Takt zusaetzlich alle 15 s)
  await syncHaltsOps(env);
  // 4) PREIS-ALARM je Abo (eigene Funktion, laeuft auch im 6-Sekunden-Takt)
  await syncPreisAlarm(env);
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
// OFFENE MIMIR-ABSTIMMUNGEN (gewuenscht: "Wie koennte man jeden Node kontaktieren?" -- Devs im Discord:
// "BPs, wenn eure Node unter 'Not Voted' steht, macht eurem Betreiber Druck"). THORNode liefert unter
// /thorchain/mimir/nodes_all jede Stimme (Schluessel, Wert, Node). Gezaehlt werden nur AKTIVE Nodes.
// Angenommen ist ein Wert ab 2/3 der aktiven Nodes. "Offen" = mindestens 5 Stimmen, aber die
// staerkste Antwort hat die Mehrheit noch nicht. Zwischengespeichert fuer 30 Sekunden.
async function offeneAbstimmungen(env, nodesVorab, frisch) {
  if (!frisch) {
    try {
      const c = JSON.parse((await pushState(env, 'abstCache')) || 'null');
      if (c && Date.now() - c.t < 30e3) return c;
    } catch (e) {}
  }
  const nodes = Array.isArray(nodesVorab) ? nodesVorab : await fetchFromBases(getThornodeBases(), '/thorchain/nodes').catch(() => null);
  const roh = await fetchFromBases(getThornodeBases(), '/thorchain/mimir/nodes_all').catch(() => null);
  if (!Array.isArray(nodes) || !roh) return null;
  const stimmen = Array.isArray(roh) ? roh : (Array.isArray(roh.mimirs) ? roh.mimirs : []);
  const aktiv = nodes.filter(n => String(n && n.status) === 'Active').map(n => String(n.node_address).toLowerCase());
  const aktivSet = new Set(aktiv);
  const noetig = Math.ceil(aktiv.length * 2 / 3);
  const jeSchluessel = new Map();
  for (const v of stimmen) {
    const key = String(v && v.key || '').toUpperCase(), sig = String(v && v.signer || '').toLowerCase();
    if (!key || !aktivSet.has(sig)) continue;
    if (!jeSchluessel.has(key)) jeSchluessel.set(key, new Map());
    jeSchluessel.get(key).set(sig, String(v.value));
  }
  const liste = [];
  for (const [key, m] of jeSchluessel) {
    if (m.size < 5) continue;
    const werte = new Map();
    for (const w of m.values()) werte.set(w, (werte.get(w) || 0) + 1);
    const sortiert = [...werte.entries()].sort((a, b) => b[1] - a[1]);
    const [topWert, topAnzahl] = sortiert[0];
    if (topAnzahl >= noetig) continue;
    liste.push({ key, wert: topWert, stimmen: topAnzahl, noetig, abgestimmt: m.size, werte: sortiert.slice(0, 4).map(([w, n]) => ({ w, n })),
      fehlen: aktiv.filter(a => !m.has(a)) });
  }
  liste.sort((a, b) => b.stimmen / b.noetig - a.stimmen / a.noetig);
  const erg = { t: Date.now(), aktiv: aktiv.length, noetig, liste: liste.slice(0, 20) };
  try { await pushStateSet(env, 'abstCache', JSON.stringify(erg)); } catch (e) {}
  return erg;
}
const runeTxt = x => Number(x).toLocaleString('en-US', { maximumFractionDigits: Math.abs(x) >= 100 ? 1 : 2 });
// VULTISIG-HINWEIS IN PUSH-NACHRICHTEN (gewuenscht: "wenn User Push-Nachrichten bekommen, soll auch drin
// stehen, dass man mit Vultisig bonden kann"). Kurz, ans Ende -- iOS zeigt nur ein paar Zeilen.
const vultisigHinweis = (de, art) => {
  const T = {
    bond: de ? 'Mehr bonden: mit Vultisig in rune.watch' : 'Bond more: with Vultisig on rune.watch',
    neu: de ? 'Neu bonden: mit Vultisig in rune.watch' : 'Bond again: with Vultisig on rune.watch',
    name: de ? 'Verl\u00e4ngern: mit Vultisig in rune.watch' : 'Renew: with Vultisig on rune.watch',
    tcy: de ? 'Mehr staken: mit Vultisig in rune.watch' : 'Stake more: with Vultisig on rune.watch',
  };
  return ' \u00b7 ' + (T[art] || T.bond);
};
async function syncPushPersoenlich(env) {
  const r = await env.DB.prepare("SELECT * FROM push_subs WHERE fails < 20 AND adressen IS NOT NULL AND adressen != '[]'").all();
  const subs = r.results || [];
  if (!subs.length) return;
  const nodes = await fetchFromBases(getThornodeBases(), '/thorchain/nodes').catch(() => null);
  if (!Array.isArray(nodes)) return;
  // LETZTER CHURN DIREKT AUS THORNODE (gemeldet: "alles sehr zeitversetzt", Rewards kamen spaet
  // oder gar nicht): Vorher kam die Churn-Hoehe von Midgard, das oft Minuten bis Stunden
  // hinterherhinkt. Stieg der Bond nach dem Churn schon, war fuer Midgard aber noch kein neuer
  // Churn da, wurde der Zuwachs nicht als Reward erkannt -- und spaeter fehlte er, weil der neue
  // Bond schon die Basis war. Jetzt: hoechstes status_since aller AKTIVEN Nodes = Hoehe des
  // letzten Churns (in den aktiven Satz kommt man nur beim Churn). Midgard nur noch als Rueckfall.
  let churnH = null;
  const aktivSeit = nodes.filter(n => String(n && n.status) === 'Active').map(n => Number(n.status_since) || 0);
  if (aktivSeit.length) churnH = String(Math.max(...aktivSeit));
  if (!churnH || churnH === '0') {
    const churns = await fetchFromBases(getMidgardBases(), '/churns').catch(() => null);
    churnH = Array.isArray(churns) && churns[0] ? String(churns[0].height) : null;
  }
  const st = await fetchFromBases(getMidgardBases(), '/stats').catch(() => null);
  const preis = Number(st && st.runePriceUSD) || null;
  const heute = new Date().toISOString().slice(0, 10);
  let abst = null;
  try { abst = await offeneAbstimmungen(env, nodes, false); } catch (e) { abst = null; }
  for (const row of subs) { try { await pushEinAbo(env, row, nodes, churnH, preis, heute, abst); } catch (e) { console.warn('[push] Abo', row.id, e?.message || e); } }
}
// EIN ABO (eigene Funktion, damit ein Fehler bei einem Abo nicht alle folgenden stoppt -- vorher
// brach die ganze Schleife ab, und alle spaeteren Abos bekamen in diesem Durchgang nichts).
async function pushEinAbo(env, row, nodes, churnH, preis, heute, abst) {
  {
    let p = {}, z = {}, adr = [];
    try { p = JSON.parse(row.prefs || '{}'); } catch (e) {}
    try { z = JSON.parse(row.zustand || '{}'); } catch (e) {}
    try { adr = JSON.parse(row.adressen || '[]'); } catch (e) {}
    if (!adr.length) return;
    // VERALTETE SERVER-ANTWORT ERKENNEN (gemeldet: "+2.623,2 RUNE" kam zweimal, obwohl seither kein Churn
    // war -- der Churn ist sogar angehalten): Die THORNode-Server antworten nicht alle vom selben Stand.
    // Lieferte einer einen aelteren Stand (letzter Churn VOR dem bekannten), sah der naechste aktuelle Lauf
    // wie ein neuer Churn aus, und der damalige Bond-Zuwachs wurde ein zweites Mal als Reward gemeldet.
    // Jetzt: Die Churn-Hoehe darf nur steigen. Ein Stand mit niedrigerer Hoehe wird fuer dieses Abo
    // komplett uebersprungen (keine Meldung, kein Speichern) -- der naechste Lauf holt sich frische Daten.
    const churnMax = Number(z.churnMax || z.churn || 0);
    if (churnH && churnMax && Number(churnH) < churnMax) return;
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
      const churnNeu = !!(churnH && churnMax && Number(churnH) > churnMax); // nur echte, NEUE Churns
      for (const [na, v] of Object.entries(neu)) {
        const a = alt[na];
        if (!a) continue;
        // Statusmeldungen nur fuer Nodes, bei denen wirklich Bond liegt (oder lag) -- nicht fuer
        // Nodes, bei denen die Wallet nur freigeschaltet ist (0 RUNE).
        const echterBond = v.b > 0.01 || a.b > 0.01;
        if (p.node && echterBond && a.s !== v.s) {
          if (v.s === 'Active') meldungen.push({ titel: 'rune.watch', text: de ? `Deine Node ${kurzNode(na)} ist wieder aktiv` : `Your node ${kurzNode(na)} is active again`, tag: 'rw-node-' + na });
          else if (a.s === 'Active') meldungen.push({ titel: 'rune.watch', text: de ? `Deine Node ${kurzNode(na)} ist nicht mehr aktiv (${v.s})` : `Your node ${kurzNode(na)} is no longer active (${v.s})`, tag: 'rw-node-' + na });
        }
        if (p.node && echterBond && v.l && !a.l) meldungen.push({ titel: 'rune.watch', text: de ? `Deine Node ${kurzNode(na)}: Austritt angefragt` : `Your node ${kurzNode(na)}: leave requested`, tag: 'rw-leave-' + na });
        // Nur gemeinsame Adressen vergleichen; alte Eintraege ohne Aufschluesselung -> kein Slash-Test.
        const gemeinsam = a.pa ? Object.keys(v.pa || {}).filter(k => k in a.pa) : [];
        const delta = a.pa ? gemeinsam.reduce((q, k) => q + (v.pa[k] - a.pa[k]), 0) : (churnNeu ? v.b - a.b : 0);
        // Ein echter Slash senkt auch den Gesamt-Bond der Node (mindestens um unseren Anteil).
        const nodeSank = a.tb > 0 && v.tb > 0 ? (a.tb - v.tb) >= Math.max(0.5, -delta * 0.9) : false;
        if (churnNeu && delta > 0) rewardSumme += delta;
        // Zuwachs OHNE erkannten Churn: bis zu 2 Stunden als Kandidat halten (alte Werte bleiben
        // die Basis). Kommt der Churn in dieser Zeit, zaehlt der Zuwachs als Reward; sonst war es
        // eine eigene Einzahlung und wird still uebernommen.
        else if (!churnNeu && delta > 0.01 && a.s === 'Active' && v.s === 'Active') {
          const k = (z.rewardKandidat || {})[na];
          if (!k || Date.now() - k.t < 2 * 3600e3) {
            z.rewardKandidat = { ...(z.rewardKandidat || {}), [na]: { t: k ? k.t : Date.now() } };
            neu[na] = { ...v, b: a.b, pa: { ...(v.pa || {}), ...Object.fromEntries(gemeinsam.map(q => [q, a.pa[q]])) }, tb: a.tb };
          } else delete z.rewardKandidat[na];
        }
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
        if (churnNeu && z.rewardKandidat && z.rewardKandidat[na]) delete z.rewardKandidat[na];
      }
      // Provider nicht mehr dabei (Bond zurueckgezahlt).
      // Nur melden, wenn die Adresse noch im Abo ist -- sonst wurde nur eine Wallet entfernt.
      if (p.bond) for (const [na, a] of Object.entries(alt)) if (!neu[na] && a.b > 1 && (!a.pa || Object.keys(a.pa).some(k => adr.includes(k)))) meldungen.push({ titel: 'rune.watch', text: de ? `Bond von Node ${kurzNode(na)} zur\u00fcckgezahlt (${runeTxt(a.b)} RUNE)` + vultisigHinweis(de, 'neu') : `Bond from node ${kurzNode(na)} returned (${runeTxt(a.b)} RUNE)` + vultisigHinweis(de, 'neu'), tag: 'rw-refund-' + na });
      // BETRAG AUS DER REWARD-HISTORIE (dieselbe Quelle wie die App): Fuer genau diesen Churn die Rewards
      // deiner Adressen nachladen und summieren. Gibt es dort Zeilen fuer den Churn, gilt deren Summe
      // (auch 0 -> keine Meldung); sonst bleibt der Bond-Zuwachs als Rueckfall.
      if (p.churn && rewardSumme > 0.01 && churnNeu) {
        try {
          const adrListe = adr.filter(a => isValidThorAddress(a)).slice(0, 10);
          for (const a of adrListe) {
            const tr = await env.DB.prepare('SELECT * FROM tracked_addresses WHERE bond_address = ?').bind(a).first().catch(() => null);
            if (tr) { try { await refreshOneAddress(env, tr, Date.now()); } catch (e) {} }
          }
          if (adrListe.length) {
            const platz = adrListe.map(() => '?').join(',');
            const r2 = await env.DB.prepare(`SELECT COUNT(*) AS n, SUM(reward_amount) AS s FROM bond_history_rows WHERE bond_address IN (${platz}) AND churn_height = ? AND reward_amount IS NOT NULL`)
              .bind(...adrListe, Number(churnH)).first();
            if (r2 && r2.n > 0) rewardSumme = Number(r2.s) || 0;
          }
        } catch (e) { console.warn('[push] Reward aus Historie:', e?.message || e); }
      }
      if (p.churn && rewardSumme > 0.01) meldungen.push({ titel: de ? 'Neue Bond-Rewards' : 'New bond rewards', text: '+' + runeTxt(rewardSumme) + ' RUNE' + (preis ? ' \u00b7 $' + (rewardSumme * preis).toFixed(2) : '') + vultisigHinweis(de, 'bond'), tag: 'rw-churn-' + churnH });
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
      if (alt && churnH && churnMax && Number(churnH) > churnMax) {
        let r2 = 0;
        for (const [na, v] of Object.entries(neu)) { const a = alt[na]; if (a && v.b - a.b > 0) r2 += v.b - a.b; }
        if (r2 > 0.01) { z.woche.rune = (Number(z.woche.rune) || 0) + r2; z.woche.churns = (Number(z.woche.churns) || 0) + 1; }
      }
      const sendeZeit = montag.getTime() + 8 * 3600e3;
      if (z.woche.key !== wocheKey && Date.now() >= sendeZeit) {
        const w = z.woche;
        // REWARDS AUS DER REWARD-HISTORIE (gemeldet: "falsche Angaben an Rewards" -- +2.623 RUNE aus 1 Churn,
        // obwohl der Bond in der Woche gleich blieb). Bisher zaehlte der Bericht jeden Bond-Anstieg bei einem
        // Churn-Wechsel; lag die gespeicherte Basis zu alt oder zu niedrig, landeten Einzahlungen bzw. mehrere
        // Wochen Zuwachs als "Reward" im Bericht. Jetzt dieselbe Quelle wie die Rewards-Historie der App
        // (bond_history_rows: Reward je Adresse und Churn), nur Churns aus der berichteten Woche. Fehlt dort
        // der letzte Churn, wird die Adresse vorher nachgeladen. Nur wenn es gar keine Historie gibt, bleibt
        // die alte Zaehlung als Rueckfall.
        try {
          const von = Date.parse(w.key + 'T00:00:00Z'), bis = von + 7 * 86400e3;
          const adrListe = adr.filter(a => isValidThorAddress(a)).slice(0, 20);
          if (adrListe.length && Number.isFinite(von)) {
            const letzter = await env.DB.prepare('SELECT MAX(height) AS h FROM churns_cache').first().catch(() => null);
            for (const a of adrListe) {
              const tr = await env.DB.prepare('SELECT * FROM tracked_addresses WHERE bond_address = ?').bind(a).first().catch(() => null);
              if (!tr) continue;
              const mx = await env.DB.prepare('SELECT MAX(churn_height) AS h FROM bond_history_rows WHERE bond_address = ?').bind(a).first().catch(() => null);
              if (letzter && letzter.h && (!mx || !mx.h || letzter.h > mx.h)) { try { await refreshOneAddress(env, tr, Date.now()); } catch (e) {} }
            }
            const platz = adrListe.map(() => '?').join(',');
            const rr = await env.DB.prepare(`SELECT churn_height, SUM(reward_amount) AS s FROM bond_history_rows WHERE bond_address IN (${platz}) AND reward_amount IS NOT NULL AND churn_timestamp >= ? AND churn_timestamp < ? GROUP BY churn_height`)
              .bind(...adrListe, von, bis).all();
            const zeilen = (rr && rr.results) || [];
            const gibtHistorie = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bond_history_rows WHERE bond_address IN (${platz})`).bind(...adrListe).first().catch(() => null);
            if (gibtHistorie && gibtHistorie.n > 0) {
              w.rune = zeilen.reduce((q, x) => q + (Number(x.s) || 0), 0);
              w.churns = zeilen.filter(x => Number(x.s) > 0).length;
            }
          }
        } catch (e) { console.warn('[push] Wochen-Rewards aus Historie:', e?.message || e); }
        if (p.woche !== false && bondJetzt > 0) {
          const pr = preis && w.preis0 ? ((preis / w.preis0 - 1) * 100) : null;
          const teile = [];
          teile.push(w.rune > 0.01 ? `+${runeTxt(w.rune)} RUNE` + (preis ? ` ($${(w.rune * preis).toFixed(0)})` : '') + (de ? ` aus ${w.churns} Churn${w.churns === 1 ? '' : 's'}` : ` from ${w.churns} churn${w.churns === 1 ? '' : 's'}`)
                                 : (de ? 'Keine neuen Rewards (kein Churn)' : 'No new rewards (no churn)'));
          teile.push((de ? 'Bond ' : 'Bond ') + runeTxt(bondJetzt) + ' RUNE');
          if (preis) teile.push('RUNE $' + preis.toFixed(3) + (pr != null ? ` (${pr >= 0 ? '+' : ''}${pr.toFixed(1)} %)` : ''));
          meldungen.push({ titel: de ? 'Deine Woche bei THORChain' : 'Your week on THORChain', text: teile.join(' \u00b7 ') + vultisigHinweis(de, 'bond'), tag: 'rw-woche-' + w.key });
        }
        z.woche = { key: wocheKey, rune: 0, churns: 0, preis0: preis || null };
      }
    }
    z.nodes = neu;
    if (churnH) { z.churn = churnH; z.churnMax = Math.max(churnMax, Number(churnH)); }
    // DEINE NODE HAT NOCH NICHT ABGESTIMMT (gewuenscht): Einmal je Abstimmung und Node. Bonder
    // haben den direkten Draht zum Betreiber -- genau sie sollen es erfahren.
    if (p.abst !== false && abst && Array.isArray(abst.liste)) {
      const offen = new Set();
      const gemeldet = z.abst || {};
      for (const a of abst.liste) {
        for (const na of Object.keys(neu)) {
          // Nur Nodes mit echtem Bond (nicht nur freigeschaltet mit 0 RUNE).
          if (neu[na].s !== 'Active' || !(neu[na].b > 0.01) || !a.fehlen.includes(String(na).toLowerCase())) continue;
          const k = a.key + ':' + na;
          offen.add(k);
          if (gemeldet[k]) continue;
          gemeldet[k] = Date.now();
          meldungen.push({ titel: 'rune.watch', tag: 'rw-abst-' + a.key + '-' + na,
            text: de ? `Deine Node ${kurzNode(na)} hat bei ${a.key} noch nicht abgestimmt (${a.stimmen}/${a.noetig}). Sprich deinen Betreiber an.`
                     : `Your node ${kurzNode(na)} hasn't voted on ${a.key} yet (${a.stimmen}/${a.noetig}). Ask your operator to vote.` });
        }
      }
      // Erledigte Abstimmungen vergessen (nach 30 Tagen auch alte Eintraege)
      for (const k of Object.keys(gemeldet)) if (!offen.has(k) && Date.now() - gemeldet[k] > 3600e3) delete gemeldet[k];
      z.abst = gemeldet;
    }
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
              text: (de ? `+${runeTxt(rune)} RUNE${usd} f\u00fcr ${runeTxt(gestakt)} gestakte TCY` : `+${runeTxt(rune)} RUNE${usd} for ${runeTxt(gestakt)} staked TCY`) + vultisigHinweis(de, 'tcy'),
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
            if (tage > 0 && tage < 30) meldungen.push({ titel: 'THORName', text: (de ? `\u201e${nm}\u201c l\u00e4uft in etwa ${Math.ceil(tage)} Tagen ab` : `"${nm}" expires in about ${Math.ceil(tage)} days`) + vultisigHinweis(de, 'name'), tag: 'rw-tn-' + nm });
          }
        }
      } catch (e) {}
    }
    for (const m of meldungen.slice(0, 5)) { try { await pushSenden(env, row, m); } catch (e) {} }
    const zNeu = JSON.stringify(z);
    if (zNeu !== (row.zustand || '')) await env.DB.prepare('UPDATE push_subs SET zustand = ? WHERE id = ?').bind(zNeu, row.id).run();
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

// LEAVE-ZEITPUNKT JE NODE (gewuenscht: \"zeigen, wann genau Nodes zum ersten Mal Leave gedrueckt
// haben\"): THORNode sagt nur requested_to_leave = true, nicht seit wann. Fuer jede Node mit diesem
// Kennzeichen sucht der Worker einmalig per Binaersuche ueber historische Blockhoehen die erste Hoehe,
// ab der das Kennzeichen gesetzt ist (etwa 20 Abfragen je Node, hoechstens 2 Nodes pro Durchgang),
// und die Uhrzeit dieses Blocks. Suchfenster 30 Tage; liegt es weiter zurueck, steht \"vor mehr als
// 30 Tagen\" (exakt = 0).
async function sichereLeaveTabelle(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS node_leave (addr TEXT PRIMARY KEY, hoehe INTEGER, zeit INTEGER, exakt INTEGER, gesehen INTEGER)').run();
}
async function syncLeaveZeiten(env) {
  await sichereLeaveTabelle(env);
  // Version 2: Eintraege der ersten Fassung neu suchen (gemeldet: beide Nodes standen mit derselben
  // Hoehe \"vor mehr als 30 Tagen\" -- vermutlich hat ein Server die Blockhoehe ignoriert und den
  // AKTUELLEN Stand geliefert).
  try { await env.DB.prepare('ALTER TABLE node_leave ADD COLUMN v INTEGER').run(); } catch (e) {}
  try { await env.DB.prepare('DELETE FROM node_leave WHERE v IS NULL').run(); } catch (e) {}
  const nodes = await fetchFromBases(getThornodeBases(), '/thorchain/nodes').catch(() => null);
  if (!Array.isArray(nodes)) return;
  const lb = await fetchFromBases(getThornodeBases(), '/thorchain/lastblock').catch(() => null);
  const curH = Number(Array.isArray(lb) && lb[0] && lb[0].thorchain) || 0;
  if (!curH) return;
  // NUR DER AKTUELLE CHURN (gewuenscht: "die Leaves nur fuer die aktuellen Churns"): Gesucht wird
  // zwischen dem letzten Churn und jetzt. Eintraege fuer Nodes, die nicht mehr aktiv mit Leave-Antrag
  // im Set stehen (schon ausgetreten), werden entfernt.
  const aktivSeit = nodes.filter(n => String(n && n.status) === 'Active').map(n => Number(n.status_since) || 0);
  const churnH = aktivSeit.length ? Math.max(...aktivSeit) : 0;
  const relevant = new Set(nodes.filter(n => n && n.requested_to_leave && String(n.status) === 'Active').map(n => String(n.node_address).toLowerCase()));
  try {
    const alle = ((await env.DB.prepare('SELECT addr FROM node_leave').all()).results || []).map(z => z.addr);
    for (const a of alle) if (!relevant.has(a)) await env.DB.prepare('DELETE FROM node_leave WHERE addr = ?').bind(a).run();
  } catch (e) {}
  const bekannt = new Set(((await env.DB.prepare('SELECT addr FROM node_leave').all()).results || []).map(z => z.addr));
  // NUR AKTIVE NODES (die beiden ersten Treffer waren laengst ausgetretene Nodes -- bei ihnen bleibt
  // requested_to_leave einfach stehen; ihr Zeitpunkt interessiert niemanden und verbrauchte die
  // Suche). Gesucht werden die, die beim naechsten Churn gehen. Bis zu 4 je Durchgang.
  const offen = nodes.filter(n => n && n.requested_to_leave && String(n.status) === 'Active' && !bekannt.has(String(n.node_address).toLowerCase())).slice(0, 4);
  if (!offen.length) return;
  // NUR SERVER, DIE ALTE STAENDE WIRKLICH LIEFERN: Probe mit /thorchain/lastblock?height=h -- ein
  // Archiv-Server antwortet mit h, ein normaler mit der aktuellen Hoehe.
  const holen = async (base, pfad) => {
    const r = await fetch(base + pfad, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  };
  let archiv = null;
  for (const b of getThornodeBases({ needsHeight: true })) {
    try {
      const probeH = curH - 50000;
      const j = await holen(b, `/thorchain/lastblock?height=${probeH}`);
      const h = Number(Array.isArray(j) && j[0] && j[0].thorchain) || 0;
      if (h && h <= probeH + 5) { archiv = b; break; }
    } catch (e) {}
  }
  if (!archiv) { console.warn('[leave] kein Archiv-Server liefert alte Staende'); return; }
  for (const n of offen) {
    const addr = String(n.node_address).toLowerCase();
    try {
      let fehler = 0;
      const gesetzt = async h => {
        try {
          const j = await holen(archiv, `/thorchain/node/${n.node_address}?height=${h}`);
          return !!(j && j.requested_to_leave);
        } catch (e) {
          if (e && (e.status === 404 || e.status === 400)) return false; // Node gab es da noch nicht
          if (++fehler > 3) throw e;
          return false;
        }
      };
      // Fenster: vom letzten Churn bis jetzt. War Leave schon beim letzten Churn gesetzt, wurde es
      // davor beantragt (exakt = 0, Zeit = letzter Churn).
      let hi = curH, lo = 0, exakt = 1;
      const start = churnH > 0 && churnH < curH ? churnH : Math.max(1, curH - 7 * 14400);
      if (!(await gesetzt(start))) lo = start; else hi = start;
      if (!lo) exakt = 0;
      else {
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (await gesetzt(mid)) hi = mid; else lo = mid;
        }
      }
      let zeit = Date.now() - (curH - hi) * 6000;
      // Blockzeit; ein zweiter Versuch, weil die Schaetzung (6 s je Block) ueber Monate um Tage abweicht
      for (let versuch = 0; versuch < 2; versuch++) {
        try {
          const b = await holen(archiv, `/thorchain/block?height=${hi}`);
          const t = b && ((b.header && b.header.time) || (b.block && b.block.header && b.block.header.time));
          const ms = t ? Date.parse(t) : NaN;
          if (Number.isFinite(ms)) { zeit = ms; break; }
        } catch (e) { await new Promise(r => setTimeout(r, 800)); }
      }
      await env.DB.prepare('INSERT OR REPLACE INTO node_leave (addr, hoehe, zeit, exakt, gesehen, v) VALUES (?, ?, ?, ?, ?, 2)').bind(addr, hi, Math.round(zeit), exakt, Date.now()).run();
    } catch (e) { console.warn('[leave] Suche', addr, e?.message || e); }
  }
  try { await env.DB.prepare('DELETE FROM node_leave WHERE gesehen < ?').bind(Date.now() - 90 * 86400e3).run(); } catch (e) {}
}

// HALT-VERLAUF (gewuenscht: \"angeben, wann die Chains gehalted wurden, besonders nach dem Double-
// Spending-Problem von ETH -- ich will nachweisen, dass die Nodes schon vorher leaven wollten\").
// THORChain fuehrt Halts als Mimir-Werte: HALT<CHAIN>CHAIN, HALT<CHAIN>TRADING, SOLVENCYHALT<CHAIN>CHAIN,
// HALTSIGNING<CHAIN>, HALTCHAINGLOBAL, HALTTRADING ... Der WERT ist die Blockhoehe, ab der der Halt gilt.
// Liest man Mimir an alten Hoehen (Archiv-Server), steht dort also direkt der Start jedes Halts --
// auch von Halts, die laengst wieder aufgehoben sind. Einmal am Tag werden 31 Tage rueckwaerts
// abgetastet (ein Abruf je 6 Stunden), sonst nur der aktuelle Stand; die Blockzeit je Start wird gespeichert.
const HALT_KEY_RE = /^(SOLVENCYHALT[A-Z0-9]+CHAIN|HALT[A-Z0-9]+CHAIN|HALT[A-Z0-9]+TRADING|HALTSIGNING[A-Z0-9]+|HALTCHAINGLOBAL|HALTTRADING|HALTCHURNING|NODEPAUSECHAINGLOBAL)$/;
function haltArt(key) {
  const k = String(key || '');
  let m;
  if ((m = /^SOLVENCYHALT([A-Z0-9]+)CHAIN$/.exec(k))) return { chain: m[1], art: 'solvency' };
  if ((m = /^HALTSIGNING([A-Z0-9]+)$/.exec(k))) return { chain: m[1], art: 'signing' };
  if (k === 'HALTCHAINGLOBAL') return { chain: 'ALL', art: 'chain' };
  // Node-Pause: einzelne Nodes koennen alle Chains fuer eine Weile pausieren; der Wert ist die Hoehe, BIS zu der die Pause gilt.
  if (k === 'NODEPAUSECHAINGLOBAL') return { chain: 'ALL', art: 'pause' };
  if (k === 'HALTTRADING') return { chain: 'ALL', art: 'trading' };
  if (k === 'HALTCHURNING') return { chain: 'ALL', art: 'churn' };
  if ((m = /^HALT([A-Z0-9]+)CHAIN$/.exec(k))) return { chain: m[1], art: 'chain' };
  if ((m = /^HALT([A-Z0-9]+)TRADING$/.exec(k))) return { chain: m[1], art: 'trading' };
  return { chain: '?', art: '?' };
}
async function sichereHaltTabelle(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS halt_verlauf (key TEXT, start INTEGER, zeit INTEGER, zuletzt INTEGER, aktiv INTEGER, PRIMARY KEY (key, start))').run();
}
async function archivBasis(curH) {
  const holen = async (base, pfad) => {
    const r = await fetch(base + pfad, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  };
  for (const b of getThornodeBases({ needsHeight: true })) {
    try {
      const probeH = curH - 50000;
      const j = await holen(b, `/thorchain/lastblock?height=${probeH}`);
      const h = Number(Array.isArray(j) && j[0] && j[0].thorchain) || 0;
      if (h && h <= probeH + 5) return { base: b, holen: pfad => holen(b, pfad) };
    } catch (e) {}
  }
  return null;
}
async function syncHaltVerlauf(env) {
  await sichereHaltTabelle(env);
  const lb = await fetchFromBases(getThornodeBases(), '/thorchain/lastblock').catch(() => null);
  const curH = Number(Array.isArray(lb) && lb[0] && lb[0].thorchain) || 0;
  if (!curH) return;
  const fund = new Map(); // key:start -> { key, start, aktiv }
  const lesen = (mimir, aktiv) => {
    if (!mimir || typeof mimir !== 'object') return;
    for (const [k0, v0] of Object.entries(mimir)) {
      const k = String(k0).toUpperCase(), v = Number(v0);
      if (!HALT_KEY_RE.test(k) || !(v > 1)) continue;
      // Node-Pause: Wert = Ende der Pause (darf in der Zukunft liegen); aktiv nur, solange das Ende noch kommt.
      const pause = k === 'NODEPAUSECHAINGLOBAL';
      if (!pause && v > curH) continue;
      const id = k + ':' + v;
      const alt = fund.get(id);
      const jetztAktiv = aktiv && (!pause || v > curH);
      fund.set(id, { key: k, start: v, aktiv: jetztAktiv || (alt && alt.aktiv) || false });
    }
  };
  // aktueller Stand
  const jetzt = await fetchFromBases(getThornodeBases(), '/thorchain/mimir').catch(() => null);
  lesen(jetzt, true);
  // Einmal am Tag: 31 Tage rueckwaerts abtasten
  const letzteSuche = Number(await pushState(env, 'haltVerlaufSuche')) || 0;
  let archiv = null;
  if (Date.now() - letzteSuche > 20 * 3600e3) {
    archiv = await archivBasis(curH);
    if (archiv) {
      // alle 6 Stunden (3600 Bloecke), damit auch kurze Halts von wenigen Stunden erfasst werden
      for (let schritt = 1; schritt <= 31 * 4; schritt++) {
        try { lesen(await archiv.holen(`/thorchain/mimir?height=${curH - schritt * 3600}`), false); } catch (e) {}
      }
      await pushStateSet(env, 'haltVerlaufSuche', Date.now());
    }
  }
  // Aktiv-Kennzeichen zuruecksetzen, dann speichern
  await env.DB.prepare('UPDATE halt_verlauf SET aktiv = 0').run();
  const bekannt = new Map(((await env.DB.prepare('SELECT key, start, zeit FROM halt_verlauf').all()).results || []).map(z => [z.key + ':' + z.start, z.zeit]));
  for (const [id, f] of fund) {
    let zeit = bekannt.get(id);
    if (!zeit || f.start > curH) {
      zeit = Date.now() - (curH - f.start) * 6000;
      try {
        if (!archiv) archiv = await archivBasis(curH);
        if (archiv) {
          if (f.start > curH) throw new Error('Zukunft');
          const b = await archiv.holen(`/thorchain/block?height=${f.start}`);
          const t = b && ((b.header && b.header.time) || (b.block && b.block.header && b.block.header.time));
          const ms = t ? Date.parse(t) : NaN;
          if (Number.isFinite(ms)) zeit = ms;
        }
      } catch (e) {}
    }
    await env.DB.prepare('INSERT INTO halt_verlauf (key, start, zeit, zuletzt, aktiv) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key, start) DO UPDATE SET zuletzt = excluded.zuletzt, aktiv = excluded.aktiv' + (bekannt.get(id) ? '' : ', zeit = excluded.zeit'))
      .bind(f.key, f.start, Math.round(zeit), Date.now(), f.aktiv ? 1 : 0).run();
  }
  // aelter als 45 Tage vergessen
  try { await env.DB.prepare('DELETE FROM halt_verlauf WHERE zeit < ?').bind(Date.now() - 45 * 86400e3).run(); } catch (e) {}
}
const PODCAST_FEEDS = ['https://media.rss.com/thorchain/feed.xml', 'https://rss.com/podcasts/thorchain/feed.xml'];
async function podcastFolgen(env, frisch) {
  if (!frisch) {
    try { const c = JSON.parse((await pushState(env, 'podcastCache')) || 'null'); if (c && Date.now() - c.t < 3600e3) return c; } catch (e) {}
  }
  let xml = null;
  for (const u of PODCAST_FEEDS) {
    try {
      const r = await fetch(u, { headers: { accept: 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(12000) });
      if (r.ok) { const t = await r.text(); if (/<item[\s>]/i.test(t)) { xml = t; break; } }
    } catch (e) {}
  }
  if (!xml) {
    try { const c = JSON.parse((await pushState(env, 'podcastCache')) || 'null'); if (c) return c; } catch (e) {}
    return null;
  }
  const text = (blk, tag) => {
    const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i').exec(blk);
    if (!m) return '';
    return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  };
  const attr = (blk, tag, a) => { const m = new RegExp('<' + tag + '[^>]*\\s' + a + '="([^"]+)"', 'i').exec(blk); return m ? m[1].replace(/&amp;/g, '&') : ''; };
  const dauer = d => { if (!d) return null; if (/^\d+$/.test(d)) return Number(d); const t = d.split(':').map(Number); return t.reduce((s, v) => s * 60 + (v || 0), 0) || null; };
  const kanal = xml.split(/<item[\s>]/i)[0];
  const showBild = attr(kanal, 'itunes:image', 'href') || text(kanal.replace(/[\s\S]*<image>/i, '<image>'), 'url');
  const folgen = xml.split(/<item[\s>]/i).slice(1).map(b => b.split(/<\/item>/i)[0]).map(b => ({
    titel: text(b, 'title'),
    datum: Date.parse(text(b, 'pubDate')) || null,
    audio: attr(b, 'enclosure', 'url'),
    dauer: dauer(text(b, 'itunes:duration')),
    bild: attr(b, 'itunes:image', 'href') || showBild,
    link: text(b, 'link'),
    beschreibung: text(b, 'itunes:summary') || text(b, 'description'),
  })).filter(f => f.titel && f.audio).slice(0, 40);
  const erg = { t: Date.now(), show: text(kanal, 'title') || 'THORChain Livestream Podcast', bild: showBild, folgen: folgen.map(f => ({ ...f, beschreibung: f.beschreibung.slice(0, 600) })) };
  try { await pushStateSet(env, 'podcastCache', JSON.stringify(erg)); } catch (e) {}
  return erg;
}
// RUNEBOND-EMPFEHLUNGEN (Hippo, RUNEBond: \"the affiliate address is now linked to the whitelist, so we can
// track which bonds come from Runewatch\"). Whitelist-Anfragen laufen on-chain an die RUNEBond-Adresse mit
//   TB:WHT:<node>:<wallet>:<RUNE-Menge>[:<affiliate>]
// Kommt die Anfrage ueber einen rune.watch-Link, steht unsere Affiliate-Adresse am Ende. Wir zaehlen diese
// Anfragen und pruefen in /thorchain/nodes, ob die Wallet bei der Node wirklich Bond haelt (= gebondet).
// Affiliate: THOR-Adresse des THORNames \"runewatch\" (oder Variable RUNEBOND_AFFILIATE, Komma-Liste).
let runebondRefCache = { at: 0, data: null };
async function runebondEmpfehlungen(env) {
  if (runebondRefCache.data && Date.now() - runebondRefCache.at < 10 * 60 * 1000) return runebondRefCache.data;
  const unsere = new Set(String(env.RUNEBOND_AFFILIATE || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  unsere.add('runewatch');
  try {
    const tn = await fetchFromBases(getThornodeBases(), '/thorchain/thorname/runewatch');
    const a = tn && Array.isArray(tn.aliases) ? tn.aliases.find(x => String(x.chain).toUpperCase() === 'THOR') : null;
    if (a && a.address) unsere.add(String(a.address).toLowerCase());
    if (tn && tn.owner) unsere.add(String(tn.owner).toLowerCase());
  } catch (e) {}
  // GENAUER UEBER DIE INTEGRATORS-API (Hippo, RUNEBond): je gelisteter Node die Whitelist-Anfragen mit Status
  // (pending/approved/bonded/rejected), echtem Bond und Transaktion. Von wem die Anfrage kam (unser Link?),
  // steht im Memo am Ende -- das liest der Worker je Transaktion EINMAL bei THORNode und merkt es sich.
  if (env && env.RUNEBOND_API_KEY) {
    try {
      const v = await runebondEmpfehlungenIntegrators(env, unsere);
      if (v) { runebondRefCache = { at: Date.now(), data: v }; return v; }
    } catch (e) { /* Rueckfall auf den Memo-Abgleich unten */ }
  }
  if (!runebondMemos.liste.length) { try { await runebondVonDerChain(); } catch (e) {} }
  const nodes = await fetchNodes().catch(() => []);
  const nachAddr = new Map((Array.isArray(nodes) ? nodes : []).map(n => [String(n.node_address).toLowerCase(), n]));
  const anfragen = [];
  for (const a of runebondMemos.liste) {
    const memo = String((a.metadata && a.metadata.send && a.metadata.send.memo) || a.memo || '').trim();
    if (!/^TB:WHT:/i.test(memo)) continue;
    const t = memo.split(':');
    if (t.length < 6) continue;
    const aff = t.slice(5).join(':').trim().toLowerCase();
    if (!unsere.has(aff)) continue;
    anfragen.push({ node: t[2].toLowerCase(), wallet: t[3].toLowerCase(), menge: Number(t[4]) >= 1e6 ? Number(t[4]) / 1e8 : Number(t[4]), zeit: a.date ? Math.round(Number(a.date) / 1e6) : null });
  }
  const paare = new Map();
  for (const x of anfragen) paare.set(x.node + '|' + x.wallet, x);
  let gebondet = 0, rune = 0;
  const wallets = new Set();
  for (const x of paare.values()) {
    wallets.add(x.wallet);
    const n = nachAddr.get(x.node);
    const p = ((n && n.bond_providers && n.bond_providers.providers) || []).find(q => String(q.bond_address).toLowerCase() === x.wallet);
    const b = p ? Number(p.bond) / 1e8 : 0;
    if (b > 0) { gebondet++; rune += b; }
  }
  const data = { anfragen: anfragen.length, wallets: wallets.size, gebondet, runeGebondet: Math.round(rune), letzte: anfragen.reduce((m, x) => Math.max(m, x.zeit || 0), 0) || null, memosGelesen: runebondMemos.liste.length };
  runebondRefCache = { at: Date.now(), data };
  return data;
}
const RB_MEMO_UNSER = new Map(); // txId -> true/false (Anfrage kam ueber rune.watch?)
const RB_PRUEF_BEISPIELE = []; // die ersten gelesenen Memos (oeffentlich), fuer /rb-pruefung
async function runebondEmpfehlungenIntegrators(env, unsere) {
  const basis = String(env.RUNEBOND_INTEGRATORS_BASE || RUNEBOND_INTEGRATORS_BASE).replace(/\/+$/, '');
  const kopf = { accept: 'application/json', 'x-api-key': String(env.RUNEBOND_API_KEY).trim() };
  const lr = await fetchWithTimeout(basis + '/v1/runebond/listed-nodes', { timeoutMs: 8000, headers: kopf });
  if (!lr.ok) return null;
  const lj = await lr.json();
  const nodes = (Array.isArray(lj && lj.nodes) ? lj.nodes : []).map(n => n && n.nodeAddress).filter(Boolean).slice(0, 40);
  if (!nodes.length) return null;
  // Gespeichert wird NUR das oeffentliche Ergebnis "Transaktion traegt die Kennung runewatch: ja/nein" (steht fuer jeden
  // sichtbar auf der Blockchain, nichts Persoenliches) -- damit die Zaehlung nach einem Neustart sofort vollstaendig ist.
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS rb_wht_memo2 (tx_id TEXT PRIMARY KEY, unser INTEGER)').run(); } catch (e) {}
  const alle = [];
  await Promise.all(nodes.map(async (addr) => {
    try {
      const r = await fetchWithTimeout(`${basis}/v1/nodes/${encodeURIComponent(addr)}/whitelist-requests?limit=100`, { timeoutMs: 8000, headers: kopf });
      if (!r.ok) return;
      const j = await r.json();
      for (const x of (Array.isArray(j && j.requests) ? j.requests : [])) if (x && x.txId) alle.push(x);
    } catch (e) {}
  }));
  // Memo je Transaktion: erst Arbeitsspeicher, dann Datenbank, dann THORNode (hoechstens 30 neue je Lauf)
  const offen = alle.filter(x => !RB_MEMO_UNSER.has(String(x.txId).toUpperCase()));
  if (offen.length) {
    try {
      const ids = offen.map(x => String(x.txId).toUpperCase());
      for (let i = 0; i < ids.length; i += 80) {
        const teil = ids.slice(i, i + 80);
        const rows = await env.DB.prepare(`SELECT tx_id, unser FROM rb_wht_memo2 WHERE tx_id IN (${teil.map(() => '?').join(',')})`).bind(...teil).all();
        for (const row of (rows.results || [])) RB_MEMO_UNSER.set(row.tx_id, !!row.unser);
      }
    } catch (e) {}
  }
  // parallel statt nacheinander (je Transaktion eine THORNode-Abfrage), hoechstens 30 neue je Lauf
  const zuPruefen = []; const gesehen = new Set();
  for (const x of alle) { const id = String(x.txId).toUpperCase(); if (!RB_MEMO_UNSER.has(id) && !gesehen.has(id) && zuPruefen.length < 30) { gesehen.add(id); zuPruefen.push(id); } }
  await Promise.all(zuPruefen.map(async (id) => {
    try {
      const t = await fetchFromBases(getThornodeBases(), `/thorchain/tx/${id}`);
      const memo = String((t && t.observed_tx && t.observed_tx.tx && t.observed_tx.tx.memo) || (t && t.tx && t.tx.memo) || '');
      const teile = memo.split(':').map(x => x.trim().toLowerCase());
      const ja = teile.slice(3).some(x => x && unsere.has(x));
      if (RB_PRUEF_BEISPIELE.length < 12) RB_PRUEF_BEISPIELE.push({ tx: id, memo, unser: ja });
      RB_MEMO_UNSER.set(id, ja);
      try { await env.DB.prepare('INSERT OR REPLACE INTO rb_wht_memo2 (tx_id, unser) VALUES (?, ?)').bind(id, ja ? 1 : 0).run(); } catch (e) {}
    } catch (e) { /* naechster Lauf */ }
  }));
  const unsereAnfragen = alle.filter(x => RB_MEMO_UNSER.get(String(x.txId).toUpperCase()) === true);
  const paare = new Map();
  for (const x of unsereAnfragen) paare.set(String(x.nodeAddress).toLowerCase() + '|' + String(x.providerAddress).toLowerCase(), x);
  let gebondet = 0, rune = 0, offenZahl = 0, freigegeben = 0;
  const wallets = new Set();
  for (const x of paare.values()) {
    wallets.add(String(x.providerAddress).toLowerCase());
    const b = Number(x.realBond) / 1e8;
    if (x.status === 'bonded' || b > 0) { gebondet++; rune += b > 0 ? b : 0; }
    else if (x.status === 'approved') freigegeben++;
    else if (x.status === 'pending') offenZahl++;
  }
  return { anfragen: unsereAnfragen.length, wallets: wallets.size, gebondet, runeGebondet: Math.round(rune), freigegeben, offen: offenZahl,
    letzte: unsereAnfragen.reduce((m, x) => Math.max(m, Date.parse(x.requestedAt) || 0), 0) || null,
    quelle: 'integrators', geprueft: alle.length, nochOhneMemo: alle.filter(x => !RB_MEMO_UNSER.has(String(x.txId).toUpperCase())).length };
}
// NEUE PODCAST-FOLGE MELDEN (gewuenscht): Alle 30 Minuten den Feed frisch lesen; ist die neueste Folge eine
// andere als zuletzt gemerkt, Push an alle, die das Thema \"Neue Podcast-Folge\" eingeschaltet haben.
// Antippen oeffnet rune.watch mit der Folgenliste (#podcast).
async function syncPodcastMeldung(env) {
  await sicherePushTabellen(env);
  const zuletzt = Number(await pushState(env, 'podcastPruefT')) || 0;
  if (Date.now() - zuletzt < 30 * 60e3) return;
  await pushStateSet(env, 'podcastPruefT', String(Date.now()));
  const d = await podcastFolgen(env, true).catch(() => null);
  const f = d && Array.isArray(d.folgen) ? d.folgen[0] : null;
  if (!f || !f.audio) return;
  const alt = await pushState(env, 'podcastNeueste');
  if (alt === f.audio) return;
  await pushStateSet(env, 'podcastNeueste', f.audio);
  if (!alt) return; // erster Lauf: nur merken, nichts melden
  if (f.datum && Date.now() - f.datum > 3 * 864e5) return; // keine alten Folgen nachmelden
  await pushAnThema(env, 'podcast', de => ({ titel: de ? 'Neue Podcast-Folge' : 'New podcast episode', text: String(f.titel || '').slice(0, 140), tag: 'rw-podcast', url: '/#podcast' }));
}
// LIVE-MITSCHREIBER (gewuenscht): Alle 4 Stunden fuer RUNE, BTC, ETH, SOL die gerade geschlossene 4H-Kerze mit
// derselben Chart-Analyse wie in der App auswerten und das Signal festhalten; um 00 UTC zusaetzlich die Tageskerze.
// Spaeter traegt der Worker ein, was danach passiert ist (Kursveraenderung nach 1/3/7 bzw. 3/7/14 Kerzen-Tagen).
// Gespeichert werden NUR oeffentliche Marktdaten. Kurse vom oeffentlichen Binance-Spiegel data-api.binance.vision.
const RW_LIVE_COINS = ['RUNE', 'BTC', 'ETH', 'SOL'];
const RW_LIVE_H = { '4h': [6, 18, 42], '1d': [3, 7, 14] };
async function rwLiveKerzen(sym, iv, n) {
  const { rows: j } = await rwKlinesHolen(sym, iv, n, null);
  const jetzt = Date.now();
  return j.filter(k => Number(k[6]) < jetzt).map(k => ({ date: Number(k[0]), open: +k[1], high: +k[2], low: +k[3], close: +k[4], value: +k[4], volume: +k[5] })); // nur geschlossene Kerzen
}
async function liveMitschreiber(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS live_signale (coin TEXT, ebene TEXT, at INTEGER, close REAL, bull_pct INTEGER, urteil TEXT, trend TEXT,
    ew_phase TEXT, szen_dir TEXT, szen_prob INTEGER, r1 REAL, r2 REAL, r3 REAL, PRIMARY KEY (coin, ebene, at))`).run();
  // neue Spalten fuer die phasenabhaengigen Signale (einmalig, Fehler = Spalte existiert schon)
  for (const sp of ['phase TEXT', 'ph_sig TEXT', 'ph_dir TEXT']) { try { await env.DB.prepare('ALTER TABLE live_signale ADD COLUMN ' + sp).run(); } catch (e) {} }
  const stunde = new Date().getUTCHours();
  const ebenen = ['4h'].concat(stunde < 1 ? ['1d'] : []);
  for (const iv of ebenen) for (const coin of RW_LIVE_COINS) {
    try {
      const k = await rwLiveKerzen(coin, iv, 700);
      if (k.length < 320) continue;
      const letzte = k[k.length - 1];
      const da = await env.DB.prepare('SELECT 1 FROM live_signale WHERE coin = ? AND ebene = ? AND at = ?').bind(coin, iv, letzte.date).first();
      if (!da) {
        let r = null;
        try { r = RW_ANALYSE.analyze({ data: k, viewStart: Math.max(0, k.length - 250), viewEnd: k.length - 1, logScale: true, dochtFilter: true }); } catch (e) { console.warn('[live] analyse', coin, iv, e && e.message); RW_DIAG.push(`analyse ${coin} ${iv}: ${e && e.message || e}`); }
        if (r) {
          const E = r.elliott, S = r.score, sc = E && E.scenarios && E.scenarios[0];
          const P = r.phasen, PS = P && P.signal;
          await env.DB.prepare('INSERT OR IGNORE INTO live_signale (coin, ebene, at, close, bull_pct, urteil, trend, ew_phase, szen_dir, szen_prob, phase, ph_sig, ph_dir) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .bind(coin, iv, letzte.date, letzte.close, S ? S.bullPct : null, S ? S.verdict : null, r.trend ? r.trend.dir : null, E ? E.phase : null, sc ? sc.dir : null, sc ? sc.prob : null, P ? P.phase : null, PS ? PS.key : null, PS ? PS.dir : null).run();
        }
      }
      // Auswertung frueherer Signale mit denselben Kerzen
      const offen = await env.DB.prepare('SELECT at, close, r1, r2, r3 FROM live_signale WHERE coin = ? AND ebene = ? AND (r1 IS NULL OR r2 IS NULL OR r3 IS NULL) AND at >= ?')
        .bind(coin, iv, k[0].date).all();
      const idx = new Map(k.map((x, i) => [x.date, i]));
      for (const o of (offen.results || [])) {
        const i = idx.get(o.at); if (i == null) continue;
        const [h1, h2, h3] = RW_LIVE_H[iv];
        const ret = h => (k[i + h] ? k[i + h].close / o.close - 1 : null);
        const n1 = o.r1 ?? ret(h1), n2 = o.r2 ?? ret(h2), n3 = o.r3 ?? ret(h3);
        if (n1 !== o.r1 || n2 !== o.r2 || n3 !== o.r3) await env.DB.prepare('UPDATE live_signale SET r1 = ?, r2 = ?, r3 = ? WHERE coin = ? AND ebene = ? AND at = ?').bind(n1, n2, n3, coin, iv, o.at).run();
      }
    } catch (e) { console.warn('[live]', coin, iv, e && e.message); RW_DIAG.push(`live ${coin} ${iv}: ${e && e.message || e}`); }
  }
}
async function liveBilanz(env) {
  try {
    const rows = (await env.DB.prepare('SELECT coin, ebene, at, bull_pct, urteil, szen_dir, szen_prob, r1, r2, r3, ph_sig, ph_dir FROM live_signale').all()).results || [];
    if (!rows.length) return { n: 0 };
    const erste = Math.min(...rows.map(r => r.at));
    const auswert = (feld) => {
      const z = rows.filter(r => r[feld] != null);
      if (!z.length) return null;
      const up = z.filter(r => r[feld] > 0).length / z.length;
      const bull = z.filter(r => r.urteil === 'bull'), bear = z.filter(r => r.urteil === 'bear');
      const q = (g, f) => g.length ? Math.round(100 * g.filter(f).length / g.length) : null;
      const brier = z.filter(r => r.bull_pct != null).reduce((a, r) => a + Math.pow(r.bull_pct / 100 - (r[feld] > 0 ? 1 : 0), 2), 0) / Math.max(1, z.filter(r => r.bull_pct != null).length);
      return { n: z.length, basisUp: Math.round(100 * up), bullUp: q(bull, r => r[feld] > 0), bullN: bull.length, bearDown: q(bear, r => r[feld] < 0), bearN: bear.length, brier: +brier.toFixed(3), brierZufall: +(up * (1 - up)).toFixed(3) };
    };
    // Phasen-Signale: Treffer nach dem gemessenen Horizont (4H: 3 Tage = r2, Tag: 7 Tage = r2)
    const ps = rows.filter(r => r.ph_dir && r.r2 != null);
    const phasenSig = { n: rows.filter(r => r.ph_dir).length, ausgewertet: ps.length, treffer: ps.length ? Math.round(100 * ps.filter(r => r.ph_dir === 'up' ? r.r2 > 0 : r.r2 < 0).length / ps.length) : null };
    return { n: rows.length, seit: erste, kurz: auswert('r1'), mittel: auswert('r2'), lang: auswert('r3'), phasenSig };
  } catch (e) { return { n: 0, fehler: String(e && e.message || e) }; }
}


// ===== DIAGNOSE fuer Live-Mitschreiber und Bot =====
let RW_DIAG = [];
async function rwDiagLauf(env, name, fn) {
  RW_DIAG = []; const t0 = Date.now(); let ergebnis = null, fehler = null;
  try { ergebnis = await fn(); } catch (e) { fehler = String(e && e.message || e); }
  const info = { at: Date.now(), ms: Date.now() - t0, fehler, einzelFehler: RW_DIAG.slice(0, 12), ergebnis };
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS bot_status (k TEXT PRIMARY KEY, v TEXT)').run();
    await env.DB.prepare('INSERT OR REPLACE INTO bot_status (k, v) VALUES (?, ?)').bind('lauf:' + name, JSON.stringify(info)).run();
  } catch (e) {}
  return info;
}
async function rwLaufInfo(env, name) {
  try { const r = await env.DB.prepare('SELECT v FROM bot_status WHERE k = ?').bind('lauf:' + name).first(); return r ? JSON.parse(r.v) : null; } catch (e) { return null; }
}
// KERZEN-QUELLEN (gemeldet: alle Binance-Adressen liefern aus Cloudflare "HTTP 403" -- Binance sperrt
// Rechenzentren). Reihenfolge: Binance (falls doch erreichbar) -> CryptoCompare (alle 8 Coins, mit Historie)
// -> Kraken (letzte 720 Kerzen). Ergebnis immer im Binance-Format [open, o, h, l, c, v, close].
const RW_KLINES_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
let rwBinanceGesperrt = false;
let rwLetzteQuelle = null;
let rwKrakenZuletzt = 0;
const RW_KRAKEN_PAAR = { BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD', DOGE: 'XDGUSD', AVAX: 'AVAXUSD', RUNE: 'RUNEUSD', BNB: 'BNBUSD' };
async function rwKlinesHolen(sym, iv, limit, endTime) {
  const fehler = [];
  const ivMs = iv === '1d' ? 864e5 : 4 * 36e5;
  if (!rwBinanceGesperrt) {
    for (const h of RW_KLINES_HOSTS) {
      try {
        const r = await fetchWithTimeout(`${h}/api/v3/klines?symbol=${sym}USDT&interval=${iv}&limit=${Math.min(1000, limit)}` + (endTime ? `&endTime=${endTime}` : ''), { timeoutMs: 8000 });
        if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j.length) { rwLetzteQuelle = 'binance'; return { rows: j, quelle: 'binance' }; } }
        fehler.push(h.replace('https://', '') + ' ' + r.status);
        if (r.status === 403 || r.status === 451) { rwBinanceGesperrt = true; break; }
      } catch (e) { fehler.push(h.replace('https://', '') + ' ' + (e && e.message || e)); }
    }
  }
  // CryptoCompare: 4H = Stundenkerzen zu je 4 zusammengefasst, Tag = Tageskerzen
  try {
    const basis = iv === '1d' ? 'histoday' : 'histohour';
    const url = `https://min-api.cryptocompare.com/data/v2/${basis}?fsym=${sym}&tsym=USD&limit=${Math.min(2000, limit)}` + (iv === '1d' ? '' : '&aggregate=4') + (endTime ? `&toTs=${Math.floor(endTime / 1000)}` : '');
    // Optionaler kostenloser Schluessel (Secret CRYPTOCOMPARE_API_KEY) -- ohne Schluessel blockt CryptoCompare oft.
    const ccKey = currentEnv && currentEnv.CRYPTOCOMPARE_API_KEY;
    const r = await fetchWithTimeout(url, { timeoutMs: 12000, headers: ccKey ? { authorization: 'Apikey ' + ccKey } : {} });
    if (r.ok) {
      const j = await r.json();
      const d = j && j.Data && Array.isArray(j.Data.Data) ? j.Data.Data : null;
      if (j && j.Response !== 'Error' && d && d.length) {
        const rows = d.filter(x => x && x.close > 0).map(x => [x.time * 1000, x.open, x.high, x.low, x.close, x.volumefrom, x.time * 1000 + ivMs - 1]);
        if (rows.length) { rwLetzteQuelle = 'cryptocompare'; return { rows, quelle: 'cryptocompare' }; }
      }
      fehler.push('cryptocompare ' + (j && j.Message ? String(j.Message).slice(0, 60) : 'leer'));
    } else fehler.push('cryptocompare ' + r.status);
  } catch (e) { fehler.push('cryptocompare ' + (e && e.message || e)); }
  // Kraken: nur die letzten 720 Kerzen, ohne Blaettern
  try {
    const paar = RW_KRAKEN_PAAR[sym];
    if (paar && !endTime) {
      const warte = rwKrakenZuletzt + 1300 - Date.now(); if (warte > 0) await new Promise(r => setTimeout(r, warte)); // Kraken: ~1 Abruf/s
      rwKrakenZuletzt = Date.now();
      const r = await fetchWithTimeout(`https://api.kraken.com/0/public/OHLC?pair=${paar}&interval=${iv === '1d' ? 1440 : 240}`, { timeoutMs: 12000 });
      const j = r.ok ? await r.json() : null;
      const key = j && j.result ? Object.keys(j.result).find(k => k !== 'last') : null;
      if (key && Array.isArray(j.result[key]) && j.result[key].length) {
        const rows = j.result[key].map(x => [x[0] * 1000, +x[1], +x[2], +x[3], +x[4], +x[6], x[0] * 1000 + ivMs - 1]).slice(-limit);
        rwLetzteQuelle = 'kraken'; return { rows, quelle: 'kraken' };
      }
      fehler.push('kraken ' + (j && j.error && j.error.length ? j.error[0] : (r.status || 'leer')));
    }
  } catch (e) { fehler.push('kraken ' + (e && e.message || e)); }
  throw new Error('keine Kursquelle erreichbar: ' + fehler.join(' | '));
}

// ===== LERNENDER BOT · SCHRITT 1: MERKMALE SAMMELN =====
// Fuer 8 Coins (4H + Tag) je Kerze einfache, schnell berechenbare Merkmale + spaeteres Ergebnis (Kursveraenderung nach
// 3 Tagen bei 4H bzw. 7 Tagen bei Tag). Einmalig wird die Historie nachgeladen (je Lauf ein Coin/Zeitebene), danach
// kommen laufend neue Kerzen dazu und offene Ergebnisse werden nachgetragen. Nur oeffentliche Marktdaten.
const RW_BOT_COINS = ['RUNE', 'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'AVAX'];
const RW_BOT_EBENEN = { '4h': { h: 18, hist: 3000 }, '1d': { h: 7, hist: 1500 } };
async function rwBotKerzen(sym, iv, anzahl) {
  let ende = Date.now(), alle = [], runden = 0;
  while (alle.length < anzahl && runden++ < 8) {
    const { rows: j, quelle } = await rwKlinesHolen(sym, iv, Math.min(1000, anzahl - alle.length + 5), alle.length ? ende : null); if (!Array.isArray(j) || !j.length) break;
    alle = j.map(x => ({ date: Number(x[0]), schluss: Number(x[6]), open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] })).concat(alle);
    ende = Number(j[0][0]) - 1; if (quelle === 'kraken' || j.length < 50) break;
  }
  // doppelte Zeitpunkte (Quellen-Ueberlappung) entfernen, sortieren
  const gesehen = new Set(); alle = alle.filter(x => !gesehen.has(x.date) && gesehen.add(x.date)).sort((a, b) => a.date - b.date);
  const jetzt = Date.now();
  return alle.filter(x => x.schluss < jetzt).slice(-anzahl);
}
function rwBotMerkmale(k, h, abIndex) {
  const n = k.length, c = k.map(x => x.close), v = k.map(x => x.volume || 0);
  const pre = [0], preV = [0]; for (let i = 0; i < n; i++) { pre.push(pre[i] + c[i]); preV.push(preV[i] + v[i]); }
  const sma = (i, p) => i >= p - 1 ? (pre[i + 1] - pre[i + 1 - p]) / p : null;
  const smaV = (i, p) => i >= p - 1 ? (preV[i + 1] - preV[i + 1 - p]) / p : null;
  const rsi = new Array(n).fill(null), atr = new Array(n).fill(null);
  let g = 0, l = 0, a = 0;
  for (let i = 1; i < n; i++) {
    const d = c[i] - c[i - 1], gu = Math.max(d, 0), ld = Math.max(-d, 0);
    const tr = Math.max(k[i].high - k[i].low, Math.abs(k[i].high - c[i - 1]), Math.abs(k[i].low - c[i - 1]));
    if (i <= 14) { g += gu / 14; l += ld / 14; a += tr / 14; } else { g = (g * 13 + gu) / 14; l = (l * 13 + ld) / 14; a = (a * 13 + tr) / 14; }
    if (i >= 14) { rsi[i] = 100 - 100 / (1 + g / (l || 1e-12)); atr[i] = a; }
  }
  const rows = [];
  for (let i = Math.max(230, abIndex || 0); i < n; i++) {
    const s200 = sma(i, 200), s200alt = sma(i - 20, 200), m20 = sma(i, 20);
    if (s200 == null || s200alt == null || m20 == null) continue;
    let q = 0; for (let j = i - 19; j <= i; j++) q += (c[j] - m20) * (c[j] - m20); const sd = Math.sqrt(q / 20) || 1e-12;
    const phase = c[i] > s200 && s200 > s200alt ? 'auf' : c[i] < s200 && s200 < s200alt ? 'ab' : 'seit';
    const vm = smaV(i - 1, 20);
    const rund = (x, st) => x == null || !isFinite(x) ? null : Math.round(x * st) / st;
    rows.push({
      at: k[i].date, close: c[i], phase,
      rsi: rund(rsi[i], 10), bbpos: rund((c[i] - m20) / (2 * sd), 100),
      mom6: rund(c[i] / c[i - 6] - 1, 10000), mom30: rund(c[i] / c[i - 30] - 1, 10000),
      dist200: rund(c[i] / s200 - 1, 10000), slope200: rund(s200 / s200alt - 1, 100000),
      volr: rund(vm ? v[i] / vm : null, 100), atrp: rund(atr[i] ? atr[i] / c[i] : null, 10000),
      ret: k[i + h] ? rund(c[i + h] / c[i] - 1, 100000) : null,
    });
  }
  return rows;
}
const RW_BOT_SPALTEN = ['coin', 'ebene', 'at', 'close', 'phase', 'rsi', 'bbpos', 'mom6', 'mom30', 'dist200', 'slope200', 'volr', 'atrp', 'ret'];
async function rwBotSchreiben(env, coin, iv, rows) {
  const proZeile = RW_BOT_SPALTEN.length, jeStmt = Math.floor(90 / proZeile); // D1: max. ~100 Parameter je Abfrage
  const stmts = [];
  for (let i = 0; i < rows.length; i += jeStmt) {
    const teil = rows.slice(i, i + jeStmt);
    const platz = teil.map(() => '(' + RW_BOT_SPALTEN.map(() => '?').join(',') + ')').join(',');
    const werte = []; for (const r of teil) werte.push(coin, iv, r.at, r.close, r.phase, r.rsi, r.bbpos, r.mom6, r.mom30, r.dist200, r.slope200, r.volr, r.atrp, r.ret);
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO bot_faelle (${RW_BOT_SPALTEN.join(',')}) VALUES ${platz}`).bind(...werte));
  }
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
}
async function botSammlerTabellen(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS bot_faelle (coin TEXT, ebene TEXT, at INTEGER, close REAL, phase TEXT, rsi REAL, bbpos REAL,
    mom6 REAL, mom30 REAL, dist200 REAL, slope200 REAL, volr REAL, atrp REAL, ret REAL, PRIMARY KEY (coin, ebene, at))`).run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS bot_status (k TEXT PRIMARY KEY, v TEXT)').run();
}
async function botSammler(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS bot_faelle (coin TEXT, ebene TEXT, at INTEGER, close REAL, phase TEXT, rsi REAL, bbpos REAL,
    mom6 REAL, mom30 REAL, dist200 REAL, slope200 REAL, volr REAL, atrp REAL, ret REAL, PRIMARY KEY (coin, ebene, at))`).run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS bot_status (k TEXT PRIMARY KEY, v TEXT)').run();
  const status = new Map(((await env.DB.prepare('SELECT k, v FROM bot_status').all()).results || []).map(r => [r.k, r.v]));
  // 1) Historie: je Lauf genau ein noch fehlendes Coin/Zeitebene-Paar nachladen
  for (const iv in RW_BOT_EBENEN) for (const coin of RW_BOT_COINS) {
    const st = status.get('hist:' + coin + ':' + iv);
    if (st === 'fertig-kurz' && !(env.CRYPTOCOMPARE_API_KEY)) continue;
    if (st === 'fertig') {
      // aelterer Stand ohne Quellen-Merker: war die Historie kurz (Kraken) und gibt es jetzt einen Schluessel -> nachladen
      if (!env.CRYPTOCOMPARE_API_KEY) continue;
      const z = await env.DB.prepare('SELECT COUNT(*) AS n FROM bot_faelle WHERE coin = ? AND ebene = ?').bind(coin, iv).first().catch(() => null);
      if (!z || z.n >= RW_BOT_EBENEN[iv].hist * 0.5) continue;
    }
    rwLetzteQuelle = null;
    const k = await rwBotKerzen(coin, iv, RW_BOT_EBENEN[iv].hist);
    const rows = rwBotMerkmale(k, RW_BOT_EBENEN[iv].h, 0);
    await rwBotSchreiben(env, coin, iv, rows);
    const kurz = rwLetzteQuelle === 'kraken';
    await env.DB.prepare('INSERT OR REPLACE INTO bot_status (k, v) VALUES (?, ?)').bind('hist:' + coin + ':' + iv, kurz ? 'fertig-kurz' : 'fertig').run();
    return { historie: coin + ' ' + iv, faelle: rows.length, quelle: rwLetzteQuelle };
  }
  // 2) Laufend: neue Kerzen anhaengen, offene Ergebnisse nachtragen
  for (const iv in RW_BOT_EBENEN) for (const coin of RW_BOT_COINS) {
    try {
      const H = RW_BOT_EBENEN[iv].h;
      const k = await rwLiveKerzen(coin, iv, 300);
      if (k.length < 240) continue;
      const rows = rwBotMerkmale(k, H, k.length - H - 3);
      await rwBotSchreiben(env, coin, iv, rows.slice(-3)); // nur die neuesten Kerzen neu einfuegen
      const M = await botModell(env, iv);
      if (M && M.modell) {
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS bot_prognosen (coin TEXT, ebene TEXT, at INTEGER, p REAL, PRIMARY KEY (coin, ebene, at))').run();
        const neu = rows.slice(-3).filter(r => r.ret == null);
        if (neu.length) await env.DB.batch(neu.map(r => env.DB.prepare('INSERT OR IGNORE INTO bot_prognosen (coin, ebene, at, p) VALUES (?, ?, ?, ?)').bind(coin, iv, r.at, +rwBotP(M.modell, rwBotVektor(r)).toFixed(4))));
      }
      const offen = rows.filter(r => r.ret != null);       // Ergebnisse, die jetzt feststehen
      if (offen.length) await env.DB.batch(offen.map(r => env.DB.prepare('UPDATE bot_faelle SET ret = ? WHERE coin = ? AND ebene = ? AND at = ? AND ret IS NULL').bind(r.ret, coin, iv, r.at)));
    } catch (e) { console.warn('[bot] laufend', coin, iv, e && e.message); RW_DIAG.push(`bot ${coin} ${iv}: ${e && e.message || e}`); }
  }
  return { laufend: true };
}

// ===== LERNENDER BOT · SCHRITT 2: LERNEN (woechentlich, mit Probelauf) =====
// Logistische Regression je Zeitebene: Wahrscheinlichkeit, dass der Kurs nach 3 Tagen (4H) bzw. 7 Tagen (Tag) hoeher steht.
// Schutzregeln: (1) Zeit-Trennung -- gelernt wird auf aelteren Daten, geprueft auf den neuesten 20 % (mit Abstand,
// damit keine Ueberlappung durchsickert); (2) ein Modell wird nur uebernommen, wenn es dort besser ist als die
// reine Basisrate UND nicht schlechter als das bisherige; (3) neuere Faelle zaehlen mehr (Halbwertszeit 1 Jahr);
// (4) Regularisierung gegen Auswendiglernen. Danach wird auf allen Daten neu angepasst.
const RW_BOT_MERKMALE = ['Abwärtstrend', 'Seitwärts', 'RSI', 'Bollinger-Lage', 'Momentum kurz', 'Momentum lang', 'Abstand 200er', 'Neigung 200er', 'Volumen', 'Schwankung',
  'RSI im Abwärtstrend', 'Band im Abwärtstrend', 'RSI seitwärts', 'Band seitwärts', 'RSI im Aufwärtstrend', 'Band im Aufwärtstrend'];
const rwClip = (x, a, b) => (x == null || !isFinite(x) ? 0 : Math.max(a, Math.min(b, x)));
function rwBotVektor(r) {
  const ab = r.phase === 'ab' ? 1 : 0, seit = r.phase === 'seit' ? 1 : 0, auf = 1 - ab - seit;
  const rsi = rwClip((r.rsi - 50) / 20, -2.5, 2.5), bb = rwClip(r.bbpos, -3, 3);
  return [ab, seit, rsi, bb, rwClip(r.mom6 * 10, -3, 3), rwClip(r.mom30 * 5, -3, 3), rwClip(r.dist200 * 5, -3, 3), rwClip(r.slope200 * 50, -3, 3),
    rwClip(Math.log(r.volr || 1), -2, 2), rwClip(r.atrp * 20, -3, 3), ab * rsi, ab * bb, seit * rsi, seit * bb, auf * rsi, auf * bb];
}
const rwSig = z => 1 / (1 + Math.exp(-z));
function rwBotTrainieren(X, y, g, iter = 300, lr = 0.15, l2 = 1e-3) {
  const d = X[0].length, n = X.length; const w = new Array(d).fill(0); let b = 0; const sg = g.reduce((a, x) => a + x, 0) || 1;
  for (let it = 0; it < iter; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) { const xi = X[i]; let z = b; for (let j = 0; j < d; j++) z += w[j] * xi[j]; const e = (rwSig(z) - y[i]) * g[i]; gb += e; for (let j = 0; j < d; j++) gw[j] += e * xi[j]; }
    b -= lr * gb / sg; for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / sg + l2 * w[j]);
  }
  return { w, b };
}
const rwBotP = (m, x) => { let z = m.b; for (let j = 0; j < m.w.length; j++) z += m.w[j] * x[j]; return rwSig(z); };
async function botLernen(env, iv) {
  const H = RW_BOT_EBENEN[iv].h, ivMs = iv === '1d' ? 864e5 : 4 * 36e5;
  const rows = ((await env.DB.prepare('SELECT * FROM bot_faelle WHERE ebene = ? AND ret IS NOT NULL ORDER BY at').bind(iv).all()).results) || [];
  if (rows.length < 2000) return { ebene: iv, status: 'zu wenig Daten', n: rows.length };
  const ats = rows.map(r => r.at).sort((a, b) => a - b), testAb = ats[Math.floor(ats.length * 0.8)], tMax = ats[ats.length - 1];
  const gewicht = r => Math.pow(0.5, (tMax - r.at) / (365 * 864e5));
  const train = rows.filter(r => r.at < testAb - H * ivMs), test = rows.filter(r => r.at >= testAb);
  const Xt = train.map(rwBotVektor), yt = train.map(r => (r.ret > 0 ? 1 : 0)), gt = train.map(gewicht);
  const m = rwBotTrainieren(Xt, yt, gt);
  const basis = yt.reduce((a, y, i) => a + y * gt[i], 0) / gt.reduce((a, x) => a + x, 0);
  const pruef = mod => { let bm = 0, bb = 0, ok = 0, klar = 0, klarOk = 0;
    for (const r of test) { const y = r.ret > 0 ? 1 : 0, p = mod ? rwBotP(mod, rwBotVektor(r)) : basis; bm += (p - y) ** 2; bb += (basis - y) ** 2; if ((p > 0.5) === (y === 1)) ok++; if (Math.abs(p - 0.5) > 0.05) { klar++; if ((p > 0.5) === (y === 1)) klarOk++; } }
    return { brier: bm / test.length, brierBasis: bb / test.length, treffer: ok / test.length, klarAnteil: klar / test.length, klarTreffer: klar ? klarOk / klar : null }; };
  const neu = pruef(m);
  const altRoh = await env.DB.prepare('SELECT v FROM bot_status WHERE k = ?').bind('modell:' + iv).first().catch(() => null);
  const alt = altRoh ? JSON.parse(altRoh.v) : null;
  const altPruef = alt && alt.modell ? pruef(alt.modell) : null;
  const besserAlsBasis = neu.brier < neu.brierBasis, nichtSchlechter = !altPruef || neu.brier <= altPruef.brier + 0.0005;
  const info = { ebene: iv, at: Date.now(), nTrain: train.length, nTest: test.length, basis: +basis.toFixed(4),
    test: Object.fromEntries(Object.entries(neu).map(([k, v]) => [k, v == null ? null : +v.toFixed(4)])), altTest: altPruef ? +altPruef.brier.toFixed(4) : null };
  if (!(besserAlsBasis && nichtSchlechter)) {
    await env.DB.prepare('INSERT OR REPLACE INTO bot_status (k, v) VALUES (?, ?)').bind('lernlauf:' + iv, JSON.stringify({ ...info, uebernommen: false, grund: !besserAlsBasis ? 'schlägt die Basisrate nicht' : 'schlechter als bisheriges Modell' })).run();
    return { ...info, uebernommen: false };
  }
  // bestanden -> auf allen Daten neu anpassen
  const Xa = rows.map(rwBotVektor), ya = rows.map(r => (r.ret > 0 ? 1 : 0)), ga = rows.map(gewicht);
  const fin = rwBotTrainieren(Xa, ya, ga);
  const basisAll = ya.reduce((a, y, i) => a + y * ga[i], 0) / ga.reduce((a, x) => a + x, 0);
  // Was hat sich gegenueber dem alten Modell am staerksten veraendert?
  let gelernt = [];
  if (alt && alt.modell) gelernt = fin.w.map((w, j) => ({ j, d: w - alt.modell.w[j] })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 2)
    .filter(x => Math.abs(x.d) > 0.02).map(x => `${RW_BOT_MERKMALE[x.j]} ${x.d > 0 ? 'stärker' : 'schwächer'} gewichtet`);
  const modell = { modell: { w: fin.w.map(x => +x.toFixed(5)), b: +fin.b.toFixed(5) }, basis: +basisAll.toFixed(4), ...info, uebernommen: true, gelernt, n: rows.length };
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO bot_status (k, v) VALUES (?, ?)').bind('modell:' + iv, JSON.stringify(modell)),
    env.DB.prepare('INSERT OR REPLACE INTO bot_status (k, v) VALUES (?, ?)').bind('lernlauf:' + iv, JSON.stringify({ ...info, uebernommen: true, gelernt })),
  ]);
  return { ...info, uebernommen: true, gelernt };
}
async function botModell(env, iv) {
  try { const r = await env.DB.prepare('SELECT v FROM bot_status WHERE k = ?').bind('modell:' + iv).first(); return r ? JSON.parse(r.v) : null; } catch (e) { return null; }
}
// Prognose fuer die juengste Kerze eines Coins (fuer die App) -- mit den zwei wichtigsten Gruenden
async function botPrognose(env, coin, iv) {
  const M = await botModell(env, iv);
  const r = await env.DB.prepare('SELECT * FROM bot_faelle WHERE coin = ? AND ebene = ? ORDER BY at DESC LIMIT 1').bind(coin, iv).first().catch(() => null);
  if (!r) return { coin, ebene: iv, status: 'keine Daten' };
  if (!M || !M.modell) return { coin, ebene: iv, status: 'noch kein Modell', phase: r.phase, at: r.at };
  const x = rwBotVektor(r), p = rwBotP(M.modell, x);
  const gruende = M.modell.w.map((w, j) => ({ j, c: w * x[j] })).filter(g => Math.abs(g.c) > 0.02).sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 2)
    .map(g => ({ merkmal: RW_BOT_MERKMALE[g.j], richtung: g.c > 0 ? 'up' : 'down' }));
  return { coin, ebene: iv, at: r.at, phase: r.phase, p: +p.toFixed(3), basis: M.basis, horizont: iv === '1d' ? '7d' : '3d', gruende,
    modell: { at: M.at, n: M.n, testTreffer: M.test.treffer, testBrier: M.test.brier, testBrierBasis: M.test.brierBasis, klarTreffer: M.test.klarTreffer, gelernt: M.gelernt || [] } };
}
async function botLiveBilanz(env) {
  try {
    const rows = ((await env.DB.prepare('SELECT p.p AS p, f.ret AS ret FROM bot_prognosen p JOIN bot_faelle f ON f.coin = p.coin AND f.ebene = p.ebene AND f.at = p.at WHERE f.ret IS NOT NULL').all()).results) || [];
    const gesamt = await env.DB.prepare('SELECT COUNT(*) AS n FROM bot_prognosen').first().catch(() => null);
    const ok = rows.filter(r => (r.p > 0.5) === (r.ret > 0)).length;
    return { n: gesamt ? gesamt.n : 0, ausgewertet: rows.length, treffer: rows.length ? ok / rows.length : null };
  } catch (e) { return { n: 0, ausgewertet: 0, treffer: null }; }
}

async function botStand(env) {
  try {
    const z = await env.DB.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN ret IS NOT NULL THEN 1 ELSE 0 END) AS mit FROM bot_faelle').first();
    const st = (await env.DB.prepare("SELECT COUNT(*) AS n FROM bot_status WHERE k LIKE 'hist:%' AND v LIKE 'fertig%'").first()) || {};
    return { faelle: z ? z.n : 0, mitErgebnis: z ? z.mit : 0, historieFertig: st.n || 0, historieGesamt: RW_BOT_COINS.length * Object.keys(RW_BOT_EBENEN).length };
  } catch (e) { return { faelle: 0, mitErgebnis: 0, historieFertig: 0, historieGesamt: 16 }; }
}

async function runRefreshCycle(env) {
  // Slash-/Erstattungs-Erkennung entfernt (gewuenscht): einmalig ihre Tabellen und Zwischenstaende loeschen
  try {
    if (!(await env.DB.prepare("SELECT v FROM push_state WHERE k = 'slashAufraeumen'").first().catch(() => null))) {
      await env.DB.batch([
        env.DB.prepare('DROP TABLE IF EXISTS bond_events'),
        env.DB.prepare('DROP TABLE IF EXISTS bond_snap'),
        env.DB.prepare("DELETE FROM push_state WHERE k LIKE 'upErst%' OR k LIKE 'upgTr:%' OR k LIKE 'beschl%' OR k LIKE 'bondNachgerechnet:%' OR k LIKE 'upg%' OR k LIKE 'bondEvLauf'"),
        env.DB.prepare("INSERT OR REPLACE INTO push_state (k, v) VALUES ('slashAufraeumen', '1')"),
      ]);
    }
  } catch (e) {}
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
  await schritt('Leave-Zeitpunkte', () => syncLeaveZeiten(env));
  await schritt('Halt-Verlauf', () => syncHaltVerlauf(env));
  await schritt('Podcast-Meldung', () => syncPodcastMeldung(env));

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

// ===== CHART-ANALYSE (automatisch aus app.js uebernommen, fuer den Live-Mitschreiber) =====
const RW_ANALYSE = (() => {
  const t = (k) => k;
// AUTOMATISCH aus app.js erzeugt (extrahiere.js) -- Chart-Analyse fuer den Worker. Nicht von Hand bearbeiten.
const RW_EW_ZUVERL = {
  waveC: { n: 237, treffer: 50, richtung: 46 }, corrDone: { n: 204, treffer: 59, richtung: 43 },
  impulseDone: { n: 155, treffer: 51, richtung: 46 }, wave4: { n: 143, treffer: 44, richtung: 53 },
  waveB: { n: 111, treffer: 31, richtung: 37 }, wave5: { n: 74, treffer: 57, richtung: 54 },
  wave3: { n: 55, treffer: 65, richtung: 49 }, wave2: { n: 36, treffer: 6, richtung: 38 },
};
const RW_EW_OHNE_PROJEKTION = ['waveB'];
const RW_PHASEN_SIGNALE = {
  '4h': { h: '3d', liste: [
    { key: 'bbUnten', phase: 'ab', dir: 'up', treffer: 58, basis: 46, coins: '6/8' },
    { key: 'bbOben', phase: 'ab', dir: 'down', treffer: 65, basis: 54, coins: '6/8' },
    { key: 'rsiTief', phase: 'ab', dir: 'up', treffer: 57, basis: 46, coins: '4/8' },
    { key: 'rsiTief', phase: 'seit', dir: 'up', treffer: 60, basis: 45, coins: '3/7' },
    { key: 'bbUnten', phase: 'seit', dir: 'up', treffer: 56, basis: 46, coins: '3/8' },
  ] },
  '1d': { h: '7d', liste: [
    { key: 'bbUnten', phase: 'seit', dir: 'up', treffer: 65, basis: 55, coins: '3/5' },
  ] },
};
function rwPhasenSignal(k) {
  if (!Array.isArray(k) || k.length < 230) return null;
  const n = k.length, c = k.map(x => +x.close), t = k.map(x => +new Date(x.date));
  const diffs = []; for (let i = Math.max(1, n - 50); i < n; i++) diffs.push(t[i] - t[i - 1]); diffs.sort((a, b) => a - b);
  const md = diffs[Math.floor(diffs.length / 2)] || 0;
  const ebene = Math.abs(md - 14400000) < 4320000 ? '4h' : Math.abs(md - 86400000) < 25920000 ? '1d' : null;
  const sma = (end, p) => { let s = 0; for (let i = end - p + 1; i <= end; i++) s += c[i]; return s / p; };
  const s200 = sma(n - 1, 200), s200alt = sma(n - 21, 200), last = c[n - 1];
  const phase = last > s200 && s200 > s200alt ? 'auf' : last < s200 && s200 < s200alt ? 'ab' : 'seit';
  const m20 = sma(n - 1, 20); let q = 0; for (let i = n - 20; i < n; i++) q += (c[i] - m20) * (c[i] - m20); const sd = Math.sqrt(q / 20);
  let g = 0, l = 0; for (let i = 1; i < n; i++) { const d = c[i] - c[i - 1], gu = Math.max(d, 0), ld = Math.max(-d, 0); if (i <= 14) { g += gu / 14; l += ld / 14; } else { g = (g * 13 + gu) / 14; l = (l * 13 + ld) / 14; } }
  const rsi = 100 - 100 / (1 + g / (l || 1e-9));
  const aktiv = { bbUnten: last < m20 - 2 * sd, bbOben: last > m20 + 2 * sd, rsiTief: rsi < 30, rsiHoch: rsi > 70 };
  const tab = ebene ? RW_PHASEN_SIGNALE[ebene] : null;
  const signale = tab ? tab.liste.filter(x => x.phase === phase && aktiv[x.key]).map(x => ({ ...x, h: tab.h, ebene })) : [];
  signale.sort((a, b) => (b.treffer - b.basis) - (a.treffer - a.basis));
  const warnung = phase === 'auf' && (aktiv.rsiHoch || aktiv.bbOben) ? 'aufUeberkauft' : null;
  return { phase, ebene, rsi: Math.round(rsi), signal: signale[0] || null, weitere: signale.slice(1), warnung };
}
const TPAnalysis = (() => {
  const ln = v => Math.log(Math.max(v, 1e-12));
  const hiOf = d => d.high != null ? d.high : d.value;
  const loOf = d => d.low != null ? d.low : d.value;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

  // ---------------------------------------------------------------- Basis-Indikatoren ------
  function atrSeries(data, period) {
    const out = [];
    let a = null;
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const h = hiOf(data[i]), l = loOf(data[i]);
      const tr = i === 0 ? h - l : Math.max(h - l, Math.abs(h - data[i - 1].value), Math.abs(l - data[i - 1].value));
      if (i < period) {
        sum += tr;
        out.push(i === period - 1 ? sum / period : null);
        if (i === period - 1) a = sum / period;
        continue;
      }
      a = (a * (period - 1) + tr) / period;
      out.push(a);
    }
    return out;
  }
  function emaArr(values, period) {
    const k = 2 / (period + 1);
    const out = [];
    let e = null, warm = 0, sum = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null || !Number.isFinite(v)) { out.push(e); continue; }
      if (e == null) {
        sum += v; warm++;
        if (warm < period) { out.push(null); continue; }
        e = sum / period; out.push(e); continue;
      }
      e = v * k + e * (1 - k);
      out.push(e);
    }
    return out;
  }
  function smaArr(values, period) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      out.push(i >= period - 1 ? sum / period : null);
    }
    return out;
  }
  function rsiArr(closes, period) {
    const out = [];
    let ag = 0, al = 0;
    for (let i = 0; i < closes.length; i++) {
      if (i === 0) { out.push(null); continue; }
      const ch = closes[i] - closes[i - 1];
      const g = Math.max(ch, 0), l = Math.max(-ch, 0);
      if (i <= period) {
        ag += g; al += l;
        if (i < period) { out.push(null); continue; }
        ag /= period; al /= period;
      } else {
        ag = (ag * (period - 1) + g) / period;
        al = (al * (period - 1) + l) / period;
      }
      out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
    }
    return out;
  }
  function stochArr(data, period, smoothK, smoothD) {
    const raw = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) { raw.push(null); continue; }
      let hi = -Infinity, lo = Infinity;
      for (let j = i - period + 1; j <= i; j++) { hi = Math.max(hi, hiOf(data[j])); lo = Math.min(lo, loOf(data[j])); }
      raw.push(hi === lo ? 50 : (data[i].value - lo) / (hi - lo) * 100);
    }
    const sm = (arr, p) => arr.map((v, i) => {
      if (v == null || i < p - 1) return null;
      const w = arr.slice(i - p + 1, i + 1);
      return w.some(x => x == null) ? null : avg(w);
    });
    const k = sm(raw, smoothK);
    const d = sm(k, smoothD);
    return { k, d };
  }

  // ---------------------------------------------------------------- ZigZag-Pivots -----------
  // Klassischer ZigZag auf Log-Preisen: ein Hoch gilt erst dann als Pivot, wenn der Kurs danach
  // um mindestens `pct` gefallen ist (und umgekehrt). Das letzte, noch unbestaetigte Extrem wird
  // als "pending" mitgeliefert -- fuer "Welle X laeuft gerade"-Aussagen.
  function zigzag(data, from, to, pct) {
    const thr = Math.log(1 + pct);
    const piv = [];
    let trend = 0;
    let hiIdx = from, hiP = hiOf(data[from]), loIdx = from, loP = loOf(data[from]);
    for (let i = from + 1; i <= to; i++) {
      const h = hiOf(data[i]), l = loOf(data[i]);
      if (trend >= 0 && h > hiP) { hiP = h; hiIdx = i; }
      if (trend <= 0 && l < loP) { loP = l; loIdx = i; }
      // WICHTIG: eine Umkehr zaehlt nur auf einer SPAETEREN Kerze als das laufende Extrem --
      // sonst wuerde eine einzelne grosse Kerze (Hoch UND Tief weit auseinander) sofort zwei
      // Pivots auf demselben Index erzeugen und die Reihe in Rauschen zerhacken.
      if (trend === 0) {
        if (i > hiIdx && ln(hiP) - ln(l) > thr) { piv.push({ idx: hiIdx, price: hiP, type: 'H' }); trend = -1; loP = l; loIdx = i; }
        else if (i > loIdx && ln(h) - ln(loP) > thr) { piv.push({ idx: loIdx, price: loP, type: 'L' }); trend = 1; hiP = h; hiIdx = i; }
      } else if (trend === 1) {
        if (i > hiIdx && ln(hiP) - ln(l) > thr) { piv.push({ idx: hiIdx, price: hiP, type: 'H' }); trend = -1; loP = l; loIdx = i; }
      } else if (i > loIdx && ln(h) - ln(loP) > thr) {
        piv.push({ idx: loIdx, price: loP, type: 'L' }); trend = 1; hiP = h; hiIdx = i;
      }
    }
    let pending = null;
    if (trend === 1) pending = { idx: hiIdx, price: hiP, type: 'H', pending: true };
    else if (trend === -1) pending = { idx: loIdx, price: loP, type: 'L', pending: true };
    return { pivots: piv, pending };
  }
  const ZZ_STEPS = [0.006, 0.009, 0.013, 0.018, 0.025, 0.035, 0.05, 0.07, 0.1, 0.14, 0.2, 0.28, 0.4, 0.6];
  // WICHTIG (gemeldet: "Muster verschwinden, wenn ich den Chart etwas verschiebe"): der ZigZag
  // lief bisher ab dem LINKEN Bildrand. Jedes Verschieben aenderte damit den Startpunkt, die
  // Wendepunkte und mit ihnen Muster und Ziele -- sie flackerten. Jetzt laeuft der ZigZag immer
  // ab der ERSTEN geladenen Kerze bis zur letzten sichtbaren ("to"), und erst das fertige
  // Ergebnis wird auf das Fenster geschnitten. Die Wendepunkte haengen dadurch nur noch von den
  // Daten ab, nicht vom Bildausschnitt -- genau wie die Fraktal-Pivots in
  // BennyThadikaran/stock-pattern (barsLeft/barsRight), nur volatilitaetsabhaengig statt fix.
  // Bis "to" statt bis zum Ende, damit beim Blick in die Vergangenheit nichts aus der Zukunft
  // "durchsickert" (ein spaeteres Hoch darf ein damaliges Pending-Extrem nicht bestaetigen).
  // Gecacht je Datenreihe (WeakMap) -- ein Live-Tick liefert eine neue Reihe und leert damit
  // automatisch den Cache; innerhalb eines Ticks kostet Verschieben nichts mehr.
  const zzCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function zigzagUpTo(data, to, pct) {
    let m = zzCache ? zzCache.get(data) : null;
    if (!m) { m = new Map(); if (zzCache) zzCache.set(data, m); }
    const key = to + ':' + pct;
    let r = m.get(key);
    if (!r) { r = zigzag(data, 0, to, pct); m.set(key, r); }
    return r;
  }
  // Schwelle rein aus der Volatilitaet (minPct = k x ATR%), auf die naechste Stufe gerundet --
  // und nur dann grober, wenn im Fenster trotzdem mehr als `maxCount` Wendepunkte liegen. Vorher
  // wurde die Schwelle nach der Anzahl im Fenster gewaehlt; ein anderes Fenster sprang dadurch
  // auf eine andere Stufe und lieferte ganz andere Pivots (zweite Flacker-Ursache).
  const pow2Span = len => Math.pow(2, Math.round(Math.log(Math.max(8, len)) / Math.LN2));
  function pivotsAuto(data, from, to, maxCount, minCount, minPct, viewLen) {
    const steps = ZZ_STEPS.filter(p => p >= (minPct || 0));
    if (!steps.length) steps.push(ZZ_STEPS[ZZ_STEPS.length - 1]);
    // Die Zaehlung fuer "zu viele Wendepunkte?" laeuft NICHT ueber das exakte Fenster (das
    // aendert sich bei jedem Verschieben um ein paar Kerzen und wuerde die Stufe kippen lassen),
    // sondern ueber eine Referenzspanne, die auf Zweierpotenzen gerundet ist (64, 128, 256 ...
    // Kerzen vor "to"). Gleiche Zoomstufe = gleiche Referenzspanne = gleiche Schwelle.
    const len = Math.max(8, viewLen || (to - from + 1));
    const refSpan = pow2Span(len);
    const refFrom = Math.max(0, to - refSpan);
    // HYSTERESE DER STUFE (gemeldet: "willkuerlich"): Die Stufe kippte, sobald die Zahl der
    // Wendepunkte in der gleitenden Referenzspanne um EINEN ueber/unter maxCount lag -- dann
    // verschwanden bestaetigte Wendepunkte, und die Elliott-Zaehlung baute sich um. Jetzt bleibt
    // die zuletzt gewaehlte Stufe derselben Reihe, solange sie hoechstens 20 % ueber maxCount
    // liegt (bzw. bei einer groeberen Stufe, solange die neue nur knapp darunter liegt).
    const key = data.length > 1 ? [data[0].date, data[0].value, data[1].date - data[0].date, maxCount, refSpan].join('|') : null;
    const alt = key ? ZZ_HYST.get(key) : null;
    const bau = pct => {
      const full = zigzagUpTo(data, to, pct);
      const inRef = full.pivots.filter(p => p.idx >= refFrom).length;
      const inWin = full.pivots.filter(p => p.idx >= from);
      // Der letzte Pivot VOR dem Fenster wird mitgenommen, damit eine Welle, die gerade am
      // linken Rand beginnt, nicht ohne Startpunkt dasteht.
      const prev = full.pivots.filter(p => p.idx < from);
      const pivots = (prev.length ? [prev[prev.length - 1]] : []).concat(inWin);
      return { pivots, pending: full.pending, pct, inRef };
    };
    let best = null, gewaehlt = null;
    for (const pct of steps) {
      const r = bau(pct);
      if (r.inRef <= maxCount) { gewaehlt = r; break; }
      best = r;
    }
    if (!gewaehlt) gewaehlt = best;
    // Die Untergrenze minPct haengt am ATR und wandert mit jeder Kerze -- die alte Stufe darf
    // deshalb bis 20 % darunter liegen, sonst fiele sie allein durch das ATR-Rauschen heraus.
    if (gewaehlt && alt != null && alt !== gewaehlt.pct && ZZ_STEPS.includes(alt) && alt >= (minPct || 0) * 0.8) {
      const iAlt = ZZ_STEPS.indexOf(alt), iNeu = ZZ_STEPS.indexOf(gewaehlt.pct);
      if (Math.abs(iAlt - iNeu) === 1) {
        const rAlt = bau(alt);
        const halten = iAlt < iNeu ? rAlt.inRef <= maxCount * 1.2 : gewaehlt.inRef >= maxCount * 0.8;
        if (halten) gewaehlt = rAlt;
      }
    }
    if (key && gewaehlt) { ZZ_HYST.set(key, gewaehlt.pct); if (ZZ_HYST.size > 300) ZZ_HYST.delete(ZZ_HYST.keys().next().value); }
    if (gewaehlt) { delete gewaehlt.inRef; return gewaehlt; }
    return { pivots: [], pending: null, pct: ZZ_STEPS[0] };
  }
  const ZZ_HYST = new Map();

  // ---------------------------------------------------------------- Trend -------------------
  function detectTrend(data, from, to, atrPct, pivots) {
    const n = to - from + 1;
    if (n < 5) return { dir: 'side', strength: 0, changePct: 0, r2: 0 };
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (let i = from; i <= to; i++) {
      const x = i - from, y = ln(data[i].value);
      sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
    }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
    const r2num = (n * sxy - sx * sy);
    const r2 = r2num * r2num / ((n * sxx - sx * sx) * (n * syy - sy * sy) || 1);
    const moveAtr = slope * n / (atrPct || 0.01);
    let hh = 0, hl = 0, lh = 0, ll = 0;
    const H = pivots.filter(p => p.type === 'H'), L = pivots.filter(p => p.type === 'L');
    for (let i = 1; i < H.length; i++) H[i].price > H[i - 1].price ? hh++ : lh++;
    for (let i = 1; i < L.length; i++) L[i].price > L[i - 1].price ? hl++ : ll++;
    const structUp = hh + hl, structDown = lh + ll;
    let dir = 'side';
    if (moveAtr > 2 && r2 > 0.2 && structUp >= structDown) dir = 'up';
    else if (moveAtr < -2 && r2 > 0.2 && structDown >= structUp) dir = 'down';
    else if (moveAtr > 4 && structUp > structDown) dir = 'up';
    else if (moveAtr < -4 && structDown > structUp) dir = 'down';
    const strength = clamp(Math.round(Math.abs(moveAtr) * r2 * 10) / 10, 0, 10);
    return { dir, strength, changePct: (Math.exp(slope * n) - 1) * 100, r2, moveAtr };
  }

  // ---------------------------------------------------------------- Trendlinien ------------
  //
  // Gemeldet: "kannst du das Zeichnen von wichtigen Linien auch ins Analyse-Tool einbauen?"
  // -- als Beispiel eine lange fallende Linie vom Allzeithoch ueber die tieferen Hochs.
  // detectTrend oben rechnet nur eine Regression und liefert "auf/ab/seitwaerts"; eine
  // zeichenbare Linie gab es bisher nicht.
  //
  // Vorgehen wie ein Chartist:
  //   1. Zwei grosse Wendepunkte gleicher Art verbinden -- Hochs fuer einen Widerstand,
  //      Tiefs fuer eine Unterstuetzung.
  //   2. Die Linie gilt nur, wenn ZWISCHEN den beiden Punkten keine Kerze deutlich durch sie
  //      hindurchgeht. Sonst ist es keine Trendlinie, sondern eine beliebige Verbindung.
  //   3. Je mehr weitere Wendepunkte die Linie beruehren, je laenger sie haelt und je naeher
  //      sie am heutigen Kurs liegt, desto wichtiger.
  //
  // Gerechnet wird im Massstab des Charts (logarithmisch oder linear). Eine im Log-Raum
  // gerade Linie waere auf einem linearen Chart gekruemmt -- sie wuerde neben den Kerzen
  // liegen, die sie beschreiben soll.
  function detectTrendlines(data, from, to, pivotsIn, useLog, tolLog, lastClose) {
    // ZWEITE QUELLE: LOKALE HOCHS UND TIEFS ohne Prozentschwelle.
    //
    // Die Zickzack-Wendepunkte haben eine Mindestbewegung (hier bis 22 %). Ein gleichmaessiger
    // Trend mit flachen Ruecksetzern von 12-17 % faellt dadurch komplett durch -- im Test lag
    // bei einem sauberen Aufwaertstrend ein einziger Wendepunkt vor, und daraus laesst sich
    // keine Linie bilden. Eine Kerze zaehlt hier als lokales Hoch, wenn keine ihrer Nachbarn
    // innerhalb von k Kerzen hoeher liegt (sinngemaess fuer Tiefs). Das braucht keine Schwelle
    // und findet genau die Punkte, an die man eine Trendlinie anlegt.
    // Nachbarschaft passt sich der Laenge an. Bei kurzen Reihen muss k = 1 sein: In einem
    // Aufwaertstrend liegt das VORIGE Tief immer tiefer, mit k = 2 findet sich dort nie ein
    // lokales Tief. Bei langen Reihen dagegen groesser, sonst zaehlt jede Zacke und die
    // Paarsuche wird quadratisch teuer.
    const kF = (to - from) < 60 ? 1 : Math.max(2, Math.round((to - from) / 60));
    const fraktal = [];
    for (let i = from + kF; i <= to - kF; i++) {
      let hoch = true, tief = true;
      for (let j = i - kF; j <= i + kF; j++) {
        if (j === i) continue;
        if (hiOf(data[j]) > hiOf(data[i])) hoch = false;
        if (loOf(data[j]) < loOf(data[i])) tief = false;
        if (!hoch && !tief) break;
      }
      if (hoch) fraktal.push({ idx: i, price: hiOf(data[i]), type: 'H' });
      if (tief) fraktal.push({ idx: i, price: loOf(data[i]), type: 'L' });
    }
    const pivots = (() => {
      const m = new Map();
      for (const p of [...(pivotsIn || []), ...fraktal]) {
        const key = p.type + p.idx;
        if (!m.has(key)) m.set(key, p);
      }
      return [...m.values()].sort((a, b) => a.idx - b.idx);
    })();
    if (pivots.length < 3) return { gewichtet: [], beruehrung: [] };
    const V = (p) => useLog ? ln(p) : p;
    // Abweichung RELATIV, damit dieselbe Toleranz auf billigen und teuren Kursen gilt.
    const abw = (ist, linie) => useLog ? (V(ist) - linie) : (ist - linie) / Math.max(Math.abs(linie), 1e-12);
    // ZWEI TOLERANZEN MIT OBERGRENZE. Die uebergebene Toleranz waechst mit der
    // Schwankungsbreite -- auf einem volatilen Wochen-Chart wurden daraus rund 34 %, und ein
    // Ausbruch um 30 % galt noch als "auf der Linie". Fuer Trendlinien ist das viel zu weit.
    //   Beruehrung: ein Wendepunkt zaehlt als Treffer, wenn er hoechstens 8 % daneben liegt.
    //   Bruch/Durchstich: schon 4 % Schlusskurs jenseits der Linie gelten als Bruch.
    const tolTreffer = Math.min(tolLog, Math.log(1.08));
    const tolBruch = Math.min(tolLog * 0.6, Math.log(1.04));
    const tol = tolTreffer;
    const spanne = Math.max(1, to - from);
    const minAbstand = Math.max(4, Math.round(spanne * 0.06));
    const kand = [];
    // WICHTIGE LINIEN BEVORZUGEN (gemeldet: "das sind nicht die wichtigsten Trennlinien"): Im
    // Monatschart fehlte z. B. der grosse Abwaertstrend vom Allzeithoch ueber das Hoch 2024 --
    // er lag "zu weit" vom heutigen Kurs (Grenze war Faktor 3,3) und flog raus, obwohl er DIE
    // Widerstandslinie des Zyklus ist. Jetzt:
    //  - Naehe-Grenze relativ zur Kursspanne des Ausschnitts (bei grossen Spannen deutlich weiter),
    //  - Anker-Gewicht: grosse Wendepunkte (Zickzack) und die Extreme des Ausschnitts zaehlen
    //    mehr als kleine Zacken,
    //  - Laenge zwischen den Ankern zaehlt staerker.
    let wHi = -Infinity, wLo = Infinity;
    for (let i = from; i <= to; i++) { if (!data[i]) continue; wHi = Math.max(wHi, hiOf(data[i])); wLo = Math.min(wLo, loOf(data[i])); }
    const spanneLog = wLo > 0 && wHi > wLo ? Math.log(wHi / wLo) : 1;
    const naeheGrenze = Math.max(1.2, 0.55 * spanneLog);
    const grossIdx = new Set((pivotsIn || []).map(p => p.type + p.idx));
    const ankerGewicht = (p) => {
      let g = grossIdx.has(p.type + p.idx) ? 1.5 : 0;
      const extrem = p.type === 'H' ? Math.abs(Math.log(p.price / wHi)) : Math.abs(Math.log(p.price / wLo));
      if (extrem < 0.03) g += 3; // Hoch/Tief des Ausschnitts
      return g;
    };

    // koerper = true: LINIEN DURCH DIE KERZEN (gewuenscht: "auch Linien einzeichnen, die durch die
    // Coins gehen"). Angelegt an SCHLUSSKURSEN statt an Dochten; Dochte duerfen die Linie beliebig
    // durchstechen, nur Schlusskurse zaehlen fuer Beruehrung und Bruch -- so ziehen viele Trader
    // ihre Linien durch die Kerzenkoerper.
    const pruefe = (liste, art, koerper = false) => {
      for (let a = 0; a < liste.length; a++) {
        for (let b = a + 1; b < liste.length; b++) {
          const p1 = liste[a], p2 = liste[b];
          if (p2.idx - p1.idx < minAbstand) continue;
          const steig = (V(p2.price) - V(p1.price)) / (p2.idx - p1.idx);
          // BEIDE RICHTUNGEN. Vorher nur fallende Widerstaende und steigende Unterstuetzungen --
          // damit fehlten die Oberkante eines Aufwaertskanals (steigender Widerstand) und die
          // Unterkante eines Abwaertskanals oder Keils (fallende Unterstuetzung), oft die
          // wichtigsten Linien ueberhaupt. Ausgeschlossen bleibt nur fast Waagerechtes: Das
          // deckt Support/Resistance bereits ab, sonst stuenden Marken doppelt im Chart.
          const gesamtAenderung = useLog
            ? Math.abs(steig * spanne)
            : Math.abs(steig * spanne) / Math.max(Math.abs(V(lastClose)), 1e-12);
          if (gesamtAenderung < Math.log(1.03)) continue;
          const auf = (i) => V(p1.price) + steig * (i - p1.idx);

          // Zwischen den Ankern darf nichts deutlich durchstossen.
          // Dochte duerfen die Linie kurz ueberragen (Toleranz fuer Treffer), Schlusskurse nicht
          // (Toleranz fuer Bruch) -- genau so liest ein Chartist eine Trendlinie.
          let gueltig = true;
          for (let i = p1.idx; i <= p2.idx; i++) {
            const docht = koerper ? -Infinity : (art === 'res' ? abw(hiOf(data[i]), auf(i)) : -abw(loOf(data[i]), auf(i)));
            const schluss = art === 'res' ? abw(data[i].value, auf(i)) : -abw(data[i].value, auf(i));
            if (docht > tolTreffer || schluss > tolBruch) { gueltig = false; break; }
          }
          if (!gueltig) continue;

          // Beruehrungen: weitere Wendepunkte dieser Art nahe der Linie.
          let beruehr = 0;
          for (const p of liste) {
            if (p.idx < p1.idx) continue;
            if (Math.abs(abw(p.price, auf(p.idx))) <= tol) beruehr++;
          }
          if (beruehr < 2) continue;

          // Bruch: erster SCHLUSSKURS deutlich jenseits der Linie nach dem zweiten Anker.
          let bruchIdx = null;
          for (let i = p2.idx + 1; i <= to; i++) {
            const d = art === 'res' ? abw(data[i].value, auf(i)) : -abw(data[i].value, auf(i));
            if (d > tolBruch) { bruchIdx = i; break; }
          }

          // Laenger zurueckliegende Brueche verwerfen. Ein FRISCHER Bruch ist die Nachricht
          // ("der Abwaertstrend ist gerade gebrochen"), ein alter nur noch Chartgeschichte --
          // der zeichnete sonst ein blasses Relikt quer durch den heutigen Kurs.
          if (bruchIdx != null && (to - bruchIdx) > spanne * 0.15) continue;

          // Wo liegt die Linie HEUTE? Eine Linie, die weit ausserhalb des Kurses liegt, ist
          // fuer die aktuelle Lage bedeutungslos, egal wie schoen sie frueher war.
          const heute = useLog ? Math.exp(auf(to)) : auf(to);
          const naehe = Math.abs(ln(Math.max(heute, 1e-12)) - ln(Math.max(lastClose, 1e-12)));
          if (naehe > naeheGrenze) continue;   // relativ zur Spanne zu weit weg -> nicht mehr relevant

          const haelt = (bruchIdx != null ? bruchIdx : to) - p1.idx;
          const punkte = beruehr * 2
            + (haelt / spanne) * 6
            + ((p2.idx - p1.idx) / spanne) * 4
            + ankerGewicht(p1) + ankerGewicht(p2)
            + (bruchIdx == null ? 2 : (to - bruchIdx < spanne * 0.08 ? 1.5 : 0))  // frischer Bruch zaehlt
            - (naehe / naeheGrenze) * 2.4;
          kand.push({ art, richtung: steig < 0 ? 'ab' : 'auf', p1, p2, steig, beruehr, bruchIdx, preisHeute: heute, punkte, koerper });
        }
      }
    };
    pruefe(pivots.filter((p) => p.type === 'H'), 'res');
    pruefe(pivots.filter((p) => p.type === 'L'), 'sup');
    // Kerzen-Linien: dieselben Wendepunkte, aber mit ihrem SCHLUSSKURS als Anker.
    const kAnz = kand.length;
    const schlussPiv = (typ) => pivots.filter((p) => p.type === typ).map((p) => ({ ...p, price: data[p.idx].value }));
    pruefe(schlussPiv('H'), 'res', true);
    pruefe(schlussPiv('L'), 'sup', true);
    const koerperKand = kand.splice(kAnz);

    // AUSWAHL: die ZWEI staerksten je Art (Widerstand / Unterstuetzung), nicht nur eine.
    // Vorher verschwand die zweitbeste Linie komplett, auch wenn sie fast gleich gut war.
    //
    // Mehr als zwei je Art bewusst nicht -- das Fibonacci-Werkzeug hat gezeigt, wohin das
    // fuehrt ("viele ueberlappen sich"). Und Beinahe-Doppel werden uebersprungen: Zwei Linien,
    // die am linken und rechten Ende fast deckungsgleich liegen, sind dieselbe Aussage.
    const liniAn = (k, i) => V(k.p1.price) + k.steig * (i - k.p1.idx);
    const relAbst = (x, y) => useLog ? Math.abs(x - y) : Math.abs(x - y) / Math.max(Math.abs(y), 1e-12);
    const aehnlich = (a, b) => a.art === b.art
      && relAbst(liniAn(a, from), liniAn(b, from)) < tolTreffer * 2
      && relAbst(liniAn(a, to), liniAn(b, to)) < tolTreffer * 2;
    const waehle = (sortierung) => {
      const aus = [];
      for (const art of ['res', 'sup']) {
        const reihe = kand.filter((k) => k.art === art).sort(sortierung);
        const gewaehlt = [];
        for (const k of reihe) {
          if (gewaehlt.length >= 2) break;
          if (gewaehlt.some((g) => aehnlich(g, k))) continue;
          gewaehlt.push(k);
        }
        gewaehlt.forEach((k, rang) => aus.push({ ...k, rang }));
      }
      return aus;
    };
    // Je Art EINE Kerzen-Linie zusaetzlich -- nur wenn sie sich von den Docht-Linien unterscheidet.
    const mitKoerper = (aus) => {
      const extra = [];
      for (const art of ['res', 'sup']) {
        const k = koerperKand.filter((x) => x.art === art).sort((x, y) => y.punkte - x.punkte)
          .find((x) => !aus.some((g) => aehnlich(g, x)));
        if (k) extra.push({ ...k, rang: 2 });
      }
      return [...aus, ...extra];
    };
    return {
      // Gewichtet: Beruehrungen, Dauer und Naehe zum heutigen Kurs zusammen (Standard).
      gewichtet: mitKoerper(waehle((x, y) => y.punkte - x.punkte)),
      // Rein nach Beruehrungen: die Linie mit den meisten Treffern zuerst, bei Gleichstand
      // entscheidet die gewichtete Bewertung.
      beruehrung: mitKoerper(waehle((x, y) => (y.beruehr - x.beruehr) || (y.punkte - x.punkte)))
    };
  }

  // ---------------------------------------------------------------- Support / Resistance ----
  function detectSR(data, ctxFrom, to, atrAbs, lastClose, atrPct) {
    const fine = pivotsAuto(data, ctxFrom, to, 40, 8, Math.min(0.15, atrPct * 1.3), Math.round((to - ctxFrom + 1) / 3));
    const pts = fine.pivots.slice();
    if (fine.pending) pts.push(fine.pending);
    // Hoechstes Hoch / tiefstes Tief des Kontexts sind immer relevante Marken.
    let maxI = ctxFrom, minI = ctxFrom;
    for (let i = ctxFrom; i <= to; i++) { if (hiOf(data[i]) > hiOf(data[maxI])) maxI = i; if (loOf(data[i]) < loOf(data[minI])) minI = i; }
    pts.push({ idx: maxI, price: hiOf(data[maxI]), type: 'H', major: true });
    pts.push({ idx: minI, price: loOf(data[minI]), type: 'L', major: true });
    // TOLERANZ MIT OBERGRENZE. Vorher wuchs sie ungebremst mit der Schwankungsbreite: im
    // Tageschart ~6 %, im Wochenchart ~18 %, bei einer maximalen Zonenbreite des 1,8-Fachen.
    // Dort wurden Wendepunkte zu einer Zone verschmolzen, die ein Chartist klar trennt, und die
    // angezeigte Zahl war der Durchschnitt einer 30 % breiten Flaeche statt einer Linie.
    // Jetzt hoechstens 4 % -- dasselbe Mass, das sich bei den Trendlinien bewaehrt hat.
    // Cluster-Breite: bisher hoechstens 4 % -- auf Wochen-/Monatskerzen im Krypto (ATR oft 15-20 %)
    // blieben so zwei Beruehrungen derselben Zone (z. B. $0.98 und $1.03) getrennt, jede mit nur
    // EINER Beruehrung, und fielen beide heraus. Jetzt bis 7 %.
    const tol = Math.max(Math.log(1.016), Math.min(0.9 * atrAbs / Math.max(lastClose, 1e-9), Math.log(1.07)));
    const sorted = pts.slice().sort((a, b) => a.price - b.price);
    const clusters = [];
    for (const p of sorted) {
      const c = clusters[clusters.length - 1];
      if (c && ln(p.price) - ln(c.members[c.members.length - 1].price) <= tol && ln(p.price) - ln(c.members[0].price) <= tol * 1.8) c.members.push(p);
      else clusters.push({ members: [p] });
    }
    const span = Math.max(1, to - ctxFrom);
    const zones = clusters.map(c => {
      const m = c.members;
      let wsum = 0, psum = 0, lastIdx = 0;
      for (const p of m) { const w = 0.5 + 0.5 * (p.idx - ctxFrom) / span + (p.major ? 0.6 : 0); wsum += w; psum += w * ln(p.price); lastIdx = Math.max(lastIdx, p.idx); }
      // MITTE AM LETZTEN WENDEPUNKT. Vorher der gewichtete Durchschnitt aller Beruehrungen --
      // bei breiten Zonen eine Zahl, an der der Kurs nie gedreht hat. Jetzt der Preis der
      // juengsten Beruehrung: dort hat der Markt die Marke zuletzt tatsaechlich respektiert.
      // Der gewichtete Durchschnitt bleibt als "mittel" erhalten, falls ihn etwas braucht.
      const mittel = Math.exp(psum / wsum);
      const juengster = m.reduce((a, b) => (b.idx > a.idx ? b : a), m[0]);
      const center = juengster.price;
      // Band um die Zone ebenfalls gedeckelt: 0,3 x ATR waren im Wochenchart rund +-6 %.
      const pad = Math.min(0.3 * atrAbs, center * 0.015);
      const lo = Math.min(m[0].price, center - pad);
      const hi = Math.max(m[m.length - 1].price, center + pad);
      // Nur ECHTE Beruehrungen zaehlen (Pivots, die nicht dasselbe Extrem doppelt sind).
      const uniq = new Set(m.map(p => p.idx));
      const touches = uniq.size;
      const major = m.some(p => p.major);
      const strength = clamp(Math.round((touches * 0.9 + (major ? 1.2 : 0) + wsum * 0.4) * 10) / 10, 0.5, 9);
      const type = lastClose > hi ? 'support' : lastClose < lo ? 'resistance' : 'inside';
      return { price: center, mittel, lo, hi, touches, strength, lastIdx, major, type, firstIdx: Math.min(...m.map(p => p.idx)) };
    });
    // AUSWAHL: die NAECHSTLIEGENDE gueltige Zone je Seite plus die zwei staerksten.
    // Vorher nur die drei staerksten -- dadurch verdraengten viel beruehrte, aber weit
    // entfernte Zonen (etwa die $1,29-$1,53 aus dem Handel 2025) die naechste Marke direkt
    // ueber dem Kurs (gemeldet: ein Doppeltop bei $0,64 fehlte). Fuer die aktuelle Lage ist
    // aber gerade die naechste Marke die wichtigste.
    const abstand = (z) => Math.abs(ln(z.price) - ln(lastClose));
    // AUSWAHL OHNE LUECKEN (gemeldet: "werden alle wichtigen Zonen gezeigt?" -- RUNE Woche:
    // R $0.777, dann direkt R $4.218 und $7.576; alles dazwischen fehlte). Bisher: naechste Zone +
    // die zwei STAERKSTEN -- und die staerksten lagen oft weit weg (Allzeithoch, altes Plateau),
    // waehrend die Zonen, auf die der Kurs als Naechstes trifft, fehlten. Jetzt:
    //  1. die naechste Zone,
    //  2. das Extrem des Ausschnitts (Hoch/Tief), falls es eine Zone auf dieser Seite ist,
    //  3. Auffuellen bis n: Zonen werden nach Staerke x Naehe gewaehlt, und vor allem wird die
    //     groesste LUECKE (im Log-Abstand) zwischen den schon gewaehlten Zonen zuerst geschlossen,
    //     solange sie groesser als ~x1,6 ist.
    const pick = (list, n) => {
      if (!list.length) return [];
      const nachAbstand = list.slice().sort((a, b) => abstand(a) - abstand(b));
      const gewaehlt = [nachAbstand[0]];
      const extrem = list.filter(z => z.major && z !== nachAbstand[0]).sort((a, b) => abstand(b) - abstand(a))[0];
      if (extrem) gewaehlt.push(extrem);
      const wert = z => z.strength * Math.exp(-abstand(z) / 1.2);
      while (gewaehlt.length < n) {
        const rest = list.filter(z => !gewaehlt.includes(z));
        if (!rest.length) break;
        const stufen = [0, ...gewaehlt.map(abstand)].sort((a, b) => a - b);
        let lueckeA = 0, lueckeB = 0;
        for (let k = 1; k < stufen.length; k++) if (stufen[k] - stufen[k - 1] > lueckeB - lueckeA) { lueckeA = stufen[k - 1]; lueckeB = stufen[k]; }
        const inLuecke = lueckeB - lueckeA > Math.log(1.6) ? rest.filter(z => abstand(z) > lueckeA + Math.log(1.12) && abstand(z) < lueckeB - Math.log(1.12)) : [];
        const kand = (inLuecke.length ? inLuecke : rest).sort((a, b) => wert(b) - wert(a))[0];
        if (!inLuecke.length && wert(kand) < 1.2) break; // keine schwachen Fernzonen nur zum Auffuellen
        gewaehlt.push(kand);
      }
      return gewaehlt.sort((a, b) => abstand(a) - abstand(b));
    };
    const supports = pick(zones.filter(z => z.type === 'support' && (z.touches >= 2 || z.major)), 4);
    const resistances = pick(zones.filter(z => z.type === 'resistance' && (z.touches >= 2 || z.major)), 4);
    const inside = zones.filter(z => z.type === 'inside' && (z.touches >= 2 || z.major)).slice(0, 1);
    return { supports, resistances, inside, all: zones };
  }

  // ---------------------------------------------------------------- Fibonacci --------------
  const FIB_RETRACE = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const FIB_EXT = [1, 1.272, 1.618, 2, 2.618];
  const fibPrice = (a, b, r, useLog) => useLog ? Math.exp(ln(a) + r * (ln(b) - ln(a))) : a + r * (b - a);
  const fibRatio = (a, b, p, useLog) => useLog ? (ln(p) - ln(a)) / ((ln(b) - ln(a)) || 1e-9) : (p - a) / ((b - a) || 1e-9);
  // Ein Fibonacci-Satz aus zwei Ankerpunkten. mode: retracement (Kurs innerhalb des Swings),
  // extension (Kurs ueber das Swing-Ende hinaus). Level ausserhalb des sichtbaren Preisbereichs
  // blendet das UI selbst aus.
  function fibSet(id, A, B, lastClose, lastIdx, useLog) {
    if (!A || !B || A.idx === B.idx || !(A.price > 0) || !(B.price > 0)) return null;
    const dir = B.price > A.price ? 'up' : 'down';
    const ratioNow = fibRatio(B.price, A.price, lastClose, useLog); // 0 = bei B, 1 = zurueck bei A
    let mode, levels;
    if (ratioNow < 0) { mode = 'extension'; levels = FIB_EXT.map(r => ({ r, price: fibPrice(A.price, B.price, r, useLog) })); }
    else { mode = 'retracement'; levels = FIB_RETRACE.map(r => ({ r, price: fibPrice(B.price, A.price, r, useLog) })); }
    let nearest = null;
    for (const l of levels) { const d = Math.abs(ln(l.price) - ln(lastClose)); if (!nearest || d < nearest.d) nearest = { ...l, d }; }
    return { id, from: A, to: B, dir, mode, levels, ratioNow: clamp(ratioNow, -3, 3), nearest, drawFromIdx: A.idx, drawToIdx: Math.max(B.idx, lastIdx) };
  }
  // Fibonacci in DREI Ebenen (gemeldet: "zu selten zu sehen, muss auch ueber grosse Zeitraeume
  // sichtbar sein"):
  //  1. major  -- die Gesamtbewegung des sichtbaren Zeitraums (hoechstes Hoch <-> tiefstes
  //               Tief, zeitlich geordnet). Immer da, auch ueber Jahre.
  //  2. swing  -- der letzte groessere Swing (grobe Pivots), das "aktuelle" Fib.
  //  3. elliott -- an die laufende Wellenzaehlung gekoppelt (siehe elliottFib): die Level,
  //               die fuer die aktuelle Welle relevant sind (Welle-2-Ruecksetzer, Welle-3-
  //               Erweiterungen usw.). Das ist die "Waffe": Elliott sagt, WELCHES Fib zaehlt.
  // Dazu Konfluenz: fallen Level verschiedener Ebenen (oder eine S/R-Zone) auf denselben
  // Preis, wird das markiert -- dort ist die Reaktion am wahrscheinlichsten.
  function detectFib(data, from, to, coarse, lastClose, useLog) {
    let hiI = from, loI = from;
    for (let i = from; i <= to; i++) { if (hiOf(data[i]) > hiOf(data[hiI])) hiI = i; if (loOf(data[i]) < loOf(data[loI])) loI = i; }
    const hiP = { idx: hiI, price: hiOf(data[hiI]), type: 'H' }, loP = { idx: loI, price: loOf(data[loI]), type: 'L' };
    const major = hiI < loI ? fibSet('major', hiP, loP, lastClose, to, useLog) : fibSet('major', loP, hiP, lastClose, to, useLog);
    const P = coarse.pivots;
    let swing = null;
    if (P.length >= 2) {
      const A = P[P.length - 2], B = P[P.length - 1];
      // Nur, wenn es nicht derselbe Swing wie "major" ist UND der Swing gross genug ist, um
      // eine eigene Aussage zu haben (gemeldet: "der kleine Fibonacci ist in dieser Ansicht
      // unnoetig und verwirrend" -- ein Swing, der nur ein Teil der Gesamtbewegung am Rand ist,
      // legt seine Level genau ueber die der Gesamtbewegung). Mindestens die Haelfte der
      // Gesamtbewegung (in Log-Spanne), sonst bleibt nur die Gesamtbewegung.
      const spanOf = f => f ? Math.abs(ln(f.to.price) - ln(f.from.price)) : 0;
      const cand = fibSet('swing', A, B, lastClose, to, useLog);
      if (cand && (!major || ((Math.abs(A.idx - major.from.idx) > 2 || Math.abs(B.idx - major.to.idx) > 2) && spanOf(cand) >= spanOf(major) * 0.5))) swing = cand;
    }
    return { major, swing };
  }
  // Fibonacci-Level, die zur laufenden Elliott-Welle gehoeren -- als eigener Satz mit
  // Wellen-Bezug, damit das UI "Welle 3 · 1,618" statt nur "161,8 %" schreiben kann.
  function elliottFib(E, useLog) {
    if (!E || !E.points || E.points.length < 2) return null;
    const pt = lab => E.points.find(p => p.label === lab);
    const sign = E.dir === 'up' ? 1 : -1;
    const proj = (fromP, a, b, mult, dirSign) => useLog ? Math.exp(ln(fromP.price) + dirSign * Math.abs(ln(b.price) - ln(a.price)) * mult) : fromP.price + dirSign * Math.abs(b.price - a.price) * mult;
    const p0 = pt('0'), p1 = pt('1'), p2 = pt('2'), p3 = pt('3'), p4 = pt('4'), p5 = pt('5'), A = pt('A'), B = pt('B'), C = pt('C');
    let levels = [], anchor = null, label = null;
    const ph = E.phase;
    if (E.kind === 'impulse') {
      if (ph === 'wave2' && p0 && p1) { anchor = p1; label = '2'; levels = [0.382, 0.5, 0.618, 0.786].map(r => ({ r, wave: '2', price: proj(p1, p0, p1, r, -sign) })); }
      else if (ph === 'wave3' && p0 && p1 && p2) { anchor = p2; label = '3'; levels = [1, 1.618, 2, 2.618].map(r => ({ r, wave: '3', price: proj(p2, p0, p1, r, sign) })); }
      else if (ph === 'wave4' && p2 && p3) { anchor = p3; label = '4'; levels = [0.236, 0.382, 0.5].map(r => ({ r, wave: '4', price: proj(p3, p2, p3, r, -sign) })); }
      else if (ph === 'wave5' && p0 && p1 && p3 && p4) { anchor = p4; label = '5'; levels = [{ r: 0.618, wave: '5', price: proj(p4, p0, p1, 0.618, sign) }, { r: 1, wave: '5', price: proj(p4, p0, p1, 1, sign) }, { r: 1.618, wave: '5', price: proj(p4, p0, p1, 1.618, sign) }, { r: 0.618, wave: '1–3', price: proj(p4, p0, p3, 0.618, sign) }]; }
      else if (ph === 'impulseDone' && p0 && p5) { anchor = p5; label = 'A'; levels = [0.236, 0.382, 0.5, 0.618].map(r => ({ r, wave: '0–5', price: proj(p5, p0, p5, r, -sign) })); }
      else if ((ph === 'waveA' || ph === 'waveB') && p5 && A) { anchor = A; label = 'B'; levels = [0.382, 0.5, 0.618, 0.786].map(r => ({ r, wave: 'A', price: proj(A, p5, A, r, sign) })); }
      else if (ph === 'waveC' && p5 && A && B) { anchor = B; label = 'C'; levels = [0.618, 1, 1.272, 1.618].map(r => ({ r, wave: 'A', price: proj(B, p5, A, r, -sign) })); }
    } else {
      if (ph === 'waveC' && p0 && A && B) { anchor = B; label = 'C'; levels = [0.618, 1, 1.272, 1.618].map(r => ({ r, wave: 'A', price: proj(B, p0, A, r, sign) })); }
      else if (ph === 'corrDone' && p0 && C) { anchor = C; label = '1'; levels = [0.382, 0.5, 0.618, 1].map(r => ({ r, wave: '0–C', price: proj(C, p0, C, r, -sign) })); }
    }
    if (!levels.length || !anchor) return null;
    levels = levels.filter(l => Number.isFinite(l.price) && l.price > 0);
    // WAHRSCHEINLICHKEIT JE STUFE (gefordert: "Welle 2 kann doch nicht nur ein Ziel haben ...
    // Wahrscheinlichkeiten muessen klein zu sehen sein"): uebliche Verteilung nach Elliott-
    // Faustregeln (Welle 2: meist 50-61,8 %, seltener 38,2 % oder 78,6 %; Welle 4: meist 38,2 %;
    // Welle 3: meist 1,618 x). Bereits erreichte Stufen fallen spaeter heraus, der Rest wird auf
    // 100 % verteilt (siehe rwFibWahrscheinlichkeit).
    const GEW = { '2': { 0.382: 15, 0.5: 30, 0.618: 35, 0.786: 20 }, '4': { 0.236: 20, 0.382: 45, 0.5: 35 }, '3': { 1: 20, 1.618: 45, 2: 15, 2.618: 20 },
                  B: { 0.382: 20, 0.5: 30, 0.618: 35, 0.786: 15 }, C: { 0.618: 20, 1: 45, 1.272: 15, 1.618: 20 }, '1': { 0.382: 35, 0.5: 30, 0.618: 25, 1: 10 }, A: { 0.236: 15, 0.382: 35, 0.5: 30, 0.618: 20 } };
    const g = GEW[label] || null;
    if (g) levels.forEach(l => { l.gewicht = g[l.r] || 0; });
    return { id: 'elliott', anchor, label, phase: ph, levels, drawFromIdx: anchor.idx };
  }
  function rwFibWahrscheinlichkeit(fe, data) {
    if (!fe || !fe.anchor || !Number.isFinite(fe.anchor.idx)) return;
    let lo = Infinity, hi = -Infinity;
    for (let i = fe.anchor.idx + 1; i < data.length; i++) {
      const d = data[i]; if (!d) continue;
      const l = d.low != null ? d.low : d.value, h = d.high != null ? d.high : d.value;
      if (Number.isFinite(l) && l < lo) lo = l;
      if (Number.isFinite(h) && h > hi) hi = h;
    }
    const ap = fe.anchor.price;
    fe.levels.forEach(l => { l.erreicht = l.price < ap ? lo <= l.price : hi >= l.price; });
    const offen = fe.levels.filter(l => !l.erreicht && l.gewicht > 0);
    const summe = offen.reduce((a, l) => a + l.gewicht, 0);
    fe.levels.forEach(l => { l.prob = !l.erreicht && l.gewicht > 0 && summe > 0 ? Math.round(l.gewicht / summe * 100) : null; });
  }
  function fibConfluence(fibs, sr, tolLog) {
    const items = [];
    const push = (price, src) => items.push({ price, src });
    for (const f of [fibs.major, fibs.swing]) if (f) for (const l of f.levels) if (l.r !== 0 && l.r !== 1) push(l.price, { set: f.id, r: l.r });
    if (fibs.elliott) for (const l of fibs.elliott.levels) push(l.price, { set: 'elliott', r: l.r, wave: l.wave });
    for (const z of [...sr.supports, ...sr.resistances, ...sr.inside]) push(z.price, { set: 'sr', touches: z.touches });
    items.sort((a, b) => a.price - b.price);
    const out = [];
    let i = 0;
    while (i < items.length) {
      let j = i;
      while (j + 1 < items.length && ln(items[j + 1].price) - ln(items[i].price) <= tolLog * 0.7) j++;
      const grp = items.slice(i, j + 1);
      const sets = new Set(grp.map(g => g.src.set));
      if (sets.size >= 2) out.push({ price: Math.exp(grp.reduce((s, g) => s + ln(g.price), 0) / grp.length), sources: grp.map(g => g.src), strength: sets.size + grp.length * 0.25 });
      i = j + 1;
    }
    return out.sort((a, b) => b.strength - a.strength).slice(0, 4);
  }

  // ---------------------------------------------------------------- Elliott-Wellen v2 -------
  // Portiert aus btcorgtfo/ElliottWaveAnalyzer (MonoWave + WaveOptions): eine Welle darf
  // kleinere Gegenbewegungen UEBERSPRINGEN -- ihr Ende ist nicht zwingend der naechste
  // Wendepunkt, sondern kann jedes spaetere neue Extrem in Wellenrichtung sein ("skip"), solange
  // dazwischen der Wellenanfang nicht unterschritten wird. Aus allen Kombinationen der fuenf
  // Wellen (bis zu 4 Kandidaten je Welle) werden nur die behalten, die alle harten Regeln
  // erfuellen; die beste nach Fibonacci-Richtlinien, Alternation, Volumen und Aktualitaet
  // gewinnt. Vorher wurden nur direkt aufeinanderfolgende Wendepunkte betrachtet, dadurch
  // fehlten fast alle Impulse, in denen Welle 3 oder 5 selbst Unterwellen hatte.
  // Gedaechtnis der zuletzt gewaehlten Zaehlung je Reihe (fuer die Hysterese in detectElliott).
  const EW_HYST = new Map();
  const RW_EW_KONTEXT = new Map();   // Zwischenspeicher fuer die Gesamt-Zaehlung (grosses Bild)
  // FIXIEREN = GENAU DIESE ZAEHLUNG (gemeldet per Video: "ich will das locken, aber es lockt sich
  // dann etwas anderes"). Beim Fixieren werden die zuletzt gezeigten Zaehlungen hier eingefroren;
  // solange fixiert ist, gewinnt immer der Kandidat, der sie fortsetzt -- egal wie knapp ein
  // anderer besser waere. Lösen gibt wieder frei.
  let EW_PIN = null;
  function detectElliott(pivotSet, lastClose, lastIdx, useLog, volumes, opts) {
    const P = pivotSet.pivots.slice();
    const pend = pivotSet.pending;
    const Q = pend ? P.concat([pend]) : P.slice();
    const n = Q.length;
    if (n < 3) return null;
    const L = (a, b) => Math.abs(useLog ? ln(b.price) - ln(a.price) : b.price - a.price);
    const near = (v, target, tol) => Math.abs(v - target) <= tol;
    const dur = (a, b) => Math.max(1, Math.abs(b.idx - a.idx));
    // WEICHE FIB-NAEHE (gemeldet: "die Elliott-Berechnung wirkt manchmal willkuerlich"): Bisher gab
    // es Punkte nur in harten Stufen (z. B. +10, wenn W2 zwischen 38,2 und 78,6 % liegt). Ein
    // Rueckgang von 38,1 % statt 38,3 % kostete so 10 Punkte -- eine neue Kerze konnte die ganze
    // Zaehlung kippen. Jetzt waechst die Bewertung stetig mit der Naehe zum naechsten Idealwert
    // (Glockenkurve im Log-Verhaeltnis; tol = Breite, 0,15 ~ +-16 %). Ergebnis 0..1.
    const fibFit = (r, ideals, tol) => {
      if (!(r > 0)) return 0;
      let b = 0;
      for (const x of ideals) { const d = Math.log(r / x) / tol; b = Math.max(b, Math.exp(-0.5 * d * d)); }
      return b;
    };
    const vOf = p => (useLog ? ln(p.price) : p.price);
    const avgVol = (a, b) => {
      if (!volumes) return null;
      let s = 0, c = 0;
      for (let i = Math.min(a.idx, b.idx); i <= Math.max(a.idx, b.idx); i++) { const v = volumes[i]; if (v != null && Number.isFinite(v)) { s += v; c++; } }
      return c ? s / c : null;
    };
    const SKIP = 4; // hoechstens 4 Kandidaten je Wellenende (= skip_n 3)

    // Kandidaten fuer das Ende einer Welle ab Position `from` (exklusiv) in Richtung `up`:
    // jedes neue Extrem in Wellenrichtung; Abbruch, sobald ein Gegen-Pivot den Wellenanfang
    // (`floor`) verletzt. Genau die find_end()-Logik der MonoWaveUp/Down.
    // startPrice: Preis am Wellenanfang -- ein Gegen-Pivot, der ihn durchbricht, beendet die
    // Suche (die Welle waere ungueltig). limitPrice (optional): Grenze fuer die Wellenenden selbst,
    // z.B. darf Welle 2 nicht unter den Start von Welle 1 (Regel 1).
    const ends = (from, up, startPrice, limitPrice) => {
      const out = [];
      let best = null;
      for (let i = from + 1; i < n && out.length < SKIP; i++) {
        const p = Q[i];
        if (up ? p.type === 'L' && p.price <= startPrice : p.type === 'H' && p.price >= startPrice) break;
        if (up ? p.type === 'H' : p.type === 'L') {
          if (limitPrice != null && (up ? p.price >= limitPrice : p.price <= limitPrice)) break;
          if (best == null || (up ? p.price > best : p.price < best)) { best = p.price; out.push(i); }
        }
      }
      return out;
    };

    const cands = [];
    const evalImpulse = (idx, up, complete) => {
      // idx: Positionen in Q fuer Punkte 0..k (k = 3..5)
      const W = idx.map(i => Q[i]);
      const [p0, p1, p2, p3, p4, p5] = W;
      let truncated = false;
      // WARUM SCHEITERT EINE ZAEHLUNG? Ohne diese Spur liesse sich nur raten, an welcher der
      // rund zwanzig Bedingungen eine von Hand geprueft gueltige Punktfolge haengen bleibt.
      // Aktiv nur, wenn ausdruecklich eine Spur angefordert wurde (evalTrace), also nie im
      // Normalbetrieb.
      const spur = (typeof evalTrace !== 'undefined' && evalTrace) ? evalTrace : null;
      const nein = (grund, zahlen) => { if (spur) spur.push({ idx: W.map(p => p && p.idx), grund, zahlen }); return null; };
      const w1 = L(p0, p1), w2 = L(p1, p2), w3 = p3 ? L(p2, p3) : 0, w4 = p4 ? L(p3, p4) : 0, w5 = p5 ? L(p4, p5) : 0;
      // Regel 1: Welle 2 nie unter den Start von 1 (durch ends() bereits gesichert, hier doppelt)
      if (up ? p2.price <= p0.price : p2.price >= p0.price) return nein('W2 haelt den Start nicht', [p2.price, p0.price]);
      // MINDESTRUECKLAUF VON WELLE 2.
      //
      // Zwei Aenderungen (gemeldet: "Makro-Zaehlung startet am ATH statt am Tief 2019"; die
      // Diagnose mit erklaereZaehlung fand dazu NICHTS):
      //
      // (a) Diese Ablehnung lief bisher ueber ein nacktes `return null` und tauchte deshalb in
      //     keiner Spur auf -- genau die Zaehlung, nach der gefragt wurde, verschwand unsichtbar.
      //     Jetzt ueber nein(), also mit Grund und Zahlen wie alle anderen Regeln auch.
      // (b) Die Schwelle von 20 % ist kein Elliott-Gesetz, sondern eine Heuristik gegen Rauschen.
      //     Auf Monatskerzen kostet sie die uebergeordnete Sicht: die Zwischenkorrektur der
      //     Rally 2020/21 lief nur ~16 % von Welle 1 zurueck, womit die GANZE Aufwaertszaehlung
      //     ab dem Tief ausfiel und nur noch eine Zaehlung ab dem ATH uebrig blieb. Fuer die
      //     Makro-Sicht (forceStart) daher 12 %; im Normalbetrieb bleibt es bei 20 %.
      const w2Min = (opts && opts.forceStart) ? 0.12 : 0.2;
      if (w2 < w2Min * w1) return nein('W2 laeuft weniger als ' + Math.round(w2Min * 100) + ' % von W1 zurueck', [w2 / (w1 || 1e-9), w2Min]);
      if (dur(p1, p2) > 9 * dur(p0, p1)) return nein('W2 dauert mehr als 9x W1', [dur(p1, p2), dur(p0, p1)]);
      let diagonal = false, ueberdehnt = false;
      if (p3) {
        if (up ? p3.price <= p1.price : p3.price >= p1.price) return nein('W3 nicht ueber W1-Ende', [p3.price, p1.price]);
        if (w3 < w1 / 3 || w3 <= w2) return nein('W3 zu kurz (< W1/3 oder <= W2)', [w3, w1, w2]);
        // Welle 3 darf deutlich laenger dauern als Welle 1 -- bei RUNE (Monatschart) dauerte
        // Welle 1 des Baerenmarkts 3 Monate, Welle 3 fast drei Jahre. 7x (WaveRules.py) war zu
        // eng, 14x laesst solche Strukturen zu, blockt aber weiterhin absurde Verhaeltnisse.
        if (dur(p2, p3) > 14 * dur(p0, p1)) return nein('W3 dauert mehr als 14x W1', [dur(p2, p3), dur(p0, p1)]);
      }
      if (p4) {
        if (w4 < w2 / 3 || w4 > 0.95 * w3) return nein('W4 zu kurz oder fast so lang wie W3', [w4, w2, w3]);
        // Regel 3: Welle 4 nie im Bereich von Welle 1 -- Ausnahme Diagonale (Keil), nur wenn
        // die Bewegungswellen nachweislich schrumpfen (hobbit7771/rules_diagonal.py).
        if (up ? p4.price <= p1.price : p4.price >= p1.price) {
          // Kontrahierender Keil (Frost/Prechter): W3 < W1, W5 < W3 UND W4 < W2. Die letzte
          // Bedingung fehlte -- ohne sie wurde jeder Overlap durchgewunken, solange die
          // Bewegungswellen schrumpften.
          // (Der erweiternde Keil wurde wieder entfernt: Er verdraengte bei RUNE/BTC im Tageschart den
          // grossen Rahmen (A)(B)(C) -- gemeldet: "es wird trotzdem so gezaehlt obwohl abc". Die Altcoin-
          // Paare laufen seit 2021 als grosse A-B-C-Korrektur, nicht als Keil.)
          const kontrahierend = w3 < w1 && (!p5 || w5 < w3) && w4 < w2;
          if (kontrahierend) diagonal = true; else return nein('W4 ueberlappt W1, kein gueltiger Keil', [w1, w2, w3, w4, w5]);
        }
      }
      if (p5) {
        // TRUNCATION (Frost/Prechter): Welle 5 erreicht das Ende von Welle 3 nicht. Selten, aber
        // ausdruecklich erlaubt -- und ein wichtiges Warnsignal (Schwaeche vor der Umkehr).
        // Bisher wurde jede solche Zaehlung verworfen; jetzt wird sie zugelassen, gekennzeichnet
        // und im Punktwert abgewertet, damit eine regulaere Zaehlung vorgeht.
        //
        // Die Grenze: Welle 5 muss wenigstens ueber das Ende von Welle 4 hinausgehen (sonst ist
        // es keine Welle 5) und darf hoechstens knapp unter Welle 3 enden (10 % im Log-Raum).
        if (up ? p5.price <= p4.price : p5.price >= p4.price) return nein('W5 geht nicht ueber W4 hinaus', [p5.price, p4.price]);
        if (up ? p5.price <= p3.price : p5.price >= p3.price) {
          // "Usually by very slim margins" (Frost/Prechter). 10 % waren viel zu grosszuegig --
          // damit verdraengte eine verkuerzte Welle 5 saubere Zaehlungen, bei denen das Hoch
          // schlicht das Ende der Bewegung war. Jetzt hoechstens 3 % gemessen an Welle 3, und
          // die Zaehlung wird deutlich abgewertet.
          // KEINE VERKUERZTE WELLE 5 (gewuenscht: "sehe ich als falsch an"): Welle 5 muss ueber das
          // Ende von Welle 3 hinausgehen, sonst wird die Zaehlung verworfen. Endet die Bewegung
          // unter Welle 3, liest die Engine das hoehere Hoch als 3 und den Rueckgang als Welle 4.
          return nein('W5 nicht ueber W3 (verkuerzte Welle 5 ausgeschlossen)', [L(p5, p3) / (w3 || 1e-9)]);
        }
        // Regel 2: Welle 3 nie die kuerzeste
        if (w3 < w1 && w3 < w5) return nein('W3 ist die kuerzeste', [w1, w3, w5]);
        // UEBERDEHNTE WELLE 5. Die Referenzimplementierung verwirft jede Zaehlung mit
        // W5 >= 2 x W1 hart. Das ist zu streng: Eine verlaengerte fuenfte Welle ist ein
        // anerkanntes Muster und tritt gerade in Schlussphasen auf -- man wuerde genau die
        // Zaehlung verlieren, die eine Blase beschreibt. Deshalb kein Ausschluss, sondern
        // eine Abwertung, damit eine unauffaellige Lesart bei sonst gleichem Befund vorgeht.
        if (w5 > 2 * w1) ueberdehnt = true;
      }
      // BEWERTUNG NACH DEN RICHTLINIEN (Frost/Prechter, "Elliott Wave Principle"): Regeln
      // streichen Zaehlungen, Richtlinien ordnen die uebrigen. Alle Richtlinien gehen stetig ein
      // (fibFit), damit kleine Kursaenderungen nur kleine Bewertungsaenderungen bewirken.
      let s = complete ? (diagonal ? 42 : 50) : 38 - (p4 ? 0 : 2);
      if (ueberdehnt) s -= 6;
      if (truncated) s -= 15; // regulaere Zaehlung geht klar vor
      const r2 = w2 / (w1 || 1e-9);
      // W2: typisch 50 / 61,8 % von W1 (tief, oft Zickzack)
      s += 14 * fibFit(r2, [0.5, 0.618], 0.2);
      if (p3) {
        const r3 = w3 / (w1 || 1e-9);
        if (r3 >= 1) s += 6;
        // W3: 1,618 / 2,618 x W1 (haeufigste Verlaengerung)
        s += 10 * fibFit(r3, [1.618, 2.618], 0.2);
        // Wellen-Persoenlichkeit: W3 ist die steilste Welle (staerkstes Momentum)
        if (w3 / dur(p2, p3) >= w1 / dur(p0, p1)) s += 3;
      }
      if (p4) {
        const r4 = w4 / (w3 || 1e-9);
        // W4: typisch 38,2 % von W3 (23,6-50 %)
        s += 8 * fibFit(r4, [0.382, 0.236, 0.5], 0.2);
        // Wechsel (Alternation): tiefe W2 -> flache W4 und umgekehrt; zusaetzlich zeitlich:
        // die flache Korrektur dauert meist laenger.
        const deep2 = r2 > 0.618, shallow2 = r2 < 0.382, deep4 = r4 > 0.618, shallow4 = r4 < 0.382;
        if ((deep2 && deep4) || (shallow2 && shallow4)) s -= 5; else if ((deep2 && shallow4) || (shallow2 && deep4)) s += 5;
        const tR = dur(p3, p4) / dur(p1, p2);
        if (r4 < r2 && tR >= 1 && tR <= 4) s += 3;
        // Kanal: W4 endet meist nahe der Parallelen zur Linie 1-3 durch 2 (Frost/Prechter)
        const sl13 = (vOf(p3) - vOf(p1)) / (p3.idx - p1.idx || 1);
        const d4 = Math.abs(vOf(p4) - (vOf(p2) + sl13 * (p4.idx - p2.idx))) / (w3 || 1e-9);
        s += 4 * Math.exp(-0.5 * (d4 / 0.25) ** 2);
      }
      if (p5) {
        const r5 = w5 / (w1 || 1e-9), w13 = L(p0, p3) || 1e-9;
        // Verlaengerung: meist genau EINE der Wellen 1/3/5 deutlich laenger als die anderen
        const lens = [w1, w3, w5].sort((a, b) => b - a);
        const extW = lens[0] === w3 ? 3 : lens[0] === w5 ? 5 : 1;
        if (lens[0] >= 1.35 * lens[1]) s += 5; else if (lens[0] < 1.1 * lens[1]) s -= 3;
        // Gleichheit: bei verlaengerter 3 tendiert W5 zu W1 (oder 0,618 x W1); sonst W5 = 0,382 /
        // 0,618 x (0-3), bei verlaengerter 5 auch 1,618 x (0-3)
        const fit5 = extW === 3 ? fibFit(r5, [1, 0.618], 0.18)
          : Math.max(fibFit(w5 / w13, [0.618, 0.382], 0.18), extW === 5 ? fibFit(w5 / w13, [1.618, 1], 0.2) : 0, fibFit(r5, [1, 0.618], 0.2) * 0.7);
        s += 9 * fit5;
        if (w3 >= w1 && w3 >= w5) s += 8; else if (w5 > w3) s -= 6;
        if (r5 > 2.5 && extW !== 5) s -= 8;
        // Kanal: W5 endet meist nahe der Parallelen zur Linie 2-4 durch 3 (Ueberschiessen erlaubt)
        const sl24 = (vOf(p4) - vOf(p2)) / (p4.idx - p2.idx || 1);
        const d5 = (vOf(p5) - (vOf(p3) + sl24 * (p5.idx - p3.idx))) * (up ? 1 : -1) / (w5 || 1e-9);
        s += 4 * Math.exp(-0.5 * (Math.min(0, d5 + 0.1) / 0.35) ** 2) * (d5 > 0.6 ? 0.6 : 1);
        // Persoenlichkeit: W5 schwaecher als W3 (Momentum), Volumen am groessten in W3
        if (w5 / dur(p4, p5) < w3 / dur(p2, p3)) s += 3;
        const v1 = avgVol(p0, p1), v3 = avgVol(p2, p3), v5 = avgVol(p4, p5);
        if (v1 != null && v3 != null && v5 != null) { if (v3 > v1 && v3 > v5) s += 6; else if (v5 > v3 * 1.3) s -= 3; }
      }
      // GRAD-STIMMIGKEIT (gemeldet: RUNE Monat -- "warum endet Welle 3 erst dort? Welle 4 ist nicht
      // sichtbar"): Die Korrekturen INNERHALB einer Welle gehoeren zum naechstkleineren Grad und
      // muessen kleiner sein als die Korrekturwellen 2 und 4 selbst. Lag in "Welle 3" eine
      // Gegenbewegung von +130 %, waehrend die "Welle 4" danach nur +70 % betrug, war die Zaehlung
      // verschoben: die grosse Gegenbewegung IST Welle 4. Jetzt: Gegenbewegungen innerhalb von W3
      // (und W5) groesser als W4 -- bzw. innerhalb von W1 groesser als W2 -- kosten Punkte.
      const innenMax = (a, b) => {
        let m = 0;
        for (let k = a; k < b; k++) {
          const d = (vOf(Q[k + 1]) - vOf(Q[k])) * (up ? 1 : -1);
          if (d < 0) m = Math.max(m, -d);
        }
        return m;
      };
      const strafe = (innen, korr, gewicht) => (korr > 0 && innen > korr ? gewicht * Math.min(1, innen / korr - 1) + 3 : 0);
      if (p2) s -= strafe(innenMax(idx[0], idx[1]), w2, 8);
      if (p4) s -= strafe(innenMax(idx[2], idx[3]), w4, 14);
      if (p5) s -= strafe(innenMax(idx[4], idx[5]), w4, 8);
      // ZEIT-STIMMIGKEIT (Kontrolle 04.10.2026, RUNE Tag: Welle 3 und 5 lagen am selben Hoch, W4 und
      // W5 dauerten zusammen ~4 Kerzen nach einer W1 von ~5 Wochen). Wellen DESSELBEN Grades sind
      // zeitlich grob vergleichbar; eine W5 von wenigen Kerzen nach einer wochenlangen W1 ist fast
      // immer nur ein Unterwellen-Zacken am Ende von W3 -- die Zaehlung ist um einen Grad
      // verschoben. Bisher gab es nur OBERgrenzen (W2 <= 9x W1, W3 <= 14x W1), keine Untergrenze.
      // Weich (Abwertung), nicht hart: Schlusswellen koennen kurz und heftig sein.
      if (p4) { const rt = dur(p3, p4) / dur(p1, p2); if (rt < 0.25) s -= 6 * Math.min(1, (0.25 - rt) / 0.2) + 2; }
      if (p5) { const rt = dur(p4, p5) / dur(p0, p1); if (rt < 0.2) s -= 10 * Math.min(1, (0.2 - rt) / 0.15) + 2; }
      const spanPiv = idx[idx.length - 1] - idx[0];
      s += Math.min(8, Math.max(0, spanPiv - (idx.length - 1)) * 1.5);
      return { score: s, diagonal, truncated };
    };

    // A-B-C nach einem kompletten Impuls (Position e = Punkt 5), ebenfalls mit Skip.
    const abcAfter = (e, up, p5) => {
      const aOpts = ends(e, !up, p5.price, null).slice(0, 3);
      let best = null;
      for (const ai of aOpts) {
        const a = Q[ai];
        const bOpts = ends(ai, up, a.price, p5.price).slice(0, 3);
        if (!bOpts.length) { const c = { pts: [ai], score: 1 }; if (!best || c.score > best.score) best = c; continue; }
        for (const bi of bOpts) {
          const b = Q[bi];
          const rb = L(a, b) / (L(p5, a) || 1e-9);
          if (rb > 1.3) continue;
          const cOpts = ends(bi, !up, b.price, null).slice(0, 3);
          if (!cOpts.length) { const c = { pts: [ai, bi], score: 2 + fibFit(rb, [0.5, 0.618, 0.382], 0.3) }; if (!best || c.score > best.score) best = c; continue; }
          for (const ci of cOpts) {
            const rc = L(b, Q[ci]) / (L(p5, a) || 1e-9);
            // C = A (haeufigst), dann 1,618 x A bzw. 0,618 x A (Frost/Prechter)
            const c = { pts: [ai, bi, ci], score: 3 + fibFit(rb, [0.5, 0.618, 0.382], 0.3) + Math.max(fibFit(rc, [1], 0.18), 0.8 * fibFit(rc, [1.618, 0.618], 0.18)) + (Q[ci].pending ? 0 : 0.5) };
            if (!best || c.score > best.score) best = c;
          }
        }
      }
      const pts = best ? best.pts.map((pi, i) => ({ ...Q[pi], label: ['A', 'B', 'C'][i] })) : [];
      pts.lastPos = best ? best.pts[best.pts.length - 1] : null;
      return pts;
    };

    // forceStart (fuer die uebergeordnete Sicht): Die Zaehlung MUSS beim ersten Wendepunkt des
    // Fensters beginnen. Ohne das waehlt die Bewertung die Zaehlung am rechten Rand, weil sie
    // besser zum aktuellen Geschehen passt -- fuer eine Makro-Sicht ist aber genau der linke
    // Rand der Ausgangspunkt.
    // Nicht stur der allererste Wendepunkt: Die ersten drei sind erlaubt. Sonst scheitert die
    // Makro-Sicht daran, dass ausgerechnet der aeusserste Punkt keine regelkonforme Zaehlung
    // traegt -- und dann gaebe es gar keine uebergeordnete Sicht.
    const s0Max = (opts && opts.forceStart) ? Math.min(3, n - 2) : n - 2;
    for (let s0 = 0; s0 < s0Max; s0++) {
      for (const up of [true, false]) {
        const p0 = Q[s0];
        if (up ? p0.type !== 'L' : p0.type !== 'H') continue;
        for (const i1 of ends(s0, up, p0.price, null)) {
          for (const i2 of ends(i1, !up, Q[i1].price, p0.price)) {
            // 1-2 (vorlaeufig): Punkt 2 ist das letzte oder unbestaetigte Extrem
            if (i2 >= n - 1) { const r = evalImpulse([s0, i1, i2], up, false); if (r) cands.push({ type: 'impulse', up, idx: [s0, i1, i2], points: [s0, i1, i2].map(i => Q[i]), complete: false, score: r.score - 8, diagonal: false, coveredTo: i2 }); }
            for (const i3 of ends(i2, up, Q[i2].price, null)) {
              if (i3 >= n - 1) { const r = evalImpulse([s0, i1, i2, i3], up, false); if (r) cands.push({ type: 'impulse', up, idx: [s0, i1, i2, i3], points: [s0, i1, i2, i3].map(i => Q[i]), complete: false, score: r.score, diagonal: r.diagonal, truncated: r.truncated, coveredTo: i3 }); }
              for (const i4 of ends(i3, !up, Q[i3].price, Q[i2].price)) {
                if (i4 >= n - 1) { const r = evalImpulse([s0, i1, i2, i3, i4], up, false); if (r) cands.push({ type: 'impulse', up, idx: [s0, i1, i2, i3, i4], points: [s0, i1, i2, i3, i4].map(i => Q[i]), complete: false, score: r.score, diagonal: r.diagonal, truncated: r.truncated, coveredTo: i4 }); }
                for (const i5 of ends(i4, up, Q[i4].price, null)) {
                  const idx = [s0, i1, i2, i3, i4, i5];
                  const complete = !Q[i5].pending;
                  const r = evalImpulse(idx, up, complete);
                  if (!r) continue;
                  const abc = complete ? abcAfter(i5, up, Q[i5]) : [];
                  const coveredTo = abc.length ? abc.lastPos : i5;
                  // Eine Zaehlung muss die AKTUELLE Position beschreiben: Impuls + Korrektur
                  // muessen bis an den letzten oder vorletzten Wendepunkt reichen.
                  //
                  // NICHT fuer die Makro-Sicht (forceStart): dort ist genau das Gegenteil
                  // gefragt. Eine uebergeordnete Zaehlung ab dem Tief 2019 endet mit ihrer
                  // A-B-C im Baerenmarkt-Tief -- alles danach ist die NAECHSTE Struktur, nicht
                  // ein Mangel dieser. Die Regel verwarf sie deshalb still (kein nein(), also
                  // auch in der Diagnose unsichtbar) und liess nur Zaehlungen uebrig, die nahe
                  // am rechten Rand beginnen -- daher der Start am ATH.
                  if (!(opts && opts.forceStart) && n - 1 - coveredTo > 1) continue;
                  cands.push({ type: 'impulse', up, idx, points: idx.map(i => Q[i]), complete, score: r.score + (coveredTo === n - 1 ? 8 : 4), diagonal: r.diagonal, truncated: r.truncated, abc, coveredTo });
                }
              }
            }
          }
        }
      }
    }
    // Reine A-B-C-Korrektur am Ende (Zickzack/Flat), ebenfalls mit Skip auf A und C.
    // Bei forceStart (Makro-Sicht) ebenfalls nur ab dem ersten Wendepunkt.
    const corrFrom = (opts && opts.forceStart) ? 0 : Math.max(0, n - 8);
    const corrTo = (opts && opts.forceStart) ? Math.min(3, n - 2) : n - 2;
    for (let s0 = corrFrom; s0 < corrTo; s0++) {
      for (const down of [true, false]) {
        const p0 = Q[s0];
        if (down ? p0.type !== 'H' : p0.type !== 'L') continue;
        const up = !down; // Richtung, in die die Korrektur laeuft (= Richtung von A und C)
        // A laeuft in Korrekturrichtung, B dagegen, C wieder in Korrekturrichtung.
        for (const ai of ends(s0, up, p0.price, null)) {
          const a = Q[ai];
          for (const bi of ends(ai, !up, a.price, null)) {
            const b = Q[bi];
            // B darf den Anfang der Korrektur (p0) nicht ueberschreiten
            if (up ? b.price <= p0.price : b.price >= p0.price) continue;
            const wa = L(p0, a), wb = L(a, b);
            const rb = wb / (wa || 1e-9);
            if (rb < 0.2 || rb > 1.3) continue;
            // Sehr grosse "Welle A" (mehr als 3,3-fach, 1,2 im Log-Raum): auf dem Gesamtchart
            // legitim -- der Absturz 2021-22 (-94 %) IST die Welle A der grossen Korrektur, und
            // genau diese A-B-C will man auf dem grossen Zeitraum sehen. Was NICHT passieren
            // darf: dass C = A daraus ein 60x-Ziel ableitet. Deshalb wird der Kandidat behalten,
            // aber (a) leicht abgestuft, damit bei gleichwertiger Impuls-Lesart der Impuls
            // gewinnt, und (b) die fuer die Ziele verwendete A-Laenge auf 1,2 (Log) gedeckelt
            // (siehe Zielberechnung unten).
            if (useLog && wa > 1.2 && wa > 2.5) continue; // jenseits ~12x ist es kein A mehr
            if (dur(a, b) > 10 * dur(p0, a)) continue;
            for (const ci of ends(bi, up, b.price, null)) {
              if (n - 1 - ci > 1) continue;
              const c = Q[ci];
              const wc = L(b, c), rc = wc / (wa || 1e-9);
              if (!c.pending && (rc < 0.6 || rc > 2.61)) continue;
              // DAUER VON WELLE C begrenzen -- fehlte bisher komplett. Fuer B galt die Grenze
              // bereits (10x A), fuer C nicht, obwohl die Referenzimplementierung sie fuer
              // beide setzt. Ohne sie konnte eine jahrelange Seitwaertsbewegung als "Welle C"
              // einer viel kuerzeren A durchgehen.
              if (dur(b, c) > 10 * dur(p0, a)) continue;
              const corrType = rb <= 0.786 ? 'zigzag' : rb >= 0.9 ? 'flat' : 'unknown';
              // Zickzack: B 38,2-78,6 % von A, C = A (oder 1,618 / 0,618 x A); Flat: B ~ 100 %,
              // C ~ A. Stetig bewertet (fibFit) statt in Stufen.
              const bFit = corrType === 'flat' ? fibFit(rb, [1, 0.9], 0.1) : fibFit(rb, [0.5, 0.618, 0.382], 0.3);
              const cFit = Math.max(fibFit(rc, [1], 0.18), 0.8 * fibFit(rc, [1.618, 0.618], 0.18));
              const score = 34 + 10 * bFit + (corrType === 'flat' ? 8 * fibFit(rc, [1], 0.15) : 0) + 10 * cFit + (c.pending ? 0 : 4) + (corrType === 'unknown' ? -4 : 0) + (ci === n - 1 ? 2 : 0);
              cands.push({ type: 'corrective', up, idx: [s0, ai, bi, ci], points: [p0, a, b, c], complete: !c.pending, score, ratios: { rb, rc }, corrType, coveredTo: ci });
            }
          }
        }
      }
    }
    if (!cands.length) return null;
    // Optionale Vorgaben der Grad-Wahl: mindestens so viele Punkte, und der Beginn mindestens so
    // weit vor dem Ende -- damit auf dem Gesamtchart die grosse, weitgehend fertige Struktur
    // gewinnt und nicht eine vorlaeufige 1-2 mit drei Punkten am rechten Rand.
    if (opts && (opts.minPoints || opts.minSpan)) {
      // HARTE ZUSATZREGEL (gemeldet: "die large-Zaehlung sieht komisch aus" -- Welle 3 lief von
      // $13,40 auf $0,59 und enthielt dabei die komplette Erholung auf ~$10):
      //
      // Eine Antriebswelle (1, 3, 5, A, C) darf INNERHALB ihrer selbst nicht nahezu vollstaendig
      // zurueckgelaufen sein. Passiert das doch, ist die Struktur in Wahrheit mehrteilig und man
      // haette an dieser Stelle teilen muessen -- die Skip-Kombinatorik ueberspringt den Punkt
      // sonst stillschweigend und behauptet eine Welle, die es so nicht gibt. Grenze: 61,8 %
      // (Fibonacci) -- wer mehr zurueckliefe, waere nach Elliott keine einzelne Welle mehr.
      const reihe = opts.data;
      const LN = v => Math.log(Math.max(v, 1e-9));
      const internOk = (c) => {
        if (!reihe) return true;
        const antrieb = c.type === 'impulse' ? [0, 2, 4] : [0, 2]; // Segmente 0→1, 2→3, 4→5
        for (const k of antrieb) {
          const a2 = c.points[k], b2 = c.points[k + 1];
          if (!a2 || !b2) continue;
          const runter = b2.price < a2.price;
          const ganz = Math.abs(LN(a2.price) - LN(b2.price));
          if (ganz <= 0) continue;
          // Nur pruefen, wenn die Welle lang genug ist, um ueberhaupt ein inneres Retracement
          // zu zeigen. Auf Monatskerzen besteht eine Welle oft aus drei, vier Kerzen -- dort
          // misst die Regel Rauschen und verwarf zuletzt JEDE Zaehlung (siehe Diagnose:
          // "keine gueltige Zaehlung" auf allen Stufen).
          if (b2.idx - a2.idx < 5) continue;
          // Laufendes Extrem mitfuehren und an JEDER Stelle fragen: wie viel der bis dahin
          // gelaufenen Strecke wurde gerade zurueckerobert? Erst ab 20 % gelaufener Strecke
          // messen -- ganz am Anfang ist der Nenner naturgemaess winzig.
          let lauf = a2.price, maxR = 0;
          for (let i = a2.idx; i <= b2.idx && i < reihe.length; i++) {
            const hi = reihe[i].high != null ? reihe[i].high : reihe[i].value;
            const lo = reihe[i].low != null ? reihe[i].low : reihe[i].value;
            if (runter) { if (lo < lauf) lauf = lo; } else { if (hi > lauf) lauf = hi; }
            const gelaufen = Math.abs(LN(a2.price) - LN(lauf));
            if (gelaufen < 0.2 * ganz) continue;
            const gegen = runter ? hi : lo;
            const r = Math.abs(LN(gegen) - LN(lauf)) / gelaufen;
            if (r > maxR) maxR = r;
          }
          if (maxR > 0.618) return false;
        }
        return true;
      };
      // EINHEITENFEHLER (gemeldet: "wieso liegt der Fokus bei so einem grossen Zeitraum auf den
      // letzten kleinen Wellen?"): Hier stand `lastIdx - c.idx[0]`. c.idx[0] ist aber die
      // POSITION im Pivot-Array (0, 1, 2 ...), lastIdx dagegen ein KERZEN-Index (z. B. 71). Die
      // Differenz war damit fast immer die halbe Historie, die Huerde ging IMMER auf -- und schon
      // auf der groebsten Stufe rutschte eine Zaehlung am rechten Rand durch, die nur ein Viertel
      // des Charts umspannt. Richtig ist der Kerzen-Index des ersten Punktes.
      const spanVon = c => lastIdx - c.points[0].idx;
      const gef = cands.filter(c => (!opts.minPoints || c.points.length >= opts.minPoints) && (!opts.minSpan || spanVon(c) >= opts.minSpan) && internOk(c));
      if (!gef.length) return null;
      cands.length = 0; cands.push(...gef);
      // FIX (gemeldet: "immer noch klein gezaehlt"): Der reine Bestwert waehlte oft eine SPAETERE
      // Struktur, die die Huerde zwar erfuellt, aber nur die halbe Historie umfasst -- etwa eine
      // Zaehlung ab dem Hoch 2024 statt ab dem Hoch 2021. Auf dem grossen Zeitraum will man die
      // GROESSTE Struktur sehen. Deshalb: unter allen Kandidaten, die nah am Bestwert liegen
      // (hoechstens 12 Punkte darunter), gewinnt der mit dem FRUEHESTEN Start.
      let bestScore = -Infinity;
      for (const c of cands) if (c.score > bestScore) bestScore = c.score;
      // 'coarse' (Nutzer hat "gross" gewaehlt) heisst: die FRUEHESTE gueltige Struktur, ohne
      // Ruecksicht auf den Punktwert -- genau das will jemand sehen, der "die grosse Zaehlung"
      // verlangt. Bei 'auto' bleibt es bei der Naehe zum Bestwert (hoechstens 12 Punkte darunter),
      // damit die Automatik keine schwache Zaehlung nur wegen ihres fruehen Starts nimmt.
      const nah = opts.preferEarliest ? cands.slice() : cands.filter(c => c.score >= bestScore - 12);
      nah.sort((x, y) => x.idx[0] - y.idx[0] || y.score - x.score);
      // AM AEUSSERSTEN WENDEPUNKT BEGINNEN (gemeldet: "faengt die erste Welle nicht schon bei den
      // 29 Cent an?"): Liegt das tiefste Tief (bzw. hoechste Hoch) der Wendepunkte VOR dem Start der
      // gewaehlten Zaehlung, und gibt es einen gueltigen Kandidaten, der genau dort beginnt und nicht
      // mehr als 20 Punkte schlechter ist, gewinnt dieser. Ein Impuls beginnt am Extrem der Bewegung
      // davor -- nicht irgendwo danach.
      if (!opts.preferEarliest && nah.length && pivotSet && Array.isArray(pivotSet.pivots) && pivotSet.pivots.length) {
        const pv = pivotSet.pivots;
        const tief = pv.reduce((m, q) => (q.type === 'L' && (!m || q.price < m.price) ? q : m), null);
        const hoch = pv.reduce((m, q) => (q.type === 'H' && (!m || q.price > m.price) ? q : m), null);
        const amExtrem = cands.filter(c => {
          const p0 = c.points[0];
          const ext = c.up ? tief : hoch;
          return ext && p0.idx === ext.idx && c.score >= bestScore - 20;
        }).sort((x, y) => y.score - x.score);
        const erster = nah[0];
        if (amExtrem.length && erster && erster.points[0].idx > amExtrem[0].points[0].idx) {
          const k = nah.indexOf(amExtrem[0]);
          if (k > 0) nah.splice(k, 1);
          if (k !== 0) nah.unshift(amExtrem[0]);
        }
      }
      cands.length = 0; cands.push(...nah);
    }
    cands.sort((x, y) => (opts && (opts.minPoints || opts.minSpan)) ? 0 : y.score - x.score);
    // Dasselbe fuer die feine Zaehlung (Rueckfall ohne Grad-Vorgaben): beginnt ein gueltiger,
    // hoechstens 20 Punkte schlechterer Kandidat am aeussersten Wendepunkt VOR dem Start des
    // besten, gewinnt er (siehe "AM AEUSSERSTEN WENDEPUNKT BEGINNEN").
    if (!(opts && (opts.minPoints || opts.minSpan || opts.forceStart || opts.preferEarliest)) && cands.length > 1 && pivotSet && Array.isArray(pivotSet.pivots)) {
      const pv = pivotSet.pivots, top = cands[0];
      const tief = pv.reduce((m, q) => (q.type === 'L' && (!m || q.price < m.price) ? q : m), null);
      const hoch = pv.reduce((m, q) => (q.type === 'H' && (!m || q.price > m.price) ? q : m), null);
      const ext = top.up ? tief : hoch;
      if (ext && top.points[0].idx > ext.idx) {
        const alt = cands.filter(c => c.up === top.up && c.points[0].idx === ext.idx && c.score >= top.score - 20).sort((x, y) => y.score - x.score)[0];
        if (alt) { cands.splice(cands.indexOf(alt), 1); cands.unshift(alt); }
      }
    }
    // HYSTERESE (gemeldet: "willkuerlich" -- mit jeder neuen Kerze konnte eine ganz andere Zaehlung
    // gewinnen, wenn sie nur knapp besser war). Die zuletzt gezeigte Zaehlung derselben Reihe wird
    // gemerkt (Datum ihrer bestaetigten Punkte). Gibt es einen Kandidaten, der sie FORTSETZT (alle
    // bestaetigten Punkte an derselben Stelle, gleiche Richtung und Art) und hoechstens 8 Punkte
    // schlechter ist, bleibt es bei ihr. Erst ein klar besserer Kandidat loest den Umbau aus.
    let best = cands[0];
    const hystKey = opts && opts.data && opts.data.length > 1
      ? [opts.data[0].date, opts.data[0].value, opts.data[1].date - opts.data[0].date, useLog ? 'L' : 'N', opts.minPoints || 0, opts.preferEarliest ? 'E' : '', pivotSet.pct || ''].join('|') : null;
    if (hystKey && best) {
      const vorher = EW_HYST.get(hystKey);
      const dat = i => (opts.data[i] ? opts.data[i].date : null);
      const fest = EW_PIN && EW_PIN.get(hystKey);
      const ziel = fest || vorher;
      if (ziel && !(ziel.type === best.type && ziel.up === best.up && ziel.dates.every((d, k) => best.points[k] && dat(best.points[k].idx) === d))) {
        const fort = cands.find(c => c.type === ziel.type && c.up === ziel.up && ziel.dates.length <= c.points.length && ziel.dates.every((d, k) => dat(c.points[k].idx) === d));
        if (fort && (fest || fort.score >= best.score - 8)) best = fort;
      }
      EW_HYST.set(hystKey, { type: best.type, up: best.up, dates: best.points.filter(p => !p.pending).map(p => dat(p.idx)) });
      if (EW_HYST.size > 200) EW_HYST.delete(EW_HYST.keys().next().value);
    }
    const alt = cands.find(c => c !== best && (c.up !== best.up || c.type !== best.type || Math.abs(c.idx[0] - best.idx[0]) >= 2) && c.score >= 42) || null;

    const labelsImp = ['0', '1', '2', '3', '4', '5'];
    const labelsCor = ['0', 'A', 'B', 'C'];
    let points = [], phase = null, targets = [], dir = best.up ? 'up' : 'down', kind = best.type;
    const sign = best.up ? 1 : -1;
    const proj = (fromP, lenLog, mult) => useLog ? Math.exp(ln(fromP.price) + sign * lenLog * mult) : fromP.price + sign * lenLog * mult;
    const back = (fromP, lenLog, mult) => useLog ? Math.exp(ln(fromP.price) - sign * lenLog * mult) : fromP.price - sign * lenLog * mult;
    const refLen = (a, b) => ({ abs: Math.abs(b.price - a.price), pct: Math.abs(b.price / a.price - 1) * 100 });
    const T = (key, price, fromP, fromLabel, factor, refA, refB, refLabel, s) => ({ key, price, explain: { fromLabel, fromPrice: fromP.price, factor, refLabel, ref: refLen(refA, refB), sign: (s == null ? sign : s) > 0 ? '+' : '−' } });
    // ZIEL-LEITER (gemeldet: "Welle 3 bei 0,733, obwohl wir schon ueber 80 Cent sind"): Die Ziele
    // der LAUFENDEN Welle waren feste Fib-Vielfache (W3 = 1,618 x W1, C = 1 x A, ...), auch wenn
    // der Kurs sie laengst hinter sich hatte -- die Projektion lief dann rueckwaerts. Jetzt gilt:
    // Ziel ist das erste Vielfache der Leiter, das JENSEITS des bisherigen Extrems der Welle
    // liegt (hoechster/tiefster Pivot seit dem Startpunkt, laufender Pivot, letzter Schluss).
    // Ist die ganze Leiter ueberschritten, steht das Ziel am Extrem selbst.
    const weiter = (x, y, s) => (useLog ? ln(x) - ln(y) : x - y) * s > 0;
    const extSeit = (fromP, s) => {
      let e = null;
      for (const q of Q) if (q.idx > fromP.idx && Number.isFinite(q.price) && (e == null || weiter(q.price, e, s))) e = q.price;
      if (Number.isFinite(lastClose) && (e == null || weiter(lastClose, e, s))) e = lastClose;
      return e != null && weiter(e, fromP.price, s) ? e : null;
    };
    const leiter = (key, keyB, fromP, fromLabel, lenLog, ratios, refA, refB, refLabel, s) => {
      if (!(lenLog > 0)) return [];
      const mv = r => (useLog ? Math.exp(ln(fromP.price) + s * lenLog * r) : fromP.price + s * lenLog * r);
      const ext = extSeit(fromP, s);
      // ZIEL GETROFFEN, NICHT UEBERSCHRITTEN (gemeldet: "C war 0,699 und wurde perfekt mit der
      // Wick getroffen -- jetzt steht ein anderes Ziel da"). Bisher sprang die Leiter auf die
      // naechste Stufe, sobald das Extrem die Zielstufe auch nur um einen Tick passiert hatte.
      // Ein Docht knapp ueber das Ziel, nach dem der Kurs wieder auf die alte Seite schliesst,
      // ist aber ein Treffer: Diese Stufe bleibt das Ziel (mit Haken), die naechste wird nur
      // Erweiterung. Knapp = hoechstens 5 % der Referenzlaenge jenseits der Stufe.
      const tolG = lenLog * 0.05;
      // ERWEITERT (gewuenscht): Auch ein tieferer Docht zaehlt als Treffer, solange seit dem
      // Start der Welle KEIN Schlusskurs jenseits der Stufe lag -- erst ein Schluss darunter (bzw.
      // darueber) schiebt die Leiter zur naechsten Stufe. (Gemeldet: C-Ziel sprang auf
      // 2,618 x A, obwohl nur ein Docht unter 1,618 x A war und der Kurs wieder darueber stand.)
      const reiheL = opts && opts.data;
      const schlussJenseits = z => {
        if (!reiheL || !fromP || !Number.isFinite(fromP.idx)) return true;
        for (let i = fromP.idx + 1; i < reiheL.length; i++) { const c = reiheL[i] && reiheL[i].value; if (Number.isFinite(c) && weiter(c, z, s)) return true; }
        return false;
      };
      // NOCH WEITER GEFASST (gemeldet: "genau gleich geblieben" -- ein einzelner Tagesschluss lag
      // kurz unter 1,618 x A, der Kurs steht aber wieder darueber): Massgeblich ist die TIEFSTE
      // (aeusserste) Stufe, die das Extrem erreicht hat. Steht der AKTUELLE Schluss wieder
      // diesseits dieser Stufe, gilt sie als Treffer -- die Welle hat dort gedreht. Erst solange
      // der Kurs jenseits der Stufe bleibt, ist die naechste Stufe das Ziel.
      void schlussJenseits;
      const getroffen = ext == null ? null : (() => {
        const erreichte = ratios.filter(r => ((useLog ? ln(ext) - ln(mv(r)) : ext - mv(r)) * s) >= 0);
        if (!erreichte.length) return null;
        const r = erreichte[erreichte.length - 1];
        const z = mv(r);
        if (Number.isFinite(lastClose) && weiter(lastClose, z, s)) return null;
        return r;
      })();
      if (getroffen != null) {
        const out = [{ ...T(key, mv(getroffen), fromP, fromLabel, getroffen, refA, refB, refLabel, s), hit: true }];
        const naechste = ratios.find(r => r > getroffen);
        if (keyB && naechste != null) out.push(T(keyB, mv(naechste), fromP, fromLabel, naechste, refA, refB, refLabel, s));
        return out;
      }
      const offen = ratios.filter(r => ext == null || weiter(mv(r), ext, s));
      const out = [];
      if (offen.length) {
        out.push(T(key, mv(offen[0]), fromP, fromLabel, offen[0], refA, refB, refLabel, s));
        if (keyB && offen[1] != null) out.push(T(keyB, mv(offen[1]), fromP, fromLabel, offen[1], refA, refB, refLabel, s));
      } else if (ext != null) {
        const f = (useLog ? Math.abs(ln(ext) - ln(fromP.price)) : Math.abs(ext - fromP.price)) / lenLog;
        out.push(T(key, ext, fromP, fromLabel, +f.toFixed(3), refA, refB, refLabel, s));
      }
      return out;
    };
    if (best.type === 'impulse') {
      points = best.points.map((p, i) => ({ ...p, label: labelsImp[i] }));
      const [p0, p1, p2, p3, p4, p5] = best.points;
      // Referenzlaengen fuer die ZIELE im Log-Raum gedeckelt (1,2 = 3,3-fach): bei einer Welle 1
      // von -95 % (2021-22) ergaebe "Welle 5 = Welle 1" ein Ziel bei drei Cent. Die Zaehlung
      // bleibt, die Ziele bleiben in einem Bereich, den ein Analyst so hinschreiben wuerde.
      const w1 = useLog ? Math.min(L(p0, p1), 1.2) : L(p0, p1), w3 = p3 ? (useLog ? Math.min(L(p2, p3), 1.2) : L(p2, p3)) : 0;
      const k = best.points.length;
      const lastPending = best.points[k - 1].pending;
      if (k === 3) {
        if (p2.pending) { phase = 'wave2'; targets.push(...leiter('ewTargetW2', null, p1, '1', w1, [0.618, 0.786], p0, p1, '1', -sign)); }
        else phase = 'wave3';
        targets.push(...leiter('ewTargetW3', null, p2, '2', w1, [1.618, 2, 2.618, 3.618], p0, p1, '1', sign));
      } else if (k === 4) { phase = 'wave3'; targets.push(...leiter('ewTargetW3', 'ewTargetW3b', p2, '2', w1, [1.618, 2, 2.618, 3.618], p0, p1, '1', sign)); }
      else if (k === 5) {
        phase = lastPending ? 'wave4' : 'wave5';
        if (lastPending) targets.push(...leiter('ewTargetW4', null, p3, '3', w3, [0.382, 0.5], p2, p3, '3', -sign), T('ewTargetW5', proj(p4, w1, 1), p4, '4', 1, p0, p1, '1'));
        else targets.push(T('ewTargetW4', useLog ? Math.exp(ln(p3.price) - sign * w3 * 0.382) : p3.price - sign * w3 * 0.382, p3, '3', 0.382, p2, p3, '3', -sign), ...leiter('ewTargetW5', null, p4, '4', w1, [1, 1.618, 2.618], p0, p1, '1', sign));
      }
      else {
        if (lastPending) {
          phase = 'wave5';
          targets.push(...leiter('ewTargetW5', null, p4, '4', w1, [1, 1.618, 2.618], p0, p1, '1', sign));
          const w5b = proj(p4, L(p0, p3), 0.618), e5 = extSeit(p4, sign);
          if (e5 == null || weiter(w5b, e5, sign)) targets.push(T('ewTargetW5b', w5b, p4, '4', 0.618, p0, p3, '1–3'));
        }
        else {
          let abc = best.abc || [];
          // A-B-C SCHON IN DER STRECKE 5 -> A? (gemeldet: "ABC ist schon gebildet" -- RUNE 4H). Die
          // Pivot-Suche war fuer den Ruecksetzer in der Mitte zu grob: Sie zaehlte das tiefste Tief als A
          // und den jetzigen Gegenlauf als B. Hier wird die Strecke 5 -> A noch einmal Kerze fuer Kerze
          // geprueft (Regeln wie bei der Nachlauf-Zaehlung): ein Zwischen-Extrem a mit Gegenbewegung b
          // (>= 23,6 % von a, nicht ueber 5 hinaus), danach das Extrem jenseits von a als c (>= 61,8 % von
          // a), a >= 30 % der ganzen Strecke. Holt der Kurs seit c schon 23,6 % zurueck, ist die
          // Korrektur fertig (A-B-C), sonst laeuft C.
          try {
            if (abc.length === 2 && abc[1].pending && p5 && abc[0] && abc[0].idx > p5.idx + 2) {
              const korrRunter = sign > 0; // nach Aufwaerts-Impuls laeuft die Korrektur abwaerts
              // Kerzen kommen ueber opts.data (nicht jeder Aufruf reicht sie mit); sonst die Wendepunkte selbst.
              const kd = opts && Array.isArray(opts.data) ? opts.data : null;
              const hi = d => (d.high != null ? d.high : d.value), lo = d => (d.low != null ? d.low : d.value);
              const reihe = kd ? null : Q.filter(q => q && q.idx > p5.idx && q.idx < abc[0].idx).sort((x, y) => x.idx - y.idx);
              const Lx = (a, b) => Math.abs(useLog ? ln(a) - ln(b) : a - b);
              const ges = Lx(abc[0].price, p5.price);
              let lauf = null, fund = null;
              const schritte = kd ? Array.from({ length: Math.max(0, abc[0].idx - p5.idx - 1) }, (_, k) => p5.idx + 1 + k) : reihe.map(q => q.idx);
              for (let si = 0; si < schritte.length; si++) {
                const i = schritte[si];
                const d = kd ? kd[i] : null;
                const q = kd ? null : reihe[si];
                if (kd && !d) continue;
                const ext = kd ? (korrRunter ? lo(d) : hi(d)) : ((korrRunter ? q.type === 'L' : q.type === 'H') ? q.price : NaN);
                const geg = kd ? (korrRunter ? hi(d) : lo(d)) : ((korrRunter ? q.type === 'H' : q.type === 'L') ? q.price : NaN);
                if (ext > 0 && (!lauf || (korrRunter ? ext < lauf.price : ext > lauf.price))) lauf = { idx: i, price: ext };
                if (!lauf || !(geg > 0) || (kd ? i <= lauf.idx + 1 : i <= lauf.idx)) continue;
                const lA = Lx(lauf.price, p5.price);
                if (!(lA > 0) || lA < 0.3 * ges) continue;
                if (korrRunter ? geg >= p5.price : geg <= p5.price) continue;
                const rueck = Lx(lauf.price, geg) / lA, lC = Lx(abc[0].price, geg);
                if (rueck >= 0.236 && rueck < 1 && lC >= 0.618 * lA && (!fund || rueck > fund.rueck)) fund = { a: { ...lauf }, b: { idx: i, price: geg }, rueck };
              }
              if (fund) {
                const tA = abc[0].type, tB = tA === 'H' ? 'L' : 'H';
                const seitC = Lx(abc[1].price, abc[0].price) / ges;
                abc = [
                  { idx: fund.a.idx, price: fund.a.price, type: tA, label: 'A', pending: false },
                  { idx: fund.b.idx, price: fund.b.price, type: tB, label: 'B', pending: false },
                  { ...abc[0], label: 'C', pending: !(seitC >= 0.236) },
                ];
              }
            }
          } catch (x) {}
          const full = L(p0, p5);
          // BUGFIX ("Welle A steht bei 0,634, obwohl wir schon ueber 80 Cent sind"): Das A-Ziel war
          // fest das 38,2-%-Niveau der Welle 0-5 -- auch wenn die laufende Gegenbewegung seit 5
          // laengst darueber hinaus ist. Die Projektion lief dann vom aktuellen Kurs RUECKWAERTS
          // zu diesem A. Jetzt zaehlt das bisherige Extrem seit 5 (laufender Pivot bzw. letzter
          // Schluss): Ziel ist das naechste Fib-Niveau (38,2 / 50 / 61,8 / 78,6 %) JENSEITS davon,
          // das zweite Ziel das darauf folgende. Ist selbst 78,6 % schon ueberschritten, gilt das
          // Extrem als A (danach folgen B und C).
          const corrZiele = () => {
            const jenseits = (x, y) => (useLog ? ln(x) - ln(y) : x - y) * -sign > 0; // x weiter in Korrekturrichtung als y
            let ext = null;
            if (pend && pend.idx > p5.idx && jenseits(pend.price, p5.price)) ext = pend.price;
            if (Number.isFinite(lastClose) && jenseits(lastClose, p5.price) && (ext == null || jenseits(lastClose, ext))) ext = lastClose;
            const stufen = [0.382, 0.5, 0.618, 0.786];
            const offen = ext == null ? stufen : stufen.filter(r => jenseits(back(p5, full, r), ext));
            const r1 = offen[0], r2 = offen[1] != null ? offen[1] : null;
            if (r1 != null) targets.push(T('ewTargetCorr', back(p5, full, r1), p5, '5', r1, p0, p5, '0–5', -sign));
            else if (ext != null) targets.push(T('ewTargetCorr', ext, p5, '5', +(L(p5, { price: ext }) / full).toFixed(3), p0, p5, '0–5', -sign));
            // Zweites Ziel: ohne Ueberschreitung wie bisher 61,8 %, sonst das naechste offene Niveau.
            const rB = r1 == null ? null : r1 === 0.382 ? 0.618 : (r2 != null ? r2 : null);
            if (rB != null) targets.push(T('ewTargetCorrB', back(p5, full, rB), p5, '5', rB, p0, p5, '0–5', -sign));
          };
          // EIN EINZELNES "A" WIRD NICHT BESCHRIFTET (gemeldet: "da steht nur a ohne b und c").
          //
          // Mit nur einem bestaetigten Korrekturpunkt laesst sich gar nicht sagen, DASS es ein A
          // ist: dieselbe eine Bewegung kann die Welle 1 eines neuen Impulses sein, eine Welle B,
          // oder der erste Teil einer laufenden Korrektur. Das Label behauptete also eine
          // Einordnung, die die Daten noch nicht hergeben -- und im Chart stand ein A, hinter dem
          // nie ein B und C kamen. Erst ab ZWEI bestaetigten Punkten (A und B) ist die Korrektur
          // als solche lesbar; vorher bleibt es bei "Impuls fertig" und die Korrektur erscheint
          // vollstaendig als gestrichelte A-B-C-Projektion.
          if (abc.length >= 2) {
            points = points.concat(abc);
            if (abc.length === 2) { phase = abc[1].pending ? 'waveB' : 'waveC'; targets.push(...(phase === 'waveC' ? leiter('ewTargetC', null, abc[1], 'B', L(p5, abc[0]), [1, 1.272, 1.618, 2.618], p5, abc[0], 'A', -sign) : [T('ewTargetC', back(abc[1], L(p5, abc[0]), 1), abc[1], 'B', 1, p5, abc[0], 'A', -sign)])); }
            else { phase = abc[2].pending ? 'waveC' : 'corrDone'; if (abc[2].pending) targets.push(...leiter('ewTargetC', null, abc[1], 'B', L(p5, abc[0]), [1, 1.272, 1.618, 2.618], p5, abc[0], 'A', -sign)); else { const lc = L(p5, abc[2]); targets.push(T('ewTargetNewImpulse', proj(abc[2], lc, 0.382), abc[2], 'C', 0.382, p5, abc[2], '5→C'), T('ewTargetNewImpulseB', proj(abc[2], lc, 0.618), abc[2], 'C', 0.618, p5, abc[2], '5→C')); } }
          } else {
            phase = 'impulseDone';
            corrZiele();
          }
        }
      }
    } else {
      points = best.points.map((p, i) => ({ ...p, label: labelsCor[i] }));
      const [p0, a, b, c] = best.points;
      phase = c.pending ? 'waveC' : 'corrDone';
      // A-Laenge fuer die Ziele gedeckelt (1,2 im Log-Raum = 3,3-fach): "C = A" bei einer
      // 15-fachen Welle A ergaebe Fantasieziele -- die Struktur bleibt, das Ziel wird zahm.
      const la = useLog ? Math.min(L(p0, a), 1.2) : L(p0, a);
      if (c.pending) targets.push(...leiter('ewTargetC', 'ewTargetCb', b, 'B', la, [1, 1.272, 1.618, 2.618], p0, a, 'A', sign));
      else {
        // Korrektur fertig: Ziele des neuen Impulses als 38,2 % / 61,8 % Rueckeroberung der
        // ganzen Korrektur (0 -> C). Das "Niveau von 0" als Ziel war auf dem Gesamtchart ein
        // 30x-Versprechen -- Elliott sagt zwar, dass ein neuer Impuls den Korrekturstart
        // irgendwann uebertrifft, aber als naechstes Ziel taugt das nicht.
        const lc = L(p0, c);
        targets.push(T('ewTargetNewImpulse', back(c, lc, 0.382), c, 'C', 0.382, p0, c, '0→C', -sign), T('ewTargetNewImpulseB', back(c, lc, 0.618), c, 'C', 0.618, p0, c, '0→C', -sign));
      }
    }
    // ERWARTETER VERLAUF (gemeldet: "Ziele als gestrichelte zukuenftige Bewegung zeichnen, damit
    // man sieht, wohin das fuehrt"): aus der laufenden Phase die naechsten 1-3 Wellen als
    // Punkte in der Zukunft -- Preis aus den Fibonacci-Richtwerten, Zeit aus der Dauer der
    // analogen Welle (Welle 4 ~ Welle 2, Welle 5 ~ Welle 1, Welle 3 ~ 1,6 x Welle 1 usw.).
    // dIdx = Kerzen nach der aktuellen Kerze.
    const projection = [];
    {
      const durOf = (a, b) => a && b ? Math.max(2, Math.abs(b.idx - a.idx)) : null;
      const lab = l => points.find(p => p.label === l);
      const P0 = lab('0'), P1 = lab('1'), P2 = lab('2'), P3 = lab('3'), P4 = lab('4'), P5 = lab('5'), PA = lab('A'), PB = lab('B'), PC = lab('C');
      const avgDur = points.length >= 2 ? Math.max(2, Math.round((points[points.length - 1].idx - points[0].idx) / (points.length - 1))) : 8;
      const d1 = durOf(P0, P1) || avgDur, d2 = durOf(P1, P2) || Math.round(avgDur * 0.7), d3 = durOf(P2, P3) || Math.round(d1 * 1.6), dA = durOf(P5, PA) || d2;
      const tgt = k => { const x = targets.find(t => t.key === k); return x ? x.price : null; };
      const lenL = (a, b) => useLog ? Math.abs(ln(b) - ln(a)) : Math.abs(b - a);
      const move = (fromPrice, lenLog, mult, s) => useLog ? Math.exp(ln(fromPrice) + s * lenLog * mult) : fromPrice + s * lenLog * mult;
      const w1 = P0 && P1 ? lenL(P0.price, P1.price) : null;
      let acc = 0;
      const trefferPreise = targets.filter(x => x.hit).map(x => x.price);
      const push = (label, price, d) => { if (!Number.isFinite(price) || price <= 0) return; acc += Math.max(2, Math.round(d)); projection.push({ label, price, dIdx: acc, hit: trefferPreise.includes(price) || undefined }); };
      // WELLE 1 LAEUFT SCHON (gemeldet: "Welle 1 immer noch nicht angepasst"): Nach fertigem (C)
      // wurde stur ein "1" bei 38,2 % der Korrektur in die ZUKUNFT gesetzt -- auch wenn der Kurs
      // seit (C) laengst darueber hinaus gelaufen war. Dann ist diese Bewegung selbst Welle 1 (oder
      // ihr Grossteil). Projektion dann: (2) = 61,8 % Rueckholung von 1, (3) = 1,618 x Welle 1.
      const extremSeitC = dir => {
        if (!PC) return null;
        let ext = null;
        for (const q of (Q || [])) {
          if (!q || !(q.idx > PC.idx) || !Number.isFinite(q.price)) continue;
          if (!ext || (dir > 0 ? q.price > ext.price : q.price < ext.price)) ext = { idx: q.idx, price: q.price };
        }
        if (Number.isFinite(lastClose) && (!ext || (dir > 0 ? lastClose > ext.price : lastClose < ext.price))) ext = { idx: lastIdx, price: lastClose };
        return ext;
      };
      const welle1Laeuft = (dir, ziel1) => {
        const ext = extremSeitC(dir);
        if (!ext || !Number.isFinite(ziel1) || !(dir > 0 ? ext.price >= ziel1 : ext.price <= ziel1)) return false;
        const w = lenL(PC.price, ext.price);
        const d1n = Math.max(2, ext.idx - PC.idx), rest = Math.max(0, lastIdx - ext.idx);
        const t2 = move(ext.price, w, 0.618, -dir);
        push('2', t2, Math.max(2, d1n * 0.6 - rest));
        push('3', move(t2, w, 1.618, dir), d1n * 1.6);
        return true;
      };
      // C-ZIEL SCHON UEBERSCHRITTEN (gemeldet: "C" bei $0,699 ueber dem aktuellen Kurs $0,631,
      // die Projektion lief erst HOCH zu C): Liegt der Kurs schon jenseits des Standardziels
      // (C = A), gilt die naechste Fib-Ausdehnung (1,618 x A, dann 2,618 x A); ist auch die
      // ueberschritten, laeuft C noch -- dann steht C beim aktuellen Kurs statt in der Vergangenheit.
      const cZiel = (cStd, corrDir, PBx, laengeA) => {
        if (!Number.isFinite(cStd) || !Number.isFinite(lastClose)) return cStd;
        const jenseits = z => corrDir > 0 ? lastClose >= z : lastClose <= z;
        if (!jenseits(cStd)) return cStd;
        if (PBx && Number.isFinite(laengeA) && laengeA > 0) {
          for (const f of [1.618, 2.618]) { const z = move(PBx.price, laengeA, f, corrDir); if (Number.isFinite(z) && z > 0 && !jenseits(z)) return z; }
        }
        return lastClose;
      };
      // KORREKTUR NACH DEM GANZEN IMPULS: Zeit nach dem GRAD skaliert (Kontrolle 04.10.2026).
      // Bisher kam die Dauer von Welle 2 (bzw. 0,8-1x davon je Schritt) -- W2 ist aber eine Stufe
      // KLEINER als die A-B-C, die den ganzen Impuls 0-5 korrigiert. Nach einem steilen W2-
      // Einbruch von wenigen Kerzen lag dadurch die komplette A-B-C in den naechsten 6 Kerzen.
      // Jetzt: Korrektur ~ 50 % der Impulsdauer (Richtwert 38-62 %), aufgeteilt A 36 % / B 28 % /
      // C 36 %; mindestens so lang wie die laengere der Wellen 2 und 4.
      const korrDauer = endIdx => {
        const imp = P0 && endIdx != null ? Math.abs(endIdx - P0.idx) : null;
        const d4 = durOf(P3, P4) || 0;
        return Math.max(6, Math.round((imp || d1 * 3) * 0.5), d2, d4);
      };
      if (best.type === 'impulse') {
        if (phase === 'wave2') { const t2 = tgt('ewTargetW2'); push('2', t2, d2 * 0.6); if (t2 && w1) push('3', move(t2, w1, 1.618, sign), d3); }
        else if (phase === 'wave3') { const t3 = tgt('ewTargetW3'); const remain = P3 ? d3 * 0.4 : d3 * 0.7; push('3', t3, remain); if (t3 && P2 && w1) { const w3p = lenL(P2.price, t3); const t4 = move(t3, w3p, 0.382, -sign); push('4', t4, d2); push('5', move(t4, w1, 1, sign), d1); } }
        else if (phase === 'wave4') { const t4 = tgt('ewTargetW4'); push('4', t4, d2 * 0.6); if (t4 && w1) push('5', move(t4, w1, 1, sign), d1); }
        else if (phase === 'wave5') { const t5 = tgt('ewTargetW5'); push('5', t5, d1 * 0.6); if (t5 && P0) { const tk = korrDauer((P4 ? P4.idx : P0.idx) + d1); push('A', move(t5, lenL(P0.price, t5), 0.382, -sign), tk * 0.36); } }
        else if (phase === 'impulseDone') { const a = tgt('ewTargetCorr'); const tk = korrDauer(P5 ? P5.idx : null); push('A', a, tk * 0.36); if (a && P5) { const b = move(a, lenL(P5.price, a), 0.618, sign); push('B', b, tk * 0.28); push('C', move(b, lenL(P5.price, a), 1, -sign), tk * 0.36); } }
        else if (phase === 'waveA') { const b = tgt('ewTargetB'); if (PA) { push('A', PA.price, Math.round(dA * 0.4)); } if (b && PA && P5) { push('B', b, Math.round(dA * 0.8)); push('C', move(b, lenL(P5.price, PA.price), 1, -sign), dA); } }
        else if (phase === 'waveB') { const b = tgt('ewTargetB'); const c = tgt('ewTargetC'); if (b && !PB) push('B', b, Math.round(dA * 0.6)); if (c) push('C', c, dA); else if (b && PA && P5) push('C', move(b, lenL(P5.price, PA.price), 1, -sign), dA); }
        else if (phase === 'waveC') { push('C', cZiel(tgt('ewTargetC'), -sign, PB, PA && P5 ? lenL(P5.price, PA.price) : null), Math.round(dA * 0.6)); }
        else if (phase === 'corrDone' && P5 && PC) { const z1 = move(PC.price, lenL(P5.price, PC.price), 0.382, sign); if (!welle1Laeuft(sign, z1)) push('1', z1, Math.round(d1 * 1.2)); }
      } else {
        // Nach einer fertigen Korrektur: Welle 1 des neuen Impulses erobert typischerweise
        // 38,2 % der Korrektur zurueck -- NICHT das ganze Ausgangsniveau (das war zu
        // aggressiv, besonders auf Monatsbasis).
        if (phase === 'waveC') { const c = cZiel(tgt('ewTargetC'), sign, PB, PA && P0 ? lenL(P0.price, PA.price) : null); push('C', c, Math.round(dA * 0.6)); if (c && P0) push('1', move(c, lenL(P0.price, c), 0.382, -sign), Math.round(d1 * 1.2)); }
        else if (phase === 'corrDone' && P0 && PC) { const z1 = move(PC.price, lenL(P0.price, PC.price), 0.382, -sign); if (!welle1Laeuft(-sign, z1)) push('1', z1, Math.round(d1 * 1.2)); }
      }
    }
    // UNGUELTIGKEIT: der Preis, dessen Bruch die Zaehlung nach den harten Regeln faellt. Das
    // ist die Verzweigung zwischen den Szenarien -- solange er haelt, gilt die Zaehlung.
    let invalidation = null;
    // C SCHON FERTIG MOEGLICH? (gemeldet: "C koennte doch theoretisch jetzt schon fertig sein" und
    // "der Satz mit invalid waere dann falsch"). Richtig: Die einzige Pflicht fuer C ist, ueber das
    // Ende von A hinauszulaufen. Ist das geschafft, ist "C fertig" ein gueltiges Szenario -- ein
    // Anstieg ueber B widerlegt dann nicht die Zaehlung, sondern BESTAETIGT, dass C vorbei ist.
    // Die harte Grenze liegt dann woanders: Die ganze Korrektur ist Welle (2) des groesseren Grads
    // und darf den Start des Impulses (0) nicht unterschreiten. B wird zur Weiche zwischen
    // "C laeuft noch" und "C ist fertig".
    let cMinimum = null, weiche = null;
    {
      const lab = l => points.find(p => p.label === l);
      const PA = lab('A'), PB = lab('B');
      const reihe = opts && opts.data;
      if (phase === 'waveC' && PA && PB && reihe && reihe.length > PB.idx + 1) {
        const abwaerts = best.type === 'impulse' ? best.up : !best.up; // Richtung von C
        let ext = null, extIdx = null;
        for (let i = PB.idx + 1; i < reihe.length; i++) {
          const v = abwaerts ? (reihe[i].low != null ? reihe[i].low : reihe[i].value) : (reihe[i].high != null ? reihe[i].high : reihe[i].value);
          if (!Number.isFinite(v)) continue;
          if (ext == null || (abwaerts ? v < ext : v > ext)) { ext = v; extIdx = i; }
        }
        const P0x = lab('0');
        const startA = best.type === 'impulse' ? lab('5') : P0x;
        if (ext != null && (abwaerts ? ext < PA.price : ext > PA.price) && startA) {
          const lenA = Math.abs(useLog ? ln(PA.price) - ln(startA.price) : PA.price - startA.price);
          const lenC = Math.abs(useLog ? ln(ext) - ln(PB.price) : ext - PB.price);
          cMinimum = { price: ext, idx: extIdx, ratio: lenA > 0 ? lenC / lenA : null, down: abwaerts };
        }
      }
    }
    {
      const lab = l => points.find(p => p.label === l);
      const P0 = lab('0'), P1 = lab('1'), P2 = lab('2'), P4 = lab('4'), P5 = lab('5'), PA = lab('A');
      const below = best.up; // Impuls aufwaerts -> Ungueltigkeit UNTER dem Niveau
      if (best.type === 'impulse') {
        if (phase === 'wave2' || phase === 'wave3') { if (P0) invalidation = { price: P0.price, below, ruleKey: 'proInvRule1' }; }
        else if (phase === 'wave4') { if (P1) invalidation = { price: P1.price, below, ruleKey: 'proInvRule3' }; }
        else if (phase === 'wave5') { if (P4) invalidation = { price: P4.price, below, ruleKey: 'proInvW5' }; }
        else if (phase === 'impulseDone' || phase === 'waveA' || phase === 'waveB') { if (P5) invalidation = { price: P5.price, below: !below, ruleKey: 'proInvBeyondEnd' }; }
        else if (phase === 'waveC' && lab('B')) {
          if (cMinimum && P0) {
            invalidation = { price: P0.price, below, ruleKey: 'proInvW2Grad' };
            weiche = { price: lab('B').price, below: !below, key: 'proSwitchCDone' };
          } else invalidation = { price: lab('B').price, below: !below, ruleKey: 'proInvC' };
        }
        else if (phase === 'corrDone' && lab('C')) { invalidation = { price: lab('C').price, below, ruleKey: 'proInvNewImpulse' }; }
      } else {
        // Korrektur: B darf den Start (0) nicht ueberschreiten (Zickzack) bzw. nur begrenzt (Flat)
        // Aufwaerts-Korrektur (A steigt): Start 0 ist ein Tief -> ungueltig UNTER 0; abwaerts umgekehrt
        if (phase === 'waveC' && P0) {
          invalidation = { price: P0.price, below: best.up, ruleKey: 'proInvCorrStart' };
          if (cMinimum && lab('B')) weiche = { price: lab('B').price, below: best.up, key: 'proSwitchCDone' };
        }
        // Nach einer fertigen Korrektur laeuft der neue Impuls ENTGEGEN der Korrektur: A-B-C abwaerts
        // -> neuer Impuls aufwaerts -> ungueltig UNTER (C). Vorher stand hier best.up (Richtung der
        // Korrektur selbst) -- gemeldet als "invalid above" unter dem Kurs.
        else if (phase === 'corrDone' && lab('C')) invalidation = { price: lab('C').price, below: !best.up, ruleKey: 'proInvNewImpulse' };
      }
      if (invalidation && !(Number.isFinite(invalidation.price) && invalidation.price > 0)) invalidation = null;
    }
    // SZENARIEN NACH DEM ZIEL (gefragt: "Was passiert, nachdem das Ziel erreicht wurde? Welche
    // Moeglichkeiten? Was muss passieren? Wie hoch sind die Wahrscheinlichkeiten?"): je Phase
    // 2-3 Verzweigungen mit Ausloeser (Schluss ueber/unter X) und Ziel. Die Basis-Prozente sind
    // Elliott-Richtwerte (z.B. C = A in ~60 % der Zickzacks, C = 1,618 A ~25 %, Truncation
    // ~15 %), in analyze() werden sie um groesseren Grad, Indikatoren und S/R korrigiert -- ein
    // Modell, keine Statistik, und so wird es auch beschriftet.
    const scenarios = [];
    {
      const lab = l => points.find(p => p.label === l);
      const lenL = (a, b) => useLog ? Math.abs(ln(b) - ln(a)) : Math.abs(b - a);
      const mv = (fromPrice, lenLog, mult, sg) => useLog ? Math.exp(ln(fromPrice) + sg * lenLog * mult) : fromPrice + sg * lenLog * mult;
      const P0 = lab('0'), P1 = lab('1'), P2 = lab('2'), P3 = lab('3'), P4 = lab('4'), P5 = lab('5'), PA = lab('A'), PB = lab('B');
      const tgt = k => { const x = targets.find(t => t.key === k); return x ? x.price : null; };
      const push = (key, dirUp, prob, trigger, target) => { if (target != null && !(Number.isFinite(target) && target > 0)) target = null; scenarios.push({ key, dir: dirUp ? 'up' : 'down', prob, trigger, target }); };
      const s = sign; // +1 Impuls aufwaerts
      if (best.type === 'impulse') {
        const w1 = P0 && P1 ? lenL(P0.price, P1.price) : null;
        if (phase === 'wave2' || phase === 'wave4') {
          const t = tgt(phase === 'wave2' ? 'ewTargetW2' : 'ewTargetW4');
          const nextT = tgt(phase === 'wave2' ? 'ewTargetW3' : 'ewTargetW5');
          push('scenResume', s > 0, 60, { price: t, below: s > 0 }, nextT);
          push('scenDeeper', s < 0, 25, { price: t, below: s > 0, beyond: true }, t != null && w1 ? mv(t, w1, 0.2, -s) : null);
          if (invalidation) push('scenFail', s < 0, 15, { price: invalidation.price, below: invalidation.below }, null);
        } else if (phase === 'wave3' || phase === 'wave5') {
          const t = tgt(phase === 'wave3' ? 'ewTargetW3' : 'ewTargetW5');
          const after = phase === 'wave3' ? (t != null && P2 && w1 ? mv(t, lenL(P2.price, t), 0.382, -s) : null) : (t != null && P0 ? mv(t, lenL(P0.price, t), 0.382, -s) : null);
          push('scenNext', s < 0, 60, { price: t, below: s < 0 }, after);
          push('scenExtend', s > 0, 25, { price: t, below: s < 0, beyond: true }, tgt(phase === 'wave3' ? 'ewTargetW3b' : 'ewTargetW5b') || (t != null && w1 ? mv(t, w1, 0.618, s) : null));
          if (invalidation) push('scenFail', s < 0, 15, { price: invalidation.price, below: invalidation.below }, null);
        } else if (phase === 'impulseDone') {
          const a = tgt('ewTargetCorr'), b = tgt('ewTargetCorrB');
          push('scenCorrection', s < 0, 65, { price: P5 ? P5.price : null, below: s > 0 }, a);
          push('scenExtend', s > 0, 20, { price: P5 ? P5.price : null, below: s < 0, beyond: true }, P5 && w1 ? mv(P5.price, w1, 0.618, s) : null);
          push('scenDeeper', s < 0, 15, { price: a, below: s > 0, beyond: true }, b);
        } else if (phase === 'waveA' || phase === 'waveB' || phase === 'waveC') {
          // Korrektur nach dem Impuls: C-Ziel, danach Fortsetzung des Impulstrends.
          // ZIEL DANACH (gefragt: "wohin genau geht es nach C?"): Der fertige Impuls 0-5 wird zu Welle (1)
          // des naechsthoeheren Grades, A-B-C zu Welle (2) -- die Fortsetzung ist Welle (3). Richtwert:
          // Welle (3) = 1,618 x Welle (1), ab dem Ende von C (Frost/Prechter). Vorher: nur 61,8 % des
          // Wegs zurueck zu Welle 5 -- also nicht einmal ein neues Hoch, obwohl die Fortsetzung eines
          // Impulstrends per Definition ueber Welle 5 hinausgeht.
          const c = tgt('ewTargetC') || tgt('ewTargetB');
          const cont = c != null && P0 && P5 ? mv(c, lenL(P0.price, P5.price), 1.618, s) : null;
          // C kann schon fertig sein, sobald sie das Ende von A ueberschritten hat. Gewicht nach der
          // bisherigen Laenge von C relativ zu A (Richtwert: C endet meist bei 1,0 x A; deutlich
          // kuerzere C sind selten). Die uebrigen Szenarien werden anteilig kleiner.
          const pDone = phase === 'waveC' && cMinimum ? (cMinimum.ratio >= 1 ? 45 : cMinimum.ratio >= 0.786 ? 35 : cMinimum.ratio >= 0.618 ? 25 : 15) : 0;
          const f = (100 - pDone) / 100;
          if (pDone) {
            const contDone = P0 && P5 ? mv(cMinimum.price, lenL(P0.price, P5.price), 1.618, s) : null;
            push('scenCDone', s > 0, pDone, { price: PB ? PB.price : null, below: s < 0, cLow: cMinimum.price }, contDone);
          }
          push('scenContinue', s > 0, Math.round(50 * f), { price: PB ? PB.price : (PA ? PA.price : null), below: s < 0, after: c }, cont);
          push('scenExtend', s < 0, Math.round(30 * f), { price: c, below: s > 0, beyond: true }, c != null && P5 && PA ? mv(PB ? PB.price : c, lenL(P5.price, PA.price), 1.618, -s) : null);
          if (!pDone) push('scenFail', s > 0, 20, { price: PB ? PB.price : null, below: s < 0, before: c }, P5 ? P5.price : null);
          else if (invalidation) push('scenFail', s < 0, Math.max(0, 100 - pDone - Math.round(50 * f) - Math.round(30 * f)), { price: invalidation.price, below: invalidation.below }, null);
        } else if (phase === 'corrDone') {
          const cP = lab('C');
          push('scenNewImpulse', s > 0, 55, { price: PB ? PB.price : null, below: s < 0 }, P5 && cP ? mv(cP.price, lenL(P5.price, cP.price), 0.618, s) : null);
          push('scenCorrCont', s < 0, 30, { price: cP ? cP.price : null, below: s > 0, beyond: true }, cP && PA && P5 ? mv(cP.price, lenL(P5.price, PA.price), 0.618, -s) : null);
          if (invalidation) push('scenFail', s < 0, 15, { price: invalidation.price, below: invalidation.below }, null);
        }
      } else {
        const A = lab('A'), B = lab('B'), C = lab('C');
        const corrUp = best.up; // Richtung der Korrektur (A)
        if (phase === 'waveC') {
          const c = tgt('ewTargetC');
          const cont = c != null && P0 ? mv(c, lenL(P0.price, c), 0.618, corrUp ? -1 : 1) : null;
          const pDone = cMinimum ? (cMinimum.ratio >= 1 ? 45 : cMinimum.ratio >= 0.786 ? 35 : cMinimum.ratio >= 0.618 ? 25 : 15) : 0;
          const f = (100 - pDone) / 100;
          if (pDone) push('scenCDone', !corrUp, pDone, { price: B ? B.price : null, below: corrUp, cLow: cMinimum.price },
            P0 ? mv(cMinimum.price, lenL(P0.price, cMinimum.price), 0.618, corrUp ? -1 : 1) : null);
          push('scenContinue', !corrUp, Math.round(50 * f), { price: B ? B.price : null, below: corrUp, after: c }, cont);
          push('scenExtend', corrUp, Math.round(30 * f), { price: c, below: !corrUp, beyond: true }, tgt('ewTargetCb'));
          push('scenFail', !corrUp, Math.max(0, 100 - pDone - Math.round(50 * f) - Math.round(30 * f)), { price: B ? B.price : null, below: corrUp, before: c }, P0 ? P0.price : null);
        } else if (phase === 'corrDone') {
          push('scenNewImpulse', !corrUp, 55, { price: B ? B.price : null, below: corrUp }, P0 && C ? mv(C.price, lenL(P0.price, C.price), 0.618, corrUp ? -1 : 1) : null);
          push('scenCorrCont', corrUp, 30, { price: C ? C.price : null, below: !corrUp, beyond: true }, C && P0 && A ? mv(C.price, lenL(P0.price, A.price), 0.618, corrUp ? 1 : -1) : null);
          if (invalidation) push('scenFail', corrUp, 15, { price: invalidation.price, below: invalidation.below }, null);
        }
      }
    }
    // UNTERTEILUNG DER KORREKTUR -- 5-3-5 oder 3-3-5?
    //
    // Gemeldet: "Wir haben doch hier 5-3-5, ist das nicht typisch fuer A-B-C? Wieso sehe ich das
    // nicht." Vollkommen richtig: Der Zickzack ist 5-3-5 (A fuenfteilig, B dreiteilig, C
    // fuenfteilig), der Flat 3-3-5. Genau daran unterscheidet man die beiden -- die Engine hat
    // bisher nur ueber die LAENGENVERHAELTNISSE geraten (B-Ruecklauf <= 78,6 % = Zickzack).
    //
    // Jetzt wird jede Teilwelle auf feineren Wendepunkten nachgezaehlt: Wie viele Segmente liegen
    // zwischen ihrem Anfang und Ende? Fuenf oder mehr -> fuenfteilig (Antriebswelle), drei ->
    // dreiteilig (Korrekturwelle). Passt das Muster nicht zu der aus den Laengen abgeleiteten
    // Einordnung, gewinnt das MUSTER: es ist das staerkere Merkmal.
    let subdivision = null;
    if (best.type === 'corrective' && opts && opts.data) {
      const reihe = opts.data;
      const feinPct = Math.max(0.03, (pivotSet.pct || 0.2) * 0.34);
      const fein = zigzagUpTo(reihe, lastIdx, feinPct);
      const teile = (a, b) => {
        const innen = fein.pivots.filter(p => p.idx > a.idx && p.idx < b.idx);
        const n = innen.length + 1; // Segmente = innere Wendepunkte + 1
        return n >= 5 ? 5 : n >= 3 ? 3 : n;
      };
      const [q0, qa, qb, qc] = best.points;
      if (q0 && qa && qb && qc) {
        const nA = teile(q0, qa), nB = teile(qa, qb), nC = teile(qb, qc);
        // Weniger als drei Segmente heisst: die Teilwelle ist auf dieser Feinheit nicht
        // aufgeloest -- dann wird nichts behauptet, statt "1-1-1" anzuzeigen.
        if (nA >= 3 && nB >= 3 && nC >= 3) {
          subdivision = { a: nA, b: nB, c: nC, text: `${nA}-${nB}-${nC}` };
          if (nA === 5 && nC === 5 && nB === 3) subdivision.pattern = 'zigzag';
          else if (nA === 3 && nB === 3 && nC === 5) subdivision.pattern = 'flat';
        }
      }
    }
    // REGELPRUEFUNG (auf Wunsch: "ueberpruef doch"): Die Zaehlung weist sich selbst aus. Jede
    // harte Elliott-Regel wird fuer die ANGEZEIGTE Zaehlung nachgerechnet und mit den konkreten
    // Zahlen belegt -- so muss niemand glauben, dass die Engine sich an ihre Regeln haelt.
    const checks = [];
    {
      const P = l => points.find(p => p.label === l);
      const f = v => v == null ? '–' : (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4));
      const p0 = P('0'), p1 = P('1'), p2 = P('2'), p3 = P('3'), p4 = P('4'), p5 = P('5');
      const A = P('A'), B = P('B'), C = P('C');
      const auf = best.up;
      if (best.type === 'impulse') {
        if (p1 && p2) checks.push({ key: 'ruleW2', ok: auf ? p2.price > p0.price : p2.price < p0.price, detail: `W2 ${f(p2.price)} ${auf ? '>' : '<'} 0 ${f(p0.price)}` });
        if (p3) { const w1 = L(p0, p1), w3 = L(p2, p3), w5 = p5 ? L(p4, p5) : null;
          checks.push({ key: 'ruleW3', ok: !(w5 != null && w3 < w1 && w3 < w5), detail: `W1 ${(w1 * 100).toFixed(0)} · W3 ${(w3 * 100).toFixed(0)}${w5 != null ? ' · W5 ' + (w5 * 100).toFixed(0) : ''}` }); }
        if (p4 && p1) checks.push({ key: 'ruleW4', ok: auf ? p4.price > p1.price : p4.price < p1.price, detail: `W4 ${f(p4.price)} ${auf ? '>' : '<'} W1 ${f(p1.price)}` + (best.diagonal ? ' ◺' : '') });
        // Welle 5 ueber das Ende von Welle 3 -- Ausnahme Truncation (erlaubt, aber selten und
        // ein Warnzeichen). Deshalb kein Regelbruch, sondern als solche ausgewiesen.
        if (p5 && p3) checks.push({ key: best.truncated ? 'ruleW5trunc' : 'ruleW5', ok: !best.truncated, detail: `W5 ${f(p5.price)} ${auf ? (best.truncated ? '<' : '>') : (best.truncated ? '>' : '<')} W3 ${f(p3.price)}` });
        if (p2 && p1 && p0) { const r2 = L(p1, p2) / (L(p0, p1) || 1e-9); checks.push({ key: 'fibW2', ok: true, detail: `W2 / W1 = ${(r2 * 100).toFixed(0)} %` }); }
        if (p3 && p2) { const r3 = L(p2, p3) / (L(p0, p1) || 1e-9); checks.push({ key: 'fibW3', ok: true, detail: `W3 / W1 = ${r3.toFixed(2)}×` }); }
        if (p4 && p3) { const r4 = L(p3, p4) / (L(p2, p3) || 1e-9); checks.push({ key: 'fibW4', ok: true, detail: `W4 / W3 = ${(r4 * 100).toFixed(0)} %` }); }
        if (p5 && p4) { const r5 = L(p4, p5) / (L(p0, p1) || 1e-9); checks.push({ key: 'fibW5', ok: true, detail: `W5 / W1 = ${r5.toFixed(2)}×` }); }
      } else if (A && B && C) {
        checks.push({ key: 'ruleB', ok: best.up ? B.price > p0.price : B.price < p0.price, detail: `B ${f(B.price)} ${best.up ? '>' : '<'} 0 ${f(p0.price)}` });
        const rb = L(A, B) / (L(p0, A) || 1e-9), rc = L(B, C) / (L(p0, A) || 1e-9);
        checks.push({ key: 'fibB', ok: true, detail: `B / A = ${(rb * 100).toFixed(0)} %` });
        checks.push({ key: 'fibC', ok: true, detail: `C / A = ${rc.toFixed(2)}×` });
      }
    }
    return {
      kind, dir, phase, points, checks, targets: targets.filter(t => Number.isFinite(t.price) && t.price > 0),
      projection, invalidation, weiche, cMinimum, scenarios, subdivision,
      diagonal: !!best.diagonal, truncated: !!best.truncated,
      corrType: (subdivision && subdivision.pattern) || best.corrType || null,
      confidence: clamp(Math.round(best.score), 25, 92), rawScore: best.score, complete: best.complete, ratios: best.ratios || null,
      alt: alt ? { kind: alt.type, dir: alt.up ? 'up' : 'down', confidence: clamp(Math.round(alt.score), 25, 92), pointsCount: alt.points.length } : null
    };
  }

  // ---------------------------------------------------------------- Indikatoren -------------
  function evalIndicators(data, from, to, ma200Override, fine) {
    const closes = data.map(d => d.value);
    const N = data.length;
    const i = to;
    const c = closes[i];
    const out = [];
    const pct = (a, b) => (a / b - 1) * 100;
    // SMA 200
    let sma200 = null;
    // BUGFIX: den MA200-Wert ZUM Ende des Ausschnitts nehmen (letzter Punkt mit Datum <= Kerze i),
    // nicht immer den neuesten -- beim Blick in die Vergangenheit stand sonst der heutige Wert da.
    if (ma200Override && ma200Override.length) {
      const tI = data[i] && data[i].date;
      let pick = null;
      for (let j = ma200Override.length - 1; j >= 0; j--) { const q = ma200Override[j]; if (tI == null || q.date == null || q.date <= tI) { pick = q; break; } }
      sma200 = pick && Number.isFinite(pick.value) ? pick.value : null;
    }
    // BUGFIX: massgeblich ist die Kerze i (Ende des Ausschnitts), nicht die Laenge der Reihe --
    // beim Blick in die Vergangenheit (i < 199) lief die Summe sonst in negative Indizes (NaN).
    else if (i >= 199) { let s = 0; for (let j = i - 199; j <= i; j++) s += closes[j]; sma200 = s / 200; }
    if (sma200 != null) {
      const d = pct(c, sma200);
      out.push({ key: 'sma200', value: sma200, delta: d, verdict: d > 1 ? 'bull' : d < -1 ? 'bear' : 'neutral', textKey: d > 1 ? 'indSma200Above' : d < -1 ? 'indSma200Below' : 'indSma200At' });
    } else out.push({ key: 'sma200', value: null, verdict: 'neutral', textKey: 'indNotEnoughData' });
    // EMA 20
    const ema20 = emaArr(closes, 20);
    if (ema20[i] != null) {
      const d = pct(c, ema20[i]);
      const slope = ema20[i - 3] != null ? pct(ema20[i], ema20[i - 3]) : 0;
      out.push({ key: 'ema20', value: ema20[i], delta: d, verdict: d > 0.3 && slope >= 0 ? 'bull' : d < -0.3 && slope <= 0 ? 'bear' : 'neutral', textKey: d > 0.3 ? 'indEma20Above' : d < -0.3 ? 'indEma20Below' : 'indEma20At' });
    } else out.push({ key: 'ema20', value: null, verdict: 'neutral', textKey: 'indNotEnoughData' });
    // Bollinger 20/2
    const sma20 = smaArr(closes, 20);
    if (sma20[i] != null) {
      let v = 0; for (let j = i - 19; j <= i; j++) v += (closes[j] - sma20[i]) ** 2;
      const sd = Math.sqrt(v / 20);
      const upper = sma20[i] + 2 * sd, lower = sma20[i] - 2 * sd;
      const pos = (c - lower) / ((upper - lower) || 1e-9); // 0..1
      const widthPct = (upper - lower) / sma20[i] * 100;
      // Squeeze: Bandbreite im unteren Fuenftel der letzten 60 Kerzen
      let sqz = false;
      if (i >= 79) {
        const widths = [];
        for (let j = i - 59; j <= i; j++) { let vv = 0; for (let k = j - 19; k <= j; k++) vv += (closes[k] - sma20[j]) ** 2; widths.push(4 * Math.sqrt(vv / 20) / sma20[j]); }
        const sortedW = widths.slice().sort((a, b) => a - b);
        sqz = widths[widths.length - 1] <= sortedW[Math.floor(sortedW.length * 0.2)];
      }
      out.push({ key: 'bb', value: pos, upper, lower, widthPct, verdict: pos > 1 ? 'bear' : pos < 0 ? 'bull' : pos > 0.8 ? 'bull' : pos < 0.2 ? 'bear' : 'neutral', textKey: sqz ? 'indBbSqueeze' : pos > 1 ? 'indBbAboveUpper' : pos < 0 ? 'indBbBelowLower' : pos > 0.8 ? 'indBbUpper' : pos < 0.2 ? 'indBbLower' : 'indBbMiddle' });
    } else out.push({ key: 'bb', value: null, verdict: 'neutral', textKey: 'indNotEnoughData' });
    // VWAP (verankert am Start des sichtbaren Zeitraums)
    let pv = 0, vol = 0;
    for (let j = from; j <= i; j++) { const v = data[j].volume; if (v != null && Number.isFinite(v)) { pv += (hiOf(data[j]) + loOf(data[j]) + closes[j]) / 3 * v; vol += v; } }
    if (vol > 0) {
      const vwap = pv / vol; const d = pct(c, vwap);
      out.push({ key: 'vwap', value: vwap, delta: d, verdict: d > 0.5 ? 'bull' : d < -0.5 ? 'bear' : 'neutral', textKey: d > 0.5 ? 'indVwapAbove' : d < -0.5 ? 'indVwapBelow' : 'indVwapAt' });
    } else out.push({ key: 'vwap', value: null, verdict: 'neutral', textKey: 'indNoVolume' });
    // RSI 14 + Divergenz auf den letzten beiden Pivots
    const rsi = rsiArr(closes, 14);
    if (rsi[i] != null) {
      const r = rsi[i];
      let div = null;
      const Hs = fine.pivots.filter(p => p.type === 'H'), Ls = fine.pivots.filter(p => p.type === 'L');
      try { const dv = detectDivergenzen(data, Math.max(0, i - 150), i).find(d => d.art === 'regulaer' && d.aktiv !== false && i - d.b.idx <= 8); if (dv) div = dv.richtung; } catch (e) {}
      if (!div && Ls.length >= 2) { const a = Ls[Ls.length - 2], b = Ls[Ls.length - 1]; if (b.price < a.price && rsi[b.idx] != null && rsi[a.idx] != null && rsi[b.idx] > rsi[a.idx] + 2) div = 'bull'; }
      if (!div && Hs.length >= 2) { const a = Hs[Hs.length - 2], b = Hs[Hs.length - 1]; if (b.price > a.price && rsi[b.idx] != null && rsi[a.idx] != null && rsi[b.idx] < rsi[a.idx] - 2) div = 'bear'; }
      out.push({ key: 'rsi', value: r, divergence: div, verdict: div === 'bull' ? 'bull' : div === 'bear' ? 'bear' : r >= 70 ? 'bear' : r <= 30 ? 'bull' : r > 55 ? 'bull' : r < 45 ? 'bear' : 'neutral', textKey: div === 'bull' ? 'indRsiBullDiv' : div === 'bear' ? 'indRsiBearDiv' : r >= 70 ? 'indRsiOverbought' : r <= 30 ? 'indRsiOversold' : r > 55 ? 'indRsiBullish' : r < 45 ? 'indRsiBearish' : 'indRsiNeutral' });
    } else out.push({ key: 'rsi', value: null, verdict: 'neutral', textKey: 'indNotEnoughData' });
    // MACD 12/26/9
    if (N >= 35) {
      const e12 = emaArr(closes, 12), e26 = emaArr(closes, 26);
      const macd = closes.map((_, j) => e12[j] != null && e26[j] != null ? e12[j] - e26[j] : null);
      const firstValid = macd.findIndex(v => v != null);
      const sig = emaArr(macd.slice(firstValid), 9);
      const sigAt = j => sig[j - firstValid];
      const m = macd[i], s = sigAt(i);
      if (m != null && s != null) {
        const hist = m - s;
        let cross = null;
        for (let j = i; j > Math.max(firstValid + 9, i - 5); j--) { const h0 = macd[j] - sigAt(j), h1 = macd[j - 1] - sigAt(j - 1); if (h1 <= 0 && h0 > 0) { cross = 'bull'; break; } if (h1 >= 0 && h0 < 0) { cross = 'bear'; break; } }
        const histRising = macd[i - 1] != null && sigAt(i - 1) != null ? hist > macd[i - 1] - sigAt(i - 1) : false;
        out.push({ key: 'macd', value: m, signal: s, hist, cross, aboveZero: m > 0, verdict: cross === 'bull' ? 'bull' : cross === 'bear' ? 'bear' : hist > 0 ? 'bull' : hist < 0 ? 'bear' : 'neutral', textKey: cross === 'bull' ? 'indMacdBullCross' : cross === 'bear' ? 'indMacdBearCross' : hist > 0 ? (histRising ? 'indMacdBullStrong' : 'indMacdBullWeakening') : (histRising ? 'indMacdBearWeakening' : 'indMacdBearStrong') });
      } else out.push({ key: 'macd', value: null, verdict: 'neutral', textKey: 'indNotEnoughData' });
    } else out.push({ key: 'macd', value: null, verdict: 'neutral', textKey: 'indNotEnoughData' });
    // Stochastic 14/3/3
    const st = stochArr(data, 14, 3, 3);
    if (st.k[i] != null && st.d[i] != null) {
      const k = st.k[i], d = st.d[i];
      const kPrev = st.k[i - 1], dPrev = st.d[i - 1];
      const crossUp = kPrev != null && dPrev != null && kPrev <= dPrev && k > d;
      const crossDn = kPrev != null && dPrev != null && kPrev >= dPrev && k < d;
      out.push({ key: 'stoch', value: k, d, verdict: k <= 20 && crossUp ? 'bull' : k >= 80 && crossDn ? 'bear' : k >= 80 ? 'bear' : k <= 20 ? 'bull' : k > d ? 'bull' : 'bear', textKey: k <= 20 && crossUp ? 'indStochBullCross' : k >= 80 && crossDn ? 'indStochBearCross' : k >= 80 ? 'indStochOverbought' : k <= 20 ? 'indStochOversold' : k > d ? 'indStochBullish' : 'indStochBearish' });
    } else out.push({ key: 'stoch', value: null, verdict: 'neutral', textKey: 'indNotEnoughData' });
    // Volumen: letzte Kerze vs. Schnitt der 20 davor
    const vols = [];
    for (let j = Math.max(0, i - 20); j < i; j++) if (data[j].volume != null && Number.isFinite(data[j].volume)) vols.push(data[j].volume);
    const vNow = data[i].volume;
    if (vols.length >= 5 && vNow != null && Number.isFinite(vNow)) {
      const ratio = vNow / (avg(vols) || 1e-9);
      const upBar = data[i].value >= (data[i].open != null ? data[i].open : closes[Math.max(0, i - 1)]);
      // Trend im Volumen: letzte 5 vs. die 15 davor
      const rec = avg(vols.slice(-5)), older = avg(vols.slice(0, -5));
      out.push({ key: 'volume', value: vNow, ratio, upBar, verdict: ratio > 1.5 ? (upBar ? 'bull' : 'bear') : 'neutral', textKey: ratio > 1.8 ? (upBar ? 'indVolSpikeUp' : 'indVolSpikeDown') : ratio < 0.6 ? 'indVolLow' : older && rec / older > 1.3 ? 'indVolRising' : older && rec / older < 0.75 ? 'indVolFalling' : 'indVolNormal' });
    } else out.push({ key: 'volume', value: null, verdict: 'neutral', textKey: 'indNoVolume' });
    return out;
  }

  // ---------------------------------------------------------------- Gesamtbild --------------
  function scoreAll(trend, sr, elliott, fib, indicators, lastClose) {
    let bull = 0, bear = 0;
    const add = (b, w) => { if (b === 'bull') bull += w; else if (b === 'bear') bear += w; };
    add(trend.dir === 'up' ? 'bull' : trend.dir === 'down' ? 'bear' : null, 2 + Math.min(2, trend.strength / 3));
    if (elliott) {
      const upPhase = ['wave3', 'wave5'].includes(elliott.phase) && elliott.kind === 'impulse';
      const corrPhase = ['waveA', 'waveB', 'waveC', 'impulseDone'].includes(elliott.phase);
      // Gewicht auf 40 % gesenkt (Walk-forward: Richtung nicht besser als Zufall, 46 %) -- die
      // Muster-Ziele und Indikatoren tragen die Wertung, Elliott nur noch als leichte Tendenz.
      const w = (1 + elliott.confidence / 60) * 0.4;
      if (elliott.kind === 'impulse') {
        if (upPhase) add(elliott.dir === 'up' ? 'bull' : 'bear', w);
        else if (corrPhase || elliott.phase === 'wave4') add(elliott.dir === 'up' ? 'bear' : 'bull', w * 0.7);
        else if (elliott.phase === 'corrDone') add(elliott.dir === 'up' ? 'bull' : 'bear', w * 0.8);
      } else add(elliott.phase === 'corrDone' ? (elliott.dir === 'down' ? 'bull' : 'bear') : (elliott.dir === 'down' ? 'bear' : 'bull'), w * 0.6);
    }
    for (const ind of indicators) if (ind.value != null) add(ind.verdict, ind.key === 'sma200' ? 1.5 : ind.key === 'volume' ? 0.6 : 1);
    if (sr.inside.length) { /* mitten in einer Zone: neutral */ }
    else {
      const ns = sr.supports[0], nr = sr.resistances[0];
      if (ns && nr) {
        const room = (ln(nr.price) - ln(lastClose)) / ((ln(nr.price) - ln(ns.price)) || 1e-9); // 1 = am Support, 0 = am Widerstand
        if (room > 0.7) add('bull', 1); else if (room < 0.3) add('bear', 1);
      }
    }
    const total = bull + bear || 1;
    const bullPct = Math.round(bull / total * 100);
    const verdict = bullPct >= 62 ? 'bull' : bullPct <= 38 ? 'bear' : 'neutral';
    return { bull, bear, bullPct, verdict };
  }

  // ---------------------------------------------------------------- Einstieg ----------------
  // AUSREISSER-DOCHTE ENTSCHAERFEN (gemeldet: "Welle 3 muesste schon frueher aufhoeren", im
  // Vergleichs-Chart RUNE/ETH). Ein einzelner Docht weit unter (bzw. ueber) allem davor und
  // danach -- typisch fuer duenne Handelspaare wie RUNEETH auf Binance oder Flash-Crashs --
  // wurde zum Wellenende, obwohl der Markt dort nie wirklich gehandelt hat. Fuer die ANALYSE
  // (nicht fuer die gezeichneten Kerzen) wird ein solcher Docht auf das Niveau von Schlusskurs
  // bzw. Nachbarkerzen gekuerzt. Kriterium (auf der Log-Skala, robust ueber die typische
  // Kerzenspanne der 20 Kerzen davor, Median): Docht > 4 Spannen lang UND > 3 Spannen jenseits
  // beider Nachbarkerzen. Normale lange Dochte bleiben unangetastet.
  function rwDochtFilter(data) {
    const N = data.length;
    if (N < 25) return data;
    const lg = v => Math.log(v);
    const hi = i => (data[i].high != null ? data[i].high : data[i].value), lo = i => (data[i].low != null ? data[i].low : data[i].value);
    let out = null;
    for (let i = 21; i < N - 1; i++) {
      const d = data[i];
      if (!(d && d.value > 0 && lo(i) > 0 && hi(i) > 0)) continue;
      const spannen = [];
      for (let k = i - 20; k < i; k++) { const h = hi(k), l = lo(k); if (h > 0 && l > 0) spannen.push(lg(h) - lg(l)); }
      if (spannen.length < 10) continue;
      spannen.sort((a, b) => a - b);
      const sp = Math.max(1e-6, spannen[Math.floor(spannen.length / 2)]);
      const bodyLo = Math.min(d.value, data[i - 1].value), bodyHi = Math.max(d.value, data[i - 1].value);
      const nbLo = Math.min(lo(i - 1), lo(i + 1)), nbHi = Math.max(hi(i - 1), hi(i + 1));
      let neuLo = null, neuHi = null;
      if (lg(bodyLo) - lg(lo(i)) > 4 * sp && lg(nbLo) - lg(lo(i)) > 3 * sp) neuLo = Math.min(bodyLo, nbLo);
      if (lg(hi(i)) - lg(bodyHi) > 4 * sp && lg(hi(i)) - lg(nbHi) > 3 * sp) neuHi = Math.max(bodyHi, nbHi);
      // FEHLAUSBRUCH (gemeldet: "dort nicht als Welle beachten, koennte ein Fake-Out gewesen sein"
      // -- RUNE 27.08.2026: Hoch 0,631, Schluss 0,507, Nachbarn 0,506/0,524): Ein einzelner Docht,
      // der > 60 % der Kerze ausmacht, > 1,2 typische Spannen lang ist und von beiden Nachbarkerzen
      // nicht einmal bis zur Haelfte erreicht wird, zaehlt fuer die Analyse nicht als Wendepunkt.
      {
        const hI = hi(i), lI = lo(i), spanne = lg(hI) - lg(lI);
        const kHi = Math.max(d.open != null ? d.open : d.value, d.value), kLo = Math.min(d.open != null ? d.open : d.value, d.value);
        const dOben = lg(hI) - lg(kHi), dUnten = lg(kLo) - lg(lI);
        if (neuHi == null && spanne > 0 && dOben > 0.6 * spanne && dOben > 1.2 * sp && hi(i - 1) < Math.exp(lg(kHi) + dOben * 0.5) && hi(i + 1) < Math.exp(lg(kHi) + dOben * 0.5)) neuHi = Math.max(kHi, nbHi);
        if (neuLo == null && spanne > 0 && dUnten > 0.6 * spanne && dUnten > 1.2 * sp && lo(i - 1) > Math.exp(lg(kLo) - dUnten * 0.5) && lo(i + 1) > Math.exp(lg(kLo) - dUnten * 0.5)) neuLo = Math.min(kLo, nbLo);
      }
      if (neuLo == null && neuHi == null) continue;
      if (!out) out = data.slice();
      out[i] = { ...d, ...(neuLo != null ? { low: neuLo, dochtGekuerzt: true } : {}), ...(neuHi != null ? { high: neuHi, dochtGekuerzt: true } : {}) };
    }
    return out || data;
  }
  // DIVERGENZEN (gewuenscht: "Divergenz-Erkennung in die Engine einbauen, wie im Bild" -- Kurs
  // macht tiefere Tiefs entlang einer fallenden Linie, der RSI dagegen hoehere Tiefs).
  // Vier Arten, je zwischen zwei Wendepunkten (3 Kerzen links und rechts, der juengste darf noch
  // "in Bildung" sein -- sonst fiele genau die aktuell entstehende Divergenz wie im Bild weg):
  //   regulaer bullisch:   Kurs tieferes Tief,  RSI hoeheres Tief  -> Verkaufsdruck laesst nach
  //   regulaer baerisch:   Kurs hoeheres Hoch,  RSI tieferes Hoch  -> Kaufdruck laesst nach
  //   versteckt bullisch:  Kurs hoeheres Tief,  RSI tieferes Tief  -> Aufwaertstrend intakt
  //   versteckt baerisch:  Kurs tieferes Hoch,  RSI hoeheres Hoch  -> Abwaertstrend intakt
  // Gueltig nur, wenn dazwischen weder Kurs noch RSI deutlich jenseits der Verbindungslinie lagen
  // (sonst ist die Linie keine echte Verbindung zweier Extreme) und der RSI am ersten Punkt in
  // der passenden Zone stand (bullisch unter 55, baerisch ueber 45).
  function detectDivergenzen(data, from, to) {
    const n = data.length;
    if (n < 40 || to - from < 20) return [];
    const closes = data.map(d => d.value);
    const rsi = rsiArr(closes, 14);
    const K = 5, start = Math.max(15, from - 80);
    const lo = i => loOf(data[i]), hi = i => hiOf(data[i]);
    // RSI-Extrem nahe am Kurs-Extrem (der RSI dreht oft eine Kerze frueher oder spaeter)
    const rx = (typ, i) => { let v = null; for (let j = Math.max(0, i - 1); j <= Math.min(to, i + 1); j++) { const r = rsi[j]; if (r == null) continue; if (v == null || (typ === 'L' ? r < v : r > v)) v = r; } return v; };
    const pivots = typ => {
      const out = [];
      for (let i = start; i <= to; i++) {
        const v = typ === 'L' ? lo(i) : hi(i);
        if (!Number.isFinite(v) || rsi[i] == null) continue;
        let ok = true;
        for (let j = Math.max(start, i - K); j <= Math.min(to, i + K); j++) {
          if (j === i) continue;
          const w = typ === 'L' ? lo(j) : hi(j);
          if (typ === 'L' ? w < v : w > v) { ok = false; break; }
        }
        if (!ok) continue;
        if (out.length && i - out[out.length - 1].idx <= 1) continue; // Plateau
        out.push({ idx: i, price: v, pending: i + K > to });
      }
      return out;
    };
    const res = [];
    const pruefe = typ => {
      const P = pivots(typ);
      for (let k = P.length - 1; k >= 1; k--) {
        const b = P[k];
        if (to - b.idx > 80) break;
        let best = null;
        for (let m = k - 1; m >= 0; m--) {
          const a = P[m], dist = b.idx - a.idx;
          if (dist < 8) continue;
          if (dist > 90) break;
          const rA = rx(typ, a.idx), rB = rx(typ, b.idx);
          if (rA == null || rB == null) continue;
          const weiter = typ === 'L' ? b.price < a.price : b.price > a.price;
          const rsiBesser = typ === 'L' ? rB > rA + 1.5 : rB < rA - 1.5;
          const rsiSchlechter = typ === 'L' ? rB < rA - 1.5 : rB > rA + 1.5;
          let art = null;
          if (weiter && rsiBesser) art = 'regulaer';
          else if (!weiter && rsiSchlechter) art = 'versteckt';
          else continue;
          if (art === 'regulaer' && (typ === 'L' ? rA > 55 : rA < 45)) continue;
          // Versteckte nur bei deutlichem RSI-Unterschied -- sonst entstehen sie in jeder kleinen
          // Gegenbewegung und ueberdecken die wichtigen regulaeren.
          if (art === 'versteckt' && Math.abs(rB - rA) < 5) continue;
          let frei = true;
          for (let j = a.idx + 1; j < b.idx && frei; j++) {
            const f = (j - a.idx) / dist;
            const pl = a.price + (b.price - a.price) * f, rl = rA + (rB - rA) * f;
            const pj = typ === 'L' ? lo(j) : hi(j), rj = rsi[j];
            if (typ === 'L' ? (pj < pl * 0.995 || (rj != null && rj < rl - 1)) : (pj > pl * 1.005 || (rj != null && rj > rl + 1))) frei = false;
          }
          if (!frei) continue;
          const staerke = Math.abs(rB - rA);
          // ABGESCHLOSSEN (gemeldet: "abgeschlossene Divergenzen nicht zeigen"): Eine Divergenz gilt als
          // erledigt, sobald (1) danach ein neuer Wendepunkt derselben Art entstanden ist -- dann ist
          // sie nicht mehr die aktuelle -- oder (2) sie sich ausgespielt hat: bullisch, wenn der Kurs
          // seit b ueber das hoechste Hoch zwischen a und b gestiegen ist; baerisch, wenn er unter
          // das tiefste Tief dazwischen gefallen ist.
          const neuerPunkt = k < P.length - 1;
          let gegen = typ === 'L' ? -Infinity : Infinity;
          for (let j = a.idx; j <= b.idx; j++) { const v = typ === 'L' ? hi(j) : lo(j); if (Number.isFinite(v)) gegen = typ === 'L' ? Math.max(gegen, v) : Math.min(gegen, v); }
          let ausgespielt = false;
          for (let j = b.idx + 1; j <= to && !ausgespielt; j++) { const v = typ === 'L' ? hi(j) : lo(j); if (Number.isFinite(v) && (typ === 'L' ? v > gegen : v < gegen)) ausgespielt = true; }
          const kand = { richtung: typ === 'L' ? 'bull' : 'bear', art, a: { idx: a.idx, price: a.price, rsi: rA }, b: { idx: b.idx, price: b.price, rsi: rB, pending: b.pending }, staerke: +staerke.toFixed(1),
            aktiv: !neuerPunkt && !ausgespielt, ausgespielt };
          if (!best || (art === 'regulaer' && best.art !== 'regulaer') || (art === best.art && staerke > best.staerke)) best = kand;
        }
        if (best) res.push(best);
      }
    };
    pruefe('L'); pruefe('H');
    // Gleicher Startpunkt mehrfach (a -> b1, a -> b2 ...): nur die juengste behalten.
    const neu = [];
    res.sort((x, y) => y.b.idx - x.b.idx).forEach(d => { if (!neu.some(e => e.richtung === d.richtung && e.art === d.art && e.a.idx === d.a.idx)) neu.push(d); });
    // Regulaere zuerst (die wichtigeren), jeweils die juengsten vorn.
    return [...neu.filter(d => d.art === 'regulaer'), ...neu.filter(d => d.art !== 'regulaer')].slice(0, 6);
  }
  // ZIEL VON WELLE 3 ABGLEICHEN (zuerst gemeldet: "Wo ist die Prognose?" -- RUNE/ETH Woche, Welle 3 laeuft,
  // der Kurs stand schon kurz vor dem Ziel). Einige Sonderfaelle der Zaehlung projizieren nur das
  // Ende von Welle 3. Liegt der Kurs schon nah daran, ist die gestrichelte Linie dann nur ein paar
  // Pixel lang und verschwindet hinter den Kerzen -- es sieht aus, als gaebe es keine Prognose.
  // Ergaenzt werden deshalb die naechsten Schritte nach den ueblichen Richtwerten (Frost/Prechter):
  //   Welle 4 = 38,2 % Ruecklauf von Welle 3
  //   Welle 5 = so lang wie Welle 1 (Gleichheit, haeufigster Fall bei verlaengerter Welle 3)
  // Nur wenn die Zaehlung 0, 1 und 2 kennt und die Projektion genau aus "3" besteht.
  // NEUER TREND NACH DER GROSSEN KORREKTUR (gemeldet bei RUNE/AVAX: "die Zaehlung ist falsch" --
  // \"es ist eine A-B-C-Korrektur seit Anfang an ... C ist fertig, jetzt neuer Aufwaertstrend\").
  // Die Engine zaehlte nach dem Tief eine kleine A-B-C NACH OBEN, deren B noch tiefer fiel als ihr
  // Start (\"erweiterte flache Korrektur\"), und erwartete danach wieder einen Fall. Liegt dieses B
  // aber am tiefsten Punkt nach einem grossen Rueckgang, ist es plausibler das ENDE der grossen
  // Welle C -- und der Anstieg danach der Beginn eines neuen Trends (Welle 1).
  // Bedingungen (alle):
  //   - Zaehlung ist eine Korrektur 0-A-B(-C) gegen die vorige grosse Richtung,
  //   - B ist ueber den Start 0 hinausgelaufen (neues Extrem),
  //   - B ist das Extrem des ganzen sichtbaren Bereichs,
  //   - davor gab es eine grosse Bewegung in B-Richtung (Rueckgang um mindestens zwei Drittel bzw.
  //     Verdopplung bei einer Korrektur nach unten),
  //   - seit B hat sich der Kurs deutlich entfernt (mindestens 61,8 % von A).
  // Dann: 0 = B, laufende Welle 1 bis zum Extrem seit B, keine Projektion fuer Welle 1
  // (Welle 1 hat keine Bezugswelle), ungueltig jenseits von B.
  function neuerTrendNachKorrektur(E, data, from, to, lastClose, useLog, fibs) {
    try {
      if (!E || E.kind !== 'corrective' || !Array.isArray(E.points)) return;
      const lab = l => E.points.find(q => String(q.label) === l);
      const P0 = lab('0'), PA = lab('A'), PB = lab('B');
      if (!P0 || !PA || !PB || PB.pending || !(P0.price > 0 && PA.price > 0 && PB.price > 0)) return;
      const auf = PA.price > P0.price;                      // Korrektur aufwaerts = neuer Trend aufwaerts
      // Fall 1: B lief ueber den Start hinaus -> B ist das Ende der grossen Welle C.
      // Fall 2 (gemeldet: "keine Aenderung" bei RUNE/AVAX -- B endete knapp UEBER dem Start, ein
      // Doppelboden): Dann ist 0 das Ende der grossen Korrektur, und A-B-C heisst 1-2-3.
      const bJenseits = auf ? PB.price < P0.price : PB.price > P0.price;
      const tief = bJenseits ? PB : P0;
      const Lg = v => useLog ? Math.log(v) : v;
      let ext = null, vorher = null;
      for (let i = Math.max(0, from); i <= to; i++) {
        const d = data[i]; if (!d) continue;
        const v = auf ? (d.low != null ? d.low : d.value) : (d.high != null ? d.high : d.value);
        const w = auf ? (d.high != null ? d.high : d.value) : (d.low != null ? d.low : d.value);
        if (Number.isFinite(v) && (ext == null || (auf ? v < ext : v > ext))) ext = v;
        if (i < P0.idx && Number.isFinite(w) && (vorher == null || (auf ? w > vorher : w < vorher))) vorher = w;
      }
      if (ext == null || Math.abs(Lg(ext) - Lg(tief.price)) > (useLog ? 0.03 : tief.price * 0.03)) return;   // Extrem des Bereichs (3 % Spielraum)
      if (!(vorher > 0) || (auf ? vorher / tief.price < 3 : tief.price / vorher < 2)) return;             // grosser Rueckgang davor (mind. -67 % bzw. Verdopplung)
      if (!bJenseits) {
        abcAlsImpulsUmbenennen(E, fibs, P0, auf); E.neuerTrendNachKorrektur = true;
        if (Array.isArray(E.grossMarken) && E.grossMarken.length) {
          const gm = E.grossMarken.map(q => ({ ...q, pending: false }));
          const kC = gm.findIndex(q => /\(C\)/.test(String(q.text || '')));
          const cNeu = { idx: P0.idx, price: P0.price, type: auf ? 'L' : 'H', text: '(C)', pending: false };
          if (kC >= 0) gm[kC] = cNeu; else if (gm.length === 2) gm.push(cNeu);
          E.grossMarken = gm;
        }
        return;
      }
      // Extrem seit B (laufende Welle 1)
      let w1 = null;
      for (let i = PB.idx + 1; i <= to; i++) {
        const d = data[i]; if (!d) continue;
        const v = auf ? (d.high != null ? d.high : d.value) : (d.low != null ? d.low : d.value);
        if (Number.isFinite(v) && (!w1 || (auf ? v > w1.price : v < w1.price))) w1 = { idx: i, price: v };
      }
      const lenA = Math.abs(Lg(PA.price) - Lg(P0.price));
      if (!w1 || Math.abs(Lg(w1.price) - Lg(PB.price)) < 0.618 * lenA) return;
      E.points = [
        { idx: PB.idx, price: PB.price, type: auf ? 'L' : 'H', label: '0', pending: false },
        { idx: w1.idx, price: w1.price, type: auf ? 'H' : 'L', label: '1', pending: true },
      ];
      E.kind = 'impulse';
      E.dir = auf ? 'up' : 'down';
      E.phase = 'wave1';
      E.projection = [];
      E.invalidation = { price: PB.price, below: auf, ruleKey: 'proInvNewImpulse' };
      E.weiche = null;
      E.scenarios = [];
      E.neuerTrendNachKorrektur = true;
      if (E.sub) E.sub = { ...E.sub, anchorLabel: '0' };
      // Grosse Marke (C) an das neue Extrem setzen, falls die grosse Korrektur markiert ist.
      if (Array.isArray(E.grossMarken) && E.grossMarken.length) {
        const gm = E.grossMarken.map(q => ({ ...q }));
        const kC = gm.findIndex(q => /\(C\)/.test(String(q.text || '')));
        const cNeu = { idx: PB.idx, price: PB.price, type: auf ? 'L' : 'H', text: '(C)', pending: false };
        if (kC >= 0) gm[kC] = cNeu; else if (gm.length === 2) gm.push(cNeu);
        E.grossMarken = gm;
      }
    } catch (e) {}
  }
  // A-B-C (gegen den alten Trend) als 1-2-3 des neuen Trends beschriften. Gemeinsamer Teil fuer
  // die Faelle "nach grosser (C)" und "nach grossem Rueckgang".
  function abcAlsImpulsUmbenennen(E, fibs, p0, auf) {
      const map = { A: '1', B: '2', C: '3' };
      const um = q => (map[String(q.label)] ? { ...q, label: map[String(q.label)] } : q);
      E.points = E.points.map(um);
      // Nur Ziele der umbenannten Wellen behalten: Die alte Zaehlung erwartete nach C einen neuen
      // Fall ("1" bei 0,066 im Bild) -- im neuen Trend ergibt "3 -> 1" keinen Sinn.
      E.projection = (E.projection || []).filter(q => map[String(q.label)]).map(um);
      if (E.zwischenziel && map[String(E.zwischenziel.wave)]) E.zwischenziel = { ...E.zwischenziel, wave: map[String(E.zwischenziel.wave)] };
      const ph = { waveA: 'wave1', waveB: 'wave2', waveC: 'wave3', corrDone: 'wave4' };
      E.phase = ph[E.phase] || E.phase;
      E.kind = 'impulse';
      E.dir = auf ? 'up' : 'down';
      E.corrType = null;
      E.invalidation = { price: p0.price, below: auf, ruleKey: E.phase === 'wave1' ? 'proInvNewImpulse' : 'proInvRule1' };
      E.weiche = null;
      E.scenarios = [];
      E.umbenanntNachGrossC = true;
      // Fibonacci-Stufen der Korrektur (\"c = 1,618 x a\") werden zu Stufen der Welle 3 (\"wave 3 x 1,618\")
      if (fibs) for (const k of ['elliott', 'elliottWeiter']) {
        const F = fibs[k];
        if (F && String(F.label) === 'C') { fibs[k] = null; continue; }
        const fl = F ? map[String(F.label)] : null;
        if (F && Array.isArray(F.levels)) fibs[k] = { ...F, label: fl || F.label,
          levels: F.levels.filter(l => !l.cExt).map(l => (fl ? { ...l, wave: fl } : map[String(l.wave)] ? { ...l, wave: map[String(l.wave)] } : l)) };
      }
  }
  // NACH EINER FERTIGEN GROSSEN (C) ZAEHLT DIE NEUE BEWEGUNG 1-2-3, NICHT A-B-C (gemeldet bei
  // RUNE/BTC: (A)(B)(C) fertig, darunter \"II\" -- der Anstieg danach hiess trotzdem A-B-C und die
  // Bewertung war baerisch). Ist die grosse Korrektur abgeschlossen, beginnt ein neuer Trend; seine
  // ersten Wellen heissen 1, 2, 3. Die Kursmarken bleiben gleich, nur die Namen (Punkte, Projektion,
  // Fibonacci-Stufen) und damit Phase, Richtung und Bewertung werden richtig.
  function abcNachGrossCAlsImpuls(E, fibs) {
    try {
      if (!E || !Array.isArray(E.points) || !Array.isArray(E.grossMarken)) return false;
      // (C) darf als "laufend" markiert sein (gemeldet: "ich sehe keine Aenderungen" -- die Engine
      // markiert (C) als laufend, solange ihre eigene Phase nicht "impulseDone" ist, also gerade
      // dann, wenn danach schon A-B gezaehlt wird). Massgeblich ist, dass das Ende von 5 fest steht
      // und die Bewegung danach schon begonnen hat.
      const gC = E.grossMarken.find(q => /\(C\)/.test(String(q.text || '')));
      if (!gC) return false;
      // Fall 2: Zaehlung ...3-4-5 (= Inneres der grossen (C)) und danach A-B(-C) -- wie im Bild von
      // RUNE/BTC. Die Wellen nach 5 werden zur eigenen Zaehlung ab 0 = Ende von 5 = Ende von (C).
      if (E.kind === 'impulse') {
        const k5 = E.points.findIndex(q => String(q.label) === '5' && !q.pending);
        if (k5 < 0) return false;
        const p5 = E.points[k5];
        if (Math.abs(p5.idx - gC.idx) > 3 && Math.abs(Math.log(p5.price / gC.price)) > 0.02) return false;
        const nach = E.points.slice(k5 + 1);
        if (!nach.length || !nach.every(q => /^[ABC]$/.test(String(q.label)))) return false;
        var grossStart = E.points.find(q => String(q.label) === '0') || null;
        E.points = [{ ...p5, label: '0', pending: false }, ...nach];
        E.kind = 'corrective';
      }
      if (E.kind !== 'corrective') return false;
      const p0 = E.points.find(q => String(q.label) === '0'), pA = E.points.find(q => String(q.label) === 'A');
      if (!gC || !p0 || !pA || !(gC.price > 0) || !(p0.price > 0)) return false;
      if (Math.abs(p0.idx - gC.idx) > 3 && Math.abs(Math.log(p0.price / gC.price)) > 0.02) return false;   // startet am Ende von (C)
      const auf = pA.price > p0.price;
      if ((gC.type === 'L') !== auf) return false;                                                       // Richtung gegen die grosse Korrektur
      abcAlsImpulsUmbenennen(E, fibs, p0, auf);
      // EINE LESART STATT GEMISCHT (gemeldet: "Warum abc und die Wellenzaehlung gemischt? Fuer abc
      // entscheiden"): Die grosse Korrektur steht jetzt als A-B-C in der Hauptzaehlung --
      // 0 (Start) - A - B - C -- und der neue Trend schliesst als 1-2-3 an. Die Zahlen 1-5 innerhalb
      // der Korrektur und die getrennten (A)(B)(C)-Marken entfallen.
      const gA = E.grossMarken.find(q => /\(A\)/.test(String(q.text || '')));
      const gB = E.grossMarken.find(q => /\(B\)/.test(String(q.text || '')));
      const st = (typeof grossStart !== 'undefined' && grossStart) || (E.grossTop && E.grossTop.idx != null ? { idx: E.grossTop.idx, price: E.grossTop.price, type: auf ? 'H' : 'L' } : null);
      if (gA && gB && st && st.idx < gA.idx && gA.idx < gB.idx && gB.idx < p0.idx) {
        const tA = auf ? 'L' : 'H', tB = auf ? 'H' : 'L';
        const neu0 = E.points[0];
        E.points = [
          // Start ohne Beschriftung: "0" bezeichnet in der Engine den Start der LAUFENDEN Zaehlung
          // (hier der neue Trend ab C) -- zwei "0" wuerden Berechnungen wie Welle-1-Laengen verfaelschen.
          { idx: st.idx, price: st.price, type: tB, label: '', pending: false },
          { idx: gA.idx, price: gA.price, type: tA, label: 'A', pending: false },
          { idx: gB.idx, price: gB.price, type: tB, label: 'B', pending: false },
          { ...neu0, label: 'C', pending: false },
          ...E.points.slice(1),
        ];
        E.grossMarken = [];
        E.abcEinheitlich = true;
      } else {
        E.grossMarken = E.grossMarken.map(q => ({ ...q, pending: false }));
      }
      return true;
    } catch (e) { return false; }
  }
  // GROSSE A-B-C AUS DEN KERZEN (gemeldet bei RUNE/ETH: \"nicht gut\" -- mit den echten Daten
  // nachgestellt: Die Engine zaehlte 2021-2026 als Impuls 0-5 und uebersah dabei den grossen
  // Anstieg 2024 mitten in Welle 3; der Rahmen aus dem Wochenchart lieferte deshalb nach dem Tief
  // 2026 ein A-B-C nach oben). Laeuft die aktuelle Bewegung seit einem tiefen Extrem C (Start einer
  // Gegenbewegung bzw. Ende einer Welle 5), wird der Weg davor direkt aus den Kerzen als grosse
  // Korrektur gelesen:
  //   Start = aeusserstes Extrem im Ausschnitt vor C (z. B. Hoch 2021),
  //   B     = groesste Gegenbewegung dazwischen (38,2-100 % Ruecklauf von Start->A),
  //   A     = Extrem zwischen Start und B,
  //   C     muss jenseits von A liegen, und der ganze Rueckgang muss gross sein (Faktor 3).
  // Passt das, heisst die Hauptzaehlung: Start - A - B - C und danach 1-2-3 des neuen Trends.
  // PROJEKTION/ZUVERLAESSIGKEIT NACH EINER UMDEUTUNG NEU BEWERTEN (gemeldet: "Wo ist die Prognose
  // hin?" -- das Panel zeigte "Projection hidden ... target reached 31 %" -- das sind die Werte der
  // Phase B: Ausgeblendet wurde VOR der Umdeutung, als die Engine noch "Welle B" zaehlte; nach der
  // Umbenennung in "Welle 2" blieb die Prognose versteckt).
  function projektionHolen(E) {
    if (E && (!Array.isArray(E.projection) || !E.projection.length) && Array.isArray(E.projectionVersteckt) && E.projectionVersteckt.length) {
      E.projection = E.projectionVersteckt; E.projectionVersteckt = null;
    }
  }
  function phaseNeuBewerten(E) {
    if (!E) return;
    E.zuverl = RW_EW_ZUVERL[E.phase] || null;
    if (RW_EW_OHNE_PROJEKTION.includes(E.phase) && Array.isArray(E.projection) && E.projection.length) { E.projectionVersteckt = E.projection; E.projection = []; }
    else if (!RW_EW_OHNE_PROJEKTION.includes(E.phase)) E.projectionVersteckt = null;
  }
  function grosseKorrekturAusDaten(E, data, from, to, useLog, fibs) {
    try {
      if (!E || !Array.isArray(E.points) || !E.points.length || !data || !data.length) return false;
      const Lg = v => useLog ? Math.log(v) : v;
      const L_ = i => { const d = data[i]; return d ? (d.low != null ? d.low : d.value) : NaN; };
      const H_ = i => { const d = data[i]; return d ? (d.high != null ? d.high : d.value) : NaN; };
      // Ganze Historie (nicht nur der Ausschnitt): Die grosse Korrektur beginnt oft weit links.
      let iMin = -1, iMax = -1;
      for (let i = 0; i <= to; i++) { const l = L_(i), h = H_(i); if (Number.isFinite(l) && (iMin < 0 || l < L_(iMin))) iMin = i; if (Number.isFinite(h) && (iMax < 0 || h > H_(iMax))) iMax = i; }
      if (iMin < 0 || iMax < 0) return false;
      // C = fester Punkt der Zaehlung am Extrem der Historie (3 % Spielraum), NACH dem Gegen-Extrem.
      const nahe = (a, b) => Math.abs(Math.log(a / b)) <= 0.03;
      let auf = null, kC = -1;
      E.points.forEach((q, k) => {
        if (q.pending || !(q.price > 0)) return;
        if (iMin > iMax && nahe(q.price, L_(iMin)) && Math.abs(q.idx - iMin) <= 3) { auf = true; kC = k; }
        else if (iMax > iMin && nahe(q.price, H_(iMax)) && Math.abs(q.idx - iMax) <= 3) { auf = false; kC = k; }
      });
      if (kC < 0) return false;
      const Cp = E.points[kC];
      const mitT = auf ? L_ : H_, gegen = auf ? H_ : L_;
      const tiefer = (x, y) => auf ? x < y : x > y;
      const c = Cp.idx;
      let s0 = -1;
      for (let i = 0; i < c; i++) { const v = gegen(i); if (Number.isFinite(v) && (s0 < 0 || (auf ? v > gegen(s0) : v < gegen(s0)))) s0 = i; }
      if (s0 < 0 || c - s0 < 20) return false;
      const S = gegen(s0), Cpr = Cp.price;
      if (!(S > 0) || (auf ? S / Cpr < 3 : Cpr / S < 3)) return false;      // grosse Korrektur (Faktor 3)
      let best = null;
      for (let b = s0 + 4; b < c - 4; b++) {
        const v = gegen(b); if (!Number.isFinite(v)) continue;
        let lokal = true; for (let j = b - 3; j <= b + 3; j++) if (j !== b && (auf ? gegen(j) > v : gegen(j) < v)) { lokal = false; break; }
        if (!lokal) continue;
        let ai = -1; for (let j = s0 + 1; j < b; j++) { const w = mitT(j); if (Number.isFinite(w) && (ai < 0 || tiefer(w, mitT(ai)))) ai = j; }
        if (ai < 0) continue;
        const A = mitT(ai), lenA = Math.abs(Lg(S) - Lg(A)), lenB = Math.abs(Lg(v) - Lg(A));
        if (!(lenA > 0)) continue;
        const r = lenB / lenA;
        if (r < 0.382 || r >= 1 || !tiefer(Cpr, A)) continue;
        let sauber = true; for (let j = b + 1; j < c; j++) if (auf ? gegen(j) > v : gegen(j) < v) { sauber = false; break; }
        if (!sauber) continue;
        if (!best || lenB > best.lenB) best = { ai, A, bi: b, B: v, lenB };
      }
      if (!best) return false;
      // Alles nach C ist der neue Trend: der Reihe nach 1, 2, 3 ... (egal wie es vorher hiess).
      // Zuordnung alt -> neu merken, damit die Projektion dieselben Namen bekommt.
      const altNeu = {};
      // NACH DER 5 KOMMT A-B-C (gemeldet: "Warum gibt es Welle 6 und 7?" -- es wurde stur weitergezaehlt).
      // Reihenfolge eines Zyklus: 1-2-3-4-5, dann die Korrektur A-B-C, danach wieder von vorn.
      const SEQ = ['1', '2', '3', '4', '5', 'A', 'B', 'C'];
      const lab8 = k => SEQ[((k % 8) + 8) % 8];
      let nach = E.points.slice(kC + 1).map((q, k) => { altNeu[String(q.label)] = lab8(k); return { ...q, label: lab8(k) }; });
      if (!nach.length) {
        let ex = null;
        for (let i = c + 1; i <= to; i++) { const v = gegen(i); if (Number.isFinite(v) && (!ex || (auf ? v > ex.price : v < ex.price))) ex = { idx: i, price: v }; }
        if (ex && Math.abs(Math.log(ex.price / Cpr)) >= Math.log(1.2)) nach = [{ idx: ex.idx, price: ex.price, type: auf ? 'H' : 'L', label: '1', pending: true }];
      }
      const letzter = nach[nach.length - 1];
      const laufendNr = !nach.length ? 1 : letzter.pending ? nach.length : nach.length + 1;
      const alteProj = (E.projection || []).filter(q => q && q.price > 0);
      // Projektion behalten, solange sie den neuen Trend nicht bricht (gemeldet: "Welle 2 wird immer noch
      // nicht angezeigt" -- vorher musste das erste Ziel in Trendrichtung liegen; das Ziel einer
      // Welle 2 liegt aber naturgemaess DARUNTER und fiel deshalb weg). Verworfen wird sie nur, wenn
      // ein Ziel jenseits von C laege -- das waere keine Welle des neuen Trends mehr.
      const passt = alteProj.length > 0 && alteProj.every(q => (auf ? q.price > Cpr : q.price < Cpr));
      // Fuer Welle 1 keine Projektion (keine Bezugswelle -- so auch sonst in der Engine).
      // PROJEKTION RICHTIG NUMMERIEREN (gemeldet: "Warum Welle 2 und nicht Welle 3???" -- das Ziel von
      // Welle 3 hiess "2"): Ein Projektionspunkt, der zu einem schon vorhandenen Punkt gehoert (Ziel
      // der laufenden Welle), bekommt dessen neuen Namen; alle weiteren zaehlen ab dem hoechsten
      // vergebenen Namen weiter. Vorher wurde stur ab der laufenden Nummer gezaehlt -- lief Welle 2
      // noch und die Projektion zeigte schon auf 3, wurde aus der 3 eine 2.
      // Waren die alten Namen schon Zahlen, bleibt der Abstand erhalten (alte "3" nach alter "1" ist
      // auch neu die "3", selbst wenn die "2" als Punkt noch fehlt).
      const altLetzt = E.points[E.points.length - 1];
      const versatz = (altLetzt && /^\d$/.test(String(altLetzt.label)) && nach.length) ? Number(altLetzt.label) - nach.length : null;
      let naechsteNr = nach.length + 1;
      const neuProj = alteProj.map(q => {
        const n0 = altNeu[String(q.label)];
        if (n0) return { ...q, label: n0 };
        if (versatz != null && /^\d$/.test(String(q.label))) { const nr = Number(q.label) - versatz; naechsteNr = Math.max(naechsteNr, nr + 1); return { ...q, label: lab8(nr - 1) }; }
        const nr = lab8(naechsteNr - 1); naechsteNr++;
        return { ...q, label: nr };
      });
      E.projection = passt && laufendNr > 1 ? neuProj.filter(q => SEQ.includes(String(q.label))) : [];
      // Laeuft eine Korrekturwelle (2 oder 4) ohne eigenen Punkt und ohne eigenes Ziel, wenigstens ihr
      // bisheriges Extrem als laufenden Punkt zeigen -- sonst ist die Welle im Chart gar nicht zu sehen.
      if (nach.length && !nach[nach.length - 1].pending && laufendNr % 2 === 0 && !E.projection.some(q => String(q.label) === lab8(laufendNr - 1))) {
        const v1 = nach[nach.length - 1];
        let ex = null;
        for (let i = v1.idx + 1; i <= to; i++) { const v = mitT(i); if (Number.isFinite(v) && (!ex || (auf ? v < ex.price : v > ex.price))) ex = { idx: i, price: v }; }
        if (ex && (auf ? ex.price < v1.price : ex.price > v1.price)) nach.push({ idx: ex.idx, price: ex.price, type: auf ? 'L' : 'H', label: lab8(laufendNr - 1), pending: true });
      }
      const tA = auf ? 'L' : 'H', tB = auf ? 'H' : 'L';
      E.points = [
        { idx: s0, price: S, type: tB, label: '', pending: false },
        { idx: best.ai, price: best.A, type: tA, label: 'A', pending: false },
        { idx: best.bi, price: best.B, type: tB, label: 'B', pending: false },
        { ...Cp, type: tA, label: 'C', pending: false },
        ...nach,
      ];
      // Phase passend zur Reihenfolge: nach der 5 laeuft die Korrektur (waveA/B/C, kind corrective)
      { const lb = lab8(laufendNr - 1); const korr = /^[ABC]$/.test(lb); E.phase = 'wave' + lb; E.kind = korr ? 'corrective' : 'impulse'; }
      E.dir = auf ? 'up' : 'down';
      E.corrType = null;
      E.invalidation = { price: Cpr, below: auf, ruleKey: laufendNr <= 1 ? 'proInvNewImpulse' : 'proInvRule1' };
      E.weiche = null;
      E.scenarios = [];
      E.grossMarken = [];
      E.zwischenziel = E.projection.length ? { ...(E.zwischenziel || {}), wave: E.projection[0].label, price: E.projection[0].price } : null;
      E.umbenanntNachGrossC = true;
      E.abcAusDaten = true;
      // Feinzaehlung der laufenden Welle: In treibenden Wellen (1, 3, 5) heissen die Teile i-ii-iii,
      // nicht a-b-c (die Feinzaehlung entstand noch unter der alten, korrigierenden Lesart).
      if (E.sub && Array.isArray(E.sub.points) && laufendNr % 2 === 1) {
        const m = { a: 'i', b: 'ii', c: 'iii', d: 'iv', e: 'v' };
        E.sub = { ...E.sub, kind: 'impulse', points: E.sub.points.map(q => (m[String(q.label)] ? { ...q, label: m[String(q.label)] } : q)) };
      }
      if (fibs) {
        // Fib-Stufen der alten Lesart passen nicht mehr zur neuen Zaehlung -- nur behalten, was zur
        // laufenden Welle gehoert (gleiche Nummer), sonst weglassen.
        for (const k of ['elliott', 'elliottWeiter']) {
          const F = fibs[k];
          if (F && Array.isArray(F.levels)) {
            const map = { A: '1', B: '2', C: '3' };
            // Die Stufen heissen nach der Welle, die GERADE ENTSTEHT (F.label) -- in der Korrektur
            // tragen Ruecklauf-Stufen aber den Namen der zurueckgelaufenen Welle ("A x 0,618" fuer B).
            // Vorher wurde daraus "wave 1 x 0,618" statt "wave 2", und die Ziel-Auswahl fand keine
            // passenden Stufen mehr (gemeldet: "Welle 2 laesst sich nicht mehr aendern").
            // Stufen fuer die alte Welle C ("c = r x a") ganz verwerfen: Aus C wird Welle 3, und die wird
            // mit eigenen Verhaeltnissen gemessen (siehe ergaenzeProjektion).
            if (String(F.label) === 'C') { fibs[k] = null; continue; }
            const fl = map[String(F.label)];
            // C-Verlaengerungen ("c = 1 x a") NICHT als Welle-3-Stufen uebernehmen (gemeldet: "das ist doch
            // nicht 1,618 fuer Welle 3" -- als Ziel stand c = 1 x a): Eine Welle 3 wird mit eigenen
            // Verhaeltnissen gemessen (1 / 1,618 / 2 / 2,618, Schwerpunkt 1,618) -- die erzeugt
            // ergaenzeProjektion, sobald keine Stufen fuer Welle 3 da sind.
            fibs[k] = { ...F, label: fl || F.label, levels: F.levels.filter(l => !l.cExt).map(l => (fl ? { ...l, wave: fl } : map[String(l.wave)] ? { ...l, wave: map[String(l.wave)] } : l)) };
          }
        }
      }
      return true;
    } catch (e) { return false; }
  }
  // RAHMEN IN DIE HAUPTZAEHLUNG (gleiches Bild wie bei RUNE/ETH): Beginnt der neue Impuls genau an
  // der grossen (C), stehen Start - A - B - C und danach 1-2-3 in EINER Zaehlung statt getrennter
  // (A)(B)(C)-Marken neben einer eigenen 0-1-2-3.
  function rahmenInZaehlung(E, data, from) {
    try {
      if (!E || E.kind !== 'impulse' || !Array.isArray(E.points) || !Array.isArray(E.grossMarken)) return false;
      const g = t => E.grossMarken.find(q => new RegExp('\\(' + t + '\\)').test(String(q.text || '')));
      const gA = g('A'), gB = g('B'), gC = g('C');
      const p0 = E.points[0];
      if (!gA || !gB || !gC || !p0 || String(p0.label) !== '0' || Math.abs(p0.idx - gC.idx) > 3) return false;
      const auf = E.dir === 'up';
      const gegen = i => { const d = data[i]; return d ? (auf ? (d.high != null ? d.high : d.value) : (d.low != null ? d.low : d.value)) : NaN; };
      let s0 = -1;
      for (let i = Math.max(0, from); i < gA.idx; i++) { const v = gegen(i); if (Number.isFinite(v) && (s0 < 0 || (auf ? v > gegen(s0) : v < gegen(s0)))) s0 = i; }
      if (s0 < 0) return false;
      const tA = auf ? 'L' : 'H', tB = auf ? 'H' : 'L';
      E.points = [
        { idx: s0, price: gegen(s0), type: tB, label: '', pending: false },
        { idx: gA.idx, price: gA.price, type: tA, label: 'A', pending: false },
        { idx: gB.idx, price: gB.price, type: tB, label: 'B', pending: false },
        { ...p0, label: 'C', pending: false },
        ...E.points.slice(1),
      ];
      E.grossMarken = [];
      E.abcEinheitlich = true;
      return true;
    } catch (e) { return false; }
  }
  function ergaenzeProjektion(E, useLog, fibs) {
    try {
      if (!E || !Array.isArray(E.projection) || !E.projection.length) return;
      // WELLE-3-ZIEL OHNE EIGENE FIB-STUFEN (gemeldet: "Warum ist die Welle 3 so kurz?" -- nach der
      // Umdeutung A-B-C -> 1-2-3 stammte das Ziel noch aus der alten Lesart "C = 1 x A", also nur
      // so lang wie Welle 1). Fehlen Stufen fuer Welle 3, werden sie hier nach den ueblichen
      // Verhaeltnissen ab dem Ende von Welle 2 erzeugt (1 / 1,618 / 2 / 2,618 x Welle 1, Gewichte wie
      // sonst in der Engine) und das Ziel auf 1,618 gesetzt.
      // ZIEL DER LAUFENDEN KORREKTURWELLE ERGAENZEN (gemeldet: "Ich kann nicht mehr anpassen, zu
      // welcher Fib die Welle 2 gehen koennte"): Laeuft Welle 2 als offener Punkt und die Projektion
      // zeigt schon auf 3, fehlte ihr eigenes Ziel -- ohne Ziel gab es keine Auswahl. Jetzt steht
      // das Ziel auf der wahrscheinlichsten offenen Fib-Stufe dieser Welle, wie sonst auch.
      {
        const P = E.points || [], letzt = P[P.length - 1];
        const L = letzt && letzt.pending && /^\d$/.test(String(letzt.label)) ? String(letzt.label) : null;
        if (L && fibs && !E.projection.some(q => String(q.label) === L)) {
          const st = [...((fibs.elliott && fibs.elliott.levels) || []), ...((fibs.elliottWeiter && fibs.elliottWeiter.levels) || [])]
            .filter(l => l && String(l.wave) === L && !l.erreicht && !l.cExt && !l.jetzt && l.price > 0 && Number.isFinite(l.prob));
          if (st.length) {
            const best = st.reduce((a, b) => (b.prob > a.prob ? b : a));
            const d0 = Math.max(2, Math.round(((E.projection[0] && E.projection[0].dIdx) || 12) * 0.25));
            E.projection = [{ label: L, price: best.price, dIdx: d0 }, ...E.projection.map(q => ({ ...q, dIdx: (q.dIdx || 0) + d0 }))];
          }
        }
      }
      const k3 = E.projection.findIndex(q => String(q.label) === '3');
      if (k3 >= 0 && fibs) {
        const hat3 = [...((fibs.elliott && fibs.elliott.levels) || []), ...((fibs.elliottWeiter && fibs.elliottWeiter.levels) || [])].some(l => l && String(l.wave) === '3');
        const pts = E.points || [];
        const i1 = pts.findIndex(q => String(q.label) === '1');
        const p1 = i1 > 0 ? pts[i1] : null, p0 = i1 > 0 ? pts[i1 - 1] : null;
        const p2 = E.projection.find(q => String(q.label) === '2') || pts.find(q => String(q.label) === '2');
        if (!hat3 && p0 && p1 && p2 && p0.price > 0 && p1.price > 0 && p2.price > 0) {
          const auf = p1.price > p0.price ? 1 : -1;
          const Lg = v => useLog ? Math.log(v) : v, Eg = v => useLog ? Math.exp(v) : v;
          const w1 = Math.abs(Lg(p1.price) - Lg(p0.price));
          const gew = { 1: 20, 1.618: 45, 2: 15, 2.618: 20 };
          const stufen = [1, 1.618, 2, 2.618].map(r => ({ r, wave: '3', price: Eg(Lg(p2.price) + auf * r * w1), prob: gew[r] })).filter(l => l.price > 0);
          fibs.elliottWeiter = { id: 'elliottWeiter', label: '3', vonPreis: p2.price, drawFromIdx: (Number.isInteger(p2.idx) ? p2.idx : (pts[pts.length - 1] || {}).idx) || 0, levels: stufen };
          const alt = E.projection[k3].price, neu = stufen.find(l => l.r === 1.618).price;
          if (alt > 0 && neu > 0) {
            const f = neu / alt, d = neu - alt;
            E.projection = E.projection.map((q, k) => k < k3 ? q : ({ ...q, price: k === k3 ? neu : (useLog ? q.price * f : q.price + d) }));
            if (E.zwischenziel && String(E.zwischenziel.wave) === '3') E.zwischenziel = { ...E.zwischenziel, price: neu, r: 1.618 };
          }
        }
      }
      if (String(E.projection[0].label) !== '3') return;
      // ZIEL VON WELLE 3 = DIE WAHRSCHEINLICHSTE FIB-STUFE (gemeldet: "Welle 3 muesste doch bis
      // 1,618 laufen" -- der Kreis "3" stand bei 3,231e-4, die Linien zeigten 1,618 = 3,772e-4 mit
      // 56 %). Einige Sonderfaelle der Zaehlung rechnen das Ziel anders als die gezeichneten
      // Stufen; dann widersprachen sich Kreis und Linien. Jetzt gewinnt die offene Stufe mit der
      // hoechsten Wahrscheinlichkeit, weitere Projektionspunkte wandern mit.
      if (fibs) {
        const stufen = [...((fibs.elliott && fibs.elliott.levels) || []), ...((fibs.elliottWeiter && fibs.elliottWeiter.levels) || [])]
          .filter(l => l && String(l.wave) === '3' && !l.erreicht && !l.cExt && !l.jetzt && l.price > 0 && Number.isFinite(l.prob));
        if (stufen.length) {
          const best = stufen.reduce((a, b) => (b.prob > a.prob ? b : a));
          const alt = E.projection[0].price;
          if (alt > 0 && Math.abs(Math.log(best.price / alt)) > 0.01) {
            const f = best.price / alt, d = best.price - alt;
            E.projection = E.projection.map((q, k) => ({ ...q, price: k === 0 ? best.price : (useLog ? q.price * f : q.price + d) }));
            if (E.zwischenziel && String(E.zwischenziel.wave) === '3') E.zwischenziel = { ...E.zwischenziel, price: best.price, r: best.r };
          }
        }
      }
      // Keine Ergaenzung um Welle 4 und 5 mehr (gemeldet: "Warum wird 4 und 5 angezeigt? Welle 3
      // hat sich noch nicht ausgebildet"). Solange Welle 3 laeuft, zeigt die Prognose nur ihr Ende.
    } catch (e) {}
  }
  function altTrunc5(E3, data, lastClose, useLog) {
    try {
      if (E3) {
        E3.alt5 = null;
        if (Array.isArray(E3.scenarios)) E3.scenarios = E3.scenarios.filter(x => x.key !== 'scenTrunc5');
      }
      if (E3 && E3.kind === 'impulse' && (E3.phase === 'wave4' || E3.phase === 'wave5') && lastClose > 0 && Array.isArray(E3.points)) {
        const lab = l => E3.points.find(q => String(q.label) === l);
        const P0 = lab('0'), P3 = lab('3'), P4 = lab('4');
        if (P3 && P4 && Number.isInteger(P4.idx) && P3.price > 0 && P4.price > 0) {
          const sg = E3.dir === 'up' ? 1 : -1;
          const dL = (a, b) => useLog ? Math.log(a) - Math.log(b) : a - b;
          let exI = -1, exP = null;
          for (let i = P4.idx + 1; i < data.length; i++) {
            const v = sg > 0 ? hiOf(data[i]) : loOf(data[i]);
            if (Number.isFinite(v) && v > 0 && (exP == null || dL(v, exP) * sg > 0)) { exP = v; exI = i; }
          }
          if (exP != null && exI < data.length - 5) {
            const vorbei = dL(exP, P3.price) * sg;                  // > 0: ueber Welle 3 hinaus
            const nah = useLog ? Math.log(1.10) : P3.price * 0.10;
            const w5 = dL(exP, P4.price) * sg;                      // Laenge der moeglichen Welle 5
            const zurueck = dL(lastClose, exP) * -sg;               // Gegenbewegung seither
            if (vorbei <= 0 && vorbei >= -nah && w5 > 0 && zurueck >= 0.618 * w5) {
              const ganz = P0 ? Math.abs(dL(P0.price, exP)) : Math.abs(dL(P4.price, exP));
              const stufe = r => useLog ? exP * Math.exp(-sg * ganz * r) : exP - sg * ganz * r;
              // A-Ziel: 38,2 / 50 / 61,8 % des ganzen Impulses -- die erste Stufe jenseits von Kurs UND
              // Welle 4 (der Ausloeser ist ein Schluss jenseits von Welle 4, das Ziel muss dahinter liegen).
              const ziele = [0.382, 0.5, 0.618].map(stufe).filter(z => Number.isFinite(z) && z > 0);
              const ziel = ziele.find(z => dL(z, lastClose) * -sg > 0 && dL(z, P4.price) * -sg > 0) || null;
              const bestaetigt = dL(lastClose, P4.price) * -sg > 0;   // schon jenseits von Welle 4
              E3.alt5 = { idx: exI, price: exP, type: sg > 0 ? 'H' : 'L', trigger: P4.price, target: ziel, bestaetigt };
              if (Array.isArray(E3.scenarios)) {
                const sc = E3.scenarios;
                sc.push({ key: 'scenTrunc5', dir: sg > 0 ? 'down' : 'up', prob: bestaetigt ? 55 : 28, trigger: { price: P4.price, below: sg > 0 }, target: ziel });
                // Neu auf 100 % verteilen (die uebrigen anteilig kleiner), absteigend sortiert.
                const summe = sc.reduce((a, x) => a + (x.prob || 0), 0) || 1;
                sc.forEach(x => { x.prob = Math.max(1, Math.round((x.prob || 0) / summe * 100)); });
                sc.sort((x, y) => y.prob - x.prob);
                const rest = 100 - sc.reduce((a, x) => a + x.prob, 0);
                if (sc.length) sc[0].prob += rest;
              }
            }
          }
        }
      }
    } catch (e) {}
  }

  function analyze({ data: rohDaten, viewStart, viewEnd, logScale, ma200Override, degreeMode, dochtFilter, kontextExtern = null }) {
    // Dochtfilter jetzt IMMER (nicht nur im Vergleichs-Chart): Fehlausbrueche sollen in keinem
    // Zeitraum eine Welle erfinden. Gezeichnet werden weiterhin die echten Kerzen.
    const data = rohDaten && rohDaten.length && dochtFilter !== false ? rwDochtFilter(rohDaten) : rohDaten;
    const N = data ? data.length : 0;
    if (N < 12) return null;
    const to = clamp(Math.floor(viewEnd != null ? viewEnd : N - 1), 0, N - 1);
    const from = clamp(Math.floor(viewStart != null ? viewStart : 0), 0, to);
    if (to - from < 8) return null;
    // Log-Mathematik erzwingen, wenn der analysierte Bereich mehr als das 3-fache ueberspannt
    // (Wochen-/Monatschart ueber Jahre): Fibonacci-Verhaeltnisse in Dollar-Schritten sind dort
    // falsch (0,382 von "20 -> 0,35" waere linear 7,86, im Log-Raum 1,65) -- unabhaengig davon,
    // ob der Nutzer die Log-Skala gerade eingeschaltet hat.
    let useLog = !!logScale;
    {
      // Bereich = sichtbares Fenster PLUS Kontext (bis 4x refSpan davor), denn die Zaehlung
      // greift auf Wendepunkte vor dem Fenster zurueck -- sonst rechnet ein enges Fenster am
      // Ende einer 50x-Bewegung linear, obwohl die Punkte der Zaehlung 20 und 0,35 heissen.
      const span0 = pow2Span(to - from + 1);
      const c0 = clamp(to - 4 * span0, 0, from);
      let mx = -Infinity, mn = Infinity;
      for (let i = c0; i <= to; i++) { const v = data[i].value; if (v > mx) mx = v; if (v < mn) mn = v; }
      if (mn > 0 && mx / mn > 3) useLog = true;
    }
    const atr = atrSeries(data, 14);
    const atrAbs = atr[to] != null ? atr[to] : avg(data.slice(from, to + 1).map(d => hiOf(d) - loOf(d))) || data[to].value * 0.02;
    const lastClose = data[to].value;
    const atrPct = atrAbs / Math.max(lastClose, 1e-9);
    const len = to - from + 1;
    // Kontext in Zweierpotenz-Schritten der Fensterbreite (siehe pivotsAuto): der linke Rand
    // des Kontexts wandert dadurch NICHT mit jedem Verschieben um eine Kerze mit -- sonst
    // kippte eine Elliott-Zaehlung am Kontextrand um, obwohl im Bild nichts passiert ist.
    const refSpan = pow2Span(len);
    const ctxFrom = clamp(to - 2 * refSpan, 0, from);
    const ctxCoarse = clamp(to - 3 * refSpan, 0, from);

    // Schwellen aus der Volatilitaet, aber gedeckelt: bei Wochen-/Monatskerzen liegt die ATR
    // selbst bei 30-60 % -- das Vielfache davon wuerde fast jeden Wendepunkt verschlucken
    // (gemeldet am Monats-Chart: "nur ein Muster" ueber sechs Jahre).
    const medium = pivotsAuto(data, ctxFrom, to, 24, 5, Math.min(0.22, atrPct * 1.8), len);
    const mediumInView = { pivots: medium.pivots.filter(p => p.idx >= from), pending: medium.pending };
    const coarse = pivotsAuto(data, ctxCoarse, to, 12, 4, Math.min(0.35, atrPct * 2.6), len);
    const fineForRsi = pivotsAuto(data, from, to, 24, 6, Math.min(0.15, atrPct * 1.3), len);
    const trend = detectTrend(data, from, to, atrPct, mediumInView.pivots);
    const sr = detectSR(data, ctxFrom, to, atrAbs, lastClose, atrPct);
    const fibs = detectFib(data, from, to, coarse, lastClose, useLog);
    const tolLog = Math.max(Math.log(1.025), 0.8 * atrPct); // mind. 2,5 %: Krypto-Hochs sind selten auf den Prozent gleich
    // Trendlinien ueber die GROBEN Wendepunkte: Die wichtigen Linien verbinden die grossen
    // Hochs und Tiefs, nicht jede Zwischenzacke. Toleranz etwas grosszuegiger als bei
    // waagerechten Marken, weil eine schraege Linie nie auf den Punkt genau trifft.
    // Grobe UND mittlere Wendepunkte zusammen: Die groben allein waren fuer ruhige Trends zu
    // grob -- bei einem gleichmaessigen Aufwaertstrend lag dort ein einziger Punkt vor, aus dem
    // sich keine Linie bilden laesst. Die Bewertung waehlt ohnehin die staerkste Linie, mehr
    // Kandidaten schaden also nicht.
    const tlPivots = (() => {
      const m = new Map();
      for (const p of [...coarse.pivots, ...medium.pivots]) if (!m.has(p.idx)) m.set(p.idx, p);
      return [...m.values()].sort((a, b) => a.idx - b.idx);
    })();
    const tlErgebnis = detectTrendlines(data, ctxCoarse, to, tlPivots, useLog, tolLog * 1.4, lastClose);
    const trendlines = tlErgebnis.gewichtet;
    const trendlinesTouch = tlErgebnis.beruehrung;

    const volumes = data.some(d => d.volume != null && Number.isFinite(d.volume)) ? data.map(d => d.volume) : null;
    // Elliott laeuft jetzt auf den MITTLEREN Pivots (mit Skip ueber Unterwellen, siehe
    // detectElliott) -- die groben allein liessen zu viele Strukturen aus.
    const fineCtx = pivotsAuto(data, ctxFrom, to, 60, 6, Math.min(0.15, atrPct * 1.3), len);
    const ewSet = { pivots: medium.pivots, pending: medium.pending };
    // GRAD-WAHL (gemeldet: "auf dem grossen Zeitraum wird keine Elliott-Theorie angewendet --
    // es wird zu klein betrachtet"): Bisher zaehlte die Engine immer die LETZTEN Wendepunkte
    // einer festen Feinheit. Auf 300 Wochenkerzen ist das zwangslaeufig die kleine Struktur am
    // Ende, egal wie weit man herauszoomt. Der Grad muss mit dem Zeitraum wachsen.
    //
    // Deshalb bei weitem Fenster (>= 120 Kerzen): von grob nach fein probieren (60 %, 40 %,
    // 28 %, 20 % Umkehrschwelle). Die GROEBSTE Stufe, deren Zaehlung mindestens 35 % des
    // Fensters ueberspannt und wenigstens vier Punkte hat, wird die Hauptzaehlung -- auf dem
    // Gesamtchart also z. B. Impuls 2020-21, dann A-B-C 2021-25 statt der 1-2-3-4-5 der
    // letzten Monate. Die feine Zaehlung bleibt als Unterwellen (Ebene "sub") erhalten.
    let elliott = null;
    let degreePivots = null;
    // DIAGNOSE (gemeldet: "trotz large keine Veraenderung"): Auf echten Daten laesst sich von
    // aussen nicht sehen, ob die Grad-Wahl ueberhaupt greift. Dieser Verlauf wird im Panel
    // angezeigt, wenn der Modus nicht 'auto' ist -- so ist nachvollziehbar, welche Stufe
    // geprueft wurde und woran sie gescheitert ist.
    const degreeLog = [];
    {
      const winLen = to - from + 1;
      // degreeMode: 'auto' (Standard), 'coarse' (Grad erzwingen -- auch bei kleinerem Fenster und
      // ohne die 35-%-Huerde), 'fine' (immer die feine Zaehlung wie frueher).
      const modus = degreeMode || 'auto';
      degreeLog.push('Fenster ' + winLen + ' Kerzen, Modus ' + modus);
      // Schwelle 60 statt 120 Kerzen: Der Monatschart hat ueber die ganze RUNE-Historie nur rund
      // 70 Kerzen -- mit 120 waere die Grad-Wahl dort NIE aktiv geworden, obwohl gerade dort die
      // grosse Struktur gefragt ist.
      if (modus !== 'fine' && (winLen >= 60 || modus === 'coarse')) {
        const feinste = Math.min(0.22, atrPct * 1.8);
        // GRAD-WAHL NACH QUALITAET (gemeldet: "willkuerlich"): Bisher gewann die GROBSTE Stufe, die
        // ueberhaupt eine Zaehlung hergab -- egal wie schlecht sie passte. Ein einziger Wendepunkt,
        // der auf der groben Stufe auftauchte oder verschwand, liess die ganze Zaehlung auf einen
        // anderen Grad springen (z. B. den ganzen Impuls als "Welle 1"). Jetzt werden in 'auto' alle
        // Stufen bewertet; es gewinnt die beste Zaehlung, groebere Stufen bekommen einen kleinen
        // Vorsprung (die grosse Struktur bleibt bevorzugt, wenn sie ungefaehr gleich gut passt).
        const stufenErg = [];
        for (const pct of (modus === 'coarse' ? [0.6, 0.4, 0.28, 0.2, 0.14, 0.1] : [0.6, 0.4, 0.28, 0.2])) {
          if (pct <= feinste && modus !== 'coarse') { degreeLog.push(pct + ': übersprungen (feiner als ' + feinste.toFixed(2) + ')'); break; }
          const zz = zigzagUpTo(data, to, pct);
          const inWin = zz.pivots.filter(p => p.idx >= from);
          if (inWin.length < 4) { degreeLog.push(pct + ': nur ' + inWin.length + ' Wendepunkte'); continue; }
          const prev = zz.pivots.filter(p => p.idx < from);
          const set = { pivots: (prev.length ? [prev[prev.length - 1]] : []).concat(inWin), pending: zz.pending, pct };
          // ZWEI Lesarten je Stufe: (1) mit dem laufenden Punkt -- liefert oft nur eine
          // vorlaeufige 1-2 mit drei Punkten, weil die Engine "in Arbeit" bevorzugt; (2) OHNE den
          // laufenden Punkt, also die zuletzt FERTIGE Struktur (z. B. A-B-C bis zum Tief 2025,
          // Korrektur fertig). Genau (2) fehlte auf dem Gesamtchart: die grosse A-B-C war fertig,
          // und die Engine sah nur den kleinen Anfang der neuen Bewegung.
          // Die Engine waehlt unter ALLEN Kandidaten dieser Stufe den besten, der mindestens vier
          // Punkte hat und mindestens 35 % des Fensters ueberspannt -- so gewinnt die grosse,
          // weitgehend fertige Struktur (Impuls 1-2-3-4 abwaerts oder A-B-C fertig) nach ihrer
          // eigenen Konfidenz, nicht eine vorlaeufige 1-2 mit drei Punkten am rechten Rand.
          const passend = detectElliott(set, lastClose, to, useLog, volumes,
            modus === 'coarse' ? { minPoints: 4, preferEarliest: true, data } : { minPoints: 4, minSpan: 0.35 * winLen, data });
          if (passend && modus === 'coarse') {
            elliott = passend; elliott.degreePct = pct; degreePivots = set.pivots;
            degreeLog.push(pct + ': ' + passend.points.length + ' Punkte ab ' + passend.points[0].idx + ' ✓');
            break;
          }
          if (passend) {
            const gute = (passend.rawScore != null ? passend.rawScore : passend.confidence) + 4 * (3 - stufenErg.length);
            stufenErg.push({ passend, pct, pivots: set.pivots, gute });
            degreeLog.push(pct + ': ' + passend.points.length + ' Punkte ab ' + passend.points[0].idx + ', Güte ' + gute.toFixed(1));
            continue;
          }
          degreeLog.push(pct + ': ' + inWin.length + ' WP, keine gültige Zählung (≥4 Punkte' + (modus === 'coarse' ? '' : ', ≥35 % Spanne') + ')');
        }
        if (!elliott && stufenErg.length) {
          const b = stufenErg.reduce((a, x) => (x.gute > a.gute ? x : a));
          elliott = b.passend; elliott.degreePct = b.pct; degreePivots = b.pivots;
          degreeLog.push('gewählt: ' + b.pct + ' ✓');
        }
      }
    }
    if (!elliott) { degreeLog.push('Rückfall auf die feine Zählung'); elliott = detectElliott(ewSet, lastClose, to, useLog, volumes, { data }) || detectElliott(coarse, lastClose, to, useLog, volumes, { data }); }
    // WELLE 5 BIS ZUM ECHTEN ENDE (gemeldet: "5" stand bei $0.64, danach lief der Kurs noch auf
    // $0.87 -- ohne Ruecksetzer unter Welle 4). Ein spaeteres Extrem jenseits von 5, vor dem der Kurs
    // nie unter das Ende von 4 fiel, gehoert noch zu Welle 5 (sie war nur noch nicht als Wendepunkt
    // bestaetigt). Dann wird die Zaehlung mit diesem Extrem als 5 neu bewertet -- inklusive Phase,
    // Zielen und Projektion -- und uebernommen, wenn sie gueltig ist.
    if (elliott && elliott.kind === 'impulse') {
      try {
        const P = l => elliott.points.find(q => String(q.label) === l);
        const p4 = P('4'), p5 = P('5');
        const auf = elliott.dir !== 'down';
        // Auch fuer eine noch LAUFENDE Welle 5 (pending) -- gemeldet: die "5" sass bei $0.70, das
        // Hoch bei $0.87 lag danach. Der laufende Punkt muss immer das bisherige Extrem sein.
        if (p4 && p5) {
          let ext = null;
          for (let i = p5.idx + 1; i <= to; i++) {
            const d = data[i]; if (!d) continue;
            const h = d.high != null ? d.high : d.value, l = d.low != null ? d.low : d.value;
            if (auf ? l < p4.price : h > p4.price) break;
            if (auf ? h > (ext ? ext.price : p5.price) : l < (ext ? ext.price : p5.price)) ext = { idx: i, price: auf ? h : l };
          }
          if (ext && p5.pending) {
            degreeLog.push('laufende Welle 5 an das bisherige Extrem gesetzt (' + p5.price.toFixed(4) + ' \u2192 ' + ext.price.toFixed(4) + ')');
            elliott.points = elliott.points.map(q => (q === p5 ? { ...q, idx: ext.idx, price: ext.price } : q));
            // Projektionspunkte fuer 5, die schon ueberschritten sind, entfallen
            if (Array.isArray(elliott.projection)) elliott.projection = elliott.projection.filter(q => !(String(q.label) === '5' && (auf ? q.price <= ext.price : q.price >= ext.price)));
            ext = null;
          }
          if (ext) {
            const piv = elliott.points.filter(q => /^[0-5]$/.test(String(q.label))).map((q, k) => ({ idx: q.idx, price: q.price, type: (k % 2 === 0) === auf ? 'L' : 'H' }));
            piv[piv.length - 1] = { idx: ext.idx, price: ext.price, type: auf ? 'H' : 'L' };
            const neu = detectElliott({ pivots: piv, pending: null }, lastClose, to, useLog, volumes, { forceStart: true, data });
            const n5 = neu && neu.kind === 'impulse' && neu.points.find(q => String(q.label) === '5');
            if (n5 && n5.idx === ext.idx) {
              degreeLog.push('Welle 5 bis zum spaeteren Extrem verlaengert (' + p5.price.toFixed(4) + ' \u2192 ' + ext.price.toFixed(4) + ')');
              elliott = Object.assign(neu, { degreePct: elliott.degreePct });
            } else if (['impulseDone', 'waveA', 'waveB', 'waveC', 'corrDone'].includes(elliott.phase) && !elliott.points.some(q => /^[ABC]$/.test(String(q.label)) && q.idx > p5.idx && q.idx < ext.idx)) {
              // Neubewertung waehlt eine andere Lesart -> 5 direkt verschieben und alles, was am
              // Ende von 5 haengt (Projektion der Korrektur, Ziele, Ungueltigkeit), um denselben
              // Faktor mitziehen. Punkte A/B/C vor dem neuen Extrem gibt es dann nicht.
              const f = ext.price / p5.price;
              degreeLog.push('Welle 5 verschoben (' + p5.price.toFixed(4) + ' \u2192 ' + ext.price.toFixed(4) + ')');
              const alt5 = p5.price;
              elliott.points = elliott.points.filter(q => !(/^[ABC]$/.test(String(q.label)) && q.idx > p5.idx)).map(q => (q === p5 ? { ...q, idx: ext.idx, price: ext.price } : q));
              if (Array.isArray(elliott.projection)) elliott.projection = elliott.projection.map(q => ({ ...q, price: q.price * f }));
              if (Array.isArray(elliott.targets)) elliott.targets = elliott.targets.map(q => ({ ...q, price: q.price * f }));
              if (elliott.invalidation && Math.abs(elliott.invalidation.price - alt5) < 1e-12) elliott.invalidation = { ...elliott.invalidation, price: ext.price };
              if (['waveA', 'waveB', 'waveC', 'corrDone'].includes(elliott.phase)) elliott.phase = 'impulseDone';
            }
          }
        }
      } catch (e) { /* bleibt bei der urspruenglichen Zaehlung */ }
    }
    // VERKUERZTE WELLE 5 IN FRAGE STELLEN (gemeldet, Tageschart: "die Welle 5 gefaellt mir nicht"
    // -- 3 und 5 lagen fast gleich hoch am Oktober-Hoch, dazwischen eine kleine 4). Die
    // naheliegendere Lesart: Das hoehere der beiden Hochs ist das Ende von Welle 3, und der
    // Rueckgang seitdem ist die laufende Welle 4 -- Welle 5 kommt noch. Gilt sie (4 nicht im
    // Bereich von Welle 1), wird sie uebernommen; die verkuerzte 5 bleibt die Ausnahme.
    if (elliott && elliott.kind === 'impulse' && elliott.truncated) {
      try {
        const P = l => elliott.points.find(q => String(q.label) === l);
        const p0 = P('0'), p1 = P('1'), p2 = P('2'), p3 = P('3'), p5 = P('5');
        const auf = elliott.dir !== 'down';
        if (p0 && p1 && p2 && p3 && p5) {
          const top = (auf ? p5.price > p3.price : p5.price < p3.price) ? p5 : p3;
          let tief = null;
          for (let i = top.idx + 1; i <= to; i++) {
            const d = data[i]; if (!d) continue;
            const v = auf ? (d.low != null ? d.low : d.value) : (d.high != null ? d.high : d.value);
            if (!tief || (auf ? v < tief.price : v > tief.price)) tief = { idx: i, price: v };
          }
          const ueberI = tief && (auf ? tief.price > p1.price : tief.price < p1.price);
          if (tief && ueberI) {
            const piv = [p0, p1, p2].map((q, k) => ({ idx: q.idx, price: q.price, type: (k % 2 === 0) === auf ? 'L' : 'H' }));
            piv.push({ idx: top.idx, price: top.price, type: auf ? 'H' : 'L' });
            const pend = { idx: tief.idx, price: tief.price, type: auf ? 'L' : 'H' };
            const neu = detectElliott({ pivots: piv, pending: pend }, lastClose, to, useLog, volumes, { forceStart: true, data });
            const n3 = neu && neu.kind === 'impulse' && neu.points.find(q => String(q.label) === '3');
            if (n3 && n3.idx === top.idx && !neu.points.some(q => String(q.label) === '5' && !q.pending)) {
              degreeLog.push('verkuerzte Welle 5 ersetzt: 3 am Hoch, Welle 4 laeuft');
              elliott = Object.assign(neu, { degreePct: elliott.degreePct });
            }
          }
        }
      } catch (e) { /* bleibt bei der verkuerzten Zaehlung */ }
    }
    if (elliott) elliott.degreeLog = degreeLog;
    if (elliott) {
      // GRAD-NAME (Stichwort Cycle / Primary / Intermediate ...): Elliott ordnet Wellen nach
      // ihrer Dauer in Grade ein. Aus der mittleren Dauer einer Welle dieser Zaehlung (Abstand
      // zwischen zwei Punkten) wird der Grad bestimmt -- Richtwerte nach Frost/Prechter:
      // Cycle Jahre, Primary Monate bis ~2 Jahre, Intermediate Wochen bis Monate, Minor Wochen,
      // Minute Tage, Minuette Stunden, Subminuette Minuten. Ueber Cycle ist bei RUNE (Daten seit
      // 2019) nichts zaehlbar -- dafuer braeuchte man Jahrzehnte.
      const gradVon = (E) => {
        const pts = (E.points || []).filter(p => Number.isFinite(data[p.idx] && data[p.idx].date));
        if (pts.length < 2) return null;
        const dauern = [];
        for (let i = 1; i < pts.length; i++) dauern.push(Math.abs(data[pts[i].idx].date - data[pts[i - 1].idx].date));
        // Mittelwert statt Median: bei nur drei Wellen kippt der Median an der Grenze, der
        // Mittelwert ("wie lange dauern diese Wellen im Schnitt") ist hier das robustere Mass.
        const med = dauern.reduce((a, b) => a + b, 0) / dauern.length;
        const T = 86400e3;
        if (med >= 730 * T) return { key: 'cycle', name: 'Cycle' };
        if (med >= 120 * T) return { key: 'primary', name: 'Primary' };
        if (med >= 18 * T) return { key: 'intermediate', name: 'Intermediate' };
        if (med >= 4 * T) return { key: 'minor', name: 'Minor' };
        if (med >= 10 * 3600e3) return { key: 'minute', name: 'Minute' };
        if (med >= 3600e3) return { key: 'minuette', name: 'Minuette' };
        return { key: 'subminuette', name: 'Subminuette' };
      };
      elliott.degree = gradVon(elliott);
      // FRUEHERE STRUKTUREN (gemeldet: "das Analyse-Tool muss auf den ganzen Chart greifen"):
      // Die Hauptzaehlung beschreibt immer nur das Ende -- auf dem Monatschart seit 2019 blieb
      // damit der ganze erste Zyklus unbeschriftet. Davor liegende Impulse und Korrekturen
      // werden deshalb RUECKWAERTS weitergezaehlt, jede Struktur endet dort, wo die naechste
      // beginnt, bis der Anfang des Fensters erreicht ist (gedimmt gezeichnet).
      //
      // Vorher lief die Schleife genau einmal -- daher der eine gedimmte Block und sonst nichts.
      // Jetzt bis zu sechs Segmente; abgebrochen wird, sobald keine Wendepunkte mehr uebrig sind
      // oder eine Zaehlung nicht weiter nach links reicht (sonst Endlosschleife).
      const prior = [];
      let endIdx = elliott.points[0].idx;
      const priorPivots = degreePivots || medium.pivots;
      // KONTEXT LINKS VOM BILD MITZAEHLEN (gemeldet: "jetzt ist wieder das ABC nicht zu sehen" --
      // beim Zoomen fiel der Anstieg 2019-2021 aus dem Bild, damit fehlte (5), und die ganze
      // grosse Zaehlung brach weg). Die frueheren Strukturen werden deshalb ueber den Kontext-
      // bereich (doppelte Fensterbreite nach links, wie die mittleren Wendepunkte) gesucht, nicht
      // nur ueber den sichtbaren Ausschnitt. Gezeichnet wird ohnehin nur, was im Bild liegt.
      const priorFrom = ctxFrom;
      for (let k = 0; k < 8; k++) {
        if (endIdx <= priorFrom + 1) break;
        // Zuerst die Wendepunkte der Hauptzaehlung. Reichen sie im frueheren Bereich nicht aus
        // (auf grober Stufe liegt dort oft nur EIN durchgehender Anstieg ohne Umkehr), wird auf
        // die feineren ausgewichen -- sonst bliebe der Anfang des Charts unbeschriftet.
        let res = null;
        for (const quelle of [priorPivots, medium.pivots, fineForRsi.pivots]) {
          if (!quelle || !quelle.length) continue;
          const sub = quelle.filter(p => p.idx <= endIdx && p.idx >= priorFrom);
          if (sub.length < 4) continue;
          let kandidat = detectElliott({ pivots: sub, pending: null }, sub[sub.length - 1].price, endIdx, useLog, volumes);
          // ABGESCHLOSSEN ODER NICHTS (gemeldet: "warum steht unten (1)(2)(3) (A)(B)(C) -- wo sind 4
          // und 5?"): Eine fruehere Struktur ist Geschichte, sie endet dort, wo die naechste beginnt.
          // Ein Impuls, der nur bis 3 (oder 4) kommt und dann in eine Korrektur uebergeht, ist nach
          // Elliott kein Impuls: Eine Bewegung in DREI Wellen ist eine Korrektur. Deshalb:
          //  - Impuls 0-1-2-3 -> als A-B-C (Zickzack) beschriften,
          //  - Impuls ohne Welle 5 mit 0-1-2-3-4 -> verwerfen (unvollstaendig),
          //  - Korrektur nur mit Welle C.
          if (kandidat && kandidat.kind === 'impulse' && !kandidat.points.some(q => String(q.label) === '5')) {
            if (kandidat.points.length === 4) {
              const abc = ['0', 'A', 'B', 'C'];
              kandidat = { ...kandidat, kind: 'corrective', corrType: 'zigzag', points: kandidat.points.map((q, i) => ({ ...q, label: abc[i] })) };
            } else kandidat = null;
          }
          if (kandidat && kandidat.kind === 'corrective' && !kandidat.points.some(q => String(q.label) === 'C')) kandidat = null;
          if (kandidat && kandidat.points.length >= 4 && kandidat.points[0].idx < endIdx) { res = kandidat; break; }
        }
        if (!res) break;
        prior.unshift(res);
        endIdx = res.points[0].idx;
      }
      // FRUEHERES (A)(B)(C) MIT DER NACHFOLGENDEN ZAEHLUNG ABGLEICHEN (gemeldet: "das ABC sieht
      // nicht korrekt aus" / "warum wird hier immer noch so ABC gezaehlt?"). Nach (5) wurde ein
      // kurzes (A)(B)(C) gezaehlt, danach begann eine NEUE 5-Wellen-Bewegung nach unten, die weit
      // tiefer lief als dieses (C). Nach einer abgeschlossenen Korrektur ist aber ein Anstieg zu
      // erwarten, kein neuer Abwaertsimpuls. Stimmiger: Die Korrektur war noch nicht fertig --
      // (A) bleibt, (B) ist der hoechste Punkt bis zum Start der folgenden Zaehlung (meist dieser
      // Start), und die folgende 5-Wellen-Bewegung IST Welle (C); das fruehe "(C)" entfaellt.
      // Gilt fuer JEDES Paar aufeinanderfolgender Zaehlungen (fruehere untereinander und die
      // letzte fruehere mit der laufenden) -- vorher nur fuer das letzte Paar.
      {
        const lab = (P, l) => P.points.find(q => String(q.label) === l);
        const folge = [...prior, elliott];
        for (let i = 0; i < folge.length - 1; i++) {
          const vor = folge[i], nach = folge[i + 1];
          const pA = lab(vor, 'A'), pB = lab(vor, 'B'), pC = lab(vor, 'C'), p5 = lab(vor, '5');
          if (!(vor.kind === 'impulse' && p5 && pA && pB && pC && nach.points && nach.points.length >= 3)) continue;
          const corrDown = vor.dir === 'up', jenseits = (x, y) => (corrDown ? x < y : x > y);
          if (nach.kind !== 'impulse' || (nach.dir === 'up') !== !corrDown) continue; // muss in Korrekturrichtung laufen
          const v0 = nach.points[0];
          const vExt = nach.points.reduce((m, q) => (m == null || jenseits(q.price, m.price) ? q : m), null);
          if (!vExt || !jenseits(vExt.price, pC.price) || !jenseits(vExt.price, pA.price)) continue;
          const neuB = jenseits(pB.price, v0.price) ? v0 : pB; // der hoehere (bei Abwaertskorrektur)
          if (jenseits(p5.price, neuB.price) || neuB.idx <= pA.idx) continue;
          const istLaufend = nach === elliott;
          folge[i] = { ...vor, phase: 'waveC',
            points: [...vor.points.filter(q => q.idx <= pA.idx), { ...neuB, label: 'B', pending: false }] };
          const cMark = { idx: vExt.idx, price: vExt.price, type: corrDown ? 'L' : 'H',
            pending: istLaufend ? (!!vExt.pending || elliott.phase !== 'impulseDone') : false };
          if (istLaufend) { elliott.waveOfPrior = 'C'; elliott.priorC = cMark; }
          else {
            // UNTERWELLEN VON (C) EINEN GRAD KLEINER (gemeldet: "(A)(B) oben, unten (C) und
            // dazwischen 5 Wellen???"): Die 5 Wellen von (C) standen als (1)-(5) da -- derselbe
            // Grad wie der grosse Anstieg, das las sich wie eine eigene Zaehlung. Nach Elliott
            // besteht (C) aus fuenf Wellen des naechstkleineren Grads: i-ii-iii-iv-v, und das
            // Ende von v IST (C). Deshalb: i-iv klein, am Extrem nur "(C)".
            const klein = { '1': 'i', '2': 'ii', '3': 'iii', '4': 'iv', '5': 'v' };
            folge[i + 1] = { ...nach, istWelleC: true,
              points: nach.points.map(q => ({ ...q, label: q.idx === vExt.idx ? 'C' : (klein[String(q.label)] || q.label) })) };
          }
        }
        // ZWEITE STUFE -- FLAT (3-3-5) DES GROESSEREN GRADS (gemeldet: "komische Zaehlung" / "ist
        // nicht A das Tief 2023, B das Hoch 2024 und C das Tief 2026?"). Nach (5) folgte eine
        // Korrektur bis zu einem Tief L1, dann ein Anstieg (hoechstens bis unter (5)), dann eine
        // 5-Wellen-Bewegung WEIT unter L1. Dann war die Korrektur nach (5) bei L1 nicht fertig:
        // (A) = L1, (B) = das Hoch dazwischen, (C) = die letzte 5-Wellen-Bewegung.
        // Bewusst UNABHAENGIG davon, wie die Abschnitte dazwischen einzeln gezaehlt wurden (die
        // erste Fassung verlangte genau einen dreiteiligen Abschnitt zwischen L1 und der letzten
        // Bewegung und griff bei echten Daten nicht): massgeblich sind nur die Extrempunkte.
        // Die Kleinbeschriftung zwischen (5) und dem Ende entfaellt -- die drei grossen Wellen
        // stehen als eigene Marken (A)/(B)/(C) da.
        {
          const letzte = folge[folge.length - 1]; // laufende Zaehlung
          // Ausgangspunkt: der aeusserste (5) aller frueheren Impulse (bei RUNE das Allzeithoch).
          let iTop = -1;
          folge.forEach((P, k) => {
            if (P === letzte || P.kind !== 'impulse' || !lab(P, '5')) return;
            if (letzte.kind === 'impulse' && P.dir === letzte.dir) return; // (5) muss VOR einer Gegenbewegung stehen
            const v = lab(P, '5').price, w = iTop >= 0 ? lab(folge[iTop], '5').price : null;
            if (iTop < 0 || (P.dir === 'up' ? v > w : v < w)) iTop = k;
          });
          // Kein frueherer Impuls mit (5) im Kontext? Dann gilt das aeusserste Hoch (bei einer
          // Abwaertsbewegung jetzt) aller frueheren Punkte als Ausgangspunkt -- so haengt die grosse
          // Zaehlung nicht daran, ob der Anstieg davor gerade mitgezaehlt wurde.
          let topErsatz = null;
          if (iTop < 0 && letzte.kind === 'impulse') {
            const runter = letzte.dir === 'down';
            folge.forEach((P, k) => {
              if (P === letzte) return;
              for (const q of P.points) if (!topErsatz || (runter ? q.price > topErsatz.q.price : q.price < topErsatz.q.price)) topErsatz = { k, q };
            });
            if (topErsatz) iTop = topErsatz.k;
          }
          if (iTop >= 0 && letzte.kind === 'impulse' && letzte.points.length >= 4) {
            const top = folge[iTop], p5 = topErsatz ? topErsatz.q : lab(top, '5');
            const corrDown = topErsatz ? letzte.dir === 'down' : top.dir === 'up', jenseits = (x, y) => (corrDown ? x < y : x > y);
            // NUR FUER KORREKTUREN NACH UNTEN (gemeldet, 4H/Tageschart: Abwaertsimpuls 2025/26 wurde
            // zu "(5)", der Anstieg danach zu (A)(B)(C) nach oben, und daraus "Welle III nach unten
            // auf $0.198 / $0.081" abgeleitet -- im groesseren Bild ist dieser Abwaertsimpuls aber
            // selbst die Welle (C) der grossen Korrektur seit 2021). Die Umdeutung zur grossen
            // Korrektur (mit I/II/III) gibt es deshalb nur im klassischen Fall: Hoch (5) eines
            // Anstiegs, danach eine Korrektur nach unten. Sonst bleibt die normale Zaehlung stehen.
            if (corrDown && (letzte.dir === 'up') === !corrDown) {
              const lExt = letzte.points.reduce((m, q) => (m == null || jenseits(q.price, m.price) ? q : m), null);
              // alle Punkte zwischen (5) und dem Extrem der laufenden Bewegung (ohne dieses)
              const dazw = [];
              for (let k = iTop; k < folge.length; k++) for (const q of folge[k].points) if (q.idx > p5.idx && q.idx < lExt.idx) dazw.push(q);
              const vorStart = dazw.filter(q => q.idx <= letzte.points[0].idx);
              const L1 = vorStart.reduce((m, q) => (m == null || jenseits(q.price, m.price) ? q : m), null);
              const nachL1 = L1 ? dazw.filter(q => q.idx > L1.idx) : [];
              const Bp = nachL1.reduce((m, q) => (m == null || jenseits(m.price, q.price) ? q : m), null);
              const lg = v => Math.log(v);
              const ok = L1 && Bp && lExt && jenseits(lExt.price, L1.price) && !jenseits(p5.price, Bp.price)
                && Math.abs(lg(Bp.price) - lg(L1.price)) >= 0.382 * Math.abs(lg(p5.price) - lg(L1.price))
                && Bp.idx > L1.idx && lExt.idx > Bp.idx;
              if (ok) {
                // Kleinbeschriftung nach (5) ausblenden (Punkte/Linie bleiben fuer den Verlauf).
                for (let k = iTop; k < folge.length - 1; k++) {
                  const P = folge[k];
                  folge[k] = { ...P, points: P.points.map(q => (q.idx > p5.idx ? { ...q, label: '' } : q)) };
                }
                // Ausgangspunkt ohne eigenen Impuls im Kontext: das aeusserste Hoch heisst (5), die
                // uebrigen Beschriftungen seines Abschnitts entfallen (dort stand z. B. "(C)" am
                // Allzeithoch -- neben dem grossen (A)(B)(C) wirkte das wie eine zweite Zaehlung).
                if (topErsatz) {
                  const P = folge[iTop];
                  folge[iTop] = { ...P, points: P.points.map(q => ({ ...q, label: q.idx === p5.idx ? '5' : (q.idx < p5.idx ? '' : q.label) })) };
                }
                const typ = corrDown ? ['L', 'H'] : ['H', 'L'];
                elliott.grossMarken = [
                  { idx: L1.idx, price: L1.price, type: typ[0], text: '(A)' },
                  { idx: Bp.idx, price: Bp.price, type: typ[1], text: '(B)' },
                  // (C) NUR AM ENDE VON WELLE 5 (gemeldet: "(C)?" stand am Tief von Welle 3 -- das
                  // ist das bisherige Extrem, aber nicht das Ende von (C); Welle 4 und 5 fehlen noch).
                  // Laeuft die Zaehlung noch (kein Punkt "5"), entfaellt die (C)-Marke; das Ende
                  // zeigt dann die Projektion der Welle 5.
                  ...(() => {
                    const p5c = letzte.points.find(q => String(q.label) === '5');
                    return p5c ? [{ idx: p5c.idx, price: p5c.price, type: typ[0], text: '(C)', pending: !!p5c.pending || elliott.phase !== 'impulseDone' }] : [];
                  })(),
                ];
                elliott.waveOfPrior = 'C';
                // Start des grossen Anstiegs (Welle I): '0' des Impulses mit (5), sonst das aeusserste
                // Tief davor (gegenueberliegendes Extrem) aller frueheren Punkte.
                let start0 = topErsatz ? null : lab(folge[iTop], '0');
                if (!start0) for (let k = 0; k <= iTop; k++) for (const q of folge[k].points) if (q.idx < p5.idx && (!start0 || (corrDown ? q.price < start0.price : q.price > start0.price))) start0 = q;
                elliott.grossTop = { idx: p5.idx, price: p5.price, corrDown, start: start0 ? { idx: start0.idx, price: start0.price } : null };
                elliott.priorC = null; // durch grossMarken ersetzt
                elliott.flatGross = true;
              }
            }
          }
        }
        for (let i = 0; i < prior.length; i++) prior[i] = folge[i];
      }
      elliott.prior = prior;
      elliott.zuverl = RW_EW_ZUVERL[elliott.phase] || null;
      if (RW_EW_OHNE_PROJEKTION.includes(elliott.phase) && Array.isArray(elliott.projection) && elliott.projection.length) {
        elliott.projectionVersteckt = elliott.projection;
        elliott.projection = [];
      }

      // UEBERGEORDNETE ZAEHLUNG (Makro) -- top-down, nicht rueckwaerts.
      //
      // Der erste Versuch scheiterte, weil er von rechts nach links arbeitete: Die roemischen
      // Ziffern sassen dort, wo die Automatik zwei Strukturen trennte, nicht an den grossen
      // Extrema. Jetzt umgekehrt, so wie ein Analyst vorgeht und wie es auch die Literatur
      // beschreibt (Frost/Prechter: erst den groessten Grad bestimmen, dann hineinzoomen):
      //
      //   1. Die GROESSTEN Wendepunkte des Fensters bestimmen -- die groebste Zickzack-Stufe,
      //      die noch mindestens vier Punkte liefert.
      //   2. Darauf eine ganz normale Elliott-Zaehlung laufen lassen, mit denselben Regeln.
      //      Das ergibt die uebergeordneten Wellen, deren Punkte auf echten Extrema liegen.
      //   3. Die feine Zaehlung (oben) beschreibt weiterhin das laufende Geschehen und liegt
      //      damit INNERHALB der letzten uebergeordneten Welle.
      //
      // Verlangt wird, dass die Makro-Zaehlung den Chart auch wirklich umspannt: Ihr Startpunkt
      // muss im ersten Fuenftel des Fensters liegen, sonst ist es keine uebergeordnete Sicht,
      // sondern nur eine weitere Zaehlung am rechten Rand -- und dann wird gar keine gezeigt.
      elliott.macro = null;
      // ENTFERNT (auf Wunsch): Die Ebene "Eine Ebene hoeher" (roemische Ziffern I-V, grosse A/B)
      // wird nicht mehr berechnet. Ohne elliott.macro verschwinden Schalter, Kreise, Panel-Zeile
      // und Hindernis-Eintraege von selbst, weil alle an E.macro haengen. Die hoehere Ebene fuer
      // Flaggen steht jetzt als (1)/(2)/(3) am Muster. Wieder einschalten: true setzen.
      const RW_MAKRO_EBENE = false;
      if (RW_MAKRO_EBENE) {
        // Robust statt "ein Versuch": ueber mehrere Zickzack-Stufen UND mehrere Startpunkte
        // (die drei aeussersten Wendepunkte im ersten Fuenftel) alle gueltigen Zaehlungen
        // sammeln und die mit der groessten Abdeckung nehmen. Der erste Anlauf probierte nur
        // je einen Startpunkt -- scheiterte der an einer Nebenbedingung, gab es gar keine
        // uebergeordnete Sicht, obwohl eine gueltige existierte.
        const spanne = to - from + 1;
        let bester = null;
        for (const pct of [0.8, 0.6, 0.45, 0.34, 0.26, 0.2]) {
          const z = zigzagUpTo(data, to, pct);
          const pv = (z.pivots || []).filter(p => p.idx >= from);
          if (pv.length < 4) continue;
          const fruehe = pv.filter(p => p.idx <= from + spanne * 0.25);
          if (!fruehe.length) continue;
          // Startkandidaten: tiefster und hoechster fruehe Punkt, dazu der allererste.
          const tief = fruehe.reduce((x, y) => y.price < x.price ? y : x);
          const hoch = fruehe.reduce((x, y) => y.price > x.price ? y : x);
          const starts = [...new Set([tief, hoch, fruehe[0]])];
          for (const st of starts) {
            const ab = pv.filter(p => p.idx >= st.idx);
            if (ab.length < 4) continue;
            const kand = detectElliott({ pivots: ab, pending: null }, lastClose, to, useLog, volumes, { forceStart: true });
            if (!kand || kand.points.length < 4) continue;
            const erster = kand.points[0].idx, letzter = kand.points[kand.points.length - 1].idx;
            const abdeckung = (letzter - erster) / spanne;
            if (abdeckung < 0.35) continue;              // keine uebergeordnete Sicht
            if (erster > from + spanne * 0.3) continue;  // beginnt zu weit rechts
            const wert = abdeckung + (kand.points.length >= 6 ? 0.1 : 0);
            // Auswahl nach FRUEHESTEM Startpunkt (gemeldet: "Makro-Zaehlung startet am ATH statt
            // am Tief 2019"): Vorher gewann schlicht die groesste "abdeckung" (+ Punkte-Bonus) --
            // eine spaeter beginnende, aber zufaellig etwas laenger durchhaltende Zaehlung (z.B.
            // ab dem ATH) schlug damit eine kuerzere, aber gueltige Zaehlung ab dem tatsaechlich
            // fruehesten Wendepunkt. Fuer eine "uebergeordnete" (Makro-)Sicht ist aber genau der
            // fruehe Beginn der Punkt -- also zuerst nach kleinstem "erster" sortieren und "wert"
            // nur noch als Tie-Breaker zwischen mehreren Kandidaten mit demselben Start verwenden.
            const besser = !bester || erster < bester.erster || (erster === bester.erster && wert > bester.wert);
            if (besser) bester = { wert, kand, pct, abdeckung, erster };
          }
        }
        if (bester) elliott.macro = {
          kind: bester.kand.kind, dir: bester.kand.dir, phase: bester.kand.phase,
          points: bester.kand.points, diagonal: !!bester.kand.diagonal,
          truncated: !!bester.kand.truncated, pct: bester.pct,
          coverage: Math.round(bester.abdeckung * 100),
        };
      }
      // UEBERGEORDNETER GRAD (gemeldet: "drei verschiedene Zaehlungen je nach Zoom -- welche
      // gilt?"): Wellen bestehen aus Wellen. Dieselbe Zaehlung noch einmal auf dem 4-fachen
      // Zeitraum (grobe Pivots) ergibt den naechstgroesseren Grad. Der groessere Grad gibt die
      // Richtung, der sichtbare das Timing. Konsistent heisst: die sichtbare Zaehlung liegt
      // innerhalb der LAUFENDEN Welle des groesseren Grads und bewegt sich in dieselbe Richtung
      // wie diese.
      {
        const bigFrom = clamp(to - 4 * refSpan, 0, from);
        if (from - bigFrom > refSpan) {
          const big = pivotsAuto(data, bigFrom, to, 12, 4, Math.min(0.35, atrPct * 2.6), 4 * refSpan);
          const parent = detectElliott(big, lastClose, to, useLog, volumes);
          if (parent && parent.points.length >= 3 && parent.points[0].idx < elliott.points[0].idx) {
            // Beginn der LAUFENDEN Bewegung des groesseren Grads (nicht der letzte Pivot: die
            // sichtbare Zaehlung darf die Unterwellen dieser ganzen Bewegung umfassen).
            const pl = l => parent.points.find(p => p.label === l);
            const startOfMove = parent.kind === 'impulse'
              ? ({ wave2: pl('1'), wave3: pl('2'), wave4: pl('3'), wave5: pl('4') }[parent.phase] || pl('5') || parent.points[0])
              : (parent.phase === 'corrDone' ? (pl('C') || parent.points[0]) : parent.points[0]);
            const anchor = startOfMove || parent.points[0];
            // Richtung der laufenden Welle des uebergeordneten Grads
            const upPhases = { impulse: { wave2: !parent.dir || parent.dir === 'down', wave3: parent.dir === 'up', wave4: parent.dir === 'down', wave5: parent.dir === 'up', impulseDone: parent.dir === 'down', waveA: parent.dir === 'down', waveB: parent.dir === 'up', waveC: parent.dir === 'down', corrDone: parent.dir === 'up' }, corrective: { waveC: parent.dir === 'up', corrDone: parent.dir === 'down' } };
            const parentWaveUp = (upPhases[parent.kind] || {})[parent.phase];
            const curUp = elliott.kind === 'impulse' ? (['wave2', 'wave4', 'impulseDone', 'waveA', 'waveC'].includes(elliott.phase) ? elliott.dir === 'down' : ['waveB'].includes(elliott.phase) ? elliott.dir === 'up' : elliott.dir === 'up') : (elliott.phase === 'waveC' ? elliott.dir === 'up' : elliott.dir === 'down');
            const inside = elliott.points[0].idx >= anchor.idx - 2;
            elliott.parent = { kind: parent.kind, dir: parent.dir, phase: parent.phase, confidence: parent.confidence, points: parent.points, invalidation: parent.invalidation, consistent: inside && parentWaveUp === curUp, inside, sameDirection: parentWaveUp === curUp, degree: gradVon(parent) };
            // (A)(B)(C) DES GROESSEREN GRADS MIT DER SICHTBAREN ZAEHLUNG ABGLEICHEN (gemeldet: "das
            // ABC sieht nicht korrekt aus" -- Monatschart: (A)(B)(C) wurde in wenige Monate direkt
            // nach (5) gequetscht, danach lief die sichtbare Zaehlung als 5-Wellen-Abwaertsbewegung
            // weiter und deutlich TIEFER). Auf den groben Pivots endet die Korrektur am ersten
            // tieferen Tief; laeuft die sichtbare Zaehlung danach in Korrekturrichtung weiter und
            // unterschreitet dieses (C), war es nicht das Ende. Dann gilt: (B) = hoechster Punkt
            // zwischen (A) und dem Start der sichtbaren Zaehlung (inkl. diesem Start), (C) = das
            // Extrem der sichtbaren Bewegung -- die sichtbare 5-Wellen-Bewegung IST Welle (C).
            const P = elliott.parent;
            const pA = P.points.find(q => q.label === 'A'), pB = P.points.find(q => q.label === 'B'), pC = P.points.find(q => q.label === 'C');
            const pTop = P.points.find(q => q.label === '5');
            if (P.kind === 'impulse' && pA && pB && pTop && (P.phase === 'corrDone' || P.phase === 'waveC')) {
              const corrDown = P.dir === 'up', jenseits = (a, b) => (corrDown ? a < b : a > b);
              const vis = elliott.points, v0 = vis[0];
              const vExt = vis.reduce((m, q) => (m == null || jenseits(q.price, m.price) ? q : m), null);
              if (v0 && vExt && v0.idx >= pA.idx && vExt.idx > v0.idx && (!pC || jenseits(vExt.price, pC.price)) && jenseits(vExt.price, pA.price)) {
                const bKand = [pB, ...vis.filter(q => q.idx <= vExt.idx && q.idx >= pA.idx && q.idx <= v0.idx + 0)].filter(Boolean);
                const nB = bKand.reduce((m, q) => (m == null || jenseits(m.price, q.price) ? q : m), null);
                // (B) darf beim Zickzack den Start von (A) nicht ueberschreiten -- sonst nichts umbauen.
                if (nB && !jenseits(pTop.price, nB.price)) {
                  const letzter = vis[vis.length - 1];
                  const laeuft = vExt === letzter && (vExt.pending || elliott.phase !== 'impulseDone');
                  const bisA = P.points.filter(q => q.idx <= pA.idx);
                  elliott.parent = { ...P,
                    points: [...bisA, { ...nB, label: 'B', pending: false }, { ...vExt, label: 'C', pending: !!laeuft }],
                    phase: laeuft ? 'waveC' : 'corrDone',
                    invalidation: laeuft ? { price: nB.price, below: !corrDown, ruleKey: 'proInvC' } : null,
                    abgeglichen: true,
                    inside: true, sameDirection: true, consistent: true };
                }
              }
            }
          }
        }
      }
      // UNTERWELLEN der laufenden Welle: ab dem letzten BESTAETIGTEN Punkt der Zaehlung auf den
      // feinen Pivots noch einmal zaehlen (i-ii-iii-iv-v bzw. a-b-c) -- so sieht man, wie weit
      // die aktuelle Welle intern schon ist (z.B. "Welle 3 laeuft, intern in Unterwelle iii").
      const confirmedPts = elliott.points.filter(p => !p.pending);
      const anchor = confirmedPts.length ? confirmedPts[confirmedPts.length - 1] : null;
      if (anchor) {
        const fineSub = fineCtx.pivots.filter(p => p.idx >= anchor.idx);
        const fineSet2 = { pivots: fineSub, pending: fineCtx.pending && fineCtx.pending.idx > anchor.idx ? fineCtx.pending : null };
        if (fineSub.length + (fineSet2.pending ? 1 : 0) >= 3 && fineSub.length && Math.abs(fineSub[0].idx - anchor.idx) <= 2) {
          const sub = detectElliott(fineSet2, lastClose, to, useLog, volumes);
          if (sub && sub.points.length >= 3) {
            const map = { '1': 'i', '2': 'ii', '3': 'iii', '4': 'iv', '5': 'v', 'A': 'a', 'B': 'b', 'C': 'c' };
            elliott.sub = { kind: sub.kind, dir: sub.dir, phase: sub.phase, confidence: sub.confidence, points: sub.points.filter(p => p.label !== '0').map(p => ({ ...p, label: map[p.label] || p.label })), anchorLabel: anchor.label };
          }
        }
      }
    }
    // WELLE 2 NACH WELLE 1 SELBST SETZEN (gemeldet: "die 1 wird eingezeichnet, aber nicht mehr --
    // wo ist Welle 2 und die Prognose?"): Endet die Zaehlung mit Welle 1 und hat der Kurs seitdem
    // mindestens 23,6 % davon zurueckgegeben, ohne den Start (0) zu verletzen, steht beim
    // tiefsten (bzw. hoechsten) Punkt seit 1 eine laufende Welle 2. Prognose dann: Welle 3 =
    // 2 + 1,618 x Welle 1 (Dauer ~1,6 x Welle 1). Gilt fuer die Haupt- und die neue Zaehlung.
    const welle2Setzen = (z, zahlenStart) => {
      try {
        if (!z || !Array.isArray(z.points)) return;
        const pts = z.points;
        const p1 = pts[pts.length - 1];
        const p0 = zahlenStart || pts[pts.length - 2];
        if (!p1 || !p0 || String(p1.label) !== '1' || p1.pending) return;
        const auf = p1.price > p0.price;
        let ext = null;
        for (let i = p1.idx + 1; i < data.length && i <= to; i++) {
          const d = data[i]; if (!d) continue;
          const v = auf ? (d.low != null ? d.low : d.value) : (d.high != null ? d.high : d.value);
          if (v > 0 && (!ext || (auf ? v < ext.price : v > ext.price))) ext = { idx: i, price: v };
        }
        if (!ext) return;
        const L = (a, b) => Math.abs(useLog ? Math.log(b) - Math.log(a) : b - a);
        const w1 = L(p0.price, p1.price);
        if (!(w1 > 0) || L(p1.price, ext.price) < 0.236 * w1) return;
        if (auf ? ext.price <= p0.price : ext.price >= p0.price) return;   // Regel: Welle 2 nie unter den Start
        pts.push({ idx: ext.idx, price: ext.price, type: auf ? 'L' : 'H', label: '2', pending: true });
        z.phase = 'wave2';
        const mv = (von, f) => useLog ? von * Math.exp((auf ? 1 : -1) * w1 * f) : von + (auf ? 1 : -1) * w1 * f;
        const dur1 = Math.max(2, p1.idx - p0.idx);
        if (z === elliott) {
          elliott.projection = [{ label: '3', price: mv(ext.price, 1.618), dIdx: Math.max(3, Math.round(dur1 * 1.6) - Math.max(0, to - ext.idx)) }];
          elliott.invalidation = { price: p0.price, below: auf, ruleKey: 'proInvRule1' };
        } else z.ziel3 = mv(ext.price, 1.618);
      } catch (e) {}
    };
    if (elliott) welle2Setzen(elliott);
    // GROSSES BILD WEITERDENKEN (gefragt: "wieso wird nicht so prognostiziert wie im Wochenchart?"):
    // Ist die Zaehlung ein fertiger 5er-Impuls, der zugleich das (C) einer fertigen Korrektur ist,
    // kommt danach keine neue Korrektur "A", sondern ein NEUER IMPULS in Gegenrichtung der
    // Korrektur. Projektion dann 1 (38,2 % der Korrektur zurueck) -> 2 (50 % von 1) -> 3 (1,618 x 1),
    // ungueltig unter (C).
    try {
      const par = elliott && elliott.parent;
      const parC = par && Array.isArray(par.points) ? par.points[par.points.length - 1] : null;
      const parStart = par && Array.isArray(par.points) ? par.points.find(q => q.label === '0') || par.points[0] : null;
      if (elliott && elliott.phase === 'impulseDone' && par && (par.phase === 'corrDone' || (parC && String(parC.label) === 'C' && !parC.pending)) && parStart && parC
          && Array.isArray(elliott.projection) && elliott.projection.length && /^[A-Ca-c]$/.test(String(elliott.projection[0].label))) {
        const auf = parC.price < parStart.price;   // Korrektur abwaerts -> neuer Impuls aufwaerts
        const L = (a, b) => Math.abs(useLog ? Math.log(b) - Math.log(a) : b - a);
        const mv = (von, len, f, dir) => useLog ? von * Math.exp(dir * len * f) : von + dir * len * f;
        const korr = L(parStart.price, parC.price), d = auf ? 1 : -1;
        const z1 = mv(parC.price, korr, 0.382, d);
        const w1 = L(parC.price, z1);
        const z2 = mv(z1, w1, 0.5, -d), z3 = mv(z2, w1, 1.618, d);
        const dauer = Math.max(3, Math.round((parC.idx - parStart.idx) * 0.4));
        const schon = Math.max(0, to - parC.idx);
        elliott.projection = [
          { label: '1', price: z1, dIdx: Math.max(2, dauer - schon) },
          { label: '2', price: z2, dIdx: Math.max(3, dauer - schon) + Math.round(dauer * 0.6) },
          { label: '3', price: z3, dIdx: Math.max(4, dauer - schon) + Math.round(dauer * 0.6) + Math.round(dauer * 1.6) },
        ];
        elliott.invalidation = { price: parC.price, below: auf, ruleKey: 'proInvNewImpulse' };
        elliott.neuerImpulsProjektion = true;
      }
    } catch (e) {}
    // NEUER IMPULS NACH FERTIGER ZAEHLUNG (gefragt: "Bildet sich gerade die 1. Welle? Die Engine
    // muss doch etwas erkennen"): Ist die Zaehlung abgeschlossen (Korrektur oder Impuls fertig) und
    // fand die Unterwellen-Suche nichts, die einfachste Lesart selbst setzen: groesstes Extrem
    // seit dem Ende in Gegenrichtung = Welle 1 (wenn mind. 38,2 % der letzten Welle zurueckgeholt),
    // danach das Gegenextrem = Welle 2 (laufend, solange es der letzte Punkt ist).
    if (elliott && !elliott.sub && (elliott.phase === 'corrDone' || elliott.phase === 'impulseDone')) {
      try {
        const pts = elliott.points.filter(p => !p.pending);
        const ende = pts[pts.length - 1], davor = pts[pts.length - 2];
        if (ende && davor) {
          const aufw = ende.price < davor.price;   // Ende ist ein Tief -> neuer Impuls aufwaerts
          const L = (a, b) => Math.abs(useLog ? Math.log(b) - Math.log(a) : b - a);
          const nach = [...(fineCtx.pivots || []), ...(fineCtx.pending ? [fineCtx.pending] : [])].filter(q => q.idx > ende.idx);
          const p1 = nach.filter(q => q.type === (aufw ? 'H' : 'L')).reduce((m, q) => (!m || (aufw ? q.price > m.price : q.price < m.price) ? q : m), null);
          if (p1 && L(ende.price, p1.price) >= 0.382 * L(davor.price, ende.price)) {
            const nach1 = nach.filter(q => q.idx > p1.idx && q.type === (aufw ? 'L' : 'H'));
            const p2 = nach1.reduce((m, q) => (!m || (aufw ? q.price < m.price : q.price > m.price) ? q : m), null);
            const punkte = [{ ...p1, label: '1', pending: false }];
            if (p2 && (aufw ? p2.price > ende.price : p2.price < ende.price) && L(p1.price, p2.price) >= 0.236 * L(ende.price, p1.price)) {
              const letzter = nach[nach.length - 1];
              punkte.push({ ...p2, label: '2', pending: letzter && letzter.idx === p2.idx });
            }
            elliott.sub = { kind: 'impulse', dir: aufw ? 'up' : 'down', phase: punkte.length > 1 ? 'wave2' : 'wave1', confidence: 0.4, points: punkte, anchorLabel: ende.label, neuerImpuls: true };
            // Fehlt Welle 2 noch in den Pivots, aus den Kerzen bestimmen und Welle 3 projizieren.
            if (punkte.length === 1) welle2Setzen(elliott.sub, ende);
            if (punkte.length >= 1) {
              const s2 = elliott.sub.points.find(q => q.label === '2');
              if (s2) {
                const w1s = Math.abs(useLog ? Math.log(p1.price) - Math.log(ende.price) : p1.price - ende.price);
                const z3 = useLog ? s2.price * Math.exp((aufw ? 1 : -1) * w1s * 1.618) : s2.price + (aufw ? 1 : -1) * w1s * 1.618;
                elliott.projection = [{ label: '3', price: z3, dIdx: Math.max(3, Math.round((p1.idx - ende.idx) * 1.6) - Math.max(0, to - s2.idx)) }];
              }
            }
          }
        }
      } catch (e) {}
    }
    const indicators = evalIndicators(data, from, to, ma200Override, fineForRsi);
    fibs.elliott = elliottFib(elliott, useLog);
    rwFibWahrscheinlichkeit(fibs.elliott, data);
    // Erreicht (per Docht) seit dem Ankerpunkt? -> Haken in Chart und Fenster.
    if (false && fibs.elliott && fibs.elliott.anchor && Number.isFinite(fibs.elliott.anchor.idx)) {
      let lo = Infinity, hi = -Infinity;
      for (let i = fibs.elliott.anchor.idx + 1; i < data.length; i++) {
        const d = data[i]; if (!d) continue;
        const l = d.low != null ? d.low : d.value, h = d.high != null ? d.high : d.value;
        if (Number.isFinite(l) && l < lo) lo = l;
        if (Number.isFinite(h) && h > hi) hi = h;
      }
      const ap = fibs.elliott.anchor.price;
      fibs.elliott.levels.forEach(l => { l.erreicht = l.price < ap ? lo <= l.price : hi >= l.price; });
    }
    // GROSSER GRAD NACH FERTIGER FLAT-KORREKTUR (gemeldet: "die Fibonacci greift nicht auf den
    // grossen Zeitraum, und die weitere Zaehlung wird auf einen kleineren Zeitraum bezogen").
    // Ist (C) der grossen Flat fertig, endet damit die ganze Korrektur seit (5). Was folgt, ist
    // nach Elliott ein NEUER Impuls im grossen Grad -- nicht ein kleines A-B-C der letzten
    // 5-Wellen-Bewegung. Deshalb:
    //  - Fibonacci: Rueckholung der GESAMTEN Korrektur (5)->(C) (23,6 / 38,2 / 50 / 61,8 %),
    //  - Projektion: (1) bis 38,2 % der Korrektur, (2) zurueck um 61,8 % von (1), (3) = 1,618 x (1),
    //    zeitlich nach der Dauer von (B)->(C) bemessen,
    //  - Ungueltig: unter dem Tief von (C) (der neue Impuls darf seinen Start nicht unterschreiten).
    if (elliott && elliott.flatGross && elliott.grossTop && elliott.grossMarken && elliott.grossMarken[2] && !elliott.grossMarken[2].pending) {
      const T5 = elliott.grossTop, Bm = elliott.grossMarken[1], Cm = elliott.grossMarken[2];
      const auf = T5.corrDown ? 1 : -1;
      const L = v => (useLog ? Math.log(v) : v), E_ = v => (useLog ? Math.exp(v) : v);
      const retr = r => E_(L(Cm.price) + r * (L(T5.price) - L(Cm.price)));
      // Dazu die Fibonacci-Verhaeltnisse INNERHALB des grossen A-B-C (gefragt: "warum wird die
      // Fibonacci nicht auf das grosse ABC angewendet?"): Laenge von (C) im Verhaeltnis zu (A),
      // abgetragen ab (B) -- 1,0 / 1,272 / 1,618 x (A). Sie zeigen, an welcher Stufe (C) geendet
      // hat (mit Haken, wenn erreicht); die Rueckholungsstufen (5)-(C) zeigen die Ziele danach.
      const Am = elliott.grossMarken[0];
      const lenA = L(Am.price) - L(T5.price);
      const cExt = [1, 1.272, 1.618].map(r => ({ r, wave: '(A)', price: E_(L(Bm.price) + r * lenA), cExt: true })).filter(l => l.price > 0);
      fibs.elliott = { id: 'elliott', anchor: { idx: Cm.idx, price: Cm.price, label: '(C)' }, label: '(1)', phase: 'neuerZyklus',
        levels: [...[0.236, 0.382, 0.5, 0.618].map(r => ({ r, wave: '(5)\u2013(C)', price: retr(r) })).filter(l => l.price > 0), ...cExt], drawFromIdx: Bm.idx };
      {
        let lo = Infinity, hi = -Infinity;
        for (let i = Cm.idx + 1; i < data.length; i++) { const d = data[i]; if (!d) continue; const l = d.low != null ? d.low : d.value, h = d.high != null ? d.high : d.value; if (l < lo) lo = l; if (h > hi) hi = h; }
        fibs.elliott.levels.forEach(l => { if (!l.cExt) l.erreicht = l.price < Cm.price ? lo <= l.price : hi >= l.price; });
        // (C)-Stufen: erreicht, wenn (C) sie erreicht hat (Extrem seit (B)).
        fibs.elliott.levels.forEach(l => { if (l.cExt) l.erreicht = T5.corrDown ? Cm.price <= l.price : Cm.price >= l.price; });
      }
      const len = Math.max(6, Cm.idx - Bm.idx), schon = Math.max(0, to - Cm.idx);
      // (1): erste noch nicht erreichte Stufe ab 38,2 %
      const rueck = fibs.elliott.levels.filter(l => !l.cExt);
      const z1 = (rueck.find(l => l.r >= 0.382 && !l.erreicht) || rueck[rueck.length - 1]).price;
      const l1 = L(z1) - L(Cm.price);
      const z2 = E_(L(z1) - 0.618 * l1), z3 = E_(L(z2) + 1.618 * l1);
      const d1 = Math.max(2, Math.round(len * 0.4) - schon), d2 = d1 + Math.max(2, Math.round(len * 0.25)), d3 = d2 + Math.max(3, Math.round(len * 0.6));
      if (z1 > 0 && z2 > 0 && z3 > 0 && (auf > 0 ? z3 > z1 : z3 < z1)) {
        // KEIN PFAD FUER (1)-(2)-(3) (gemeldet: "Welle 1 kann man doch gar nicht voraussagen"):
        // Richtig -- fuer die erste Welle eines neuen Trends gibt es keine Messgroesse (Fibonacci-
        // Ziele beziehen sich immer auf eine VORHERIGE Welle desselben Trends). Die Rueckhol-
        // stufen (5)-(C) sind nur moegliche Widerstaende, keine Ziele fuer (1). Eine Projektion
        // gibt es erst, wenn (1) und (2) stehen; dann rechnet die normale Zaehlung (2) und (3).
        // Was bleibt: Rueckholstufen, die Ziele fuer Welle III des grossen Grads (aus I und II
        // messbar) und die Ungueltigkeit unter (C).
        void z2; void z3; void d1; void d2; void d3;
        elliott.projection = [];
        elliott.invalidation = { price: Cm.price, below: auf > 0, ruleKey: 'proInvNewImpulse' };
        elliott.weiche = null;
        elliott.neuerZyklus = true;
        // (Unterzaehlung der neuen Bewegung: siehe NACHLAUF-ZAEHLUNG weiter unten.)
        // WELLE III DES GROSSEN GRADS (gefragt: "wenn 2019-2021 Welle 1 und dann 2 durch ABC,
        // warum gibt es keine Prognose der Welle 3?"): Der ganze Anstieg bis (5) ist Welle I, die
        // fertige Flat-Korrektur (A)(B)(C) Welle II. Welle III wird ab dem Ende von II mit dem
        // Ueblichen abgetragen: 1,0 / 1,618 / 2,618 x Laenge von I. Laengen in der Skala des
        // Charts (Log: Verhaeltnis, linear: Dollar) -- bei Coins, die aus wenigen Cent kamen,
        // ergibt Log riesige Zahlen; deshalb wird die jeweils andere Rechnung mit ausgewiesen.
        if (T5.start && T5.start.price > 0) {
          const lenI = L(T5.price) - L(T5.start.price);
          const lenILin = T5.price - T5.start.price, lenILog = Math.log(T5.price / T5.start.price);
          // FOLGT DER SKALA DES CHARTS (auf Wunsch: "ja, auf Log"): Log-Ansicht -> Laenge von I als
          // Verhaeltnis, lineare Ansicht -> in Dollar. Die jeweils andere Rechnung steht zum
          // Vergleich im Analyse-Fenster. Hinweis: kam I aus wenigen Cent, ergibt Log sehr hohe Ziele.
          elliott.grossW3 = [1, 1.618, 2.618].map(r => ({
            r, price: E_(L(Cm.price) + auf * Math.abs(lenI) * r),
            alt: useLog ? Cm.price + auf * Math.abs(lenILin) * r : Cm.price * Math.exp(auf * Math.abs(lenILog) * r),
            altLog: !useLog,
          })).filter(x => x.price > 0);
        }
      }
    }
    // NACHLAUF-ZAEHLUNG NACH WELLE 5 (gefragt: "wo ist die Zaehlung nach Welle 5?"). Ist ein Impuls
    // fertig, zeigte die Engine danach oft gar nichts mehr: Die Wendepunkte der gewaehlten
    // Feinheit sind auf den GANZEN Ausschnitt abgestimmt (hoechstens ~24), und die kleineren
    // Schwuenge nach Welle 5 werden davon verschluckt. Hier wird der Abschnitt ab dem Ende von
    // Welle 5 eigens mit einer feineren Schwelle gezaehlt:
    //  - neuer Zyklus (grosse Korrektur fertig): als Impuls i-ii-iii-iv-v in die neue Richtung,
    //  - sonst: als Korrektur a-b-c gegen den Impuls.
    // Regeln: Impuls -- ii nicht unter den Start, iii ueber i, iv nicht in i, v ueber iii;
    // Korrektur -- b nicht ueber das Ende von 5 hinaus, c jenseits von a. Die letzte, noch nicht
    // bestaetigte Bewegung zaehlt mit "?" (laufend). Projektion nur mit Bezugswelle:
    // Impuls ab i+ii -> iii = 1,618 x i, ab iii -> iv = 38,2 % von iii, ab iv -> v = Laenge von i;
    // Korrektur ab a+b -> c = Laenge von a.
    try {
      const p5 = elliott && elliott.kind === 'impulse' && elliott.points.find(q => q.label === '5' && !q.pending);
      const startPunkt = elliott && elliott.neuerZyklus && elliott.grossMarken && elliott.grossMarken[2]
        ? { idx: elliott.grossMarken[2].idx, price: elliott.grossMarken[2].price }
        : (p5 && elliott.phase === 'impulseDone' && !elliott.points.some(q => /^[ABC]$/.test(String(q.label)) && q.idx > p5.idx) ? { idx: p5.idx, price: p5.price } : null);
      // (Nur, wenn die Zaehlung NACH Welle 5 noch nichts gezaehlt hat -- gemeldet: "was ist dieser
      // Doppelstrich?": Die Hauptzaehlung fuehrte schon A-B-C, und die Nachlauf-Zaehlung zeichnete
      // ihr a-b-c fast deckungsgleich daneben.)
      if (startPunkt && to - startPunkt.idx >= 4) {
        const impuls = !!elliott.neuerZyklus;
        const runter = elliott.neuerZyklus ? !(elliott.grossTop && elliott.grossTop.corrDown) : elliott.dir === 'up'; // Richtung der NEUEN Bewegung (gegen den Impuls)
        const auf2 = runter ? -1 : 1;
        const Lg = v => (useLog ? Math.log(v) : v), Eg = v => (useLog ? Math.exp(v) : v);
        // Schwelle relativ zur Spanne des Abschnitts selbst (20 % davon, auf der Log-Skala): so
        // zaehlen die grossen Schwuenge, nicht jedes Zittern -- unabhaengig vom Zeitraum.
        let segHi = -Infinity, segLo = Infinity;
        for (let i = startPunkt.idx; i <= to; i++) { const d = data[i]; if (!d) continue; const h = d.high != null ? d.high : d.value, l = d.low != null ? d.low : d.value; if (h > segHi) segHi = h; if (l < segLo) segLo = l; }
        const spanneLog = segLo > 0 && segHi > segLo ? Math.log(segHi / segLo) : 0.3;
        const pct = Math.max(0.06, Math.min(0.35, Math.exp(0.2 * spanneLog) - 1, Math.max(0.06, (atrPct || 0.05) * 4)));
        // FEHLAUSBRUCH (DOCHT) NICHT ALS WELLE ZAEHLEN (gemeldet: "dort nicht als Welle beachten,
        // koennte ein Fake-Out gewesen sein" -- Wochenchart: ein einzelner Docht auf 0,631 bei
        // Schluss 0,457 wurde zu Welle i, Welle iii wirkte dadurch zu kurz). Fuer diese Zaehlung
        // werden Kerzen, deren Hoch bzw. Tief nur aus EINEM Docht besteht (Docht > 60 % der Kerze,
        // Nachbarkerzen erreichen nicht einmal dessen Mitte), auf ihren Koerper gekuerzt -- vor der
        // Suche nach Wendepunkten, damit der Docht keinen Schwung "erfindet".
        const datenOhneDocht = data.map((d, i) => {
          if (!d || d.open == null || d.high == null || d.low == null || i < startPunkt.idx) return d;
          const sp = d.high - d.low; if (!(sp > 0)) return d;
          const kOben = Math.max(d.open, d.close), kUnten = Math.min(d.open, d.close);
          const nb = [data[i - 1], data[i + 1]].filter(Boolean);
          let h = d.high, l = d.low;
          if (d.high - kOben > 0.6 * sp && nb.length && nb.every(x => x.high < kOben + (d.high - kOben) * 0.5)) h = kOben;
          if (kUnten - d.low > 0.6 * sp && nb.length && nb.every(x => x.low > kUnten - (kUnten - d.low) * 0.5)) l = kUnten;
          return h === d.high && l === d.low ? d : { ...d, high: h, low: l };
        });
        const zz = zigzag(datenOhneDocht, startPunkt.idx, to, pct);
        const piv = (zz && zz.pivots ? zz.pivots : []).filter(q => q.idx > startPunkt.idx);
        if (zz && zz.pending && zz.pending.idx > startPunkt.idx) piv.push({ ...zz.pending, laufend: true });
        const hT = auf2 > 0 ? 'H' : 'L', tT = auf2 > 0 ? 'L' : 'H';
        const ueber = (x, y) => (auf2 > 0 ? x > y : x < y);
        const folgeP = [];
        for (const q of piv.sort((x, y) => x.idx - y.idx)) {
          const erw = folgeP.length % 2 === 0 ? hT : tT;
          if (q.type === erw) folgeP.push(q);
          else if (folgeP.length && q.type === folgeP[folgeP.length - 1].type) {
            const l = folgeP[folgeP.length - 1];
            if (q.type === hT ? ueber(q.price, l.price) : ueber(l.price, q.price)) folgeP[folgeP.length - 1] = q;
          }
        }
        const labs = impuls ? ['i', 'ii', 'iii', 'iv', 'v'] : ['a', 'b', 'c'];
        const pts = [];
        for (let k = 0; k < folgeP.length && k < labs.length; k++) {
          const q = folgeP[k];
          if (impuls) {
            if (k === 1 && !ueber(q.price, startPunkt.price)) break;
            if ((k === 2 || k === 3) && !ueber(q.price, pts[0].price)) break;
            if (k === 4 && !ueber(q.price, pts[2].price)) break;
          } else {
            const p5price = startPunkt.price;
            if (k === 1 && !ueber(q.price, p5price)) break;            // b nicht ueber 5 hinaus
            if (k === 2 && !ueber(q.price, pts[0].price)) break;       // c jenseits von a
          }
          pts.push({ ...q, label: labs[k] }); // ohne "?" (auf Wunsch)
          if (q.laufend) break;
        }
        // LETZTE WELLE BIS ZU IHREM ECHTEN ENDE VERLAENGERN (gemeldet: "dieses kleine abc ist
        // falsch" -- c sass auf einer Zwischenspitze, danach lief der Kurs noch hoeher). Eine c-
        // bzw. v-Welle besteht selbst aus Teilwellen; ein Ruecksetzer darin ist kein neues
        // Ereignis, solange er die vorige Welle (b bzw. iv) nicht unterschreitet. Das Ende ist
        // deshalb das aeusserste Extrem in Wellenrichtung, bis eine Gegenbewegung unter b/iv
        // faellt.
        if (pts.length >= 3 && pts.length === labs.length) {
          const li = pts.length - 1, vorLetzt = pts[li - 1];
          const startIdx = folgeP.findIndex(q => q.idx === pts[li].idx);
          let best = pts[li];
          for (let k2 = startIdx + 1; k2 < folgeP.length; k2++) {
            const q = folgeP[k2];
            if (q.type !== hT && !ueber(q.price, vorLetzt.price)) break; // Gegenbewegung unter b/iv
            if (q.type === hT && ueber(q.price, best.price)) best = q;
          }
          if (best !== pts[li]) pts[li] = { ...best, label: labs[li] };
        }
        if (pts.length) {
          const lI = Lg(pts[0].price) - Lg(startPunkt.price);
          const dI = Math.max(2, pts[0].idx - startPunkt.idx);
          const fertig = pts.filter(q => !q.laufend);
          let ziel = null;
          if (impuls) {
            // BODEN FUER WELLE ii (gefragt: "wo waere der Boden fuer Welle 2?"): Rueckholung von i,
            // ueblich 50-61,8 %, hoechstens bis kurz vor den Start (78,6 %). Ziel = 61,8 %.
            if (fertig.length === 1) {
              const lI1 = Lg(fertig[0].price) - Lg(startPunkt.price);
              const stufe = r => Eg(Lg(fertig[0].price) - r * lI1);
              ziel = { label: 'ii', price: stufe(0.618), dBars: Math.round(dI * 0.6), stufen: [0.5, 0.618, 0.786].map(r => ({ r, price: stufe(r) })) };
              // Und wohin iii danach liefe (gewuenscht: "ich will sehen, wo Welle 3 enden koennte"):
              // 1,618 x i ab dem Ziel von ii, dazu 1 x und 2,618 x als Spanne.
              const ab = Lg(ziel.price);
              ziel.danach = { label: 'iii', price: Eg(ab + 1.618 * lI1), dBars: Math.round(dI * 1.6), spanne: [1, 2.618].map(r => ({ r, price: Eg(ab + r * lI1) })) };
            } else if (fertig.length === 2) ziel = { label: 'iii', price: Eg(Lg(fertig[1].price) + 1.618 * lI), dBars: Math.round(dI * 1.6) };
            else if (fertig.length === 3) ziel = { label: 'iv', price: Eg(Lg(fertig[2].price) - 0.382 * (Lg(fertig[2].price) - Lg(fertig[1].price))), dBars: Math.round(dI * 0.6) };
            else if (fertig.length === 4) ziel = { label: 'v', price: Eg(Lg(fertig[3].price) + lI), dBars: dI };
          } else if (fertig.length === 2) ziel = { label: 'c', price: Eg(Lg(fertig[1].price) + lI), dBars: dI };
          // ERREICHT? (gemeldet: "warum c bei $0.72, obwohl wir schon drunter sind?") -- Ziel der
          // laufenden Welle mit dem bisherigen Extrem seit dem letzten fertigen Punkt vergleichen.
          // Wellenrichtung der Zielwelle: c/iii/v laufen wie a/i (Index gerade), iv wie ii.
          if (ziel && ziel.price > 0) {
            const lzt = fertig[fertig.length - 1];
            const zielAuf = (fertig.length % 2 === 0) ? auf2 > 0 : auf2 < 0;
            let ex = null;
            for (let i = lzt.idx + 1; i <= to; i++) { const d = data[i]; if (!d) continue; const v = zielAuf ? (d.high != null ? d.high : d.value) : (d.low != null ? d.low : d.value); if (ex == null || (zielAuf ? v > ex : v < ex)) ex = v; }
            ziel.erreicht = ex != null && (zielAuf ? ex >= ziel.price : ex <= ziel.price);
          }
          elliott.nachlauf = { points: pts, start: startPunkt, ziel: ziel && ziel.price > 0 ? ziel : null, art: impuls ? 'impuls' : 'korrektur' };
          // EINE ZAEHLUNG, NICHT ZWEI (gemeldet: "es ueberlappen sich immer noch Wellenzaehlungen"):
          // Die Nachlauf-Zaehlung ist die genauere (Dochtfilter, Regeln, Ziele) -- die einfache
          // 1-2-Lesart von oben entfaellt dann.
          // Gleiches gilt fuer die Unterwellen-Suche, wenn sie denselben Abschnitt zaehlt (Monatschart:
          // i-ii doppelt).
          if (elliott.sub && (elliott.sub.neuerImpuls || (elliott.sub.points || []).some(q => q.idx >= startPunkt.idx))) delete elliott.sub;
          // Eine zweite Projektion (das grosse A-B-C der Engine) widerspraeche der gezaehlten
          // Bewegung -- es gilt die Nachlauf-Zaehlung mit ihrem eigenen Ziel.
          elliott.projection = [];
        }
      }
    } catch (e) { /* Zusatz -- ohne ihn bleibt alles wie vorher */ }
    fibs.confluence = fibConfluence(fibs, sr, tolLog);
    const fib = fibs.swing || fibs.major; // Rueckwaertskompatibel: "das" aktuelle Fib
    let score = scoreAll(trend, sr, elliott, fib, indicators, lastClose);
    if (elliott && elliott.scenarios && elliott.scenarios.length) {
      // Korrekturen: groesserer Grad (passend -> Hauptszenario +8, sonst -8), Indikatoren
      // (Bull-Anteil verschiebt bis zu +/-10 in Richtung), S/R-Zone nahe dem Ziel des
      // "laeuft darueber hinaus"-Szenarios (-5). Danach auf 100 normiert.
      const sc = elliott.scenarios;
      const par = elliott.parent;
      const tilt = Math.max(-10, Math.min(10, Math.round((score.bullPct - 50) / 5)));
      for (const x of sc) {
        if (par) x.prob += (x.key === 'scenContinue' || x.key === 'scenCDone' || x.key === 'scenNext' || x.key === 'scenResume' || x.key === 'scenNewImpulse' || x.key === 'scenCorrection') ? (par.consistent ? 8 : -8) : (par.consistent ? -4 : 4);
        x.prob += x.dir === 'up' ? tilt : -tilt;
        if (x.key === 'scenExtend' && x.target) {
          const near = [...sr.supports, ...sr.resistances].some(z => Math.abs(ln(z.price) - ln(x.target)) < 0.03);
          if (near) x.prob -= 5;
        }
        x.prob = Math.max(5, x.prob);
      }
      const sum = sc.reduce((a, x) => a + x.prob, 0) || 1;
      let acc = 0;
      sc.forEach((x, i) => { x.prob = i === sc.length - 1 ? 100 - acc : Math.round(x.prob / sum * 100); acc += x.prob; });
    }
    // KLEINE ZEITRAEUME BESTAETIGEN DIE GROSSEN (gefordert: "die kleineren Zeitraeume muessen dem
    // groesseren entsprechen und ihn bestaetigen, nicht das andere behaupten"). Bei 4H/1H usw.
    // reicht die eigene Kurshistorie (wenige Monate) nicht fuer das grosse Bild -- der 4H-Chart
    // zaehlte deshalb winzige Schwuenge direkt nach dem Tief als 1-2-3-4-5. Jetzt liefert die App
    // die Zaehlung des WOCHENCHARTS mit (kontextExtern: Punkte mit Datum). Die Punkte werden auf
    // die Kerzen dieses Zeitraums gelegt (Extrem innerhalb der jeweiligen Woche), und die feine
    // Zaehlung laeuft nur noch INNERHALB der aktuellen grossen Welle (z. B. a-b-c von Welle 2).
    try {
      const kx = kontextExtern;
      if (kx && Array.isArray(kx.punkte) && kx.punkte.length && elliott) {
        const T = i => Number(data[i] && (data[i].date != null ? data[i].date : data[i].time));
        const hiOf = d => (d.high != null ? d.high : d.value), loOf = d => (d.low != null ? d.low : d.value);
        // Echte Kerzen (nicht dochtgefiltert): Der Wochenchart hat das Extrem bereits geprueft.
        const roh = rohDaten && rohDaten.length === data.length ? rohDaten : data;
        const finde = (pkt, oben) => {
          let best = null;
          for (let i = 0; i <= to; i++) {
            // Kerze ueberschneidet die Woche (auch Monatskerzen, die laenger als eine Woche sind).
            const t0 = T(i), t1 = i + 1 < data.length ? T(i + 1) : t0 + (i > 0 ? t0 - T(i - 1) : 86400e3);
            if (!(t0 < pkt.bis && t1 > pkt.von)) continue;
            const v = oben ? hiOf(roh[i]) : loOf(roh[i]);
            if (v > 0 && (!best || (oben ? v > best.price : v < best.price))) best = { idx: i, price: v };
          }
          return best;
        };
        const auf = kx.punkte[0].price > kx.start.price;
        const start = finde(kx.start, !auf);
        const gelegtAlle = kx.punkte.map((q, k) => { const oben = (k % 2 === 0) === auf; const f = finde(q, oben); return f ? { ...f, type: oben ? 'H' : 'L', label: q.label, pending: !!q.laeuft } : null; });
        // KURZE HISTORIE (getestet: 4H-Charts reichen nur ~16 Monate zurueck, der Wochen-Rahmen beginnt
        // 2024): Punkte VOR dem ersten Kursdatum fehlen hier einfach -- die spaeteren werden trotzdem
        // gelegt, solange alle ab dem ersten gefundenen Punkt da sind.
        const ersterDa = gelegtAlle.findIndex(Boolean);
        const datenStart = T(0);
        const vorDaten = ersterDa > 0 && gelegtAlle.slice(0, ersterDa).every((g, k) => !g && kx.punkte[k].bis <= datenStart + 7 * 86400e3);
        const gelegt = vorDaten ? gelegtAlle.slice(ersterDa) : gelegtAlle;
        if (!(gelegt.length && gelegt.every(Boolean))) elliott.kontextFehler = 'Punkte des Wochencharts nicht in diesen Kerzen gefunden (' + gelegt.filter(Boolean).length + '/' + gelegt.length + ')';
        // Auch wenn der letzte grosse Punkt VOR dem Ausschnitt liegt (z. B. SOL: Welle 3 im Mai, der
        // Ausschnitt zeigt nur die laufende Welle 4) -- der Rahmen gilt trotzdem.
        if (gelegt.length && gelegt.every(Boolean)) {
          // Laufende letzte Welle: ihr Extrem bis JETZT in diesem Zeitraum
          const letzt = gelegt[gelegt.length - 1];
          if (letzt.pending) {
            const oben = letzt.type === 'H';
            const vorher = gelegt[gelegt.length - 2] || start;
            for (let i = (vorher ? vorher.idx + 1 : 0); i <= to; i++) { const v = oben ? hiOf(data[i]) : loOf(data[i]); if (v > 0 && (oben ? v > letzt.price : v < letzt.price)) { letzt.idx = i; letzt.price = v; } }
          }
          const pts = [...(start && !vorDaten ? [{ ...start, type: auf ? 'L' : 'H', label: '0', pending: false }] : []), ...gelegt];
          const korrektur = kx.art === 'korrektur' || gelegt.some(q => /^[A-E]$/.test(String(q.label)));
          elliott.kind = korrektur ? 'correction' : 'impulse'; elliott.dir = auf ? 'up' : 'down';
          elliott.points = pts;
          elliott.phase = kx.phase || ('wave' + gelegt.length);
          elliott.projection = (kx.projektion || []).map((q, k) => ({ label: q.label, price: q.price, dIdx: Math.max(3, Math.round((q.tage || 14) * (kx.balkenJeTag || 1))) }));
          // Ungueltigkeit nach dem Start der Struktur -- auch wenn er vor den Kursdaten liegt.
          const startPreis = start ? start.price : kx.start && kx.start.price;
          if (startPreis > 0) elliott.invalidation = { price: startPreis, below: auf, ruleKey: korrektur ? 'proInvCorrStart' : gelegt.length >= 2 ? 'proInvRule1' : 'proInvNewImpulse' };
          elliott.kontextZaehlung = true; elliott.kontextQuelle = kx.quelle || 'W';
          delete elliott.nachlauf; delete elliott.parent;
          // NACH FERTIGEM 5er: DIE KORREKTUR DANACH ZAEHLEN (gemeldet bei RUNE/BTC: Wochen-Rahmen "0-5
          // fertig", danach zeigte der Chart nur ein loses a-b-c und ein Ziel fuer eine laengst fertige
          // Welle 5). Seit dem Ende von 5 ist der Kurs in Gegenrichtung gelaufen = Welle A; laeuft er
          // seit dem Extrem von A wieder mindestens 23,6 % zurueck = Welle B (laufend). Ziele:
          // B = 50/61,8 % von A, danach C = 1 x A ab B.
          try {
            const p5 = elliott.points[elliott.points.length - 1];
            if (p5 && String(p5.label) === '5' && !p5.pending && elliott.kind === 'impulse') {
              const Lg = v => (useLog ? Math.log(v) : v), Eg = v => (useLog ? Math.exp(v) : v);
              const korrAuf = p5.type === 'L';   // nach Abwaerts-Impuls laeuft die Korrektur aufwaerts
              let aP = null;
              for (let i = p5.idx + 1; i <= to; i++) { const d = data[i]; if (!d) continue; const v = korrAuf ? hiOf(roh[i]) : loOf(roh[i]); if (v > 0 && (!aP || (korrAuf ? v > aP.price : v < aP.price))) aP = { idx: i, price: v }; }
              if (aP) {
                const lenA = Math.abs(Lg(aP.price) - Lg(p5.price));
                let bP = null;
                for (let i = aP.idx + 1; i <= to; i++) { const d = data[i]; if (!d) continue; const v = korrAuf ? loOf(roh[i]) : hiOf(roh[i]); if (v > 0 && (!bP || (korrAuf ? v < bP.price : v > bP.price))) bP = { idx: i, price: v }; }
                const bRueck = bP && lenA > 0 ? Math.abs(Lg(aP.price) - Lg(bP.price)) / lenA : 0;
                // Start der Struktur, auch wenn er vor den Kursdaten liegt (kurze 4H-Historie).
                const p0i = elliott.points.find(q => q.label === '0') || (kx.start && kx.start.price > 0 ? { price: kx.start.price } : null);
                const gesamt = p0i ? Math.abs(Lg(p5.price) - Lg(p0i.price)) : 0;
                // A-B-C SCHON IN DER BEWEGUNG SEIT 5? (gemeldet: "ABC ist schon gebildet, finde ich" --
                // RUNE 4H: nach 5 erst ein Tief, ein Ruecksetzer nach oben, dann ein tieferes Tief. Gezaehlt
                // wurde das tiefere Tief als A und der jetzige Anstieg als B.) Gesucht wird im Abschnitt
                // 5 -> Extrem ein Zwischen-Tief (a) mit Gegenbewegung (b), die
                //   - mindestens 23,6 % von a zurueckholt und nicht ueber 5 hinaus laeuft,
                //   - von einem neuen Extrem jenseits von a abgeloest wird (c),
                //   - mit c mindestens 61,8 % so lang wie a (sonst ist es nur ein Zittern in a),
                //   - und a mindestens 30 % der ganzen Strecke 5 -> Extrem ausmacht.
                // Gibt es mehrere, gilt die mit der kraeftigsten Gegenbewegung. Dann ist die Korrektur
                // A-B-C fertig, wenn der Kurs seit dem Extrem schon wieder 23,6 % der Korrektur holt.
                let abc = null;
                try {
                  const ges = Math.abs(Lg(aP.price) - Lg(p5.price));
                  let lauf = null;
                  for (let i = p5.idx + 1; i < aP.idx; i++) {
                    const d = roh[i]; if (!d) continue;
                    const ext = korrAuf ? hiOf(d) : loOf(d), geg = korrAuf ? loOf(d) : hiOf(d);
                    if (ext > 0 && (!lauf || (korrAuf ? ext > lauf.price : ext < lauf.price))) lauf = { idx: i, price: ext };
                    if (!lauf || !(geg > 0) || i <= lauf.idx + 1) continue;
                    const lA = Math.abs(Lg(lauf.price) - Lg(p5.price));
                    if (!(lA > 0) || lA < 0.3 * ges) continue;
                    if (korrAuf ? geg <= p5.price : geg >= p5.price) continue; // b nicht ueber 5 hinaus
                    const rueck = Math.abs(Lg(lauf.price) - Lg(geg)) / lA;
                    const lC = Math.abs(Lg(aP.price) - Lg(geg));
                    if (rueck >= 0.236 && rueck < 1 && lC >= 0.618 * lA && (!abc || rueck > abc.rueck))
                      abc = { a: { ...lauf }, b: { idx: i, price: geg }, rueck };
                  }
                } catch (x) { abc = null; }
                if (abc && lenA > 0 && gesamt > 0) {
                  const lenK = Math.abs(Lg(aP.price) - Lg(p5.price));
                  const seitC = bP ? Math.abs(Lg(bP.price) - Lg(aP.price)) / lenK : 0;
                  const cFertig = seitC >= 0.236;
                  elliott.points.push({ idx: abc.a.idx, price: abc.a.price, type: korrAuf ? 'H' : 'L', label: 'A', pending: false });
                  elliott.points.push({ idx: abc.b.idx, price: abc.b.price, type: korrAuf ? 'L' : 'H', label: 'B', pending: false });
                  elliott.points.push({ idx: aP.idx, price: aP.price, type: korrAuf ? 'H' : 'L', label: 'C', pending: !cFertig });
                  elliott.kind = 'correction'; elliott.dir = korrAuf ? 'up' : 'down';
                  const dk = korrAuf ? 1 : -1;
                  if (cFertig) {
                    // Korrektur fertig: neuer Impuls in Richtung der alten Welle 1-5. Erste Marke = 38,2 %
                    // der Korrektur zurueck (typisches Ende einer ersten Welle), dann 61,8 %.
                    elliott.phase = 'corrDone';
                    // Naechste noch NICHT erreichte Stufe (38,2 / 50 / 61,8 / 78,6 % der Korrektur zurueck).
                    const z1 = [0.382, 0.5, 0.618, 0.786].map(f => Eg(Lg(aP.price) - dk * lenK * f)).find(z => (korrAuf ? z < bP.price : z > bP.price));
                    elliott.projection = z1 ? [{ label: '1', price: z1, dIdx: 8 }] : [];
                    elliott.invalidation = { price: aP.price, below: !korrAuf, ruleKey: 'proInvNewImpulse' };
                  } else {
                    elliott.phase = 'waveC';
                    elliott.projection = [{ label: 'C', price: Eg(Lg(abc.b.price) + dk * Math.abs(Lg(abc.a.price) - Lg(p5.price))), dIdx: 8 }];
                    elliott.invalidation = { price: p5.price, below: korrAuf, ruleKey: 'proInvCorrStart' };
                  }
                  kx.phase = elliott.phase;
                } else if (lenA > 0 && gesamt > 0 && lenA >= 0.05 * gesamt) {
                  const aLaeuft = !(bP && bRueck >= 0.236);
                  elliott.points.push({ idx: aP.idx, price: aP.price, type: korrAuf ? 'H' : 'L', label: 'A', pending: aLaeuft });
                  if (!aLaeuft) elliott.points.push({ idx: bP.idx, price: bP.price, type: korrAuf ? 'L' : 'H', label: 'B', pending: true });
                  elliott.kind = 'correction'; elliott.dir = korrAuf ? 'up' : 'down';
                  const dk = korrAuf ? 1 : -1;
                  if (aLaeuft) {
                    elliott.phase = 'waveA';
                    // Naechste noch nicht erreichte Stufe: 23,6 / 38,2 / 50 / 61,8 % der ganzen Abwaertswelle.
                    const zA = [0.236, 0.382, 0.5, 0.618].map(f => Eg(Lg(p5.price) + dk * gesamt * f)).find(z => (korrAuf ? z > aP.price : z < aP.price));
                    elliott.projection = zA ? [{ label: 'A', price: zA, dIdx: 6 }] : [];
                  } else {
                    elliott.phase = 'waveB';
                    const zB = Eg(Lg(aP.price) - dk * lenA * (bRueck >= 0.5 ? 0.618 : 0.5));
                    elliott.projection = [{ label: 'B', price: zB, dIdx: 6 }, { label: 'C', price: Eg(Lg(zB) + dk * lenA), dIdx: 20 }];
                  }
                  elliott.invalidation = { price: p5.price, below: korrAuf, ruleKey: 'proInvCorrStart' };
                  kx.phase = elliott.phase;
                }
              }
            }
          } catch (e) {}
          // LAUFENDE TREIBENDE WELLE SCHON FERTIG? (gemeldet bei RUNE/BTC: "warum 2x Welle 5?" -- Welle 5
          // stand am Tief vom Juni UND als Ziel weit darunter, obwohl der Kurs seither ~60 % gestiegen
          // war). Hat der Kurs seit dem Extrem einer laufenden Welle 1/3/5/A/C mindestens 38,2 % dieser
          // Welle zurueckgeholt, gilt sie als fertig: Punkt fest, ihr Ziel faellt weg, die Feinzaehlung
          // beschreibt ab dort die naechste Welle (nach 5 die Korrektur A, nach C ein neuer Impuls).
          try {
            const lp = elliott.points[elliott.points.length - 1], vp = elliott.points[elliott.points.length - 2];
            if (lp && vp && lp.pending && ['1', '3', '5', 'A', 'C'].includes(String(lp.label))) {
              const Lg = v => (useLog ? Math.log(v) : v);
              const lenW = Math.abs(Lg(lp.price) - Lg(vp.price));
              const zur = Math.abs(Lg(lastClose) - Lg(lp.price));
              const gegenRichtung = lp.type === 'H' ? lastClose < lp.price : lastClose > lp.price;
              if (lenW > 0 && gegenRichtung && zur >= 0.382 * lenW) {
                lp.pending = false;
                elliott.projection = (elliott.projection || []).filter(q => String(q.label) !== String(lp.label));
                const folge = { '1': 'wave2', '3': 'wave4', '5': 'waveA', 'A': 'waveB', 'C': 'wave1' }[String(lp.label)];
                elliott.phase = folge === 'waveA' ? 'impulseDone' : folge === 'wave1' ? 'corrDone' : folge;
                kx.phase = folge;
                // Projektion fuer die Folgewelle, wenn keine mehr da ist: Ruecklauf 38,2/50/61,8 % von
                // 0 bis 5 (nach Impuls) bzw. von der ganzen Korrektur (nach C) -- Ziel 50 %.
                if (!elliott.projection.length) {
                  const p0 = elliott.points.find(q => q.label === '0') || elliott.points[0];
                  const gesamt = Math.abs(Lg(lp.price) - Lg(p0.price));
                  const d = lp.type === 'H' ? -1 : 1;
                  const Eg = v => (useLog ? Math.exp(v) : v);
                  if (folge === 'waveA' || folge === 'wave1') elliott.projection = [{ label: folge === 'waveA' ? 'A' : '1', price: Eg(Lg(lp.price) + d * gesamt * (folge === 'waveA' ? 0.236 : 0.382)), dIdx: 6 }];
                  else if (folge === 'wave2' || folge === 'wave4') elliott.projection = [{ label: folge === 'wave2' ? '2' : '4', price: Eg(Lg(lp.price) + d * lenW * (folge === 'wave2' ? 0.618 : 0.382)), dIdx: 6 }];
                }
                if (folge === 'waveA') elliott.invalidation = { price: lp.price, below: lp.type === 'L', ruleKey: 'proInvBeyondEnd' };
              }
            }
          } catch (e) {}
          // FEINE ZAEHLUNG NUR INNERHALB DER LAUFENDEN GROSSEN WELLE
          delete elliott.sub;
          const anker = [...pts].reverse().find(q => !q.pending) || null;
          if (anker) {
            // EIGENE WENDEPUNKTE AB DEM ANKER (getestet: lag der Anker vor dem Ausschnitt, fehlten die
            // feinen Wendepunkte zwischen Anker und Ausschnitt -- die Feinzaehlung wurde unsinnig).
            // Schwelle passend zur Groesse der laufenden Welle.
            let fein = fineCtx.pivots.filter(q => q.idx >= anker.idx), pend = fineCtx.pending && fineCtx.pending.idx > anker.idx ? fineCtx.pending : null;
            // IMMER so (nicht nur wenn der Anker vor dem Ausschnitt liegt): sonst zaehlte jede Zoomstufe
            // die Teilwellen anders, weil die Wendepunkt-Schwelle vom Ausschnitt abhing.
            if (true) {
              let mx = -Infinity, mn = Infinity;
              for (let i = anker.idx; i <= to; i++) { const d = data[i]; if (!d) continue; mx = Math.max(mx, hiOf(d)); mn = Math.min(mn, loOf(d)); }
              const span = mx > 0 && mn > 0 ? Math.log(mx / mn) : 0;
              const pct = Math.min(0.25, Math.max(0.03, Math.exp(span / 6) - 1));
              try { const zz = zigzag(data, anker.idx, to, pct); fein = (zz.pivots || []).filter(q => q.idx >= anker.idx); pend = zz.pending && zz.pending.idx > anker.idx ? zz.pending : null; } catch (e) {}
            }
            const set = { pivots: fein, pending: pend };
            // KORREKTIVE WELLE (2, 4, B) -> gezielt als a-b-c zaehlen (getestet: die allgemeine Suche
            // lieferte fuer Welle 2 "a-b-c-d-e", ein Dreieck -- das gibt es in Welle 2 nicht).
            // c = Extrem seit dem Anker, b = staerkste Gegenbewegung davor (mind. 23,6 % von a),
            // a = Extrem zwischen Anker und b.
            const naechsteW = String(kx.phase || '').replace('wave', '');
            if (['2', '4', 'B'].includes(naechsteW)) {
              const ab = anker.type === 'H';   // Korrektur abwaerts nach einem Hoch
              const alle = [...fein, ...(pend ? [pend] : [])];
              const tiefOf = i => (ab ? loOf(data[i]) : hiOf(data[i]));
              let cI = null;
              for (let i = anker.idx + 1; i <= to; i++) { const v = tiefOf(i); if (v > 0 && (cI == null || (ab ? v < tiefOf(cI) : v > tiefOf(cI)))) cI = i; }
              let best = null;
              if (cI != null) for (const h of alle) {
                if (h.idx <= anker.idx || h.idx >= cI || h.type !== (ab ? 'H' : 'L')) continue;
                let aI = null; for (let i = anker.idx + 1; i < h.idx; i++) { const v = tiefOf(i); if (v > 0 && (aI == null || (ab ? v < tiefOf(aI) : v > tiefOf(aI)))) aI = i; }
                if (aI == null) continue;
                const Lg = v => (useLog ? Math.log(v) : v);
                const lenA = Math.abs(Lg(anker.price) - Lg(tiefOf(aI)));
                const ret = lenA > 0 ? Math.abs(Lg(h.price) - Lg(tiefOf(aI))) / lenA : 0;
                if (ret >= 0.236 && ret < 1 && (!best || ret > best.ret)) best = { aI, h, ret };
              }
              if (best) {
                const cLaeuft = cI >= to - 2;
                const pts3 = [
                  { idx: best.aI, price: tiefOf(best.aI), type: ab ? 'L' : 'H', label: 'a', pending: false },
                  { idx: best.h.idx, price: best.h.price, type: ab ? 'H' : 'L', label: 'b', pending: false },
                  { idx: cI, price: tiefOf(cI), type: ab ? 'L' : 'H', label: 'c', pending: cLaeuft },
                ];
                elliott.sub = { kind: 'correction', dir: ab ? 'down' : 'up', phase: cLaeuft ? 'waveC' : 'corrDone', confidence: 0.5, imKontext: true, anchorLabel: anker.label, points: pts3 };
                const lz0 = elliott.points[elliott.points.length - 1];
                if (lz0 && lz0.pending) elliott.points = elliott.points.slice(0, -1);
              }
            }
            if (!elliott.sub && fein.length + (set.pending ? 1 : 0) >= 3) {
              const sub = detectElliott(set, lastClose, to, useLog, volumes);
              if (sub && sub.points && sub.points.length >= 3) {
                // Laeuft eine KORREKTIVE grosse Welle (2, 4, B), wird ihre Feinzaehlung als a-b-c
                // beschriftet (getestet: dieselbe Welle 2 hiess mal i-ii, mal a-b-c). Nur in
                // treibenden Wellen (1, 3, 5, A, C) heissen die Teile i-ii-iii-iv-v.
                const naechste = String(kx.phase || '').replace('wave', '');
                const korrektiv = ['2', '4', 'B', 'b'].includes(naechste);
                // In TREIBENDEN Wellen auch eine gefundene A-B-C-Folge als i-ii-iii beschriften (gemeldet:
                // "Warum abc?" -- RUNE/ETH Woche, Welle 3 lief, die Feinzaehlung zeigte a-b-c). Drei
                // Teilwellen am Anfang einer Welle 3 sind der Beginn ihrer fuenf Teile (i, ii, iii),
                // keine Korrektur: Die Richtung der grossen Welle legt fest, wie sie heissen.
                const map = korrektiv ? { '1': 'a', '2': 'b', '3': 'c', '4': 'd', '5': 'e', 'A': 'a', 'B': 'b', 'C': 'c' } : { '1': 'i', '2': 'ii', '3': 'iii', '4': 'iv', '5': 'v', 'A': 'i', 'B': 'ii', 'C': 'iii' };
                // Nur die erste vollstaendige Teil-Struktur: kein "i-v + a-b-c" in einer Welle.
                if (sub.points.filter(q => q.label !== '0').length > 5) sub.points = sub.points.slice(0, 6);
                const alsImpuls = !korrektiv && /^correct/.test(String(sub.kind || ''));
                elliott.sub = { kind: alsImpuls ? 'impulse' : sub.kind, dir: sub.dir, phase: alsImpuls ? 'wave3' : sub.phase, confidence: sub.confidence, imKontext: true, anchorLabel: anker.label,
                  points: sub.points.filter(q => q.label !== '0').map(q => ({ ...q, label: map[q.label] || q.label })) };
                // Die laufende grosse Welle wird jetzt von a-b-c (bzw. i-v) beschrieben -- ihr
                // vorlaeufiger Endpunkt wuerde sonst auf "a" liegen (Ueberlappung). Ihr Ziel bleibt
                // in der Projektion.
                const lz = elliott.points[elliott.points.length - 1];
                if (lz && lz.pending) elliott.points = elliott.points.slice(0, -1);
              }
            }
          }
        }
      }
    } catch (e) {}
    // REGEL "Welle 4 nie unter das Ende von Welle 1" auch OHNE Feinzaehlung (getestet: Monatschart
    // RUNE/SOL hat zu wenige Kerzen fuer eine a-b-c-Suche und zeigte sonst weiter Welle 4).
    try {
      if (kontextExtern && elliott && elliott.kontextZaehlung && elliott.kind === 'impulse' && String(elliott.phase) === 'wave4') {
        const auf = elliott.dir === 'up';
        const p1 = elliott.points.find(q => q.label === '1'), p3 = elliott.points.find(q => q.label === '3');
        if (p1 && p3) {
          let ext = null;
          for (let i = p3.idx + 1; i <= to; i++) { const d = data[i]; if (!d) continue; const v = auf ? (d.low != null ? d.low : d.value) : (d.high != null ? d.high : d.value); if (v > 0 && (!ext || (auf ? v < ext.price : v > ext.price))) ext = { idx: i, price: v }; }
          if (ext && (auf ? ext.price < p1.price : ext.price > p1.price)) {
            elliott.points = elliott.points.filter(q => q.label === '0' || q.label === '3').map(q => q.label === '3' ? { ...q, label: '1', pending: false } : q);
            elliott.points.push({ idx: ext.idx, price: ext.price, type: auf ? 'L' : 'H', label: '2', pending: true });
            elliott.phase = 'wave2'; elliott.umbenannt = true;
            delete elliott.sub;   // die a-b-c gehoerte zur verworfenen "Welle 4"
            const L = (a, b) => Math.abs(useLog ? Math.log(b) - Math.log(a) : b - a);
            const p0 = elliott.points.find(q => q.label === '0');
            const w1 = p0 ? L(p0.price, p3.price) : 0;
            const mv = (v, f) => useLog ? v * Math.exp((auf ? 1 : -1) * w1 * f) : v + (auf ? 1 : -1) * w1 * f;
            // Laeuft der Kurs seit dem Tief schon ueber das neue "1"? Dann ist 2 fertig und 3 laeuft.
            let hoch = null;
            for (let i = ext.idx + 1; i <= to; i++) { const d = data[i]; if (!d) continue; const v = auf ? (d.high != null ? d.high : d.value) : (d.low != null ? d.low : d.value); if (v > 0 && (!hoch || (auf ? v > hoch.price : v < hoch.price))) hoch = { idx: i, price: v }; }
            if (hoch && (auf ? hoch.price > p3.price : hoch.price < p3.price)) {
              elliott.points[elliott.points.length - 1].pending = false;
              elliott.points.push({ idx: hoch.idx, price: hoch.price, type: auf ? 'H' : 'L', label: '3', pending: true });
              elliott.phase = 'wave3';
              const z = [1.618, 2.618, 4.236].map(f => mv(ext.price, f)).find(v => (auf ? v > hoch.price : v < hoch.price));
              elliott.projection = z ? [{ label: '3', price: z, dIdx: 6 }] : [];
              elliott.invalidation = { price: ext.price, below: auf, ruleKey: 'proInvRule1' };
            } else {
              elliott.projection = [{ label: '3', price: mv(ext.price, 1.618), dIdx: 8 }];
              elliott.invalidation = p0 ? { price: p0.price, below: auf, ruleKey: 'proInvRule1' } : elliott.invalidation;
            }
          }
        }
      }
    } catch (e) {}
    // (nach Fein-Zaehlung) Korrektur moeglicherweise schon fertig?
    try {
      const kx = kontextExtern;
      // Schon nach der Regel "Welle 4 nie unter Welle 1" umbenannt -> nicht noch einmal umdeuten.
      if (kx && elliott && elliott.kontextZaehlung && elliott.sub && elliott.sub.imKontext && !elliott.umbenannt) {
        const auf = elliott.dir === 'up';
                  // NACH a-b-c IST DIE KORREKTUR MOEGLICHERWEISE FERTIG (gefragt: "muesste nach abc nicht
                  // die Korrektur zu Ende sein?"): Zaehlt der kleine Zeitraum die laufende Welle 2 (bzw.
                  // 4) schon als FERTIGES a-b-c (oder als fertigen 5er-Abschwung = c), kann sie hier
                  // enden -- auch wenn sie flacher ist als ueblich. Dann:
                  //   - Welle 2 als moeglich fertig markieren (gestrichelt) am Ende von c,
                  //   - Projektion direkt zu Welle 3 (1,618 x Welle 1 ab dort),
                  //   - Bestaetigung: ueber b (Weiche "Welle 2 wohl fertig"),
                  //   - die tieferen Fib-Stufen bleiben als Alternative, mit geringerer Wahrscheinlichkeit.
                  const sub = elliott.sub; const gegen = sub.dir !== (auf ? 'up' : 'down');
                  const subFertig = gegen && ((sub.kind !== 'impulse' && sub.phase === 'corrDone') || (sub.kind === 'impulse' && sub.phase === 'impulseDone'));
                  let laufendeWelle = String(kx.phase || '').replace('wave', '');
                  if (subFertig && (laufendeWelle === '2' || laufendeWelle === '4')) {
                    const cEnde = elliott.sub.points[elliott.sub.points.length - 1];
                    // REGEL "Welle 4 nie unter das Ende von Welle 1" (getestet: RUNE/SOL und RUNE/XRP --
                    // die Korrektur nach "3" lief tief in den Bereich von Welle 1). Dann war die Zaehlung
                    // 0-1-2-3 so nicht richtig: der ganze Anstieg bis "3" ist Welle 1, die Korrektur
                    // ist Welle 2. Umbenennen statt eine regelwidrige Welle 4 zu zeigen.
                    const p1w0 = elliott.points.find(q => q.label === '1');
                    if (laufendeWelle === '4' && p1w0 && cEnde && (auf ? cEnde.price < p1w0.price : cEnde.price > p1w0.price)) {
                      const p3alt = elliott.points.find(q => q.label === '3');
                      if (p3alt) {
                        elliott.points = elliott.points.filter(q => q.label === '0' || q.label === '3').map(q => q.label === '3' ? { ...q, label: '1' } : q);
                        laufendeWelle = '2';
                        elliott.phase = 'wave2';
                        elliott.umbenannt = true;
                      }
                    }
                    const bPkt = elliott.sub.points.find(q => q.label === 'b') || elliott.sub.points[elliott.sub.points.length - 2];
                    const pA = elliott.points.find(q => q.label === '0'), pB = elliott.points.find(q => q.label === '1');
                    if (cEnde && pA && pB) {
                      const Lg = v => (useLog ? Math.log(v) : v), Eg = v => (useLog ? Math.exp(v) : v);
                      const w1 = Math.abs(Lg(pB.price) - Lg(pA.price));
                      const rueck = w1 > 0 ? Math.abs(Lg(pB.price) - Lg(cEnde.price)) / w1 : 0;
                      elliott.points.push({ idx: cEnde.idx, price: cEnde.price, type: auf ? 'L' : 'H', label: laufendeWelle, pending: true, moeglich: true });
                      // Welle 3: 1,618 x Welle 1. Welle 5: 1 x Welle 1, hoechstens 0,618 x (0 bis 3) --
                      // getestet: RUNE/BTC lieferte sonst ein Ziel um den Faktor 80 tiefer.
                      const p3w = elliott.points.find(q => q.label === '3');
                      const len5 = Math.min(w1, p3w ? 0.618 * Math.abs(Lg(p3w.price) - Lg(pA.price)) : w1);
                      const z3 = laufendeWelle === '2' ? Eg(Lg(cEnde.price) + (auf ? 1 : -1) * w1 * 1.618) : Eg(Lg(cEnde.price) + (auf ? 1 : -1) * len5);
                      const dauer1 = Math.max(4, pB.idx - pA.idx);
                      elliott.projection = [{ label: laufendeWelle === '2' ? '3' : '5', price: z3, dIdx: Math.round(dauer1 * 1.6) }];
                      // Wahrscheinlichkeit "jetzt fertig": je tiefer der Ruecklauf schon ist, desto eher.
                      elliott.welleFertigWkt = rueck >= 0.618 ? 60 : rueck >= 0.5 ? 50 : rueck >= 0.382 ? 40 : 25;
                      elliott.welleFertigRueck = rueck;
                      if (bPkt) elliott.weiche = { price: bPkt.price, below: !auf, key: 'proSwitchW2Done' };
                      // SCHON BESTAETIGT (getestet: RUNE/XRP -- Welle 4 endete im Juni, danach lief der Kurs
                      // laengst ueber das Hoch von Welle 3): Ist der Kurs seit c ueber den Start der
                      // Korrektur hinaus, ist die Welle FERTIG und die naechste laeuft. Dann: Punkt fest,
                      // naechste Welle laufend am Extrem seither, Projektion fuer diese Welle.
                      const startKorr = elliott.points.filter(q => !q.moeglich).slice(-1)[0];
                      let ext = null;
                      for (let i = cEnde.idx + 1; i <= to; i++) { const d = data[i]; if (!d) continue; const v = auf ? (d.high != null ? d.high : d.value) : (d.low != null ? d.low : d.value); if (v > 0 && (!ext || (auf ? v > ext.price : v < ext.price))) ext = { idx: i, price: v }; }
                      if (startKorr && ext && (auf ? ext.price > startKorr.price : ext.price < startKorr.price)) {
                        const mp = elliott.points.find(q => q.moeglich);
                        if (mp) { mp.pending = false; delete mp.moeglich; }
                        const naechste = laufendeWelle === '2' ? '3' : '5';
                        elliott.points.push({ idx: ext.idx, price: ext.price, type: auf ? 'H' : 'L', label: naechste, pending: true });
                        elliott.phase = 'wave' + naechste;
                        // Ziel: naechste noch NICHT erreichte Stufe (getestet: SOL/XRP -- Welle 5 war schon
                        // ueber 1 x und 1,618 x hinaus). Welle 3: 1,618 / 2,618 / 4,236 x Welle 1;
                        // Welle 5: 1 / 1,618 / 2,618 x Welle 1. Alles erreicht -> keine Projektion (Welle
                        // kann jederzeit enden).
                        const stufenN = naechste === '3' ? [1.618, 2.618, 4.236] : [1, 1.618, 2.618];
                        const zN = stufenN.map(f => Eg(Lg(cEnde.price) + (auf ? 1 : -1) * w1 * f)).find(z => (auf ? z > ext.price : z < ext.price));
                        elliott.projection = zN ? [{ label: naechste, price: zN, dIdx: Math.max(3, Math.round(dauer1 * 0.6)) }] : [];
                        delete elliott.welleFertigWkt; delete elliott.welleFertigRueck;
                        elliott.weiche = null;
                        elliott.invalidation = { price: cEnde.price, below: auf, ruleKey: 'proInvRule1' };
                        delete elliott.sub;
                      }
                    }

        }
      }
    } catch (e) {}
    // DAS GROSSE BILD GILT AUCH IM AUSSCHNITT (gemeldet: "im Wochen-/Monatschart ungenau, jede Welle
    // beachten" -- getestet mit echten Kursen: Voll-Ansicht D/W/M zaehlt einheitlich "Korrektur bis
    // $0,295 fertig, neuer Impuls i = $0,845, ii laeuft"; im herangezoomten Wochenchart wurde
    // derselbe Anstieg dagegen mal A-B, mal 0-A-B-C mit Ziel UNTER $0,30 gezaehlt, weil der
    // Ausschnitt die Vorgeschichte nicht kennt). Jetzt: Ist der Ausschnitt nicht der ganze Verlauf,
    // wird einmal (zwischengespeichert) der ganze Verlauf gezaehlt. Erkennt der einen neuen Impuls
    // nach fertiger Korrektur und liegt dessen Start im Ausschnitt, uebernimmt der Ausschnitt genau
    // diese Zaehlung (0 = Start, dann 1, 2 ...) samt Ziel und Ungueltigkeitsmarke.
    try {
      if (from > 0 && !analyze.__imKontext && elliott && !elliott.kontextZaehlung) {
        const key = [N, data[N - 1] && data[N - 1].date, data[N - 1] && data[N - 1].value, useLog, degreeMode].join('|');
        let ctx = RW_EW_KONTEXT.get(key);
        if (ctx === undefined) {
          analyze.__imKontext = true;
          try { ctx = analyze({ data: rohDaten, viewStart: 0, viewEnd: to, logScale, ma200Override, degreeMode, dochtFilter, kontextExtern: null }); } catch (e) { ctx = null; }
          analyze.__imKontext = false;
          if (RW_EW_KONTEXT.size > 20) RW_EW_KONTEXT.clear();
          RW_EW_KONTEXT.set(key, ctx || null);
        }
        const nl = ctx && ctx.elliott && ctx.elliott.nachlauf;
        if (nl && nl.art === 'impuls' && nl.start && nl.points && nl.points.length && nl.points[nl.points.length - 1].idx >= from) {
          const map = { i: '1', ii: '2', iii: '3', iv: '4', v: '5' };
          const auf = nl.points[0].price > nl.start.price;
          const letzter = nl.points[nl.points.length - 1];
          // Laeuft die letzte Welle noch? Ja, wenn das Ziel der Nachlauf-Zaehlung genau dieser Welle
          // gilt und noch nicht erreicht ist (oder sie an der letzten Kerze endet).
          const laeuft = !!(letzter && ((nl.ziel && !nl.ziel.erreicht && nl.ziel.label === letzter.label) || letzter.idx >= to - 1));
          const pts = [{ idx: nl.start.idx, price: nl.start.price, type: auf ? 'L' : 'H', label: '0', pending: false },
            ...nl.points.map((q, k) => ({ idx: q.idx, price: q.price, type: q.type || (k % 2 === 0 ? (auf ? 'H' : 'L') : (auf ? 'L' : 'H')), label: map[q.label] || q.label, pending: k === nl.points.length - 1 && laeuft }))];
          const n = nl.points.length;
          const proj = [];
          if (nl.ziel && !nl.ziel.erreicht) {
            proj.push({ label: map[nl.ziel.label] || nl.ziel.label, price: nl.ziel.price, dIdx: Math.max(2, nl.ziel.dBars || 4) });
            if (nl.ziel.danach) proj.push({ label: map[nl.ziel.danach.label] || nl.ziel.danach.label, price: nl.ziel.danach.price, dIdx: Math.max(3, (nl.ziel.dBars || 4) + (nl.ziel.danach.dBars || 6)) });
          }
          elliott.kind = 'impulse'; elliott.dir = auf ? 'up' : 'down';
          elliott.points = pts;
          elliott.phase = n >= 5 ? 'impulseDone' : 'wave' + (n + (laeuft ? 0 : 1));
          elliott.projection = proj;
          elliott.invalidation = { price: nl.start.price, below: auf, ruleKey: n >= 2 ? 'proInvRule1' : 'proInvNewImpulse' };
          elliott.kontextZaehlung = true;
          delete elliott.sub; delete elliott.nachlauf;
          // Rahmen-Zaehlung (eine Stufe groesser) weglassen, wenn sie dieselben Punkte beschriftet --
          // sonst stuenden z. B. "1" und "(1)" uebereinander.
          if (elliott.parent && (elliott.parent.points || []).some(q => q.label !== '0' && pts.some(m => m.label !== '0' && Math.abs(m.idx - q.idx) <= 1))) delete elliott.parent;
          // Die grosse Korrektur davor als Rahmen behalten, wenn bekannt.
          if (ctx.elliott.grossMarken) elliott.grossMarken = ctx.elliott.grossMarken;
        } else if (ctx && ctx.elliott && Array.isArray(ctx.elliott.points) && ctx.elliott.points.length >= 2 && ctx.elliott.points[0].idx >= from && ctx.elliott.umgestelltNachGross) {
          // GLEICHE ZAEHLUNG BEIM HERANZOOMEN (getestet: RUNE/AVAX Monat -- ganz herausgezoomt "(C) fertig,
          // neuer Impuls 1-2-3", herangezoomt "5 abwaerts, dann A-B-C"). Liegt die Zaehlung der
          // Gesamtansicht vollstaendig im Ausschnitt, wird sie uebernommen.
          const C = ctx.elliott;
          elliott.kind = C.kind; elliott.dir = C.dir; elliott.phase = C.phase;
          elliott.points = C.points.map(q => ({ ...q }));
          elliott.projection = (C.projection || []).map(q => ({ ...q }));
          elliott.invalidation = C.invalidation ? { ...C.invalidation } : elliott.invalidation;
          elliott.weiche = C.weiche || null;
          if (C.grossMarken) elliott.grossMarken = C.grossMarken;
          delete elliott.parent; delete elliott.sub; delete elliott.nachlauf;
          elliott.kontextZaehlung = true;
        }
      }
    } catch (e) {}
    // GROSSE WELLE ENDET MITTEN IN DER KLEINEN ZAEHLUNG (gemeldet bei RUNE/AVAX, Monatschart: "B geht
    // tiefer, das geht doch nicht" -- das Tief war zugleich (C) der grossen Zaehlung UND "B" der
    // kleinen; A und B gehoerten in Wahrheit noch zur grossen Welle (C)). Faellt ein Punkt der kleinen
    // Zaehlung mit dem Ende der grossen (C bzw. 5) zusammen, beginnt die kleine Zaehlung DORT: dieser
    // Punkt wird "0", alles davor entfaellt, und die Folgewellen heissen 1, 2, 3 ... (nach einer fertigen
    // grossen Korrektur kommt ein neuer Impuls).
    try {
      // Ende der grossen Zaehlung: Rahmen-Zaehlung (parent) ODER die grossen Marken "(A)(B)(C)"
      // (gemeldet: im Monatschart stand das grosse (C) als Marke, nicht als Rahmen-Zaehlung).
      const par = elliott && !elliott.kontextZaehlung && elliott.parent;
      let pe = par && Array.isArray(par.points) ? par.points[par.points.length - 1] : null;
      const gm = elliott && !elliott.kontextZaehlung && Array.isArray(elliott.grossMarken) ? elliott.grossMarken[elliott.grossMarken.length - 1] : null;
      if ((!pe || !['C', '5'].includes(String(pe.label))) && gm && /\(C\)|\(5\)/.test(String(gm.text || ''))) pe = { ...gm, label: String(gm.text).replace(/[()]/g, ''), pending: false };   // Marke gilt als Ende, auch wenn sie "laufend" hiess
      if (pe && !pe.pending && ['C', '5'].includes(String(pe.label)) && Array.isArray(elliott.points)) {
        const k = elliott.points.findIndex(q => q.label !== '0' && Math.abs(q.idx - pe.idx) <= 1);
        if (k > 0) {
          const nach = elliott.points.slice(k + 1);
          const neuLab = ['1', '2', '3', '4', '5'];
          elliott.points = [{ ...elliott.points[k], label: '0', pending: false }, ...nach.map((q, i) => ({ ...q, label: neuLab[i] || q.label }))];
          // Laeuft der letzte Punkt noch, gehoert das erste Ziel zu IHM (gleiche Nummer), nicht zur naechsten Welle.
          const letzterLaeuft = nach.length && nach[nach.length - 1].pending;
          const off = letzterLaeuft ? nach.length - 1 : nach.length;
          elliott.projection = (elliott.projection || []).map((q, i) => ({ ...q, label: neuLab[off + i] || q.label }));
          elliott.kind = 'impulse';
          elliott.dir = pe.type === 'L' ? 'up' : 'down';
          elliott.phase = 'wave' + (off + 1);
          elliott.invalidation = { price: pe.price, below: pe.type === 'L', ruleKey: off >= 1 ? 'proInvRule1' : 'proInvNewImpulse' };
          elliott.weiche = null;
          elliott.umgestelltNachGross = true;
          // Ziel der laufenden Welle schon ueberschritten? (getestet: RUNE/AVAX Monat -- "3" stand bei
          // 0,0759, ihr Ziel bei 0,0745). Dann naechste Stufe: Welle 3 = 1,618/2,618 x Welle 1 ab 2,
          // Welle 5 = 1/1,618 x Welle 1 ab 4, Welle 1 = 38,2/61,8 % der grossen Korrektur.
          try {
            const lz = elliott.points[elliott.points.length - 1];
            const z0 = (elliott.projection || [])[0];
            const aufN = elliott.dir === 'up';
            if (lz && lz.pending && z0 && String(z0.label) === String(lz.label) && (aufN ? lz.price >= z0.price : lz.price <= z0.price)) {
              const Lg = v => (useLog ? Math.log(v) : v), Eg = v => (useLog ? Math.exp(v) : v);
              const q = l => elliott.points.find(x => x.label === l);
              const p0 = q('0'), p1 = q('1'), p2 = q('2'), p4 = q('4');
              const w1 = p0 && p1 ? Math.abs(Lg(p1.price) - Lg(p0.price)) : null;
              const dd = aufN ? 1 : -1;
              let basis = null, stufen = [];
              if (lz.label === '3' && p2 && w1) { basis = p2.price; stufen = [1.618, 2.618, 4.236]; }
              else if (lz.label === '5' && p4 && w1) { basis = p4.price; stufen = [1, 1.618, 2.618]; }
              const neu = basis ? stufen.map(f => Eg(Lg(basis) + dd * w1 * f)).find(z => (aufN ? z > lz.price : z < lz.price)) : null;
              elliott.projection = neu ? [{ ...z0, price: neu }, ...elliott.projection.slice(1)] : elliott.projection.slice(1);
            }
          } catch (e) {}
          // Die grossen Marken bleiben (sie zeigen den Rahmen), aber ohne "laufend".
          if (Array.isArray(elliott.grossMarken)) elliott.grossMarken = elliott.grossMarken.map(q => ({ ...q, pending: false }));
        }
      }
    } catch (e) {}
    // KEIN ZIEL FUER EINE SCHON FERTIGE WELLE (gemeldet bei RUNE/BTC: "5 Wellen fertig -- Korrektur
    // erwartet" und gleichzeitig "Erwarteter Pfad: 5 bei 3,5e-6"): Ziele, deren Welle in der Zaehlung
    // bereits als fester Punkt steht, fallen weg.
    try {
      if (elliott && Array.isArray(elliott.projection) && Array.isArray(elliott.points)) {
        const fest = new Set(elliott.points.filter(q => !q.pending && !q.moeglich).map(q => String(q.label)));
        elliott.projection = elliott.projection.filter(q => !fest.has(String(q.label)));
      }
    } catch (e) {}
    // FIB NACH DER ZAEHLUNG NEU (gemeldet: "die Fib macht keinen Sinn" -- es standen noch die
    // Stufen "Welle 4" der verworfenen Ausschnitt-Zaehlung da): Wurde die Zaehlung durch das grosse
    // Bild ersetzt, gehoeren die Fibonacci-Stufen zur NEUEN laufenden Welle (z. B. Welle 2 =
    // 38,2/50/61,8/78,6 % von Welle 1), jeweils mit Wahrscheinlichkeit.
    if (elliott && elliott.kontextZaehlung) {
      try {
        // Die "Weiche" (z. B. "ueber $0,712: C fertig") gehoerte zur verworfenen Zaehlung.
        elliott.weiche = null;
        // Laufende Welle ohne eigenen Punkt (wurde fuer a-b-c entfernt): Phase bleibt, Anker = letzter Punkt.
        // Ist die laufende Welle moeglicherweise schon fertig (a-b-c komplett), wird ihr Endpunkt fuer
        // die Fib-Rechnung ausgeblendet (Stufen gemessen an Welle 1), und "jetzt fertig" bekommt
        // seinen Anteil -- die uebrigen Stufen teilen sich den Rest.
        const ohneMoeglich = elliott.welleFertigWkt ? { ...elliott, points: elliott.points.filter(q => !q.moeglich) } : elliott;
        fibs.elliott = elliottFib(ohneMoeglich, useLog);
        rwFibWahrscheinlichkeit(fibs.elliott, data);
        if (fibs.elliott && elliott.welleFertigWkt) {
          const rest = 100 - elliott.welleFertigWkt;
          const offen = fibs.elliott.levels.filter(l => l.prob != null);
          const summe = offen.reduce((a, l) => a + l.prob, 0) || 1;
          offen.forEach(l => { l.prob = Math.round(l.prob / summe * rest); });
          fibs.elliott.jetztFertig = { prob: elliott.welleFertigWkt, rueck: elliott.welleFertigRueck };
          // Als eigene Stufe zeigen: "Welle 2 x 0,33 $0,598 · 25 %" -- das ist die Variante "schon fertig".
          const mp = elliott.points.find(q => q.moeglich);
          if (mp) fibs.elliott.levels.push({ r: Math.round(elliott.welleFertigRueck * 100) / 100, wave: fibs.elliott.label, price: mp.price, prob: elliott.welleFertigWkt, erreicht: false, jetzt: true });
        }
        fibs.confluence = fibConfluence(fibs, sr, tolLog);
      } catch (e) {}
    }
    // FIB DER KLEINEN KORREKTUR (gewuenscht: "ich will auch die Fib bei a-b-c-Korrekturen sehen"):
    // Laeuft innerhalb der grossen Welle eine a-b-c (Feinzaehlung), die ueblichen Ziele fuer c:
    // 0,618 / 1 / 1,272 / 1,618 x a, gemessen ab b. Mit Haken (erreicht) und Wahrscheinlichkeit.
    try {
      fibs.elliottSub = null;
      const S = elliott && elliott.sub;
      if (S && S.imKontext && Array.isArray(S.points)) {
        const a = S.points.find(q => q.label === 'a'), b = S.points.find(q => q.label === 'b');
        const anker = elliott.points.filter(q => !q.moeglich && !q.pending).slice(-1)[0];
        if (a && b && anker) {
          const Ssyn = { kind: 'correction', dir: a.price < anker.price ? 'down' : 'up', phase: 'waveC',
            points: [{ ...anker, label: '0' }, { ...a, label: 'A' }, { ...b, label: 'B' }] };
          const fs = elliottFib(Ssyn, useLog);
          if (fs) { fs.id = 'elliottSub'; rwFibWahrscheinlichkeit(fs, data); fibs.elliottSub = fs; }
        }
      }
    } catch (e) {}
    // NAECHSTES ZWISCHENZIEL (Backtest, unabhaengige Zeitpunkte, 14 RUNE-Paare, Tageschart 45 Tage:
    // das grosse Wellenziel wurde in 20 % der Faelle erreicht -- SELTENER als ein gleich weites Ziel in
    // Gegenrichtung (24 %); die naechste noch offene Fib-Stufe der laufenden Welle dagegen in 30 %,
    // Gegenrichtung 25 %). Diese Stufe wird hervorgehoben (dickere Linie) und im Fenster genannt.
    try {
      if (fibs.elliott && elliott && Array.isArray(elliott.projection) && elliott.projection.length && lastClose > 0) {
        const auf = elliott.projection[0].price > lastClose;
        const offen = fibs.elliott.levels.filter(l => l && l.price > 0 && !l.erreicht && !l.jetzt && (auf ? l.price > lastClose : l.price < lastClose));
        const nah = offen.sort((x, y) => Math.abs(x.price - lastClose) - Math.abs(y.price - lastClose))[0];
        if (nah) { fibs.elliott.nearest = { r: nah.r, wave: nah.wave }; elliott.zwischenziel = { price: nah.price, r: nah.r, wave: nah.wave, prob: nah.prob }; }
      }
    } catch (e) {}
    // NAECHSTE WELLE MIT WAHRSCHEINLICHKEITEN (gefordert: "Welle 3 muss auch mit Wahrscheinlich-
    // keiten angezeigt werden, alle Wellen"): Laeuft Welle 2 (bzw. 4), werden zusaetzlich die
    // Stufen der FOLGEWELLE berechnet -- gemessen ab dem wahrscheinlichsten Ziel der laufenden Welle
    // (erster Projektionspunkt): Welle 3 = 1 / 1,618 / 2 / 2,618 x Welle 1, Welle 5 = 0,618 / 1 /
    // 1,618 x Welle 1. Gezeichnet als kurze Linien rechts, ab dem Projektionspunkt.
    try {
      fibs.elliottWeiter = null;
      const E2 = elliott;
      if (E2 && E2.kind === 'impulse' && Array.isArray(E2.projection) && E2.projection.length) {
        const lab = l => E2.points.find(q => q.label === l);
        const p0 = lab('0'), p1 = lab('1');
        const ziel = E2.projection[0];
        const sign = E2.dir === 'up' ? 1 : -1;
        const w1 = p0 && p1 ? Math.abs(useLog ? Math.log(p1.price) - Math.log(p0.price) : p1.price - p0.price) : null;
        const mv = (von, f) => useLog ? von * Math.exp(sign * w1 * f) : von + sign * w1 * f;
        let stufen = null, welle = null, gew = null;
        if (w1 && (E2.phase === 'wave2') && (String(ziel.label) === '2' || String(ziel.label) === '3')) { welle = '3'; stufen = [1, 1.618, 2, 2.618]; gew = { 1: 20, 1.618: 45, 2: 15, 2.618: 20 }; }
        else if (w1 && (E2.phase === 'wave4') && String(ziel.label) === '4') { welle = '5'; stufen = [0.618, 1, 1.618]; gew = { 0.618: 35, 1: 45, 1.618: 20 }; }
        if (stufen) {
          const summe = stufen.reduce((a, r) => a + gew[r], 0);
          // Bezugspunkt: Ziel der laufenden Welle -- oder, wenn sie schon moeglich fertig ist, ihr Ende.
          const basis = String(ziel.label) === welle ? (E2.points.find(q => q.moeglich) || ziel) : ziel;
          fibs.elliottWeiter = { id: 'elliottWeiter', label: welle, vonPreis: basis.price, drawFromIdx: String(ziel.label) === welle ? (basis.idx != null ? basis.idx : to) : to + Math.max(1, ziel.dIdx || 1),
            levels: stufen.map(r => ({ r, wave: welle, price: mv(basis.price, r), prob: Math.round(gew[r] / summe * 100) })).filter(l => Number.isFinite(l.price) && l.price > 0) };
        }
      }
    } catch (e) {}
    // VERKUERZTE FUENFTE ALS ALTERNATIVE (gefragt: "Koennte Welle 5 nicht schon im September
    // entstanden sein?"). Erst hier am Ende, auf der ENDGUELTIGEN Zaehlung (nach Grad-Abgleich,
    // Nachlauf usw.), damit Kreis und Szenario zur gezeichneten Zaehlung passen.
    // Laeuft laut Zaehlung noch Welle 4 oder 5: Gab es seit Welle 4 schon ein Extrem in
    // Trendrichtung, das hoechstens 10 % vor dem Ende von Welle 3 stehen blieb (nicht darueber
    // hinaus -- sonst waere es eine regulaere Welle 5), und ist der Kurs seitdem um mindestens
    // 61,8 % dieses Wegs zurueckgelaufen? Dann ist eine "truncated fifth" plausibel: Welle 5 ist
    // fertig, die Korrektur A-B-C laeuft. Bestaetigt erst durch einen Schluss jenseits von Welle 4.
    // Vor den Umdeutungen eine versteckte Projektion zurueckholen, danach je nach NEUER Phase bewerten.
    const vorUmdeutung = elliott ? { phase: elliott.phase, kind: elliott.kind, n: (elliott.points || []).length } : null;
    const versteckt0 = elliott ? elliott.projectionVersteckt : null;
    projektionHolen(elliott);
    grosseKorrekturAusDaten(elliott, data, from, to, useLog, fibs);
    neuerTrendNachKorrektur(elliott, data, from, to, lastClose, useLog, fibs);
    rahmenInZaehlung(elliott, data, from);
    abcNachGrossCAlsImpuls(elliott, fibs);
    if (elliott && vorUmdeutung && (elliott.phase !== vorUmdeutung.phase || elliott.kind !== vorUmdeutung.kind || (elliott.points || []).length !== vorUmdeutung.n)) phaseNeuBewerten(elliott);
    else if (elliott && versteckt0 && (!elliott.projection || !elliott.projection.length || elliott.projection === versteckt0)) { elliott.projectionVersteckt = versteckt0; elliott.projection = []; }
    ergaenzeProjektion(elliott, useLog, fibs);
    // Bewertung neu, wenn die Zaehlung oben umgedeutet wurde (sonst stand z. B. weiter "Bearish").
    if (elliott && (elliott.neuerTrendNachKorrektur || elliott.umbenanntNachGrossC)) { try { score = scoreAll(trend, sr, elliott, fib, indicators, lastClose); } catch (e) {} }
    altTrunc5(elliott, data, lastClose, useLog);
    // PLAUSIBILITAETS-DECKEL FUER PROJEKTIONEN (gemeldet bei RUNE/NEAR Woche: "diese Zaehlungen machen
    // keinen Sinn" -- Welle 3 bei 0,011 und Welle 5 bei 0,0016, also -99 % vom aktuellen Kurs 0,165).
    // Ursache: Die Wellenlaengen werden aus frueheren, riesigen Bewegungen abgeleitet (Log-Skala ueber
    // Jahre) und dann vom aktuellen Kurs aus weitergerechnet. Ein Ziel mehr als Faktor 3,3 (1,2 im
    // Log-Raum) vom aktuellen Kurs entfernt ist keine brauchbare Prognose mehr. Solche Ziele -- und alle
    // dahinter, weil der Weg sonst abreisst -- entfallen; die Zaehlung selbst bleibt sichtbar.
    try {
      // GRENZE JE ZEITEBENE (gemeldet: "nur im Daily-Chart keine Wellen-Prognose"): Ein fester Faktor 3,3 war fuer
      // Tages- und Wochenkerzen zu eng -- eine Welle 3 kann dort leicht das 4- bis 6-Fache bringen. Jetzt nach
      // Kerzenabstand: unter 1 Tag Faktor 3,3, Tageskerzen Faktor 7, Wochen/Monate Faktor 15.
      const abstand = data.length > 2 ? Math.abs((data[data.length - 1].date || 0) - (data[data.length - 2].date || 0)) : 0;
      const grenzeLog = abstand >= 5 * 86400e3 ? Math.log(15) : abstand >= 20 * 3600e3 ? Math.log(7) : 1.2;
      // Nach unten strenger: mehr als -75 % (Faktor 4) gilt auf jeder Zeitebene als unbrauchbar (RUNE/NEAR-Fall mit -99 %).
      const weitWeg = pr => { if (!(Number.isFinite(pr) && pr > 0 && lastClose > 0)) return false; const r = Math.log(pr / lastClose); return r < 0 ? -r > Math.min(grenzeLog, Math.log(4)) : r > grenzeLog; };
      if (elliott && Array.isArray(elliott.projection) && elliott.projection.length) {
        const k = elliott.projection.findIndex(q => weitWeg(q && q.price));
        if (k >= 0) { elliott.projection = elliott.projection.slice(0, k); elliott.projektionGekappt = true; }
      }
      if (elliott && Array.isArray(elliott.targets) && elliott.targets.length) {
        const vorher = elliott.targets.length;
        elliott.targets = elliott.targets.filter(q => !weitWeg(q && q.price));
        if (elliott.targets.length !== vorher) elliott.projektionGekappt = true;
      }
      const nl = elliott && elliott.nachlauf;
      if (nl && nl.ziel) {
        if (weitWeg(nl.ziel.price)) { nl.ziel = null; elliott.projektionGekappt = true; }
        else if (nl.ziel.danach && weitWeg(nl.ziel.danach.price)) { delete nl.ziel.danach; elliott.projektionGekappt = true; }
      }
    } catch (e) {}
    let divergenzen = [];
    try { divergenzen = detectDivergenzen(data, from, to); } catch (e) { divergenzen = []; }
    return {
      from, to, lastClose, atrAbs, atrPct, useLog, divergenzen,
      pivots: mediumInView.pivots, pending: medium.pending, coarsePivots: coarse.pivots,
      trend, sr, fib, fibs, elliott, indicators, score, trendlines, trendlinesTouch,
      phasen: (() => { try { return rwPhasenSignal(rohDaten); } catch (e) { return null; } })(),
      updatedAt: Date.now()
    };
  }

  // DIAGNOSE: Warum wird eine bestimmte Punktfolge nicht gezaehlt?
  //
  // Ohne das liesse sich nur raten, an welcher der rund zwanzig Bedingungen eine von Hand
  // geprueft gueltige Folge haengen bleibt. Der Aufruf laesst die normale Zaehlung laufen,
  // protokolliert jede Ablehnung mit Grund und Zahlen und gibt die Eintraege zurueck, die
  // genau zur gesuchten Punktfolge gehoeren.
  function erklaereZaehlung(data, pivots, gesuchteIdx, to, useLog) {
    evalTrace = [];
    let erg = null;
    try {
      erg = detectElliott({ pivots, pending: null }, data[to].value, to, useLog !== false, data.map(d => d.volume), { forceStart: true });
    } catch (e) {
      evalTrace.push({ idx: [], grund: 'Ausnahme: ' + (e && e.message), zahlen: [] });
    }
    const spur = evalTrace || []; evalTrace = null;
    const passt = (a) => Array.isArray(a) && gesuchteIdx.every((g, i) => a[i] === g);
    return {
      gefunden: erg ? erg.points.map(p => p.label + '@' + p.idx).join(' ') : null,
      treffer: spur.filter(e => passt(e.idx)),
      gesamt: spur.length,
    };
  }

  const pinZaehlung = () => { EW_PIN = new Map([...EW_HYST.entries()].map(([k, v]) => [k, { ...v, dates: v.dates.slice() }])); };
  const loeseZaehlung = () => { EW_PIN = null; };
  return { analyze, pinZaehlung, loeseZaehlung, zigzag, pivotsAuto, atrSeries, rsiArr, emaArr, erklaereZaehlung, _internal: { detectElliott, detectSR, detectFib, detectTrend, zigzagUpTo, altTrunc5, detectDivergenzen, ergaenzeProjektion, neuerTrendNachKorrektur, abcNachGrossCAlsImpuls, grosseKorrekturAusDaten, rahmenInZaehlung } };
})();
  return TPAnalysis;
})();
