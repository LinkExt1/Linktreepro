const fs = require('fs');
const path = require('path');
const { getAdminApp, validUid } = require('./_security');

function escapeHTML(value) {
  if (value === null || value === undefined) return '';
  return String(value)
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

function replaceMetaContent(html, attributeName, attributeValue, dynamicValue) {
  const safeValue = escapeHTML(dynamicValue);
  const escapedAttributeValue = attributeValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagRegex = new RegExp(
    `<meta\\b(?=[^>]*\\b${attributeName}\\s*=\\s*["']${escapedAttributeValue}["'])[^>]*>`,
    'gi'
  );
  let found = false;
  html = html.replace(tagRegex, tag => {
    found = true;
    const contentRegex = /\bcontent\s*=\s*(["'])[^"']*\1/i;
    const replacement = `content="${safeValue}"`;
    return contentRegex.test(tag) ? tag.replace(contentRegex, replacement) : tag.replace(/\s*\/?>(\s*)$/, ` ${replacement}>$1`);
  });
  return { html, found };
}

function setMetaTags(html, values) {
  const definitions = [
    ['property', 'og:title', values.ogTitle],
    ['property', 'og:description', values.ogDescription],
    ['property', 'og:image', values.ogImage],
    ['property', 'og:url', values.ogUrl],
    ['property', 'og:type', values.ogType],
    ['name', 'twitter:card', values.twitterCard],
    ['name', 'twitter:title', values.twitterTitle],
    ['name', 'twitter:description', values.twitterDescription],
    ['name', 'twitter:image', values.twitterImage]
  ];
  const missing = [];
  for (const [attributeName, attributeValue, dynamicValue] of definitions) {
    const result = replaceMetaContent(html, attributeName, attributeValue, dynamicValue);
    html = result.html;
    if (!result.found) missing.push(`<meta ${attributeName}="${attributeValue}" content="${escapeHTML(dynamicValue)}">`);
  }
  if (missing.length && /<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${missing.join('\n      ')}\n</head>`);
  }
  return html;
}

function setTitle(html, title) {
  const safe = escapeHTML(title);
  if (/<title\b[^>]*>[^<]*<\/title>/i.test(html)) {
    return html.replace(/<title\b[^>]*>[^<]*<\/title>/i, `<title>${safe}</title>`);
  }
  return html.replace(/<\/head>/i, `<title>${safe}</title>\n</head>`);
}

function publicOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

module.exports = async (req, res) => {
  const rawId = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  const defaultTitle = 'Linktreepro - Ta page de liens personnalisée';
  const defaultDescription = 'Centralisez vos réseaux et projets en un clic.';
  const defaultImage = 'https://ui-avatars.com/api/?name=LinkExt&background=0a0b10&color=00f2fe&size=200';
  const origin = publicOrigin(req);
  let dynamicTitle = defaultTitle;
  let dynamicDescription = defaultDescription;
  let dynamicImage = defaultImage;

  try {
    if (validUid(id)) {
      const app = getAdminApp();
      const snap = await app.firestore().collection('users').doc(id).get();
      if (snap.exists) {
        const user = snap.data() || {};
        if (user.accountStatus !== 'banned') {
          const displayName = typeof user.displayName === 'string' ? user.displayName.trim() : '';
          const bio = typeof user.bio === 'string' ? user.bio.trim() : '';
          const photoURL = typeof user.photoURL === 'string' ? user.photoURL.trim() : '';
          const links = Array.isArray(user.links) ? user.links : [];
          const activeLinks = links.filter(link => link && link.active === true && link.isSection !== true && typeof link.url === 'string' && link.url.trim());
          const unique = user.redirectUnique === true && activeLinks.length === 1;

          if (unique) {
            const link = activeLinks[0];
            const title = typeof link.title === 'string' && link.title.trim()
              ? link.title.trim()
              : typeof link.name === 'string' && link.name.trim() ? link.name.trim() : 'Redirection sécurisée';
            dynamicTitle = `${title} - LinkExt`;
            dynamicDescription = typeof user.redirect_message === 'string' && user.redirect_message.trim()
              ? user.redirect_message.trim() : title;
            dynamicImage = sanitizeHttpUrl(link.imageUrl, sanitizeHttpUrl(photoURL, defaultImage));
          } else {
            dynamicTitle = displayName ? `${displayName} - LinkExt` : defaultTitle;
            dynamicDescription = bio || defaultDescription;
            dynamicImage = sanitizeHttpUrl(photoURL, defaultImage);
          }
        }
      }
    }
  } catch (error) {
    console.error('OG Firestore/Admin SDK :', error);
  }

  try {
    const indexPath1 = path.join(process.cwd(), 'index.html');
    const indexPath2 = path.join(__dirname, '..', 'index.html');
    let html = '';
    try {
      if (fs.existsSync(indexPath1)) html = fs.readFileSync(indexPath1, 'utf8');
      else if (fs.existsSync(indexPath2)) html = fs.readFileSync(indexPath2, 'utf8');
      else throw new Error('Fichier index.html introuvable dans le bundle Vercel');
    } catch (err) {
      console.error('Erreur lecture HTML :', err);
      return res.status(500).send('Erreur interne du serveur lors de la lecture du fichier.');
    }

    html = setTitle(html, dynamicTitle);
    html = setMetaTags(html, {
      ogTitle: dynamicTitle,
      ogDescription: dynamicDescription,
      ogImage: dynamicImage,
      ogUrl: origin ? `${origin}/?id=${encodeURIComponent(id)}` : '',
      ogType: 'profile',
      twitterCard: 'summary_large_image',
      twitterTitle: dynamicTitle,
      twitterDescription: dynamicDescription,
      twitterImage: dynamicImage
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).send(html);
  } catch (error) {
    console.error('Erreur OG :', error);
    return res.status(500).send('Erreur serveur');
  }
};
