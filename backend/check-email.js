const {getAdminApp,getClientIp,handleCors,enforceRateLimit}=require('./_security');
module.exports=async(req,res)=>{
 const c=handleCors(req,res);if(c)return;
 if(req.method!=='GET')return res.status(405).json({ok:false,error:'Method Not Allowed'});
 try{
  const email=String(req.query?.email||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({ok:false,error:'Email invalide.'});
  const db=getAdminApp().firestore(),rate=await enforceRateLimit(db,{action:'check-email',ip:getClientIp(req),limit:10,windowSeconds:60});
  if(!rate.allowed)return res.status(429).json({ok:false,error:'Trop de tentatives.'});
  const snap=await db.collection('blacklisted_emails').doc(Buffer.from(email).toString('base64url')).get();
  if(!snap.exists)return res.status(200).json({ok:true,blocked:false});
  const exp=snap.data()?.expiresAt?.toDate?snap.data().expiresAt.toDate():new Date(snap.data()?.expiresAt||0);
  if(exp.getTime()<=Date.now()){await snap.ref.delete();return res.status(200).json({ok:true,blocked:false});}
  return res.status(403).json({ok:false,blocked:true,error:'Cette adresse email est temporairement bloquée selon la durée configurée par l’administration.'});
 }catch(e){console.error('check-email:',e);return res.status(500).json({ok:false,error:'Vérification email indisponible.'});}
};
