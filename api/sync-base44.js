// api/sync-base44.js
// מסנכרן מחירים מ-Google Sheets (CSV) ל-Entity "Stock" ב-Base44,
// עם עבודה במקטעים (batch) וקונקרנציה מוגבלת כדי למנוע TIMEOUT.
//
// ENV חובה: SHEET_CSV_URL (output=csv), BASE44_APP_ID, BASE44_API_KEY, SYNC_SECRET

const BASE44 = 'https://app.base44.com/api';

// --- עזר ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- קריאת CSV => [{ticker, price}] ---
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

// --- נרמול טיקרים ---
const norm = s => String(s||'').trim().toUpperCase()
  .replace(/^(NASDAQ:|NYSE:|AMEX:|BATS:|TASE:|TLV:|LON:)/,'')
  .replace(/\.(US|TA|L|AX|TO|HK)$/,'');

// --- PUT עם ריטריי עדין ל-429/5xx ---
async function putWithRetry(url, options, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, options);
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      await sleep(300 * (i + 1));
      continue;
    }
    // 4xx אחר - אין טעם לנסות שוב
    return res;
  }
  // ניסיון אחרון
  return fetch(url, options);
}

// --- בריכת קונקרנציה פשוטה ---
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
  // אימות: Cron של Vercel או Bearer secret
  const byCron = !!req.headers['x-vercel-cron'];
  const auth = req.headers.authorization?.split(' ')[1];
  if (!byCron && auth !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // נאפשר POST וגם GET (נוח ל-dry_run)
  if (!['POST','GET','OPTIONS'].includes(req.method) && !byCron) {
    return res.status(405).json({ error: 'Use POST' });
  }

  // פרמטרים
  const url = new URL(req.url || '', 'http://localhost');
  const dry        = url.searchParams.get('dry_run') === '1';
  const force      = url.searchParams.get('force') === '1';
  const maxUpdates = Number(url.searchParams.get('max_updates') || '250'); // ברירת מחדל
  const concurrency= Number(url.searchParams.get('concurrency') || '6');
  const tickersParam = url.searchParams.get('tickers') || '';
  const filterTickers = tickersParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const allow = filterTickers.length ? new Set(filterTickers.map(norm)) : null;

  try {
    const { BASE44_APP_ID, BASE44_API_KEY } = process.env;
    if (!BASE44_APP_ID || !BASE44_API_KEY) throw new Error('Missing Base44 env');

    // 1) מחירים
    const prices = await fetchSelfPrices();
    const priceMap = new Map(prices.map(p => [norm(p.ticker), p.price]));

    // 2) קריאת Stock מ-Base44
    const listResp = await fetch(`${BASE44}/apps/${BASE44_APP_ID}/entities/Stock`, {
      headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' }
    });
    if (!listResp.ok) throw new Error(`Base44 read failed ${listResp.status}: ${await listResp.text()}`);
    const json = await listResp.json();
    const list = Array.isArray(json) ? json : (json.data || json.results || []);
    if (!Array.isArray(list)) throw new Error('Unexpected Base44 list format');

    // 3) סיווג
    let unchanged = 0, notFound = 0, nullPrice = 0;
    const candidates = [];
    for (const rec of list) {
      const tRaw = String(rec.Ticker || '');
      const t = norm(tRaw);

      if (!t || !priceMap.has(t) || (allow && !allow.has(t))) {
        notFound++; continue;
      }
      const newPrice = Number(priceMap.get(t));
      if (!Number.isFinite(newPrice)) { nullPrice++; continue; }

      const oldNum = Number(rec.Price);
      const same = Number.isFinite(oldNum) && Math.abs(oldNum - newPrice) < 0.0000001;
      if (same && !force) { unchanged++; continue; }

      candidates.push({ id: rec.id, ticker: tRaw, price: newPrice });
    }

    // 4) מגבילים לעד X עדכונים בהרצה כדי לא לחצות TIMEOUT
    const batch = candidates.slice(0, Math.max(0, maxUpdates));
    let updated = 0;

    if (!dry && batch.length) {
      const hdrs = { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' };
      updated = await runPool(batch, async (item) => {
        const put = await putWithRetry(
          `${BASE44}/apps/${BASE44_APP_ID}/entities/Stock/${item.id}`,
          { method: 'PUT', headers: hdrs, body: JSON.stringify({ Price: item.price }) }
        );
        if (!put.ok) {
          console.error('Update failed', item.id, put.status, await put.text());
          return false;
        }
        return true;
      }, Math.max(1, concurrency));
    } else if (dry) {
      updated = batch.length; // סימולציה
    }

    const remaining = candidates.length - batch.length;

    return res.json({
      ok: true,
      updated,
      skipped: list.length - updated,
      breakdown: { notFound, nullPrice, unchanged },
      info: {
        totalRecords: list.length,
        toUpdateTotal: candidates.length,
        processedThisRun: batch.length,
        remainingForNextRun: Math.max(0, remaining),
        params: { max_updates: maxUpdates, concurrency, dry_run: dry, force, filtered: !!allow }
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
}
