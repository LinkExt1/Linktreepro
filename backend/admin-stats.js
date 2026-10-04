const {getAdminApp,handleCors,verifyAdmin}=require('./_security');
module.exports=async(req,res)=>{
 const c=handleCors(req,res);if(c)return;
 if(req.method!=='GET')return res.status(405).json({ok:false,error:'Method Not Allowed'});
 try{
  await verifyAdmin(req);
  const db=getAdminApp().firestore();
  const [users,events,bugs,pending,inProgress,resolved,rejected]=await Promise.all([
    db.collection('users').count().get(),
    db.collection('analytics_events').count().get(),
    db.collection('bug_reports').count().get(),
    db.collection('bug_reports').where('status','in',['pending','open']).count().get(),
    db.collection('bug_reports').where('status','==','in_progress').count().get(),
    db.collection('bug_reports').where('status','==','resolved').count().get(),
    db.collection('bug_reports').where('status','==','rejected').count().get()
  ]);
  res.setHeader('Cache-Control','private, max-age=30');
  return res.status(200).json({ok:true,users:users.data().count,events:events.data().count,bugs:bugs.data().count,pending:pending.data().count,inProgress:inProgress.data().count,resolved:resolved.data().count,rejected:rejected.data().count});
 }catch(e){
  if(e.message==='ADMIN_REQUIRED')return res.status(403).json({ok:false,error:'Accès administrateur requis.'});
  if(e.message==='AUTH_REQUIRED')return res.status(401).json({ok:false,error:'Authentification requise.'});
  console.error('admin-stats:',e);return res.status(500).json({ok:false,error:'Statistiques indisponibles.'});
 }
};
