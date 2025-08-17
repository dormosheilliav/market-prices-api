
import fetch from "node-fetch"; // אם Node < 18, אחרת ניתן להשתמש ב fetch מובנה

export default async function handler(req, res) {
  // מקבל את הפרמטרים מה‑URL
  const symbol = req.query.symbol || "GOOGL";
  const horizon = req.query.horizon || "3month";

  // מקבל את המפתח מה‑Environment Variables של Vercel
  const API_KEY = process.env.ALPHA_VANTAGE_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: "Alpha Vantage API key is missing" });
  }

  // URL ל‑Alpha Vantage API
  const url = `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&symbol=${symbol}&horizon=${horizon}&apikey=${API_KEY}`;

  try {
    const response = await fetch(url);
    const data = await response.text(); // מקבל CSV
    res.status(200).send(data); // מחזיר CSV ישירות
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
