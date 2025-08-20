// api/tasks/refresh-earnings.js
// *** NEW ***
// מריץ "חימום" של קאש הדוחות לכל הטיקרים, במנות קטנות, כדי שלא יהיה TIMEOUT.
// מקורות לטיקרים: Base44 (entities/Stock) או Fallback מ-ENV EARNINGS_SYMBOLS.
// דורש ENV: SELF_BASE_URL (https://market-prices-api.vercel.app), ובמידת הצורך BASE44_APP_ID/BASE44_API_KEY.

const BASE44 = 'https://app.base44.com/api';

export default async function handler(req, res) {
  // להרצה ע״י Cron של Vercel מותר גם ללא POST
  const byCron = !!req.headers['x-vercel-cron'];
  if (!['GET','POST'].includes(req.method) && !byCron) {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const start = Date.now();
  const MAX_MS = 55_000;                        // נעצור לפני 60ש׳׳נ
  const selfBase = (process.env.SELF_BASE_URL || '').trim();
  if (!selfBase) {
    return res.status(500).json({ error: 'Missing SELF_BASE_URL env' });
  }

  const url = new URL(req.url || '', 'http://localhost');
  const cursor = Number(url.searchParams.get('cursor') || '0');
  const batchSize = Number(url.searchParams.get('batch') || '60'); // כמה טיקרים בכל ריצה
  const horizon = url.searchParams.get('horizon') || '12m';

  try {
    const allSymbols = await getAllSymbols();
    const slice = allSymbols.slice(cursor, cursor + batchSize);

    let ok = 0, fail = 0;
    for (const sym of slice) {
      try {
        // קריאה לנתיב שלך שמחשב ומחזיר JSON עם Cache-Control
        await fetch(`${selfBase}/api/earnings?symbol=${encodeURIComponent(sym)}&horizon=${encodeURIComponent(horizon)}`);
        ok++;
      } catch {
        fail++;
      }
      if (Date.now() - start > MAX_MS) break;
    }

    const nextCursor = cursor + slice.length;
    const done = nextCursor >= allSymbols.length;

    if (!done) {
      // מזמן את עצמו להמשך (ללא תלות ב-CRON)
      const nextUrl = `${selfBase}/api/tasks/refresh-earnings?cursor=${nextCursor}&batch=${batchSize}&horizon=${encodeURIComponent(horizon)}`;
      // אין צורך להמתין לתשובה
      fetch(nextUrl).catch(() => {});
    }

    return res.status(200).json({
      ok: true,
      processed: slice.length,
      okCount: ok,
      failCount: fail,
      nextCursor,
      total: allSymbols.length,
      done
    });

  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

// --- מקורות לטיקרים ---
async function getAllSymbols() {
  // 1) מ-Base44 אם יש הרשאות
  const { BASE44_APP_ID, BASE44_API_KEY } = process.env;
  if (BASE44_APP_ID && BASE44_API_KEY) {
    const r = await fetch(`${BASE44}/apps/${BASE44_APP_ID}/entities/Stock`, {
      headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' }
    });
    if (r.ok) {
      const json = await r.json();
      const list = Array.isArray(json) ? json : (json.data || json.results || []);
      const set = new Set();
      for (const rec of list) {
        const t = normalizeTicker(rec?.Ticker);
        if (t) set.add(t);
      }
      if (set.size) return Array.from(set);
    }
  }

  // 2) Fallback: ENV עם קומות, למשל: AAPL,MSFT,NVDA
  const envList = (process.env.EARNINGS_SYMBOLS || '')
      .split(',').map(s => normalizeTicker(s)).filter(Boolean);
  if (envList.length) return envList;

  // 3) ברירת מחדל קטנה שלא תייצר עומס
  return ['AAPL','MSFT','NVDA'];
}

function normalizeTicker(s) {
  return String(s || '').trim().toUpperCase()
    .replace(/^(NASDAQ:|NYSE:|AMEX:|BATS:|TASE:|TLV:|LON:)/,'')
    .replace(/\.(US|TA|L|AX|TO|HK)$/,'');
}
