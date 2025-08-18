// /api/earnings.js — Cross-check: Alpha Vantage (CSV) + Finnhub (JSON)
// ENV:
//   - ALPHAVANTAGE_API_KEY או ALPHA_VANTAGE_KEY  (נדרש ל-Alpha Vantage)
//   - FINNHUB_API_KEY (אופציונלי; אם קיים נקבל BMO/AMC ונעדיף תאריך מדויק יותר)

function parseHorizon(h) {
  const v = (Array.isArray(h) ? h[0] : h) || "12m";
  const m = String(v).toLowerCase().trim();
  if (m.endsWith("w")) return parseInt(m, 10) * 7;
  if (m.endsWith("d")) return parseInt(m, 10);
  if (m.endsWith("m")) return parseInt(m, 10) * 30;
  if (!isNaN(Number(m))) return Number(m);
  return 365;
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
  return { q: Math.floor((m - 1) / 3) + 1, y };
}

// CSV parser קטן (תומך במרכאות)
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (c === '"') { if (inQuotes && next === '"') { field += '"'; i++; } else inQuotes = !inQuotes; }
    else if (c === ',' && !inQuotes) { row.push(field); field = ""; }
    else if ((c === '\n' || c === '\r') && !inQuotes) {
      if (field.length || row.length) { row.push(field); rows.push(row); }
      field = ""; row = []; if (c === '\r' && next === '\n') i++;
    } else { field += c; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1)
    .filter(r => r.some(x => x && x.trim() !== ""))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

// ------- Alpha Vantage (Calendar=CSV, Earnings=JSON) -------
async function fetchAlpha(symbol, days, fromISO) {
  const key = process.env.ALPHAVANTAGE_API_KEY || process.env.ALPHA_VANTAGE_KEY;
  if (!key) throw new Error("Missing ALPHAVANTAGE_API_KEY or ALPHA_VANTAGE_KEY env var");

  const horizonStr = alphaHorizon(days);
  const calUrl = `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&symbol=${encodeURIComponent(symbol)}&horizon=${horizonStr}&apikey=${key}`;
  const lastUrl = `https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(symbol)}&apikey=${key}`;

  const [calResp, lastResp] = await Promise.all([fetch(calUrl), fetch(lastUrl)]);

  const calText = await calResp.text();
  if (!calResp.ok) throw new Error(`EARNINGS_CALENDAR failed: ${calText}`);
  if (calText.trim().startsWith("{")) {
    const err = JSON.parse(calText);
    throw new Error(err.Note || err.Information || err["Error Message"] || "Alpha calendar error");
  }
  const rows = parseCSV(calText); // [{symbol,name,reportDate,fiscalDateEnding,estimate,currency}, ...]
  rows.sort((a, b) => (a.reportDate > b.reportDate ? 1 : -1));
  const nearest = rows.find(x => x.reportDate >= fromISO) || rows[0];

  const { q, y } = quarterFromDate(nearest?.fiscalDateEnding);
  const next = nearest ? {
    date: nearest.reportDate || null,
    whenShort: "UNKNOWN",
    whenLabel: "Unknown",
    epsEstimate: nearest.estimate ? Number(nearest.estimate) : null,
    quarter: q, year: y,
    daysUntilUTC: nearest.reportDate ? daysUntilUTC(nearest.reportDate) : null,
    source: "alpha_vantage",
  } : { date: null, whenShort: "UNKNOWN", whenLabel: "Unknown", source: "alpha_vantage" };

  // last (רבעון אחרון) מ-alpha (JSON)
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

// ------- Finnhub (אם יש מפתח) -------
async function fetchFinnhub(symbol, days, fromISO) {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) return null;

  const toISO = toISODate(new Date(new Date(fromISO).getTime() + days * 86400000));
  const calUrl = `https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${fromISO}&to=${toISO}&token=${token}`;
  const lastUrl = `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(symbol)}&token=${token}`;

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

    // 1) Alpha (חובה) + 2) Finnhub (אם קיים KEY)
    const [alphaData, finnhubData] = await Promise.all([
      fetchAlpha(symbol, days, fromISO),
      fetchFinnhub(symbol, days, fromISO)
    ]);

    // בחירת התאריך המוקדם בין הספקים
    const candidates = [];
    if (alphaData?.next?.date) candidates.push({ provider: "alpha_vantage", ...alphaData.next });
    if (finnhubData?.next?.date) candidates.push({ provider: "finnhub", ...finnhubData.next });

    let chosenNext = { date: null, whenShort: "UNKNOWN", whenLabel: "Unknown", source: null };
    if (candidates.length) {
      candidates.sort((a, b) => (a.date > b.date ? 1 : -1));
      chosenNext = candidates[0];
    }

    // העדפת last מ-Finnhub אם קיים; אחרת Alpha
    const last = (finnhubData && Object.keys(finnhubData.last || {}).length)
      ? finnhubData.last
      : alphaData.last;

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({
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
