// /api/earnings.js — v3-optional-alpha (Finnhub works even without Alpha)
// ENV supported:
//   FINNHUB_API_KEY  (מומלץ; מחזיר גם BMO/AMC)
//   ALPHAVANTAGE_API_KEY או ALPHA_VANTAGE_KEY (אופציונלי)

function parseHorizon(h) {
  const v = (Array.isArray(h) ? h[0] : h) || "12m";
  const m = String(v).toLowerCase().trim();
  if (m.endsWith("w")) return parseInt(m, 10) * 7;
  if (m.endsWith("d")) return parseInt(m, 10);
  if (m.endsWith("m")) return parseInt(m, 10) * 30;
  if (!isNaN(Number(m))) return Number(m);
  return 365;
}
function alphaHorizon(days) { return days <= 100 ? "3month" : days <= 200 ? "6month" : "12month"; }
function toISODate(d) { return d.toISOString().slice(0, 10); }
function daysUntilUTC(dateStr) {
  if (!dateStr) return null;
  const event = new Date(dateStr + "T00:00:00Z");
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((event.getTime() - todayUTC.getTime()) / 86400000);
}
function quarterFromDate(s) {
  if (!s) return { q: null, y: null };
  const [y, m] = s.split("-").map(Number);
  return !y || !m ? { q: null, y: null } : { q: Math.floor((m - 1) / 3) + 1, y };
}
function parseCSV(text) {
  const rows = []; let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (c === '"') { if (inQuotes && next === '"') { field += '"'; i++; } else inQuotes = !inQuotes; }
    else if (c === ',' && !inQuotes) { row.push(field); field = ""; }
    else if ((c === '\n' || c === '\r') && !inQuotes) { if (field.length || row.length) { row.push(field); rows.push(row); } field = ""; row = []; if (c === '\r' && next === '\n') i++; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.some(x => x && x.trim() !== ""))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

// --------- Alpha Vantage (optional) ---------
async function fetchAlpha(symbol, days, fromISO, alphaKey) {
  if (!alphaKey) return null; // אופציונלי

  const calUrl = `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&symbol=${encodeURIComponent(symbol)}&horizon=${alphaHorizon(days)}&apikey=${alphaKey}`;
  const lastUrl = `https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(symbol)}&apikey=${alphaKey}`;

  const [calResp, lastResp] = await Promise.all([fetch(calUrl), fetch(lastUrl)]);
  const calText = await calResp.text();
  if (!calResp.ok || calText.trim().startsWith("{")) return null; // שגיאה/Rate limit

  const rows = parseCSV(calText);
  rows.sort((a, b) => (a.reportDate > b.reportDate ? 1 : -1));
  const nearest = rows.find(x => x.reportDate >= fromISO) || rows[0];

  let next = null;
  if (nearest) {
    const { q, y } = quarterFromDate(nearest.fiscalDateEnding);
    next = {
      date: nearest.reportDate || null,
      whenShort: "UNKNOWN", whenLabel: "Unknown",
      epsEstimate: nearest.estimate ? Number(nearest.estimate) : null,
      quarter: q, year: y,
      daysUntilUTC: nearest.reportDate ? daysUntilUTC(nearest.reportDate) : null,
      source: "alpha_vantage",
    };
  }

  let last = {};
  try {
    const lastJson = await lastResp.json();
    const qs = Array.isArray(lastJson?.quarterlyEarnings) ? lastJson.quarterlyEarnings : [];
    if (qs.length) {
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
  } catch { /* ignore */ }

  return { next, last };
}

// --------- Finnhub (preferred if available) ---------
async function fetchFinnhub(symbol, days, fromISO, finKey) {
  if (!finKey) return null;

  const toISO = toISODate(new Date(new Date(fromISO).getTime() + days * 86400000));
  const calUrl = `https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${fromISO}&to=${toISO}&token=${finKey}`;
  const lastUrl = `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(symbol)}&token=${finKey}`;

  const [calResp, lastResp] = await Promise.all([fetch(calUrl), fetch(lastUrl)]);
  if (!calResp.ok) return null;

  const calJson = await calResp.json();
  const list = Array.isArray(calJson?.earningsCalendar) ? calJson.earningsCalendar : [];
  list.sort((a, b) => (a.date > b.date ? 1 : -1));
  const nearest = list.find(x => x.date >= fromISO) || list[0];

  let next = null;
  if (nearest) {
    const hour = String(nearest.hour || "unknown").toUpperCase();
    const whenShort = hour === "BMO" ? "BMO" : hour === "AMC" ? "AMC" : "UNKNOWN";
    const whenLabel = whenShort === "BMO" ? "Before Market" : whenShort === "AMC" ? "After Market" : "Unknown";
    next = {
      date: nearest.date || null,
      whenShort, whenLabel,
      epsEstimate: nearest.epsEstimate ?? null,
      quarter: nearest.quarter ?? null,
      year: nearest.year ?? null,
      daysUntilUTC: nearest.date ? daysUntilUTC(nearest.date) : null,
      source: "finnhub",
    };
  }

  let last = {};
  if (lastResp.ok) {
    const lastJson = await lastResp.json();
    const arr = Array.isArray(lastJson) ? lastJson : [];
    if (arr.length) {
      arr.sort((a, b) => (a.period > b.period ? -1 : 1));
      const r = arr[0];
      last = {
        period: r?.period ?? null,
        actual: r?.actual ?? null,
        estimate: r?.estimate ?? null,
        surprise: r?.surprise ?? null,
        surprisePercent: r?.surprisePercent ?? null,
      };
    }
  }

  return { next, last };
}

export default async function handler(req, res) {
  const ALLOW = "*";
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", ALLOW);
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(200).end(); return;
  }
  res.setHeader("Access-Control-Allow-Origin", ALLOW);
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const symParam = req.query.symbol;
    if (!symParam || (Array.isArray(symParam) && !symParam[0])) {
      res.status(400).json({ error: "Missing ?symbol=AAPL" }); return;
    }
    const symbol = Array.isArray(symParam) ? symParam[0] : symParam;

    const days = parseHorizon(req.query.horizon);
    const fromISO = toISODate(new Date());

    // קרא מפתחות פעם אחת — כדי שלא יהיו חריגות על "Missing …"
    const FIN_KEY = process.env.FINNHUB_API_KEY || "";
    const ALPHA_KEY = process.env.ALPHAVANTAGE_API_KEY || process.env.ALPHA_VANTAGE_KEY || "";

    const [alphaData, finnhubData] = await Promise.all([
      fetchAlpha(symbol, days, fromISO, ALPHA_KEY),
      fetchFinnhub(symbol, days, fromISO, FIN_KEY)
    ]);

    if (!alphaData && !finnhubData) {
      res.status(500).json({ error: "No data providers available (missing API keys)" });
      return;
    }

    const candidates = [];
    if (alphaData?.next?.date) candidates.push(alphaData.next);
    if (finnhubData?.next?.date) candidates.push(finnhubData.next);

    let chosenNext = { date: null, whenShort: "UNKNOWN", whenLabel: "Unknown", source: null };
    if (candidates.length) {
      candidates.sort((a, b) => (a.date > b.date ? 1 : -1)); // בוחר את המוקדם
      chosenNext = candidates[0];
    }

    const last = (finnhubData && Object.keys(finnhubData.last || {}).length)
      ? finnhubData.last
      : (alphaData?.last || {});

    // *** CHANGED: קאש יומי, עם SWR ארוך
res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=86400");

    res.status(200).json({
      version: "v3-optional-alpha",
      providers: { haveFinnhub: !!FIN_KEY, haveAlpha: !!ALPHA_KEY },
      symbol,
      asOf: new Date().toISOString(),
      next: chosenNext,
      last,
      sources: {
        alpha_vantage: alphaData?.next?.date || null,
        finnhub: finnhubData?.next?.date || null
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Unexpected server error", detail: String(err?.message || err) });
  }
}
