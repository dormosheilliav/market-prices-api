// pages/api/earnings.js
import fetch from "node-fetch";

export default async function handler(req, res) {
  const symbol = req.query.symbol || "GOOGL";
  const horizon = req.query.horizon || "3month";
  const API_KEY = process.env.ALPHA_VANTAGE_KEY;

  const url = `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&symbol=${symbol}&horizon=${horizon}&apikey=${API_KEY}`;

  try {
    const response = await fetch(url);
    const data = await response.text(); // CSV

    res.status(200).send(data); // מחזיר CSV ל‑Front-End
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
