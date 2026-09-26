const fs = require('fs');
const path = require('path');

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sanitizeHttpUrl(value, fallback = '') {
  if (!value || typeof value !== 'string') return fallback;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback;
    return url.toString();
  } catch (_) {
    return fallback;
  }
}

module.exports = async (req, res) => {
  const rawId = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  const id = typeof rawId === 'string' ? rawId.trim() : '';

  let title = 'Linktreepro - Ta page de liens personnalisée';
  let description = 'Centralisez vos réseaux et projets en un clic.';
  let imageUrl = 'https://ui-avatars.com/api/?name=Linktreepro&background=0a0b10&color=00f2fe&size=200';

  if (id && /^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    try {
      const firestoreId = encodeURIComponent(id);
      const response = await fetch(
        `https://firestore.googleapis.com/v1/projects/linkext-83984/databases/(default)/documents/users/${firestoreId}`
      );
      if (response.ok) {
        const data = await response.json();
        if (data.fields) {
          const displayName = data.fields.displayName?.stringValue;
          const bio = data.fields.bio?.stringValue;
          const photoURL = data.fields.photoURL?.stringValue;

          if (displayName) title = `${displayName} - LinkExt`;
          if (bio) description = bio;
          if (photoURL) imageUrl = sanitizeHttpUrl(photoURL, imageUrl);
        }
      }
    } catch (e) {
      console.error('Erreur de récupération :', e);
    }
  }

  try {
    const indexPath1 = path.join(process.cwd(), 'index.html');
    const indexPath2 = path.join(__dirname, '..', 'index.html');
    let html = '';

    try {
      if (fs.existsSync(indexPath1)) {
        html = fs.readFileSync(indexPath1, 'utf8');
      } else if (fs.existsSync(indexPath2)) {
        html = fs.readFileSync(indexPath2, 'utf8');
      } else {
        throw new Error("Fichier index.html introuvable dans le bundle Vercel");
      }
    } catch (err) {
      console.error('Erreur lecture HTML :', err);
      return res.status(500).send('Erreur interne du serveur lors de la lecture du fichier.');
    }

    html = html.replace(/<meta property="og:[^>]+>/g, '');
    html = html.replace(/<meta name="twitter:[^>]+>/g, '');
    html = html.replace(/<title>[^<]*<\/title>/, '');

    const safeTitle = escapeHTML(title);
    const safeDescription = escapeHTML(description);
    const safeImageUrl = escapeHTML(sanitizeHttpUrl(imageUrl, ''));

    const metaTags = `
      <title>${safeTitle}</title>
      <meta property="og:title" content="${safeTitle}">
      <meta property="og:description" content="${safeDescription}">
      <meta property="og:image" content="${safeImageUrl}">
      <meta property="og:type" content="profile">
      <meta name="twitter:card" content="summary_large_image">
      <meta name="twitter:title" content="${safeTitle}">
      <meta name="twitter:description" content="${safeDescription}">
      <meta name="twitter:image" content="${safeImageUrl}">
    `;

    html = html.replace('</head>', `${metaTags}\n</head>`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err) {
    console.error('Erreur OG :', err);
    res.status(500).send('Erreur serveur');
  }
};
