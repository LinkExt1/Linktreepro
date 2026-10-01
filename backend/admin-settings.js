const { getAdminApp, handleCors, verifyAdmin } = require('./_security');

const ALLOWED = ['minViewsForBadge','minViewsPostSuspension','badgeEvaluationWindowDays'];

function normalize(body) {
  const out = {};
  for (const key of ALLOWED) {
    const n = Number(body?.[key]);
    if (!Number.isFinite(n) || n < 1 || n > 100000000) throw new Error('BAD_SETTING');
    out[key] = Math.floor(n);
  }
  return out;
}
module.exports = async (req,res) => {
  const c=handleCors(req,res); if(c)return;
  try {
    await verifyAdmin(req);
    const ref=getAdminApp().firestore().collection('admin_settings').doc('badges');
    const snap=await ref.get();
    const current=snap.exists?snap.data():{};
    if(req.method==='GET'){
      res.setHeader('Cache-Control','private, max-age=60');
      return res.status(200).json({ok:true,settings:Object.fromEntries(ALLOWED.map(k=>[k,Number.isFinite(Number(current[k])) ? Number(current[k]) : null]))});
    }
    if(req.method!=='PATCH'&&req.method!=='PUT'&&req.method!=='POST') return res.status(405).json({ok:false,error:'Method Not Allowed'});
    const clean=normalize(req.body||{});
    await ref.set({...clean,updatedAt:new Date()},{merge:true});
    return res.status(200).json({ok:true,settings:clean});
  } catch(e) {
    if(e.message==='ADMIN_REQUIRED')return res.status(403).json({ok:false,error:'Accès administrateur requis.'});
    if(e.message==='AUTH_REQUIRED')return res.status(401).json({ok:false,error:'Authentification requise.'});
    if(e.message==='BAD_SETTING')return res.status(400).json({ok:false,error:'Paramètre de badge invalide.'});
    console.error('admin-settings:',e);return res.status(500).json({ok:false,error:'Impossible de gérer les paramètres des badges.'});
  }
};
