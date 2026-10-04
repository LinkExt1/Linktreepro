const { getAdminApp, handleCors, verifyAdmin, verifyBearerUser, validUid } = require('./_security');
const { getModerationConfig } = require('./moderation-config');
const { runExaminationAgent, getAiConfig } = require('./ai-moderator');

function toMillis(value) {
  if (!value) return 0;
  if (value.toDate) return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAppeal(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    ...data,
    userId: data.userId || doc.id,
    statut: data.statut || (data.status === 'pending' ? 'en_attente' : data.status === 'resolved' ? 'approuve' : data.status === 'rejected' ? 'rejete' : data.status || 'en_attente'),
    cause: data.accountSnapshot?.banReason || data.banReason || data.cause || '',
    banReasonReport: data.banReasonReport || data.accountSnapshot?.banReasonReport || '',
    clarification: data.clarification && typeof data.clarification === 'object' ? data.clarification : null,
    decisionMessage: data.decisionMessage || data.notification?.message || ''
  };
}

function publicAppeal(appeal) {
  const clean = { ...appeal };
  delete clean.internalNotes;
  return clean;
}

function sanitizeNotes(value) {
  return String(value || '').trim().slice(0, 5000);
}

function sanitizeClarification(value) {
  return String(value || '').trim().slice(0, 5000);
}

async function writeDecisionAudit(db, entry) {
  try {
    await db.collection('moderation_audit_logs').add({
      ...entry,
      createdAt: new Date()
    });
  } catch (e) {
    console.error('moderation_audit_logs (decision non bloquante):', e && e.message ? e.message : e);
  }
}

module.exports = async (req, res) => {
  const c = handleCors(req, res);
  if (c) return;
  try {
    const decoded = await verifyBearerUser(req);
    const db = getAdminApp().firestore();

    if (req.method === 'GET') {
      if (decoded.admin === true) {
        const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 50)));
        const [appealSnap, historySnap] = await Promise.all([
          db.collection('appeals').limit(limit).get(),
          db.collection('moderation_audit_logs').limit(Math.min(limit * 2, 100)).get()
        ]);
        const appeals = appealSnap.docs.map(normalizeAppeal).sort((a, b) => toMillis(b.submittedAt) - toMillis(a.submittedAt));
        const history = historySnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(200).json({ ok: true, appeals, history });
      }

      const ref = db.collection('appeals').doc(decoded.uid);
      const [appealSnap, userSnap] = await Promise.all([
        ref.get(),
        db.collection('users').doc(decoded.uid).get()
      ]);
      const user = userSnap.exists ? userSnap.data() || {} : {};
      const appeal = appealSnap.exists ? publicAppeal(normalizeAppeal(appealSnap)) : null;
      const aiDialogue = appeal?.dialogue && typeof appeal.dialogue === 'object' ? appeal.dialogue : null;
      const aiConfig = await getAiConfig();
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({
        ok: true,
        userStatus: String(user.accountStatus || 'active'),
        banReason: String(user.banReason || ''),
        banReasonReport: String(user.banReasonReport || ''),
        appeal,
        correctionRequired: user.moderationCorrection?.required === true,
        dialogue: aiDialogue ? { enabled: true, question: String(aiDialogue.question || ''), answer: String(aiDialogue.answer || ''), answered: aiDialogue.answered === true, status: String(aiDialogue.status || ''), feedback: String(aiDialogue.feedback || '') } : null,
        dialogueEnabled: aiConfig.dialogueEnabled === true && Boolean(aiConfig.dialoguePrompt) && aiConfig.models.length > 0
      });
    }

    if (req.method === 'PATCH') {
      if (decoded.admin !== true) {
        const action = String(req.body?.action || '').trim().toLowerCase();
        const ref = db.collection('appeals').doc(decoded.uid);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: 'Aucun recours trouvé.' });
        const current = snap.data() || {};

        if (action === 'start_dialogue') {
          const userSnap = await db.collection('users').doc(decoded.uid).get();
          const user = userSnap.exists ? userSnap.data() || {} : {};
          const source = { report: String(user.banReasonReport || current.banReasonReport || ''), reason: String(user.banReason || current.banReason || ''), message: String(current.message || current.raison || '') };
          const result = await runExaminationAgent(JSON.stringify(source));
          if (!result.configured) return res.status(409).json({ ok: false, error: 'Le dialogue d’examen n’est pas configuré.' });
          if (!result.result) return res.status(503).json({ ok: false, error: 'Le dialogue d’examen est momentanément indisponible.' });
          const question = String(result.result.question || '').trim();
          if (!question) return res.status(503).json({ ok: false, error: 'Aucune question d’examen n’a pu être générée.' });
          await ref.set({ dialogue: { question, generatedAt: new Date(), answered: false, status: 'OPEN' }, updatedAt: new Date() }, { merge: true });
          return res.status(200).json({ ok: true, question });
        }

        if (action === 'dialogue_response') {
          const answer = sanitizeClarification(req.body?.message);
          if (answer.length < 5) return res.status(400).json({ ok: false, error: 'Votre réponse doit contenir plus de précisions.' });
          const dialogue = current.dialogue && typeof current.dialogue === 'object' ? current.dialogue : {};
          if (!dialogue.question) return res.status(409).json({ ok: false, error: 'Aucune question d’examen active.' });
          const result = await runExaminationAgent(JSON.stringify({ question: String(dialogue.question), answer }));
          if (!result.configured || !result.result) return res.status(503).json({ ok: false, error: 'L’analyse de votre réponse est momentanément indisponible.' });
          const decision = String(result.result.action || '').toUpperCase();
          const userRef = db.collection('users').doc(decoded.uid);
          if (decision === 'ALLOW' || decision === 'ACTIVE') {
            await userRef.update({ accountStatus: 'active', isBanned: false, suspendedAt: null, suspensionEndsAt: null, moderationCorrection: null, banReasonReport: '' });
            try { await getAdminApp().auth().updateUser(decoded.uid, { disabled: false }); } catch (_) {}
            await ref.set({ dialogue: { ...dialogue, answer, answered: true, answeredAt: new Date(), status: 'RESOLVED', decision: 'ACTIVE', feedback: String(result.result.report || result.result.reason || '') }, status: 'resolved', statut: 'approuve', decision: 'dialogue_active', resolvedAt: new Date(), updatedAt: new Date() }, { merge: true });
            return res.status(200).json({ ok: true, status: 'active', report: String(result.result.report || result.result.reason || '') });
          }
          if (decision === 'CORRECTION_PENDING' || decision === 'REQUIRES_CORRECTION') {
            const userSnap = await userRef.get();
            const user = userSnap.exists ? userSnap.data() || {} : {};
            const incident = user.moderationIncident && typeof user.moderationIncident === 'object' ? user.moderationIncident : {};
            const report = String(result.result.report || result.result.reason || user.banReasonReport || '');
            await userRef.update({ accountStatus: 'CORRECTION_PENDING', isBanned: false, moderationCorrection: { required: true, fields: Array.isArray(incident.fields) ? incident.fields : [], baselineHashes: incident.baselineHashes || {}, report, createdAt: new Date(), approvedBy: 'dialogue' }, banReasonReport: report });
            try { await getAdminApp().auth().updateUser(decoded.uid, { disabled: false }); } catch (_) {}
            await ref.set({ dialogue: { ...dialogue, answer, answered: true, answeredAt: new Date(), status: 'CORRECTION_PENDING', decision: 'CORRECTION_PENDING', feedback: report }, status: 'resolved', statut: 'approuve', decision: 'dialogue_correction', resolvedAt: new Date(), updatedAt: new Date() }, { merge: true });
            return res.status(200).json({ ok: true, status: 'CORRECTION_PENDING', report });
          }
          await ref.set({ dialogue: { ...dialogue, answer, answered: true, answeredAt: new Date(), status: 'MORE_INFO', decision: 'MORE_INFO', feedback: String(result.result.report || result.result.reason || '') }, updatedAt: new Date() }, { merge: true });
          return res.status(200).json({ ok: true, status: 'more_info', report: String(result.result.report || result.result.reason || '') });
        }

        if (action !== 'clarification_response') return res.status(403).json({ ok: false, error: 'Action non autorisée.' });
        const message = sanitizeClarification(req.body?.message);
        if (message.length < 5) return res.status(400).json({ ok: false, error: 'Votre réponse doit contenir au moins 5 caractères.' });
        if (['resolved', 'rejected'].includes(String(current.status || '').toLowerCase())) {
          return res.status(409).json({ ok: false, error: 'Ce recours est déjà traité.' });
        }
        const clarification = current.clarification && typeof current.clarification === 'object' ? current.clarification : {};
        if (!clarification.requested) return res.status(409).json({ ok: false, error: 'Aucune clarification n’est demandée.' });
        await ref.set({
          clarification: { ...clarification, answer: message, answeredAt: new Date(), answered: true },
          updatedAt: new Date()
        }, { merge: true });
        return res.status(200).json({ ok: true, message: 'Clarification transmise.' });
      }

      const uid = String(req.body?.uid || '').trim();
      const action = String(req.body?.action || '').trim().toLowerCase();
      if (!validUid(uid)) return res.status(400).json({ ok: false, error: 'UID invalide.' });
      if (uid === decoded.uid) return res.status(400).json({ ok: false, error: 'Action impossible sur votre propre compte.' });

      const appealRef = db.collection('appeals').doc(uid);
      const userRef = db.collection('users').doc(uid);
      const [appealSnap, userSnap, moderationConfig] = await Promise.all([
        appealRef.get(),
        userRef.get(),
        getModerationConfig()
      ]);
      if (!appealSnap.exists) return res.status(404).json({ ok: false, error: 'Recours introuvable.' });
      if (!userSnap.exists) return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });

      const currentAppeal = appealSnap.data() || {};
      const currentUser = userSnap.data() || {};
      const now = new Date();
      const notes = sanitizeNotes(req.body?.internalNotes);
      const decisionMessage = String(req.body?.decisionMessage || '').trim().slice(0, 1000);

      if (['approve_correction', 'approuver_avec_correction', 'reactivate'].includes(action)) {
        const incident = currentUser.moderationIncident && typeof currentUser.moderationIncident === 'object' ? currentUser.moderationIncident : {};
        const correction = {
          required: true,
          fields: Array.isArray(incident.fields) ? incident.fields : [],
          baselineHashes: incident.baselineHashes && typeof incident.baselineHashes === 'object' ? incident.baselineHashes : {},
          report: String(currentUser.banReasonReport || incident.report || currentAppeal.banReasonReport || currentAppeal.banReason || ''),
          createdAt: now,
          approvedBy: decoded.uid
        };
        await userRef.update({
          accountStatus: 'CORRECTION_PENDING',
          isBanned: false,
          suspendedAt: null,
          suspensionEndsAt: null,
          moderationCorrection: correction,
          banReasonReport: correction.report
        });
        try { await getAdminApp().auth().updateUser(uid, { disabled: false }); } catch (_) {}
        await appealRef.set({
          statut: 'approuve',
          status: 'resolved',
          decision: 'approve_correction',
          decisionMessage: decisionMessage || '',
          notification: { type: 'correction_required', message: decisionMessage, createdAt: now },
          internalNotes: notes || currentAppeal.internalNotes || '',
          resolvedAt: now,
          resolvedBy: decoded.uid,
          updatedAt: now
        }, { merge: true });
        await writeDecisionAudit(db, { uid, actorUid: decoded.uid, action: 'APPEL_APPROUVE_CORRECTION', source: 'appeal', reason: correction.report, banReasonReport: correction.report });
        return res.status(200).json({ ok: true, status: 'CORRECTION_PENDING', decision: 'approve_correction' });
      }

      if (['reject', 'rejeter'].includes(action)) {
        await appealRef.set({
          statut: 'rejete',
          status: 'rejected',
          decision: 'reject',
          decisionMessage: decisionMessage || 'Votre recours a été rejeté. La sanction est maintenue.',
          notification: { type: 'appeal_rejected', message: decisionMessage || 'Votre recours a été rejeté. La sanction est maintenue.', createdAt: now },
          internalNotes: notes || currentAppeal.internalNotes || '',
          rejectedAt: now,
          rejectedBy: decoded.uid,
          updatedAt: now
        }, { merge: true });
        await writeDecisionAudit(db, { uid, actorUid: decoded.uid, action: 'APPEL_REJETE', source: 'appeal', reason: decisionMessage || currentUser.banReason || '', banReasonReport: currentUser.banReasonReport || '' });
        return res.status(200).json({ ok: true, status: 'rejected', decision: 'reject' });
      }

      if (['clarify', 'request_clarification', 'demander_clarification'].includes(action)) {
        const prompt = String(req.body?.clarificationMessage || req.body?.message || '').trim().slice(0, 3000);
        if (prompt.length < 5) return res.status(400).json({ ok: false, error: 'La demande de clarification est trop courte.' });
        await appealRef.set({
          status: 'pending',
          statut: 'en_attente',
          stage: 'clarification_requested',
          clarification: { requested: true, message: prompt, requestedAt: now, requestedBy: decoded.uid, answered: false },
          decisionMessage: decisionMessage || 'Une clarification complémentaire est demandée pour poursuivre l’examen.',
          internalNotes: notes || currentAppeal.internalNotes || '',
          updatedAt: now
        }, { merge: true });
        await writeDecisionAudit(db, { uid, actorUid: decoded.uid, action: 'APPEL_CLARIFICATION_DEMANDEE', source: 'appeal', reason: prompt, banReasonReport: currentUser.banReasonReport || '' });
        return res.status(200).json({ ok: true, status: 'pending', decision: 'request_clarification' });
      }

      if (['adjust_sanction', 'adjust', 'commute_sanction'].includes(action)) {
        const durationDays = Number(req.body?.durationDays);
        if (!Number.isFinite(durationDays) || durationDays <= 0) return res.status(400).json({ ok: false, error: 'La durée de suspension doit être un nombre de jours positif.' });
        const sanction = moderationConfig.sanction || {};
        if (sanction.minDurationDays && durationDays < sanction.minDurationDays) return res.status(400).json({ ok: false, error: `La durée doit être au moins de ${sanction.minDurationDays} jour(s).` });
        if (sanction.maxDurationDays && durationDays > sanction.maxDurationDays) return res.status(400).json({ ok: false, error: `La durée ne peut pas dépasser ${sanction.maxDurationDays} jour(s).` });
        const endsAt = new Date(now.getTime() + durationDays * 86400000);
        await userRef.update({
          accountStatus: 'suspended',
          isBanned: true,
          suspendedAt: currentUser.suspendedAt || now,
          suspensionEndsAt: endsAt,
          banReason: currentUser.banReason || '',
          banReasonReport: currentUser.banReasonReport || currentAppeal.banReasonReport || ''
        });
        await appealRef.set({
          statut: 'approuve',
          status: 'resolved',
          decision: 'adjust_sanction',
          sanctionDurationDays: durationDays,
          sanctionEndsAt: endsAt,
          decisionMessage,
          notification: { type: 'sanction_adjusted', message: decisionMessage, createdAt: now },
          internalNotes: notes || currentAppeal.internalNotes || '',
          resolvedAt: now,
          resolvedBy: decoded.uid,
          updatedAt: now
        }, { merge: true });
        await writeDecisionAudit(db, { uid, actorUid: decoded.uid, action: 'SANCTION_AJUSTEE_RECOURS', source: 'appeal', reason: decisionMessage || currentUser.banReason || '', banReasonReport: currentUser.banReasonReport || '', sanctionDurationDays: durationDays, sanctionEndsAt: endsAt });
        return res.status(200).json({ ok: true, status: 'resolved', decision: 'adjust_sanction', durationDays });
      }

      return res.status(400).json({ ok: false, error: 'Action de recours inconnue.' });
    }

    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  } catch (e) {
    if (e.message === 'ADMIN_REQUIRED') return res.status(403).json({ ok: false, error: 'Accès administrateur requis.' });
    if (e.message === 'AUTH_REQUIRED') return res.status(401).json({ ok: false, error: 'Authentification requise.' });
    console.error('appeals:', e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: 'Gestion des recours impossible.' });
  }
};
