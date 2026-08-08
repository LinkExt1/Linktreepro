const fs = require('fs');
const path = require('path');

// ============================================================
// ⚠️ METS TON VRAI ID DE PROJET FIREBASE ICI SI CE N'EST PAS LE BON
// ============================================================
const FIREBASE_PROJECT_ID = 'linkext-83984'; 
const FIRESTORE_API_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

async function fetchUserData(uid) {
    if (!uid) return null;
    try {
        const response = await fetch(`${FIRESTORE_API_URL}/users/${uid}`);
        if (!response.ok) return null;
        const data = await response.json();
        if (!data.fields) return null;

        return {
            displayName: data.fields.displayName?.stringValue || 'Utilisateur',
            bio: data.fields.bio?.stringValue || 'Découvrez mon profil sur LinkExt',
            photoURL: data.fields.photoURL?.stringValue || 'https://ui-avatars.com/api/?name=LinkExt&background=0a0b10&color=00f2fe&size=200'
        };
    } catch (e) {
        return null;
    }
}

module.exports = async (req, res) => {
    try {
        const fullUrl = `https://${req.headers.host}${req.url}`;
        const url = new URL(fullUrl);
        const uid = url.searchParams.get('id');

        // 1. Lire le fichier HTML d'origine
        const indexPath = path.join(process.cwd(), 'index.html');
        let html = fs.readFileSync(indexPath, 'utf8');

        // 2. Données par défaut du site
        let title = 'LinkExt - Centralisez vos réseaux';
        let description = 'Créez votre page de liens personnalisée en un clic.';
        let imageUrl = 'https://ui-avatars.com/api/?name=LinkExt&background=0a0b10&color=00f2fe&size=200';

        // 3. Récupérer les données de l'utilisateur si un ID est présent
        if (uid) {
            const userData = await fetchUserData(uid);
            if (userData) {
                title = `${userData.displayName} - LinkExt`;
                description = userData.bio;
                // ON DONNE DIRECTEMENT LA PHOTO FIREBASE AU ROBOT
                imageUrl = userData.photoURL; 
            }
        }

        // 4. Nettoyer le HTML d'origine (on supprime l'ancien bloc head générique pour éviter les conflits)
        // On supprime proprement les anciennes balises meta OG et Twitter
        html = html.replace(/<meta property="og:[^>]+>/g, '');
        html = html.replace(/<meta name="twitter:[^>]+>/g, '');
        html = html.replace(/<title>[^<]*<\/title>/, '');

        // 5. Créer les balises dynamiques infaillibles
        const metaTags = `
    <title>${title}</title>
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${imageUrl}">
    <meta property="og:url" content="${fullUrl}">
    <meta property="og:type" content="profile">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${imageUrl}">
        `;

        // 6. On injecte nos balises propres juste avant la fermeture du </head>
        html = html.replace('</head>', `${metaTags}\n</head>`);

        // 7. Envoi de la page au robot
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(html);

    } catch (error) {
        console.error('Erreur Vercel:', error);
        res.status(500).send('Erreur lors de la génération de l\'aperçu');
    }
};
