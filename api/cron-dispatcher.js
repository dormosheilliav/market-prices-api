// api/cron-dispatcher.js
export default async function handler(req, res) {
  // Base URL (חייב מוחלט ל-fetch בצד שרת)
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const BASE  = (process.env.PUBLIC_API_ORIGIN && process.env.PUBLIC_API_ORIGIN.trim())
    || `${proto}://${host}`;

  const isCron = !!req.headers['x-vercel-cron'];

  // שעה בישראל
  const nowIL = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const hh = nowIL.getHours(), mm = nowIL.getMinutes(), cur = hh*60+mm;
  const TOL = 8; // טולרנס
  const within = (H,M,t=TOL)=>Math.abs(cur-(H*60+M))<=t;

  const doPrices   = within(16,30) || within(20,0) || within(23,0);
  const doEarnings = within(13,0); // התאמת שעת הרצת-דוחות אם תרצה

  const results = {};

  if (doPrices) {
    try {
      const r = await fetch(`${BASE}/api/sync-base44?max_updates=300&concurrency=8`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SYNC_SECRET || ''}`, // חייב להתאים למה שב- /api/sync-base44
        },
        body: JSON.stringify({})
      });
      const txt = await r.text();
      results.prices = { status: r.status, body: tryJson(txt) };
    } catch (err) {
      results.prices = { error: String(err?.message || err) };
    }
  }

  if (doEarnings) {
    try {
      const r = await fetch(`${BASE}/api/earnings?symbol=AAPL`);
      const txt = await r.text();
      results.earnings = { status: r.status, body: tryJson(txt) };
    } catch (err) {
      results.earnings = { error: String(err?.message || err) };
    }
  }

  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    ok: true,
    isCron,
    nowIL: nowIL.toISOString(),
    triggered: { prices: !!doPrices, earnings: !!doEarnings },
    results
  });
}

function tryJson(s){ try{return s?JSON.parse(s):null;} catch {return s;} }
