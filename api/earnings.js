// /api/earnings.js — Vercel Serverless Function (Finnhub)
// ENV חובה: FINNHUB_API_KEY

function parseHorizon(h) {
  const v = (Array.isArray(h) ? h[0] : h) || "6m"; // ברירת מחדל נדיבה
  const m = String(v).toLowerCase().trim();
  if (m.endsWith("w")) return parseInt(m, 10) * 7;
  if (m.endsWith("d")) return parseInt(m, 10);
  if (m.endsWith("m")) return parseInt(m, 10) * 30;
  if (!isNaN(Number(m))) return Number(m);
  return 180;
}

function toISODate(d) { return d.toISOString().slice(0, 10); }
function daysUntilUTC(dateStr) {
  if (!dateStr) return null;
  const event = new Date(dateStr + "T00:00:00Z");
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((event.getTime() - todayUTC.getTime()) / 86400000);
}
function mapWhen(hour) {
  const h = String(hour || "unknown").toLowerCase();
  if (h === "bmo") return { whenShort: "BMO", whenLabel: "Before Market" };
  if (h === "amc") return { whenShort: "AMC", whenLabel: "After Market" };
  return { whenShort: "UNKNOWN", whenLabel: "Unknown" };
}

export default async function handler(req, res) {
  const ALLOW = "*"; // אפשר להגביל לדומיין ה-Base44 שלך
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", ALLOW);
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(200).end(); return;
  }
  res.setHeader("Access-Control-Allow-Origin", ALLOW);
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const symbolParam = req.query.symbol;
    if (!symbolParam || (Array.isArray(symbolParam) && !symbolParam[0])) {
      res.status(400).json({ error: "Missing ?symbol=AAPL" }); return;
    }
    const symbol = Array.isArray(symbolParam) ? symbolParam[0] : symbolParam;
    const horizonDays = parseHorizon(req.query.horizon);
    const token = process.env.FINNHUB_API_KEY;
    if (!token) { res.status(500).json({ error: "Missing FINNHUB_API_KEY env var" }); return; }

    const now = new Date();
    const from = toISODate(now);
    const to = toISODate(new Date(now.getTime() + horizonDays * 86400000));

    const calUrl = `https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${token}`;
    const lastUrl = `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(symbol)}&token=${token}`;

    const [calResp, lastResp] = await Promise.all([fetch(calUrl), fetch(lastUrl)]);
    if (!calResp.ok) { res.status(502).json({ error: "Earnings calendar fetch failed", detail: await calResp.text() }); return; }
    if (!lastResp.ok) { res.status(502).json({ error: "Earnings last results fetch failed", detail: await lastResp.text() }); return; }

    const calJson = await calResp.json();   // { earningsCalendar: [...] }
    const lastJson = await lastResp.json(); // array

    // האירוע הקרוב
    const list = Array.isArray(calJson?.earningsCalendar) ? calJson.earningsCalendar : [];
    let next = { date: null, whenShort: "UNKNOWN", whenLabel: "Unknown", epsEstimate: null, quarter: null, year: null, daysUntilUTC: null };
    if (list.length) {
      list.sort((a,b)=> (a.date > b.date ? 1 : -1));
      const nearest = list.find(x => x.date >= from) || list[0];
      const mapped = mapWhen(nearest?.hour);
      next = {
        date: nearest?.date || null,
        whenShort: mapped.whenShort,
        whenLabel: mapped.whenLabel,
        epsEstimate: nearest?.epsEstimate ?? null,
        quarter: nearest?.quarter ?? null,
        year: nearest?.year ?? null,
        daysUntilUTC: nearest?.date ? daysUntilUTC(nearest.date) : null,
      };
    }

    // התוצאות האחרונות
    let last = {};
    const arr = Array.isArray(lastJson) ? lastJson : [];
    if (arr.length) {
      arr.sort((a,b)=> (a.period > b.period ? -1 : 1));
      const r = arr[0];
      last = {
        period: r?.period ?? null,
        actual: r?.actual ?? null,
        estimate: r?.estimate ?? null,
        surprise: r?.surprise ?? null,
        surprisePercent: r?.surprisePercent ?? null,
      };
    }

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({ symbol, asOf: new Date().toISOString(), next, last });
  } catch (err) {
    res.status(500).json({ error: "Unexpected server error", detail: String(err?.message || err) });
  }
}
