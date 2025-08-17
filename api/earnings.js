// /api/earnings.js — Alpha Vantage
// ENV חובה: ALPHAVANTAGE_API_KEY

function parseHorizon(h) {
  const v = (Array.isArray(h) ? h[0] : h) || "6m";
  const m = String(v).toLowerCase().trim();
  if (m.endsWith("w")) return parseInt(m, 10) * 7;
  if (m.endsWith("d")) return parseInt(m, 10);
  if (m.endsWith("m")) return parseInt(m, 10) * 30;
  if (!isNaN(Number(m))) return Number(m);
  return 180; // ברירת מחדל
}
function alphaHorizon(days) {
  if (days <= 100) return "3month";
  if (days <= 200) return "6month";
  return "12month";
}
function toISODate(d) { return d.toISOString().slice(0, 10); }
function daysUntilUTC(dateStr) {
  if (!dateStr) return null;
  const event = new Date(dateStr + "T00:00:00Z");
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((event.getTime() - todayUTC.getTime()) / 86400000);
}
function quarterFromDate(yyyy_mm_dd) {
  if (!yyyy_mm_dd) return { q: null, y: null };
  const [y, m] = yyyy_mm_dd.split("-").map(Number);
  if (!y || !m) return { q: null, y: null };
  const q = Math.floor((m - 1) / 3) + 1;
  return { q, y };
}

export default async function handler(req, res) {
  const ALLOW = "*"; // אפשר לשים פה את דומיין ה-Base44 שלך
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

    const key = process.env.ALPHAVANTAGE_API_KEY;
    if (!key) { res.status(500).json({ error: "Missing ALPHAVANTAGE_API_KEY env var" }); return; }

    const days = parseHorizon(req.query.horizon);
    const now = new Date();
    const from = toISODate(now); // להשוואה (למרות שה-API לא מקבל from)
    const h = alphaHorizon(days);

    const calUrl = `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&symbol=${encodeURIComponent(symbol)}&horizon=${h}&apikey=${key}`;
    const lastUrl = `https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(symbol)}&apikey=${key}`;

    const [calResp, lastResp] = await Promise.all([fetch(calUrl), fetch(lastUrl)]);

    const calJson = await calResp.json();
    if (!calResp.ok || calJson?.Note || calJson?.Information || calJson?.["Error Message"]) {
      res.status(502).json({ error: "EARNINGS_CALENDAR failed", detail: calJson?.Note || calJson?.Information || calJson?.["Error Message"] || (await calResp.text()) });
      return;
    }
    const lastJson = await lastResp.json();
    if (!lastResp.ok || lastJson?.Note || lastJson?.Information || lastJson?.["Error Message"]) {
      res.status(502).json({ error: "EARNINGS failed", detail: lastJson?.Note || lastJson?.Information || lastJson?.["Error Message"] || (await lastResp.text()) });
      return;
    }

    // ---- הקרוב הבא ----
    const list = Array.isArray(calJson?.earningsCalendar) ? calJson.earningsCalendar : [];
    let next = { date: null, whenShort: "UNKNOWN", whenLabel: "Unknown", epsEstimate: null, quarter: null, year: null, daysUntilUTC: null };
    if (list.length) {
      // reportDate ascending
      list.sort((a, b) => (a.reportDate > b.reportDate ? 1 : -1));
      const nearest = list.find(x => x.reportDate >= from) || list[0];
      const { q, y } = quarterFromDate(nearest?.fiscalDateEnding);
      next = {
        date: nearest?.reportDate || null,
        whenShort: "UNKNOWN",      // Alpha Vantage לא מחזיר BMO/AMC
        whenLabel: "Unknown",
        epsEstimate: nearest?.estimate != null ? Number(nearest.estimate) : null,
        quarter: q,
        year: y,
        daysUntilUTC: nearest?.reportDate ? daysUntilUTC(nearest.reportDate) : null,
      };
    }

    // ---- התוצאות האחרונות ----
    let last = {};
    const qs = Array.isArray(lastJson?.quarterlyEarnings) ? lastJson.quarterlyEarnings : [];
    if (qs.length) {
      // חדש ביותר לפי reportedDate
      qs.sort((a, b) => (a.reportedDate > b.reportedDate ? -1 : 1));
      const r = qs[0];
      last = {
        period: r?.fiscalDateEnding ?? null,
        actual: r?.reportedEPS != null ? Number(r.reportedEPS) : null,
        estimate: r?.estimatedEPS != null ? Number(r.estimatedEPS) : null,
        surprise: r?.surprise != null ? Number(r.surprise) : null,
        surprisePercent: r?.surprisePercentage != null ? Number(r.surprisePercentage) : null,
      };
    }

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({ symbol, asOf: new Date().toISOString(), next, last });
  } catch (err) {
    res.status(500).json({ error: "Unexpected server error", detail: String(err?.message || err) });
  }
}
