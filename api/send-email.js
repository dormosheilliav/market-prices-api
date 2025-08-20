export default async function handler(req, res) {
  // ===== OPTIONAL GET TEST (browser) =====
  if (req.method === 'GET') {
    if (process.env.ALLOW_GET_EMAIL_TEST !== 'true') {
      return res.status(403).json({ error: 'GET test is disabled' });
    }
    const secret = req.query.secret;
    if (secret !== process.env.EMAIL_GATEWAY_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const to = req.query.to || 'you@example.com';
    const subject = req.query.subject || 'Gateway Test (GET)';
    const html = `<h1>Test ✅</h1><p>GET test email from gateway.</p>`;

    const { RESEND_API_KEY, EMAIL_FROM } = process.env;
    if (!RESEND_API_KEY || !EMAIL_FROM) {
      return res.status(500).json({ error: 'Missing env vars' });
    }

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject,
        html,
        text: html.replace(/<[^>]+>/g, ' ')
      }),
    });

    const ok = resp.status >= 200 && resp.status < 300;
    const detail = await resp.text().catch(() => '');
    return res.status(ok ? 200 : resp.status).json(ok ? { ok: true } : { ok: false, detail });
  }
  // ===== END GET TEST =====

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST', 'GET']);
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
