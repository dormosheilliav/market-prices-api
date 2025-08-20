// /api/cron-dispatcher.js  (ESM)
export default async function handler(req, res) {
  const isCron = !!req.headers['x-vercel-cron'];

  // Base URL אמין לריצה בסרוור
  const baseOrigin =
    (process.env.PUBLIC_API_ORIGIN && process.env.PUBLIC_API_ORIGIN.trim()) ||
    `${(req.headers['x-forwarded-proto'] || 'https')}://${req.headers.host}`;

  // שעה ישראלית
  const nowIL = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const hh = nowIL.getHours();
  const mm = nowIL.getMinutes();
  const cur = hh * 60 + mm;

  const TOL = 8; // דק׳
  const within = (H, M, tol = TOL) => Math.abs(cur - (H * 60 + M)) <= tol;

  const doPrices   = within(16, 30) || within(20, 0) || within(23, 0); // 16:30, 20:00, 23:00 IL
  const doEarnings = within(18, 0);                                     // 18:00 IL

  const results = {};

  if (doPrices) {
    try {
      const r = await fetch(`${baseOrigin}/api/sync-base44?max_updates=300&concurrency=8`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SYNC_SECRET || ''}`
        },
        body: JSON.stringify({})
      });
      const txt = await r.text();
      results.prices = { status: r.status, body: safeJson(txt) };
    } catch (err) {
      results.prices = { error: String(err?.message || err) };
    }
  }

  if (doEarnings) {
    try {
      const r = await fetch(`${baseOrigin}/api/tasks/refresh-earnings?batch=60&horizon=12m`, { method: 'POST' });
      const txt = await r.text();
      results.earnings = { status: r.status, body: safeJson(txt) };
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

function safeJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return s; }
}
