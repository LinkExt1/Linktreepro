const {getAdminApp,getClientIp,originAllowed,handleCors,validUid,enforceRateLimit}=require('./_security');
function getBeninParts(date=new Date()){return{dateStr:new Intl.DateTimeFormat('fr-CA',{timeZone:'Africa/Porto-Novo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date),hourStr:new Intl.DateTimeFormat('fr-FR',{timeZone:'Africa/Porto-Novo',hour:'2-digit',minute:'2-digit',hour12:false}).format(date),monthStr:new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Porto-Novo',year:'numeric',month:'2-digit'}).format(date).slice(0,7)}}
function readAuthUid(req){const h=req.headers.authorization||'';return h.startsWith('Bearer ')?h.slice(7).trim():''}
async function getOptionalAuthUid(app,req){const token=readAuthUid(req);if(!token)return '';try{return (await app.auth().verifyIdToken(token)).uid||''}catch(_){return ''}}
module.exports=async(req,res)=>{
 const corsHandled=handleCors(req,res);if(corsHandled)return;
 if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({ok:false,error:'Method Not Allowed'})}
 if(!originAllowed(req))return res.status(403).json({ok:false,error:'Origine refusée.'});
 const rawId=Array.isArray(req.query?.id)?req.query.id[0]:req.query?.id,uid=typeof rawId==='string'?rawId.trim():'';
 if(!validUid(uid))return res.status(400).json({ok:false,error:'ID utilisateur invalide.'});
 try{
  const app=getAdminApp(),db=app.firestore(),userRef=db.collection('users').doc(uid),visitorUid=await getOptionalAuthUid(app,req);
  if(visitorUid===uid)return res.status(200).json({ok:true,totalViews:null,ignored:true,reason:'owner_visit'});
  const rate=await enforceRateLimit(db,{action:'visit',uid,ip:getClientIp(req),limit:60,windowSeconds:60});
  if(!rate.allowed){res.setHeader('Retry-After',String(rate.retryAfter));return res.status(429).json({ok:false,error:'Trop de visites depuis cette origine.'});}
  const countryHeader=req.headers['x-vercel-ip-country'],country=String(Array.isArray(countryHeader)?countryHeader[0]:(countryHeader||'XX')).trim().toUpperCase().slice(0,2)||'XX';
  const now=new Date(),{dateStr,hourStr,monthStr}=getBeninParts(now);
  const settingsSnap=await db.collection('admin_settings').doc('badges').get();
  const settings=settingsSnap.exists?settingsSnap.data():{};
  const result=await db.runTransaction(async transaction=>{
   const currentSnap=await transaction.get(userRef);if(!currentSnap.exists)throw new Error('NOT_FOUND');const current=currentSnap.data()||{};
   if(['banned','suspended','disabled'].includes(current.accountStatus))throw new Error('BANNED');
   const currentRawViews=Number(current.totalRawViews ?? current.backgroundViews ?? current.totalViews ?? current.views ?? 0),displayViews=Number(current.displayedViews ?? current.publicViews ?? 0),currentMonth=String(current.monthly_views_reset||'');
   const nextMonthly=(currentMonth===monthStr?Number(current.total_views_month||0):0)+1;
   let windowStart=current.badgeWindowStartAt?.toDate?current.badgeWindowStartAt.toDate():(current.badgeWindowStartAt?new Date(current.badgeWindowStartAt):null);
   let windowViews=Number(current.badgeWindowViews||0);
   const evaluationStart=current.badgeEvaluationStartAt?.toDate?current.badgeEvaluationStartAt.toDate():(current.badgeEvaluationStartAt?new Date(current.badgeEvaluationStartAt):null);
   const baseStart=windowStart||evaluationStart||now;
   const evaluationDays=Number(settings.badgeEvaluationWindowDays); if(!Number.isFinite(evaluationDays)||evaluationDays<1){windowStart=windowStart||now; windowViews=windowViews||0;} else if(!windowStart||now.getTime()-baseStart.getTime()>=evaluationDays*86400000){windowStart=now;windowViews=0;}
   windowViews+=1;
   const threshold=current.badgeResetAt?Number(settings.minViewsPostSuspension):Number(settings.minViewsForBadge);
   const updates={totalRawViews:currentRawViews+1,backgroundViews:currentRawViews+1,totalViews:currentRawViews+1,views:currentRawViews+1,displayedViews:displayViews+1,publicViews:displayViews+1,total_views_month:nextMonthly,monthly_views_reset:monthStr,badgeRawViews:Number(current.badgeRawViews||0)+1,badgeWindowViews:windowViews,badgeWindowStartAt:windowStart};
   if(current.badgeManual!==true && Number.isFinite(threshold) && threshold>0 && windowViews>=threshold){updates.verified=true; if(current.badgeResetAt)updates.badgeResetAt=null;}
   if(current.visitorAnalyticsEnabled!==false){const visitorRef=userRef.collection('visitor_logs').doc();transaction.set(visitorRef,{country,timestamp:admin.firestore.FieldValue.serverTimestamp(),dateStr,hourStr});}
   transaction.update(userRef,updates);return updates;
  });
  return res.status(201).json({ok:true,totalRawViews:result.totalRawViews,displayedViews:result.displayedViews,publicViews:result.publicViews,verified:result.verified===true});
 }catch(error){
  if(error.message==='BANNED')return res.status(403).json({ok:false,error:'Profil indisponible.'});
  if(error.message==='NOT_FOUND')return res.status(404).json({ok:false,error:'Profil introuvable.'});
  console.error('Erreur API visitor_logs:',error);return res.status(500).json({ok:false,error:'Impossible d’enregistrer la visite.'});
 }
};
