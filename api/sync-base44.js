// api/sync-base44.js
const BASE44 = 'https://app.base44.com/api';

// קורא את ה-CSV ישירות מה-Google Sheet ומחזיר [{ticker, price}]
async function fetchSelfPrices() {
  const csvUrl = process.env.SHEET_CSV_URL;
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
  // CORS (כדי שאפשר יהיה להריץ גם מהדפדפן אם תרצה)
 // const ORIGIN = process.env.PUBLIC_WEB_ORIGIN || '*';
//  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
 // res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  //res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  //if (req.method === 'OPTIONS') return res.status(200).end();

  // אימות: או קריאת Cron של Vercel או Bearer secret
  const byCron = !!req.headers['x-vercel-cron'];
  const auth = req.headers.authorization?.split(' ')[1];
  if (!byCron && auth !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!['POST','OPTIONS'].includes(req.method) && !byCron) {
    return res.status(405).json({ error: 'Use POST' });
  }

  try {
    const { BASE44_APP_ID, BASE44_API_KEY } = process.env;
    if (!BASE44_APP_ID || !BASE44_API_KEY) throw new Error('Missing Base44 env');

    // 1) מחירים עדכניים מה-CSV
    const prices = await fetchSelfPrices();
    const priceMap = new Map(prices.map(p => [String(p.ticker).toUpperCase(), p.price]));

    // 2) קוראים את כל רשומות Stock
    const listResp = await fetch(`${BASE44}/apps/${BASE44_APP_ID}/entities/Stock`, {
      headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' }
    });
    if (!listResp.ok) {
      const t = await listResp.text();
      throw new Error(`Base44 read failed ${listResp.status}: ${t}`);
    }
    const list = await listResp.json();

    // 3) עדכון שדה Price לפי Ticker
    let updated = 0, skipped = 0;
    for (const rec of list) {
      const t = String(rec.Ticker || '').toUpperCase();
      if (!t || !priceMap.has(t)) { skipped++; continue; }
      const newPrice = priceMap.get(t);
      if (newPrice == null || Number(rec.Price) === Number(newPrice)) { skipped++; continue; }

      const put = await fetch(`${BASE44}/apps/${BASE44_APP_ID}/entities/Stock/${rec.id}`, {
        method: 'PUT',
        headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ Price: newPrice })
      });
      if (put.ok) { updated++; await new Promise(r => setTimeout(r, 120)); }
      else { console.error('Update failed', rec.id, put.status, await put.text()); }
    }

    res.json({ ok: true, updated, skipped });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
}
