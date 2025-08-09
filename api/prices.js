// api/prices.js
// קורא CSV פומבי מגוגל שיט ומחזיר JSON של {ticker, price}
export default async function handler(req, res) {
  const ORIGIN = process.env.PUBLIC_WEB_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const csvUrl = process.env.SHEET_CSV_URL; // נזין ב-Vercel עוד רגע
    if (!csvUrl) throw new Error('SHEET_CSV_URL env is missing');

    const r = await fetch(csvUrl);
    if (!r.ok) throw new Error(`CSV fetch ${r.status}`);
    const text = await r.text();

    // פרסור CSV קטן (כולל מרכאות)
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

    const header = rows[0].map(h => h.trim());
    const iTicker = header.findIndex(h => /^ticker$/i.test(h));
    const iPrice  = header.findIndex(h => /^price$/i.test(h));
    if (iTicker === -1 || iPrice === -1) throw new Error('Header must contain Ticker and Price');

    let data = rows.slice(1)
      .filter(r => r[iTicker])
      .map(r => ({
        ticker: String(r[iTicker]).trim().toUpperCase(),
        price:  r[iPrice] ? Number(String(r[iPrice]).replace(/,/g,'')) : null
      }))
      .filter(x => x.ticker);

    // סינון אופציונלי: ?tickers=RCKT,OSUR
    const filter = (req.query.tickers || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (filter.length) data = data.filter(d => filter.includes(d.ticker));

    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    res.json({ updatedAt: new Date().toISOString(), count: data.length, data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
