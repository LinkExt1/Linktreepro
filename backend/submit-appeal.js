const nodemailer = require('nodemailer');
const { getAdminApp, handleCors, verifyBearerUser } = require('./_security');

async function notifyAdmin(payload) {
  // Isolé : un échec d'e-mail ne doit JAMAIS faire échouer la création du recours
  try {
    const user = process.env.EMAIL_USER || process.env.SMTP_USER || process.env.GMAIL_SMTP_USER;
    const pass = process.env.EMAIL_PASS || process.env.SMTP_PASS || process.env.GMAIL_SMTP_PASS;
    const adminTo = process.env.ADMIN_EMAIL || process.env.SMTP_FROM || user;
    if (!user || !pass || !adminTo) return { sent: false, reason: 'config' };

    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT || 465);
    const secure = String(process.env.SMTP_SECURE || 'true') === 'true';
    const from = process.env.SMTP_FROM || process.env.EMAIL_FROM || user;

    const transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
    await transporter.sendMail({
      from,
      to: adminTo,
      subject: `[LinkExt] Nouveau recours en attente — ${payload.email}`,
      text: `Un nouveau recours a été soumis.\n\nTicket: ${payload.ticketId}\nEmail: ${payload.email}\nUID: ${payload.userId}\nRaison: ${payload.message}\nDate suspension: ${payload.suspendedAt || 'N/A'}\n\nConnectez-vous au tableau de bord admin pour traiter le dossier.`
    });
    return { sent: true };
  } catch (e) {
    console.error('notifyAdmin (non bloquant):', e && e.message ? e.message : 'error');
    return { sent: false, reason: 'send_failed' };
  }
}

module.exports = async (req, res) => {
  const c = handleCors(req, res);
  if (c) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, success: false, error: 'Method Not Allowed' });
  try {
    const decoded = await verifyBearerUser(req);
    const db = getAdminApp().firestore();
    const uid = decoded.uid;
    const text = String(req.body?.message || '').trim().slice(0, 5000);

    if (text.length < 20) {
      return res.status(400).json({ ok: false, success: false, error: 'Votre explication doit contenir au moins 20 caractères.' });
    }

    const uref = db.collection('users').doc(uid);
    const us = await uref.get();
    if (!us.exists) return res.status(404).json({ ok: false, success: false, error: 'Compte introuvable.' });

    const data = us.data() || {};
    const status = String(data.accountStatus || 'active');
    if (!['suspended', 'banned'].includes(status)) {
      return res.status(409).json({ ok: false, success: false, error: 'Un examen est disponible uniquement pour un compte restreint.' });
    }

    // Vérification OTP préalable (Admin SDK)
    const vr = await db.collection('appeal_verifications').doc(uid).get();
    const vd = vr.exists ? vr.data() : {};
    const exp = vd.expiresAt?.toDate ? vd.expiresAt.toDate() : new Date(vd.expiresAt || 0);
    if (vd.email !== String(decoded.email || '').toLowerCase() || exp.getTime() < Date.now()) {
      return res.status(403).json({ ok: false, success: false, error: 'Vérification OTP requise.' });
    }

    // Un seul recours actif à la fois
    const existing = await db.collection('appeals').doc(uid).get();
    if (existing.exists) {
      const ed = existing.data() || {};
      const st = String(ed.statut || ed.status || '').toLowerCase();
      if (st === 'en_attente' || st === 'pending') {
        return res.status(409).json({
          ok: false,
          success: false,
          error: 'Un recours est déjà en cours d\'analyse pour ce compte.'
        });
      }
    }

    const ticketId = 'RC-' + uid.slice(0, 6).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
    const dossier = {
      userId: uid,
      email: String(decoded.email || data.email || ''),
      message: text,
      raison: text,
      ticketId,
      accountSnapshot: data,
      nom: data.displayName || data.nom || data.lastName || '',
      prenom: data.firstName || data.prenom || '',
      banReason: data.banReason || '',
      suspendedAt: data.suspendedAt || null,
      adminContactLink: data.adminContactLink || '',
      collectedData: {
        linksCount: Array.isArray(data.links) ? data.links.length : 0,
        productsCount: Array.isArray(data.products) ? data.products.length : 0,
        photoURL: data.photoURL || '',
        bio: data.bio || '',
        verified: data.verified === true,
        createdAt: data.createdAt || null,
        badgeRawViews: Number(data.badgeRawViews || 0),
        badgeWindowViews: Number(data.badgeWindowViews || 0)
      },
      statut: 'en_attente',
      status: 'pending',
      submittedAt: new Date(),
      updatedAt: new Date()
    };

    // Source de vérité unique : appeals (Admin SDK)
    await db.collection('appeals').doc(uid).set(dossier, { merge: true });

    // Consommer la vérification OTP
    await vr.ref.delete();

    // Notification admin isolée (ne bloque jamais la réponse succès)
    await notifyAdmin(dossier);

    return res.status(201).json({
      ok: true,
      success: true,
      message: 'Recours transmis avec succès.',
      ticketId
    });
  } catch (e) {
    if (e.message === 'AUTH_REQUIRED') {
      return res.status(401).json({ ok: false, success: false, error: 'Authentification requise.' });
    }
    console.error('submit-appeal:', e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, success: false, error: 'Impossible de soumettre le recours.' });
  }
};
