const {getAdminApp,handleCors,verifyAdmin,validUid}=require('./_security');
const {getModerationConfig}=require('./moderation-config');

async function addToBlacklist(db, email, reason, durationDays) {
 const normalized=String(email||'').trim().toLowerCase(); const days=Number(durationDays);
 if(!normalized||!Number.isFinite(days)||days<=0)return false;
 const now=new Date();
 await db.collection('blacklisted_emails').doc(Buffer.from(normalized).toString('base64url')).set({email:normalized,createdAt:now,expiresAt:new Date(now.getTime()+days*86400000),reason:String(reason||'').slice(0,500)},{merge:true});
 return true;
}

module.exports=async(req,res)=>{
 const c=handleCors(req,res);if(c)return;
 if(req.method!=='POST')return res.status(405).json({ok:false,error:'Method Not Allowed'});
 try{
  const adminDecoded=await verifyAdmin(req);
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  // Compatibilité stricte avec toutes les variantes historiques du frontend.
  // Le bouton Forcer l'activation transmet désormais targetUid, mais uid/userId/id
  // restent acceptés afin d'éviter toute régression sur les autres actions admin.
  const uid = String(body.targetUid || body.uid || body.userId || body.id || '').trim();
  const action=String(body.action||'').trim();
  if(!validUid(uid))return res.status(400).json({ok:false,error:'UID invalide ou manquant.'});
  if(uid===adminDecoded.uid)return res.status(400).json({ok:false,error:'Action impossible sur votre propre compte.'});
  const db=getAdminApp().firestore(),ref=db.collection('users').doc(uid),snap=await ref.get();
  if(!snap.exists)return res.status(404).json({ok:false,error:'Utilisateur introuvable.'});
  const x=snap.data()||{};
  const now=new Date();
  if(['suspend','ban','disable'].includes(action)){
    const requestedStatus=action==='suspend'?'suspended':action==='ban'?'banned':'disabled';
    const reason=String(body.reason||'').slice(0,300);
    const cfg=await getModerationConfig();
    const threshold=Number(cfg.sanction?.maxAllowed ?? cfg.sanction?.recurrenceThreshold);
    const nextCount=Number(x.suspensionCount||0)+(action==='suspend'?1:0);
    const status=action==='suspend' && Number.isFinite(threshold) && threshold>0 && nextCount>=threshold ? 'banned' : requestedStatus;
    await ref.update({accountStatus:status,verified:false,badgeResetAt:now,badgeWindowStartAt:now,badgeWindowViews:0,banReason:reason,adminContactLink:String(body.contact||'').slice(0,200),suspendedAt:status==='suspended'?now:null,suspensionEndsAt:null,suspensionCount:nextCount});
    if(status==='banned'){
      try{await getAdminApp().auth().updateUser(uid,{disabled:true});}catch(e){console.warn('auth disable admin action:',e.message);}
      await addToBlacklist(db,x.email||'',reason,cfg.sanction?.blacklistAfterDays);
    }
    return res.status(200).json({ok:true,status,suspensionCount:nextCount});
  }
  if(action==='force-activate'){
    await ref.update({status:'ACTIVE',accountStatus:'active',isSuspended:false,isBanned:false,suspensionReason:null,correctionRequired:false,flaggedFields:[],banReason:'',banReasonReport:'',adminContactLink:'',suspendedAt:null,suspensionEndsAt:null,moderationCorrection:null,moderationIncident:null,moderationReview:null,adminOverride:true,updatedAt:now});
    try{await getAdminApp().auth().updateUser(uid,{disabled:false});}catch(e){console.warn('auth enable force activation:',e.message);}
    return res.status(200).json({ok:true,status:'active',adminOverride:true});
  }
  if(action==='reactivate'){
    await ref.update({accountStatus:'active',isBanned:false,banReason:'',adminContactLink:'',suspendedAt:null,suspensionEndsAt:null,verified:false,badgeResetAt:now,badgeEvaluationStartAt:now,badgeWindowStartAt:now,badgeWindowViews:0});
    try{await getAdminApp().auth().updateUser(uid,{disabled:false});}catch(e){console.warn('auth enable admin action:',e.message);}
    return res.status(200).json({ok:true,status:'active'});
  }
  if(action==='grantBadge'||action==='removeBadge'){
    await ref.update({verified:action==='grantBadge',badgeManual:action==='grantBadge'});
    return res.status(200).json({ok:true,verified:action==='grantBadge'});
  }
  return res.status(400).json({ok:false,error:'Action inconnue.'});
 }catch(e){
  if(e.message==='ADMIN_REQUIRED')return res.status(403).json({ok:false,error:'Accès administrateur requis.'});
  if(e.message==='AUTH_REQUIRED')return res.status(401).json({ok:false,error:'Authentification requise.'});
  console.error('admin-user-action:',e);return res.status(500).json({ok:false,error:'Action impossible.'});
 }
};
