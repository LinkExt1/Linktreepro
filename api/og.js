const fs = require('fs');
const path = require('path');

/**
 * Escape HTML before inserting any dynamic value into HTML attributes/content.
 */
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Only allow absolute HTTP(S) URLs in Open Graph metadata.
 */
function sanitizeHttpUrl(value, fallback = '') {
  if (!value || typeof value !== 'string') return fallback;

  try {
    const url = new URL(value.trim());

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return fallback;
    }

    return url.toString();
  } catch (_) {
    return fallback;
  }
}

/**
 * Convert a Firestore REST Value into a normal JavaScript value.
 */
function firestoreValueToJS(value) {
  if (!value || typeof value !== 'object') return null;

  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('geoPointValue' in value) return value.geoPointValue;

  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(firestoreValueToJS);
  }

  if ('mapValue' in value) {
    const fields = value.mapValue.fields || {};

    return Object.fromEntries(
      Object.entries(fields).map(([key, fieldValue]) => [
        key,
        firestoreValueToJS(fieldValue)
      ])
    );
  }

  return null;
}

function firestoreDocumentToJS(document) {
  const fields = document?.fields || {};

  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      firestoreValueToJS(value)
    ])
  );
}

function getFirstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

module.exports = async (req, res) => {
  const rawId = Array.isArray(req.query?.id)
    ? req.query.id[0]
    : req.query?.id;

  const id = typeof rawId === 'string'
    ? rawId.trim()
    : '';

  let title = 'LinkExt - Ta page de liens personnalisée';

  let description =
    'Centralisez vos réseaux et projets en un clic.';

  let imageUrl =
    'https://ui-avatars.com/api/?name=LinkExt&background=0a0b10&color=00f2fe&size=200';

  /*
   * Récupération du profil Firestore.
   */
  if (id && /^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    try {
      const firestoreId = encodeURIComponent(id);

      const response = await fetch(
        `https://firestore.googleapis.com/v1/projects/linkext-83984/databases/(default)/documents/users/${firestoreId}`
      );

      if (response.ok) {
        const firestoreDocument = await response.json();

        const user = firestoreDocumentToJS(
          firestoreDocument
        );

        const displayName = getFirstNonEmptyString(
          user.displayName,
          user.username,
          user.name
        );

        const bio = getFirstNonEmptyString(
          user.bio
        );

        const photoURL = getFirstNonEmptyString(
          user.photoURL,
          user.photoUrl
        );

        const redirectMessage = getFirstNonEmptyString(
          user.redirect_message,
          'Redirection sécurisée en cours...'
        );

        /*
         * Liste des liens du profil.
         */
        const links = Array.isArray(user.links)
          ? user.links
          : [];

        /*
         * On conserve uniquement les liens actifs
         * possédant une URL et qui ne sont pas des sections.
         */
        const activeLinks = links.filter((link) =>
          link &&
          link.active === true &&
          link.isSection !== true &&
          typeof link.url === 'string' &&
          link.url.trim() !== ''
        );

        /*
         * Redirection Unique :
         *
         * Compatible avec les différentes propriétés
         * utilisées dans LinkExt :
         *
         * - redirectUnique
         * - singleRedirect
         * - activeSingleLink
         *
         * Et on exige exactement un lien actif.
         */
        const singleRedirectEnabled =
          (
            user.redirectUnique === true ||
            user.singleRedirect === true ||
            user.activeSingleLink === true
          ) &&
          activeLinks.length === 1;

        if (singleRedirectEnabled) {

          const link = activeLinks[0];

          /*
           * Titre du lien.
           */
          const linkTitle = getFirstNonEmptyString(
            link.title,
            link.name,
            link.label,
            link.description,
            redirectMessage
          );

          /*
           * Description du lien.
           */
          const linkDescription = getFirstNonEmptyString(
            link.description,
            redirectMessage,
            bio
          );

          /*
           * Image spécifique du lien.
           *
           * Priorité :
           * 1. imageUrl
           * 2. previewImage
           */
          const linkImage = getFirstNonEmptyString(
            link.imageUrl,
            link.previewImage
          );

          title = linkTitle || title;

          description =
            linkDescription || description;

          /*
           * L'image du lien est prioritaire.
           *
           * Si elle est absente ou invalide,
           * on revient sur la photo du profil.
           */
          imageUrl = sanitizeHttpUrl(
            linkImage,
            ''
          );

          if (!imageUrl) {
            imageUrl = sanitizeHttpUrl(
              photoURL,
              imageUrl
            );
          }

        } else {

          /*
           * Comportement normal :
           * aperçu du profil LinkExt.
           */
          if (displayName) {
            title = `${displayName} - LinkExt`;
          }

          if (bio) {
            description = bio;
          }

          if (photoURL) {
            imageUrl = sanitizeHttpUrl(
              photoURL,
              imageUrl
            );
          }
        }
      }

    } catch (e) {
      console.error(
        'Erreur de récupération Firestore :',
        e
      );
    }
  }

  /*
   * Génération de la page HTML contenant
   * les métadonnées Open Graph / Twitter.
   */
  try {
    const indexPath = path.join(
      process.cwd(),
      'index.html'
    );

    let html = fs.readFileSync(
      indexPath,
      'utf8'
    );

    /*
     * Supprime les anciennes métadonnées
     * OG/Twitter pour éviter les doublons.
     */
    html = html.replace(
      /<meta property="og:[^>]+>/gi,
      ''
    );

    html = html.replace(
      /<meta name="twitter:[^>]+>/gi,
      ''
    );

    html = html.replace(
      /<title>[^<]*<\/title>/i,
      ''
    );

    /*
     * Échappement obligatoire avant insertion
     * dans le HTML.
     */
    const safeTitle = escapeHTML(
      title
    );

    const safeDescription = escapeHTML(
      description
    );

    const safeImageUrl = escapeHTML(
      sanitizeHttpUrl(
        imageUrl,
        ''
      )
    );

    /*
     * Métadonnées Open Graph + Twitter Card.
     */
    const metaTags = `
      <title>${safeTitle}</title>

      <meta property="og:title" content="${safeTitle}">
      <meta property="og:description" content="${safeDescription}">
      <meta property="og:image" content="${safeImageUrl}">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
      <meta property="og:type" content="profile">

      <meta name="twitter:card" content="summary_large_image">
      <meta name="twitter:title" content="${safeTitle}">
      <meta name="twitter:description" content="${safeDescription}">
      <meta name="twitter:image" content="${safeImageUrl}">
    `;

    /*
     * Injection juste avant </head>.
     */
    html = html.replace(
      '</head>',
      `${metaTags}\n</head>`
    );

    res.setHeader(
      'Content-Type',
      'text/html; charset=utf-8'
    );

    res.setHeader(
      'Cache-Control',
      'public, s-maxage=60, stale-while-revalidate=300'
    );

    return res
      .status(200)
      .send(html);

  } catch (err) {

    console.error(
      'Erreur OG :',
      err
    );

    return res
      .status(500)
      .send('Erreur serveur');
  }
};
