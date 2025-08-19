export default function handler(req, res) {
  const ok =
    !!process.env.RESEND_API_KEY &&
    !!process.env.EMAIL_FROM &&
    !!process.env.EMAIL_GATEWAY_SECRET;

  res.status(ok ? 200 : 500).json({
    ok,
    haveRESEND_API_KEY: !!process.env.RESEND_API_KEY,
    haveEMAIL_FROM: !!process.env.EMAIL_FROM,
    haveEMAIL_GATEWAY_SECRET: !!process.env.EMAIL_GATEWAY_SECRET
  });
}
