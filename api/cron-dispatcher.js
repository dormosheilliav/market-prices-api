// api/cron-dispatcher.js  (ESM)
export default async function handler(req, res) {
  // לזיהוי קריאת cron של Vercel (לא חובה, אבל טוב ללוגיקה/אבטחה)
  const isCron = !!req.headers['x-vercel-cron'];

  // פונקציה לקבל תאריך "עכשיו" לפי Asia/Jerusalem, כולל DST
  const nowIL = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const hh    = nowIL.getHours();
  const mm    = nowIL.getMinutes();
  const cur   = hh * 60 + mm;

  // מרווח סבילות סביב הזמן היעד (דקות)
  const TOL = 8; // ריצה כל 15 דק' → 8 דק' מכסה יפה

  const within = (H, M, tol = TOL) => Math.abs(cur - (H * 60 + M)) <= tol;

  const doPrices =
      within(16, 30) || // 16:30 IL
      within(20,  0) || // 20:00 IL
      within(23,  0);   // 23:00 IL

  const doEarnings = within(18, 0); // 18:00 IL, פעם ביום

  const results = {};

  // ---- סנכרון מחירים ----
  if (doPrices) {
    try {
      const r = await fetch(`${process.env.PUBLIC_API_ORIGIN || ''}/api/sync-base44?max_updates=300&concurrency=8`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // אותו secret שכבר הגדרת ומשמש את sync-base44
          'Authorization': `Bearer ${process.env.SYNC_SECRET || ''}`
        },
        // אפשר להעביר body אם תרצה פרמטרים נוספים
        body: JSON.stringify({})
      });
      const txt = await r.text();
      results.prices = { status: r.status, body: tryJson(txt) };
    } catch (err) {
      results.prices = { error: String(err?.message || err) };
    }
  }

  // ---- דוחות רבעוניים (placeholder) ----
  if (doEarnings) {
    // כאן חבר כשתהיה פונקציית batch לדוחות (למשל /api/earnings-batch).
    // כרגע נשמור פינג פשוט כדי לראות שזה רץ.
    try {
      const ping = await fetch(`${process.env.PUBLIC_API_ORIGIN || ''}/api/earnings?symbol=AAPL`);
      const txt  = await ping.text();
      results.earnings = { status: ping.status, body: tryJson(txt) };
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

function tryJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return s; }
}
