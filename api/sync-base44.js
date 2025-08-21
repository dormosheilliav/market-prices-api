// api/sync-base44.js  — Batch updates with offset/limit (cap=150) + throttle/backoff

const BASE44 = 'https://app.base44.com/api';

// ---------- helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Rate-limit: limit PUTs per second to Base44 (NEW) ---
const RPS = Number(process.env.BASE44_RPS || '4'); // tweak via env if needed
let lastTs = 0;
async function rateLimit() {
  const gap = Math.ceil(1000 / Math.max(1, RPS));
  const now = Date.now();
  const wait = Math.max(0, gap - (now - lastTs));
  lastTs = now + wait;
  if (wait) await sleep(wait);
}

// ---------- CSV -> rows ----------
async function fetchSelfPrices() {
  const csvUrl = process.env.SHEET_CSV_URL;
  if (!csvUrl) throw new Error('SHEET_CSV_URL env is missing');

  const r = await fetch(csvUrl);
  if (!r.ok) throw new Error(`CSV fetch ${r.status}`);
  const text = await r.text();

  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i+1];
    if (ch === '"' && inQuotes && next === '"') { cell += '"'; i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { row.push(cell); cell=''; continue; }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (cell.length || row.length) { row.push(cell); rows.push(row); row=[]; cell=''; }
      continue;
    }
    cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];

  const header = rows[0].map(h => h.trim());
  const iTicker = header.findIndex(h => /^ticker$/i.test(h));
  const iPrice  = header.findIndex(h => /^price$/i.test(h));
  if (iTicker === -1 || iPrice === -1) throw new Error('Header must contain Ticker and Price');

  return rows.slice(1)
    .filter(r => r[iTicker])
    .map(r => ({
      ticker: String(r[iTicker]).trim().toUpperCase(),
      price:  r[iPrice] ? Number(String(r[iPrice]).replace(/,/g,'')) : null
    }))
    .filter(x => x.ticker);
}

const norm = s => String(s||'').trim().toUpperCase()
  .replace(/^(NASDAQ:|NYSE:|AMEX:|BATS:|TASE:|TLV:|LON:)/,'')
  .replace(/\.(US|TA|L|AX|TO|HK)$/,'');

// --- PUT with throttle + exponential backoff (REPLACED) ---
async function putWithRetry(url, options, tries = 5) {
  let backoff = 400; // ms
  for (let i = 0; i < tries; i++) {
    await rateLimit(); // don't exceed RPS
    const res = await fetch(url, options);
    if (res.ok) return res;

    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after')) || 0;
      await sleep(ra ? ra * 1000 : backoff + Math.random() * 250);
      backoff = Math.min(backoff * 2, 8000);
      continue;
    }
    if (res.status >= 500) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 8000);
      continue;
    }
    // other 4xx – give up
    return res;
  }
  // last attempt
  await rateLimit();
  return fetch(url, options);
}

// ---------- simple concurrency pool ----------
async function runPool(items, worker, concurrency) {
  let i = 0, active = 0, ok = 0;
  return new Promise((resolve) => {
    const next = () => {
      while (active < concurrency && i < items.length) {
        const item = items[i++]; active++;
        Promise.resolve(worker(item))
          .then(s => { if (s) ok++; })
          .catch(() => {})
          .finally(() => { active--; next(); });
      }
      if (active === 0 && i >= items.length) resolve(ok);
    };
    next();
  });
}

export default async function handler(req, res) {
  // Auth: Vercel cron OR Bearer secret
  const byCron = !!req.headers['x-vercel-cron'];
  const auth = req.headers.authorization?.split(' ')[1];
  if (!byCron && auth !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!['POST','GET','OPTIONS'].includes(req.method) && !byCron) {
    return res.status(405).json({ error: 'Use POST' });
  }

  // Params
  const url = new URL(req.url || '', 'http://localhost');

  const limit       = Math.min(150, Math.max(1, Number(url.searchParams.get('limit') || '150'))); // hard cap=150
  const offset      = Math.max(0, Number(url.searchParams.get('offset') || '0'));
  const dry         = url.searchParams.get('dry_run') === '1';
  const force       = url.searchParams.get('force') === '1';
  const concurrency = Math.max(1, Number(url.searchParams.get('concurrency') || '3')); // softer default (CHANGED)
  const tickersParam = url.searchParams.get('tickers') || '';
  const filterTickers = tickersParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const allow = filterTickers.length ? new Set(filterTickers.map(norm)) : null;

  try {
    const { BASE44_APP_ID, BASE44_API_KEY } = process.env;
    if (!BASE44_APP_ID || !BASE44_API_KEY) throw new Error('Missing Base44 env');

    // 1) Prices from Google Sheet
    const prices = await fetchSelfPrices();
    const priceMap = new Map(prices.map(p => [norm(p.ticker), p.price]));

    // 2) Read Stock list from Base44 (one shot)
    const listResp = await fetch(`${BASE44}/apps/${BASE44_APP_ID}/entities/Stock`, {
      headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' }
    });
    if (!listResp.ok) throw new Error(`Base44 read failed ${listResp.status}: ${await listResp.text()}`);
    const json = await listResp.json();
    const list = Array.isArray(json) ? json : (json.data || json.results || []);
    if (!Array.isArray(list)) throw new Error('Unexpected Base44 list format');

    // 3) Build candidates (all), then slice by offset/limit
    let unchanged = 0, notFound = 0, nullPrice = 0;
    const candidates = [];
    for (const rec of list) {
      const tRaw = String(rec.Ticker || '');
      const t = norm(tRaw);

      if (!t || !priceMap.has(t) || (allow && !allow.has(t))) { notFound++; continue; }

      const newPrice = Number(priceMap.get(t));
      if (!Number.isFinite(newPrice)) { nullPrice++; continue; }

      const oldNum = Number(rec.Price);
      const same = Number.isFinite(oldNum) && Math.abs(oldNum - newPrice) < 0.0000001;
      if (same && !force) { unchanged++; continue; }

      candidates.push({ id: rec.id, ticker: tRaw, price: newPrice });
    }

    const totalCandidates = candidates.length;
    const window = candidates.slice(offset, offset + limit);
    let updated = 0;

    if (!dry && window.length) {
      const hdrs = { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' };
      updated = await runPool(window, async (item) => {
        const put = await putWithRetry(
          `${BASE44}/apps/${BASE44_APP_ID}/entities/Stock/${item.id}`,
          { method: 'PUT', headers: hdrs, body: JSON.stringify({ Price: item.price }) }
        );
        if (!put.ok) {
          console.error('Update failed', item.id, put.status, await put.text());
          return false;
        }
        return true;
      }, concurrency);
    } else if (dry) {
      updated = window.length; // simulation
    }

    const nextOffset = Math.min(totalCandidates, offset + limit);
    const done = nextOffset >= totalCandidates;

    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');
    return res.json({
      ok: true,
      updated,
      window: { offset, limit, processed: window.length },
      totals: {
        base44Records: list.length,
        candidates: totalCandidates,
        notFound, nullPrice, unchanged
      },
      nextOffset,
      done
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
}
