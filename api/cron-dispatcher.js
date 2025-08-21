// api/cron-dispatcher.js
export default async function handler(req, res) {
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const BASE  = (process.env.PUBLIC_API_ORIGIN && process.env.PUBLIC_API_ORIGIN.trim())
    || `${proto}://${host}`;

  const isCron = !!req.headers['x-vercel-cron'];

  // שעה בישראל
  const nowIL = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const hh = nowIL.getHours(), mm = nowIL.getMinutes(), cur = hh*60+mm;
  const TOL = 8;
  const within = (H, M, t=TOL) => Math.abs(cur - (H*60 + M)) <= t;

  // ברירת מחדל: מחירים בערב, דוחות ב-13:00
  let doPrices   = within(16,30) || within(20,0) || within(23,0);
  let doEarnings = within(13,0);

  // ---- פרמטרים לבדיקות ידניות ----
  const url = new URL(req.url || '', 'http://local');
  const force = url.searchParams.get('force'); // "prices" | "earnings"
  const dry   = url.searchParams.get('dry') === '1'; // אל תריץ, רק דווח

  if (force === 'prices')   { doPrices = true;  doEarnings = false; }
  if (force === 'earnings') { doPrices = false; doEarnings = true;  }

  const results = {};
  if (doPrices && !dry) {
    try {
      const r = await fetch(`${BASE}/api/sync-base44?max_updates=300&concurrency=8`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SYNC_SECRET || ''}` },
        body: JSON.stringify({})
      });
      const txt = await r.text();
      results.prices = { status: r.status, body: tryJson(txt) };
    } catch (err) { results.prices = { error: String(err?.message || err) }; }
  }

  if (doEarnings && !dry) {
    try {
      // אם אתה משתמש ב"החימום" – תוכל להחליף ל /api/tasks/refresh-earnings
      const r = await fetch(`${BASE}/api/earnings?symbol=AAPL`);
      const txt = await r.text();
      results.earnings = { status: r.status, body: tryJson(txt) };
    } catch (err) { results.earnings = { error: String(err?.message || err) }; }
  }

  res.setHeader('Content-Type','application/json');
  res.status(200).json({
    ok: true, isCron,
    nowIL: nowIL.toISOString(),
    triggered: { prices: !!doPrices, earnings: !!doEarnings },
    dry, force, results
  });
}
function tryJson(s){ try{return s?JSON.parse(s):null;} catch {return s;} }
