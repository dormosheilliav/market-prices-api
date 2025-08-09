// api/sync-base44.js
const BASE44 = 'https://app.base44.com/api';

async function fetchSelfPrices(req) {
  // משתמשים ב-API /api/prices שכבר בנית — כדי לא לכתוב שוב פרסור CSV
  const self = process.env.SELF_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  const r = await fetch(`${self}/api/prices`);
  if (!r.ok) throw new Error(`prices endpoint ${r.status}`);
  const j = await r.json();
  return j.data || []; // [{ticker, price}, ...]
}

export default async function handler(req, res) {
  // הגנות: מותר או ע"י Cron של Vercel, או עם סוד SYNC_SECRET (Header או query)
  const byCron = !!req.headers['x-vercel-cron'];
  const auth = req.headers.authorization?.split(' ')[1];
  const urlSecret = req.query.secret;
  if (!byCron && auth !== process.env.SYNC_SECRET && urlSecret !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST' && !byCron) return res.status(405).json({ error: 'Use POST' });

  try {
    const { BASE44_APP_ID, BASE44_API_KEY } = process.env;
    if (!BASE44_APP_ID || !BASE44_API_KEY) throw new Error('Missing Base44 env');

    // 1) מחירים עדכניים
    const prices = await fetchSelfPrices(req);
    const priceMap = new Map(prices.map(p => [String(p.ticker).toUpperCase(), p.price]));

    // 2) כל רשומות ה-Stock
    const list = await fetch(`${BASE44}/apps/${BASE44_APP_ID}/entities/Stock`, {
      headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' }
    }).then(r => r.json());

    // 3) עדכונים לפי התאמת Ticker
    let updated = 0, skipped = 0;
    for (const rec of list) {
      const t = String(rec.Ticker || '').toUpperCase();
      if (!t || !priceMap.has(t)) { skipped++; continue; }

      const newPrice = priceMap.get(t);
      if (newPrice == null || Number(rec.Price) === Number(newPrice)) { skipped++; continue; }

      const resp = await fetch(`${BASE44}/apps/${BASE44_APP_ID}/entities/Stock/${rec.id}`, {
        method: 'PUT',
        headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ Price: newPrice })
      });
      if (resp.ok) { updated++; await new Promise(r => setTimeout(r, 120)); }
      else console.error('Update failed', rec.id, await resp.text());
    }

    res.json({ ok: true, updated, skipped });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
}
