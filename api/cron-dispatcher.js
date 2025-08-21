// בתוך if (doPrices) { ... } ב- /api/cron-dispatcher.js
try {
  const base = process.env.PUBLIC_API_ORIGIN || '';
  const secret = process.env.SYNC_SECRET || '';

  // נניח בערך 2,600 – זה רק לצורך חלוקה לסגמנטים. אם בפועל יש פחות/יותר זה לא פוגע.
  const TOTAL_APPROX = 2600;
  const CHUNK_SIZE   = 150;   // המנה שאתה רוצה
  const PER_RUN      = 4;     // כמה מנות בכל ריצה (כל 15 דק') => 600 בכל ריצה
  const SEGMENT_SIZE = CHUNK_SIZE * PER_RUN;  // 600

  // חישוב "סגמנט" מתחלף לפי רבע-שעה כדי לכסות את הטווח לאורך הזמן
  const nowIL = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const slot  = Math.floor(nowIL.getMinutes() / 15);         // 0..3
  const segCount = Math.max(1, Math.ceil(TOTAL_APPROX / SEGMENT_SIZE)); // ≈5
  const segIndex = ((nowIL.getHours() * 4) + slot) % segCount;
  const baseOffset = segIndex * SEGMENT_SIZE;

  const offsets = Array.from({ length: PER_RUN }, (_, i) => baseOffset + i * CHUNK_SIZE);

  // מריצים את 4 הקריאות במקביל זהיר (או אחת אחרי השנייה – שניהם בסדר)
  await Promise.allSettled(
    offsets.map(off =>
      fetch(`${base}/api/sync-base44?limit=${CHUNK_SIZE}&offset=${off}&concurrency=8`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secret}`
        },
        body: '{}'
      })
    )
  );

  results.prices = { status: 200, detail: { baseOffset, offsets, chunk: CHUNK_SIZE } };
} catch (err) {
  results.prices = { error: String(err?.message || err) };
}
