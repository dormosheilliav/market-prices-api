// api/email-self-test.js
// Self-test endpoint for email configuration on Vercel (Node runtime)
// Supports providers: resend, sendgrid
// Usage: GET /api/email-self-test?to=user@example.com  (falls back to EMAIL_OVERRIDE_TO if missing)

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const provider = process.env.EMAIL_PROVIDER;
    const fromEmail = process.env.EMAIL_FROM;
    const to = (req.query.to || process.env.EMAIL_OVERRIDE_TO || '').trim();

    if (!provider) return res.status(500).json({ error: 'EMAIL_PROVIDER not set' });
    if (!fromEmail) return res.status(500).json({ error: 'EMAIL_FROM not set' });
    if (!to) return res.status(400).json({ error: 'Missing "to" (query) or EMAIL_OVERRIDE_TO' });

    const subject = 'Email System Self-Test';
    const textBody =
      `This is a test email from your TradeJournal app.\n\n` +
      `Sent at: ${new Date().toISOString()}\n\n` +
      `If you receive this, your email configuration is working correctly!`;
    const htmlBody =
      `<h2>Email System Self-Test</h2>` +
      `<p>This is a test email from your TradeJournal app.</p>` +
      `<p><strong>Sent at:</strong> ${new Date().toISOString()}</p>` +
      `<p>If you receive this, your email configuration is working correctly! ✅</p>`;

    let result;

    if (provider === 'resend') {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY not set' });

      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,      // e.g. "Trading Journal <no-reply@yourdomain.com>"
          to: [to],
          subject,
          text: textBody,
          html: htmlBody,
        }),
      });

      const json = await r.json();
      if (!r.ok) {
        return res.status(r.status).json({ error: 'Resend API error', details: json });
      }
      result = json;
    } else if (provider === 'sendgrid') {
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'SENDGRID_API_KEY not set' });

      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: fromEmail }, // must be a verified sender/domain in SendGrid
          subject,
          content: [
            { type: 'text/plain', value: textBody },
            { type: 'text/html', value: htmlBody },
          ],
        }),
      });

      if (!r.ok) {
        const errText = await r.text();
        return res.status(r.status).json({ error: 'SendGrid API error', details: errText });
      }
      result = { success: true, provider: 'sendgrid' };
    } else {
      return res.status(400).json({ error: `Unsupported EMAIL_PROVIDER: ${provider}` });
    }

    return res.status(200).json({
      success: true,
      provider,
      sent_from: fromEmail,
      sent_to: to,
      result,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  }
}
