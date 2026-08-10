// api/og.js - Fonction Vercel pour l'injection dynamique des balises Open Graph
// Ce fichier intercepte les requêtes avec ?id= et injecte les données utilisateur
// depuis Firestore dans les balises meta du HTML.

const admin = require('firebase-admin');

// Initialisation de Firebase Admin SDK
// Les credentials sont lus automatiquement depuis les variables d'environnement Vercel
if (!admin.apps.length) {
  // En production, Vercel fournit automatiquement les variables d'environnement
  // Pour le développement local, utilisez un fichier .env
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } else {
    // Mode développement : utiliser les variables d'environnement individuelles
    const projectId = process.env.FIREBASE_PROJECT_ID || 'linkext-83984';
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: projectId,
          clientEmail: clientEmail,
          privateKey: privateKey
        })
      });
    } else {
      // Fallback pour les tests locaux - NE PAS UTILISER EN PRODUCTION
      console.warn('⚠️ Utilisation de la configuration par défaut - Définissez les variables d\'environnement Firebase');
      admin.initializeApp({
        credential: admin.credential.applicationDefault()
      });
    }
  }
}

const db = admin.firestore();

// Configuration par défaut du site
const SITE_URL = process.env.SITE_URL || 'https://linkext.vercel.app';
const DEFAULT_TITLE = 'LinkExt - Centralisez vos réseaux en un clic';
const DEFAULT_DESCRIPTION = 'LinkExt est la plateforme ultime pour regrouper tous vos canaux importants en un seul lien.';
const DEFAULT_IMAGE = 'https://ui-avatars.com/api/?name=LinkExt&background=0a0b10&color=00f2fe&size=400';
const DEFAULT_LOGO = 'https://ui-avatars.com/api/?name=LinkExt&background=0a0b10&color=00f2fe&size=400';

module.exports = async (req, res) => {
  // Définir les en-têtes CORS pour permettre l'accès depuis n'importe quelle origine
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Récupérer le paramètre ?id= de l'URL
  const uid = req.query.id || '';
  
  // Initialiser les valeurs OG par défaut (pour la page d'accueil)
  let ogTitle = DEFAULT_TITLE;
  let ogDescription = DEFAULT_DESCRIPTION;
  let ogImage = DEFAULT_IMAGE;
  let userName = 'LinkExt';
  let userBio = '';
  let userPhoto = '';
  let twitterCard = 'summary_large_image';

  // Si un UID est fourni, interroger Firestore pour les données utilisateur
  if (uid && uid.trim() !== '') {
    try {
      const docRef = db.collection('users').doc(uid);
      const doc = await docRef.get();

      if (doc.exists) {
        const data = doc.data();
        
        // Récupérer les données du profil
        userName = data.displayName || 'Utilisateur';
        userBio = data.bio || '';
        userPhoto = data.photoURL || '';
        
        // Construire les balises OG dynamiques
        ogTitle = userName + ' - LinkExt';
        ogDescription = userBio || `Découvrez le profil de ${userName} sur LinkExt.`;
        
        // Utiliser la photo de profil si disponible, sinon générer une avatar
        if (userPhoto && userPhoto.startsWith('http')) {
          ogImage = userPhoto;
        } else {
          ogImage = generateAvatarUrl(userName);
        }

        // Utiliser le SEO personnalisé si disponible
        if (data.seo) {
          if (data.seo.title) ogTitle = data.seo.title;
          if (data.seo.description) ogDescription = data.seo.description;
        }

        console.log(`✅ Profil chargé pour l'UID: ${uid} - ${userName}`);
      } else {
        console.log(`⚠️ Profil introuvable pour l'UID: ${uid}`);
        // Utiliser les valeurs par défaut mais avec un message indiquant que le profil n'existe pas
        ogTitle = 'Profil introuvable - LinkExt';
        ogDescription = 'Ce profil n\'existe pas ou a été supprimé.';
      }
    } catch (error) {
      console.error('❌ Erreur Firestore:', error);
      // En cas d'erreur, garder les valeurs par défaut
      ogTitle = 'Erreur - LinkExt';
      ogDescription = 'Impossible de charger le profil.';
    }
  } else {
    console.log('ℹ️ Page d\'accueil - Aucun UID fourni');
  }

  // Récupérer le HTML original depuis le serveur ou utiliser un template
  // Pour Vercel, nous allons construire le HTML complet avec les métadonnées injectées
  const html = generateHTML(ogTitle, ogDescription, ogImage, SITE_URL, userName);

  // Envoyer la réponse avec le bon Content-Type
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
};

/**
 * Génère une URL d'avatar basée sur le nom
 */
function generateAvatarUrl(name) {
  const encodedName = encodeURIComponent(name || 'User');
  return `https://ui-avatars.com/api/?name=${encodedName}&background=0a0b10&color=00f2fe&size=400&font-size=0.5`;
}

/**
 * Génère le HTML complet avec les balises Open Graph injectées
 */
function generateHTML(title, description, image, url, userName) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    
    <!-- ===== TITRE DYNAMIQUE (INJECTÉ PAR LE SERVEUR) ===== -->
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="robots" content="index, follow">
    
    <!-- ===== OPEN GRAPH (INJECTÉ PAR LE SERVEUR) ===== -->
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:image" content="${escapeHtml(image)}">
    <meta property="og:url" content="${escapeHtml(url)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="LinkExt">
    <meta property="og:locale" content="fr_FR">
    
    <!-- ===== TWITTER CARDS (INJECTÉ PAR LE SERVEUR) ===== -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${escapeHtml(image)}">
    <meta name="twitter:site" content="@LinkExt">
    
    <!-- ===== ICÔNES ET FAVICON ===== -->
    <link rel="icon" href="${escapeHtml(DEFAULT_LOGO)}" sizes="any">
    <link rel="apple-touch-icon" href="${escapeHtml(DEFAULT_LOGO)}">
    
    <!-- ===== REDIRECTION VERS LE SITE COMPLET ===== -->
    <!-- Les robots des réseaux sociaux verront cette page statique -->
    <!-- Les utilisateurs normaux seront redirigés vers le SPA -->
    <script>
      // Redirection uniquement si ce n'est pas un robot/IA
      const userAgent = navigator.userAgent.toLowerCase();
      const isBot = /bot|crawler|spider|facebook|twitter|linkedin|whatsapp|slack|discord|telegram|embed|preview/i.test(userAgent);
      const isFacebook = /facebook|fb|fb_iab/i.test(userAgent);
      const isWhatsApp = /whatsapp/i.test(userAgent);
      const isTwitter = /twitter/i.test(userAgent);
      
      if (!isBot && !isFacebook && !isWhatsApp && !isTwitter) {
        // Rediriger les utilisateurs normaux vers le SPA avec le même paramètre
        const currentUrl = new URL(window.location.href);
        const params = new URLSearchParams(window.location.search);
        const uid = params.get('id') || '';
        
        // Construire l'URL de la page d'accueil avec le paramètre
        let redirectUrl = window.location.origin + window.location.pathname;
        if (uid) {
          redirectUrl += '?id=' + uid;
        }
        window.location.replace(redirectUrl);
      }
    </script>
    
    <!-- ===== CONTENU MINIMAL POUR LE ROBOT ===== -->
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: #0a0b10;
        color: #e0e0ff;
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: 100vh;
        margin: 0;
        padding: 20px;
      }
      .og-container {
        max-width: 600px;
        text-align: center;
        padding: 40px 20px;
      }
      .og-avatar {
        width: 120px;
        height: 120px;
        border-radius: 50%;
        border: 3px solid #00f2fe;
        margin-bottom: 20px;
        object-fit: cover;
        background: #0a0b10;
      }
      .og-name {
        font-size: 28px;
        font-weight: 700;
        margin-bottom: 10px;
        background: linear-gradient(135deg, #00f2fe, #4facfe);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }
      .og-bio {
        color: #a0a0c0;
        font-size: 16px;
        line-height: 1.6;
        margin-bottom: 20px;
      }
      .og-footer {
        color: #666;
        font-size: 12px;
        border-top: 1px solid #1a1a2e;
        padding-top: 20px;
      }
      .og-footer a {
        color: #00f2fe;
        text-decoration: none;
      }
    </style>
</head>
<body>
    <div class="og-container">
        <img src="${escapeHtml(image)}" alt="${escapeHtml(userName)}" class="og-avatar" onerror="this.src='${escapeHtml(DEFAULT_LOGO)}'">
        <h1 class="og-name">${escapeHtml(userName)}</h1>
        <p class="og-bio">${escapeHtml(description)}</p>
        <div class="og-footer">
            <p>🔗 <a href="${escapeHtml(url)}">Découvrir le profil complet sur LinkExt</a></p>
            <p>📱 Scannez le QR code pour accéder directement</p>
        </div>
    </div>
</body>
</html>`;
}

/**
 * Échappe les caractères HTML pour éviter les injections
 */
function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, function(m) { return map[m]; });
}
