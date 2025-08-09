// api/sync-base44.js
const BASE44 = 'https://app.base44.com/api';

// קורא את ה-CSV ישירות מה-Google Sheet ומחזיר [{ticker, price}]
async function fetchSelfPrices() {
  const csvUrl = process.env.SHEET_CSV_URL;
  if (!csvUrl) throw new Error('SHEET_CSV_URL env is missing');
  const r = await fetch(csvUrl);
  if (!r.ok) throw new Error(`CSV fetch ${r.status}`);
  const text = await r.text();

  // parser ל-CSV (תומך במרכאות)
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

export default async function handler(req, res) {
  // שים לב: אין כאן כותרות CORS — לא נחוצות ל-Postman/curl ומנעו שגיאות בעבר

  // אימות: או Cron של Vercel או Bearer secret
  const byCron = !!req.headers['x-vercel-cron'];
  const auth = req.headers.authorization?.split(' ')[1];
  if (!byCron && auth !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // נרשה POST (ובנוחות גם GET לצורך בדיקות עם dry_run)
  if (!['POST','GET','OPTIONS'].includes(req.method) && !byCron) {
    return res.status(405).json({ error: 'Use POST' });
  }

  try {
    const { BASE44_APP_ID, BASE44_API_KEY } = process.env;
    if (!BASE44_APP_ID || !BASE44_API_KEY) throw new Error('Missing Base44 env');

    // פרמטרים מה-URL
    const qs = (req.url.split('?')[1] || '');
    const getParam = (name) => {
      const m = qs.match(new RegExp('(?:^|&)' + name + '=([^&]+)'));
      return m ? decodeURIComponent(m[1]) : '';
    };
    const dry = getParam('dry_run') === '1';
    const filterTickers = (getParam('tickers') || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

    // 1) מחירים מה-CSV
    const prices = await fetchSelfPrices();

    // נרמול טיקרים (מסיר קידומות/סיומות נפוצות ומעלה לאותיות גדולות)
    const norm = s => String(s||'').trim().toUpperCase()
      .replace(/^(NASDAQ:|NYSE:|AMEX:|BATS:|TASE:|TLV:|LON:)/,'')
      .replace(/\.(US|TA|L|AX|TO|HK)$/,'');
    const priceMap = new Map(prices.map(p => [norm(p.ticker), p.price]));
    const allow = filterTickers.length ? new Set(filterTickers.map(norm)) : null;

    // 2) קריאת רשומות Stock
    const listResp = await fetch(`${BASE44}/apps/${BASE44_APP_ID}/entities/Stock`, {
      headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' }
    });
    if (!listResp.ok) throw new Error(`Base44 read failed ${listResp.status}: ${await listResp.text()}`);
    const json = await listResp.json();
    const list = Array.isArray(json) ? json : (json.data || json.results || []);

    // 3) דיבוג + עדכון
    let updated = 0, unchanged = 0, notFound = 0, nullPrice = 0;
    const sample = { notFound: [], nullPrice: [], unchanged: [] };

    for (const rec of list) {
      const tRaw = String(rec.Ticker || '');
      const t = norm(tRaw);

      if (!t || !priceMap.has(t) || (allow && !allow.has(t))) {
        notFound++; if (sample.notFound.length < 10) sample.notFound.push(tRaw);
        continue;
      }

      const newPrice = Number(priceMap.get(t));
      if (!Number.isFinite(newPrice)) {
        nullPrice++; if (sample.nullPrice.length < 10) sample.nullPrice.push(tRaw);
        continue;
      }

      const oldNum = Number(rec.Price);
      const same = Number.isFinite(oldNum) && Math.abs(oldNum - newPrice) < 0.005; // סבילות קטנה
      if (same) {
        unchanged++; if (sample.unchanged.length < 10) sample.unchanged.push(tRaw);
        continue;
      }

      if (!dry) {
        const put = await fetch(`${BASE44}/apps/${BASE44_APP_ID}/entities/Stock/${rec.id}`, {
          method: 'PUT',
