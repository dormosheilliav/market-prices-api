// api/sync-base44.js
// מסנכרן מחירי מניות מגיליון Google Sheets (CSV) אל ה-Entity "Stock" ב-Base44.
// ENV חובה: SHEET_CSV_URL (עם output=csv), BASE44_APP_ID, BASE44_API_KEY, SYNC_SECRET

const BASE44 = 'https://app.base44.com/api';

// --- קורא את ה-CSV ומחזיר [{ ticker, price }] ---
async function fetchSelfPrices() {
  const csvUrl = process.env.SHEET_CSV_URL;
  if (!csvUrl) throw new Error('SHEET_CSV_URL env is missing');

  const r = await fetch(csvUrl);
  if (!r.ok) throw new Error(`CSV fetch ${r.status}`);
  const text = await r.text();

  // parser פשוט עם תמיכה במרכאות
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"' && inQuotes && next === '"') { cell += '"'; i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { row.push(cell); cell = ''; continue; }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (cell.length || row.length) { row.push(cell); rows.push(row); row = []; cell = ''; }
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
      price:  r[iPrice] ? Number(String(r[iPrice]).replace(/,/g, '')) : null
    }))
    .filter(x => x.ticker);
}

// --- נרמול טיקרים: מסיר קידומות/סיומות נפוצות ומעלה לאותיות גדולות ---
const norm = (s) => String(s || '').trim().toUpperCase()
  .replace(/^(NASDAQ:|NYSE:|AMEX:|BATS:|TASE:|TLV:|LON:)/, '')
  .replace(/\.(US|TA|L|AX|TO|HK)$/, ''); // אפשר להרחיב לפי צורך

export default async function handler(req, res) {
  // אימות: או קריאת Cron של Vercel או Bearer secret
  const byCron = !!req.headers['x-vercel-cron'];
  const auth = req.headers.authorization?.split(' ')[1];
  if (!byCron && auth !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // נאפשר POST וגם GET (נוח לבדיקה עם dry_run)
  if (!['POST', 'GET', 'OPTIONS'].includes(req.method) && !byCron) {
    return res.status(405).json({ error: 'Use POST' });
  }

  // פרמטרים מה-URL בצורה בטוחה
  const url = new URL(req.url || '', 'http://localhost');
  const dry = url.searchParams.get('dry_run') === '1';
  const tickersParam = url.searchParams.get('tickers') || '';
  const filterTickers = tickersParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const allow = filterTickers.length ? new Set(filterTickers.map(norm)) : null;

  try {
    const { BASE44_APP_ID, BASE44_API_KEY } = process.env;
    if (!BASE44_APP_ID || !BASE44_API_KEY) throw new Error('Missing Base44 env');

    // 1) מחירים מה-CSV
    const prices = await fetchSelfPrices();
    const priceMap = new Map(prices.map(p => [norm(p.ticker), p.price]));

    // 2) קריאת רשומות Stock מ-Base44
    const listResp = await fetch(`${BASE44}/apps/${BASE44_APP_ID}/entities/Stock`, {
      headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' }
    });
    if (!listResp.ok) {
      throw new Error(`Base44 read failed ${listResp.status}: ${await listResp.text()}`);
    }
    const json = await listResp.json();
    const list = Array.isArray(json) ? json : (json.data || json.results || []);
    if (!Array.isArray(list)) {
      throw new Error('Unexpected Base44 list format');
    }

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
          headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ Price: newPrice })
        });
        if (put.ok) {
          updated++;
          await new Promise(r => setTimeout(r, 80)); // הגנה קלה מול Rate Limit
        } else {
          console.error('Update failed', rec.id, put.status, await put.text());
        }
      } else {
        updated++; // סימולציה
      }
    }

    return res.json({
      ok: true,
      updated,
      skipped: list.length - updated,
      breakdown: { notFound, nullPrice, unchanged },
      sample
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
}
