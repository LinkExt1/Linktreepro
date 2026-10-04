const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { getAdminApp, getClientIp, handleCors, verifyBearerUser, enforceRateLimit } = require('./_security');

function hash(v) {
  return crypto.createHash('sha256').update(`${process.env.RATE_LIMIT_SALT || 'linkext'}:${v}`).digest('hex');
}

function generateOtp5() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  const bytes = crypto.randomBytes(5);
  for (let i = 0; i < 5; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

function getMailConfig() {
  const user = process.env.EMAIL_USER || process.env.SMTP_USER || process.env.GMAIL_SMTP_USER;
  const pass = process.env.EMAIL_PASS || process.env.SMTP_PASS || process.env.GMAIL_SMTP_PASS;
  // Ne jamais logger user/pass
  if (!user || !pass || typeof user !== 'string' || typeof pass !== 'string') {
    return null;
  }
  if (!user.includes('@') || pass.length < 8) {
    return null;
  }
  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    user,
    pass,
    from: process.env.SMTP_FROM || process.env.EMAIL_FROM || user
  };
}

async function purgeExpiredOtps(db, email) {
  const now = new Date();
  try {
    // Purge du document email courant s'il est expiré
    const reqRef = db.collection('otp_requests').doc(email);
    const reqSnap = await reqRef.get();
    if (reqSnap.exists) {
      const d = reqSnap.data() || {};
      const exp = d.expiresAt?.toDate ? d.expiresAt.toDate() : new Date(d.expiresAt || 0);
      if (exp.getTime() < now.getTime()) await reqRef.delete();
    }
  } catch (_) {}
}

module.exports = async (req, res) => {
  const c = handleCors(req, res);
  if (c) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  try {
    const decoded = await verifyBearerUser(req);
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[a-z0-9._%+-]+@gmail\.com$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Une adresse Gmail valide est requise.' });
    }
    if (email !== String(decoded.email || '').toLowerCase()) {
      return res.status(403).json({ ok: false, error: 'L’adresse Gmail doit correspondre au compte connecté.' });
    }

    const db = getAdminApp().firestore();
    const ip = getClientIp(req);

    // Rate limit : 3 / 10 min par couple (email + IP) via uid+ip (email lié au compte)
    const rate = await enforceRateLimit(db, {
      action: 'send-otp',
      uid: decoded.uid + ':' + email,
      ip,
      limit: 3,
      windowSeconds: 600
    });
    if (!rate.allowed) {
      return res.status(429).json({
        ok: false,
        error: 'Trop de tentatives. Veuillez réessayer dans 10 minutes.'
      });
    }

    await purgeExpiredOtps(db, email);

    const code = generateOtp5();
    const challenge = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await db.collection('otp_challenges').doc(challenge).set({
      uid: decoded.uid,
      email,
      codeHash: hash(code),
      expiresAt,
      attempts: 0,
      createdAt: new Date()
    });
    await db.collection('otp_requests').doc(email).set({
      uid: decoded.uid,
      email,
      codeHash: hash(code),
      challenge,
      expiresAt,
      attempts: 0,
      createdAt: new Date()
    });

    const mail = getMailConfig();
    if (!mail) {
      return res.status(500).json({ ok: false, error: 'Service email OTP non configuré.' });
    }

    const transporter = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: { user: mail.user, pass: mail.pass }
    });
    await transporter.sendMail({
      from: mail.from,
      to: email,
      subject: 'Votre code de vérification pour la demande d\'examen',
      text: `Votre code de vérification est : ${code}\n\nIl expire dans 10 minutes.\n\nSi vous n'avez pas demandé cet examen, ignorez cet e-mail.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0f1419;color:#e7e9ea;border-radius:12px;">
        <h2 style="color:#1d9bf0;margin:0 0 16px;">Code de vérification</h2>
        <p style="margin:0 0 12px;">Voici votre code pour la demande d'examen de compte :</p>
        <p style="font-size:28px;letter-spacing:6px;font-weight:bold;color:#fff;background:#1a2332;padding:16px 24px;border-radius:8px;text-align:center;margin:16px 0;">${code}</p>
        <p style="font-size:13px;color:#8b98a5;margin:0;">Ce code expire dans <strong>10 minutes</strong>.</p>
        <p style="font-size:12px;color:#8b98a5;margin-top:20px;">Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.</p>
      </div>`
    });

    return res.status(200).json({ ok: true, challenge });
  } catch (e) {
    if (e.message === 'AUTH_REQUIRED') return res.status(401).json({ ok: false, error: 'Authentification requise.' });
    console.error('send-otp:', e && e.message ? e.message : 'error');
    return res.status(500).json({ ok: false, error: 'Impossible d’envoyer le code OTP.' });
  }
};
