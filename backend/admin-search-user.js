const { getAdminApp, handleCors, verifyAdmin, validUid } = require('./_security');
module.exports=async(req,res)=>{
 const c=handleCors(req,res); if(c)return;
 if(req.method!=='GET') return res.status(405).json({ok:false,error:'Method Not Allowed'});
 try{
  const adminDecoded=await verifyAdmin(req), q=String(req.query?.q||'').trim().slice(0,120);
  if(!q)return res.status(400).json({ok:false,error:'Recherche vide.'});
  const db=getAdminApp().firestore(), users=db.collection('users'), docs=new Map();
  if(validUid(q)){const s=await users.doc(q).get();if(s.exists&&s.id!==adminDecoded.uid)docs.set(s.id,s);}
  const fields=['email','displayName','firstName','lastName','nom','prenom','username'];
  await Promise.all(fields.map(async field=>{try{const snap=await users.where(field,'>=',q).where(field,'<=',q+'\uf8ff').limit(20).get();snap.forEach(d=>{if(d.id!==adminDecoded.uid)docs.set(d.id,d);});}catch(_){}}));
  const results=[];
  for(const d of [...docs.values()].slice(0,20)){
    const x=d.data()||{};
    let recentLogs=[];
    let moderationHistory=[];
    try{const logs=await d.ref.collection('visitor_logs').orderBy('timestamp','desc').limit(8).get();recentLogs=logs.docs.map(l=>{const v=l.data()||{};return {country:v.country||'XX',dateStr:v.dateStr||'',hourStr:v.hourStr||''};});}catch(_){ }
    try{const logs=await db.collection('moderation_audit_logs').where('uid','==',d.id).orderBy('createdAt','desc').limit(20).get();moderationHistory=logs.docs.map(l=>{const v=l.data()||{};return {action:v.action||'',reason:v.reason||'',report:v.banReasonReport||'',fields:Array.isArray(v.fields)?v.fields:[],source:v.source||'',model:v.model||'',createdAt:v.createdAt||null};});}catch(_){try{const logs=await db.collection('moderation_audit_logs').where('uid','==',d.id).limit(20).get();moderationHistory=logs.docs.map(l=>{const v=l.data()||{};return {action:v.action||'',reason:v.reason||'',report:v.banReasonReport||'',fields:Array.isArray(v.fields)?v.fields:[],source:v.source||'',model:v.model||'',createdAt:v.createdAt||null};});}catch(__){}}
    results.push({uid:d.id,email:x.email||'',displayName:x.displayName||'',firstName:x.firstName||x.prenom||'',lastName:x.lastName||x.nom||'',username:x.username||'',phoneNumber:x.phoneNumber||'',role:x.role||'user',accountStatus:x.accountStatus||'active',suspensionCount:Number(x.suspensionCount||0),banReason:x.banReason||'',banReasonReport:x.banReasonReport||'',suspensionEndsAt:x.suspensionEndsAt||null,suspendedAt:x.suspendedAt||null,createdAt:x.createdAt||null,linksCount:Array.isArray(x.links)?x.links.length:0,productsCount:Array.isArray(x.products)?x.products.length:0,testimonialsCount:Array.isArray(x.testimonials)?x.testimonials.length:0,photoURL:x.photoURL||'',bio:x.bio||'',verified:x.verified===true,badgeRawViews:Number(x.badgeRawViews||0),badgeWindowViews:Number(x.badgeWindowViews||0),moderationCorrection:x.moderationCorrection||null,moderationIncident:x.moderationIncident||null,moderationReview:x.moderationReview||null,recentLogs,moderationHistory});
  }
  res.setHeader('Cache-Control','private, no-store'); return res.status(200).json({ok:true,users:results});
 }catch(e){
  if(e.message==='ADMIN_REQUIRED')return res.status(403).json({ok:false,error:'Accès administrateur requis.'});
  if(e.message==='AUTH_REQUIRED')return res.status(401).json({ok:false,error:'Authentification requise.'});
  console.error('admin-search-user:',e);return res.status(500).json({ok:false,error:'Recherche impossible.'});
 }
};
