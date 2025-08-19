// market-prices-api/api/send-email.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { RESEND_API_KEY, EMAIL_FROM, EMAIL_GATEWAY_SECRET } = process.env;
  if (!RESEND_API_KEY || !EMAIL_FROM || !EMAIL_GATEWAY_SECRET) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  const secret = req.headers['x-email-secret'];
  if (secret !== EMAIL_GATEWAY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { to, subject, html, text, cc, bcc, replyTo } = body || {};
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'Missing to/subject/html' });
  }

  const payload = {
    from: EMAIL_FROM,
    to: Array.isArray(to) ? to : [to],
    ...(cc ? { cc: Array.isArray(cc) ? cc : [cc] } : {}),
    ...(bcc ? { bcc: Array.isArray(bcc) ? bcc : [bcc] } : {}),
    subject,
    html,
    text: text ?? html.replace(/<[^>]+>/g, ' '),
    ...(replyTo ? { reply_to: replyTo } : {}),
  };

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const ok = resp.status >= 200 && resp.status < 300;
  const detail = await resp.text().catch(() => '');
  return res.status(ok ? 200 : resp.status).json(ok ? { ok: true } : { ok: false, detail });
}
