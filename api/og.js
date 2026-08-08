// api/og.js - Serverless Function Vercel pour l'aperçu dynamique Open Graph

// ============================================================
// IMPORT DES MODULES
// ============================================================
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURATION
// ============================================================
const FIREBASE_PROJECT_ID = 'linkext-83984';
const FIRESTORE_API_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// ============================================================
// FONCTIONS UTILITAIRES
// ============================================================

/**
 * Récupère les données d'un utilisateur depuis Firestore via l'API REST
 * @param {string} uid - L'ID de l'utilisateur
 * @returns {Promise<Object|null>} - Les données de l'utilisateur ou null
 */
async function fetchUserData(uid) {
    if (!uid || uid === '') {
        return null;
    }

    try {
        const url = `${FIRESTORE_API_URL}/users/${uid}`;
        const response = await fetch(url);

        if (!response.ok) {
            console.error(`Erreur Firestore API: ${response.status}`);
            return null;
        }

        const data = await response.json();

        if (!data.fields) {
            return null;
        }

        // Convertir les champs Firestore en objets JavaScript
        const fields = data.fields;
        const userData = {};

        // Mapping des types Firestore vers JS
        if (fields.displayName) {
            userData.displayName = fields.displayName.stringValue || 'Utilisateur';
        }
        if (fields.bio) {
            userData.bio = fields.bio.stringValue || '';
        }
        if (fields.photoURL) {
            userData.photoURL = fields.photoURL.stringValue || '';
        }
        if (fields.seo) {
            userData.seo = {
                title: fields.seo.mapValue?.fields?.title?.stringValue || '',
                description: fields.seo.mapValue?.fields?.description?.stringValue || '',
                keywords: fields.seo.mapValue?.fields?.keywords?.stringValue || ''
            };
        }

        return userData;
    } catch (error) {
        console.error('Erreur lors de la récupération des données utilisateur:', error);
        return null;
    }
}

/**
 * Génère une URL d'image dynamique pour l'aperçu
 * @param {string} name - Nom de l'utilisateur
 * @param {string} avatarUrl - URL de l'avatar
 * @param {string} bio - Bio de l'utilisateur
 * @returns {string} - URL de l'image dynamique
 */
function generateOgImageUrl(name, avatarUrl, bio) {
    const encodedName = encodeURIComponent(name || 'LinkExt');
    const encodedAvatar = encodeURIComponent(avatarUrl || '');
    const encodedBio = encodeURIComponent(bio || '');
    
    // Utiliser le service OG Image de Vercel
    return `https://og-image.vercel.app/${encodedName}%20-%20LinkExt.png?theme=dark&md=1&fontSize=50px&images=${encodedAvatar}&description=${encodedBio}&width=1200&height=630`;
}

/**
 * Injecte les balises Open Graph dans le HTML
 * @param {string} html - Le HTML brut
 * @param {Object} data - Les données à injecter
 * @param {string} url - L'URL complète de la page
 * @returns {string} - Le HTML modifié
 */
function injectOpenGraphTags(html, data, url) {
    if (!data) {
        // Données par défaut (profil générique)
        data = {
            displayName: 'LinkExt',
            bio: 'Centralisez vos réseaux et projets en un clic',
            photoURL: 'https://ui-avatars.com/api/?name=LinkExt&background=0a0b10&color=00f2fe&size=200'
        };
    }

    const title = data.displayName ? `${data.displayName} - LinkExt` : 'LinkExt - Centralisez vos réseaux';
    const description = data.bio || 'Découvrez le profil de ' + (data.displayName || 'cet utilisateur') + ' sur LinkExt.';
    const imageUrl = data.photoURL ? generateOgImageUrl(data.displayName, data.photoURL, data.bio) : 'https://ui-avatars.com/api/?name=LinkExt&background=0a0b10&color=00f2fe&size=200';

    // Remplacer les balises Open Graph
    let modifiedHtml = html;

    // Remplacer og:title
    modifiedHtml = modifiedHtml.replace(
        /<meta property="og:title" content="[^"]*"/,
        `<meta property="og:title" content="${title}"`
    );

    // Remplacer og:description
    modifiedHtml = modifiedHtml.replace(
        /<meta property="og:description" content="[^"]*"/,
        `<meta property="og:description" content="${description}"`
    );

    // Remplacer og:image
    modifiedHtml = modifiedHtml.replace(
        /<meta property="og:image" content="[^"]*"/,
        `<meta property="og:image" content="${imageUrl}"`
    );

    // Remplacer og:url
    modifiedHtml = modifiedHtml.replace(
        /<meta property="og:url" content="[^"]*"/,
        `<meta property="og:url" content="${url}"`
    );

    // Remplacer twitter:title
    modifiedHtml = modifiedHtml.replace(
        /<meta name="twitter:title" content="[^"]*"/,
        `<meta name="twitter:title" content="${title}"`
    );

    // Remplacer twitter:description
    modifiedHtml = modifiedHtml.replace(
        /<meta name="twitter:description" content="[^"]*"/,
        `<meta name="twitter:description" content="${description}"`
    );

    // Remplacer twitter:image
    modifiedHtml = modifiedHtml.replace(
        /<meta name="twitter:image" content="[^"]*"/,
        `<meta name="twitter:image" content="${imageUrl}"`
    );

    // Remplacer le titre de la page
    modifiedHtml = modifiedHtml.replace(
        /<title>[^<]*<\/title>/,
        `<title>${title}</title>`
    );

    return modifiedHtml;
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

module.exports = async (req, res) => {
    try {
        // 1. Récupérer l'URL et les paramètres
        const fullUrl = `https://${req.headers.host}${req.url}`;
        const url = new URL(fullUrl);
        const uid = url.searchParams.get('id');

        // 2. Lire le fichier index.html
        const indexPath = path.join(process.cwd(), 'index.html');
        let html;

        try {
            html = fs.readFileSync(indexPath, 'utf8');
        } catch (err) {
            console.error('Erreur lecture index.html:', err);
            // Fallback si le fichier n'existe pas
            html = `
                <!DOCTYPE html>
                <html>
                <head><title>LinkExt</title></head>
                <body><h1>Site en cours de chargement...</h1></body>
                </html>
            `;
        }

        // 3. Vérifier si c'est une requête pour un profil utilisateur
        if (uid && uid !== '') {
            console.log(`[OG] Requête pour l'utilisateur: ${uid}`);
            const userData = await fetchUserData(uid);

            if (userData) {
                console.log(`[OG] Données récupérées: ${userData.displayName}`);
                // Injecter les données utilisateur
                html = injectOpenGraphTags(html, userData, fullUrl);
            } else {
                console.log(`[OG] Utilisateur non trouvé: ${uid}, utilisation des données par défaut`);
                // Données par défaut mais avec le nom de l'utilisateur dans l'URL
                const defaultData = {
                    displayName: `Profil ${uid.substring(0, 8)}`,
                    bio: 'Découvrez ce profil sur LinkExt',
                    photoURL: 'https://ui-avatars.com/api/?name=Profil&background=0a0b10&color=00f2fe&size=200'
                };
                html = injectOpenGraphTags(html, defaultData, fullUrl);
            }
        } else {
            console.log('[OG] Requête sans ID utilisateur, utilisation des balises par défaut');
            // Utiliser les données par défaut du site
            const defaultData = {
                displayName: 'LinkExt',
                bio: 'Centralisez vos réseaux et projets en un clic',
                photoURL: 'https://ui-avatars.com/api/?name=LinkExt&background=0a0b10&color=00f2fe&size=200'
            };
            html = injectOpenGraphTags(html, defaultData, fullUrl);
        }

        // 4. Envoyer la réponse
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(html);

    } catch (error) {
        console.error('[OG] Erreur fatale:', error);
        // En cas d'erreur, renvoyer la page par défaut
        try {
            const indexPath = path.join(process.cwd(), 'index.html');
            const html = fs.readFileSync(indexPath, 'utf8');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.status(200).send(html);
        } catch (e) {
            res.status(500).send('Erreur serveur');
        }
    }
};
