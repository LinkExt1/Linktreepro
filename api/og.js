const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
  // Récupère l'ID dans le lien
  const { id } = req.query; 
  
  // Textes par défaut si c'est le lien global du site
  let title = "Linktreepro - Ta page de liens personnalisée";
  let description = "Centralisez vos réseaux et projets en un clic.";
  let imageUrl = "https://ui-avatars.com/api/?name=Linktreepro&background=0a0b10&color=00f2fe&size=200";

  // Si on a un ID utilisateur, on va chercher ses infos publiquement
  if (id) {
    try {
      // Pas besoin de clés secrètes grâce à tes règles de sécurité !
      const response = await fetch(`https://firestore.googleapis.com/v1/projects/linkext-83984/databases/(default)/documents/users/${id}`);
      if (response.ok) {
        const data = await response.json();
        if (data.fields) {
           title = data.fields.displayName?.stringValue ? `${data.fields.displayName.stringValue} - LinkExt` : title;
           description = data.fields.bio?.stringValue || description;
           imageUrl = data.fields.photoURL?.stringValue || imageUrl;
        }
      }
    } catch (e) {
      console.error("Erreur de récupération :", e);
    }
  }

  // Lecture de ton site et injection
  try {
    const indexPath = path.join(process.cwd(), 'index.html');
    let html = fs.readFileSync(indexPath, 'utf8');

    // On efface les vieilles balises pour éviter les doublons
    html = html.replace(/<meta property="og:[^>]+>/g, '');
    html = html.replace(/<meta name="twitter:[^>]+>/g, '');
    html = html.replace(/<title>[^<]*<\/title>/, '');

    // On injecte les nouvelles infos
    const metaTags = `
      <title>${title}</title>
      <meta property="og:title" content="${title}">
      <meta property="og:description" content="${description}">
      <meta property="og:image" content="${imageUrl}">
      <meta property="og:type" content="profile">
      <meta name="twitter:card" content="summary_large_image">
      <meta name="twitter:title" content="${title}">
      <meta name="twitter:description" content="${description}">
      <meta name="twitter:image" content="${imageUrl}">
    `;

    html = html.replace('</head>', `${metaTags}\n</head>`);
    
    // On envoie au robot (Facebook/WhatsApp)
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch(err) {
    res.status(500).send("Erreur serveur");
  }
};
