const fs = require('fs');
const path = require('path');

/**
 * Échappe une valeur avant insertion dans un attribut HTML.
 */
function escapeHTML(value) {
  if (value === null || value === undefined) return '';

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Autorise uniquement les URLs HTTP(S).
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
 * Convertit une valeur Firestore REST en valeur JavaScript.
 */
function firestoreValueToJs(value) {
  if (!value || typeof value !== 'object') return null;

  if ('stringValue' in value) {
    return value.stringValue;
  }

  if ('booleanValue' in value) {
    return value.booleanValue;
  }

  if ('integerValue' in value) {
    return Number(value.integerValue);
  }

  if ('doubleValue' in value) {
    return Number(value.doubleValue);
  }

  if ('timestampValue' in value) {
    return value.timestampValue;
  }

  if ('nullValue' in value) {
    return null;
  }

  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(firestoreValueToJs);
  }

  if ('mapValue' in value) {
    const fields = value.mapValue.fields || {};

    return Object.fromEntries(
      Object.entries(fields).map(([key, fieldValue]) => [
        key,
        firestoreValueToJs(fieldValue)
      ])
    );
  }

  return null;
}

/**
 * Convertit un document Firestore REST complet en objet JS.
 */
function firestoreDocumentToJs(document) {
  const fields = document?.fields || {};

  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      firestoreValueToJs(value)
    ])
  );
}

/**
 * Remplace le contenu d'une balise <meta> existante
 * indépendamment de sa valeur placeholder.
 *
 * Exemple :
 *
 * <meta property="og:title" content="N'importe quoi">
 *
 * devient :
 *
 * <meta property="og:title" content="Titre dynamique">
 */
function replaceMetaContent(
  html,
  attributeName,
  attributeValue,
  dynamicValue
) {
  const safeValue = escapeHTML(dynamicValue);

  const escapedAttributeValue = attributeValue.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );

  const tagRegex = new RegExp(
    `<meta\\b(?=[^>]*\\b${attributeName}\\s*=\\s*["']${escapedAttributeValue}["'])[^>]*>`,
    'gi'
  );

  let found = false;

  html = html.replace(tagRegex, (tag) => {
    found = true;

    const contentRegex = /\bcontent\s*=\s*(["'])[^"']*\1/i;

    const replacement = `content="${safeValue}"`;

    if (contentRegex.test(tag)) {
      return tag.replace(contentRegex, replacement);
    }

    return tag.replace(
      /\s*\/?>\s*$/,
      ` ${replacement}>`
    );
  });

  return {
    html,
    found
  };
}

/**
 * Remplace toutes les balises OG/Twitter nécessaires.
 *
 * Si une balise n'existe pas dans index.html,
 * elle est ajoutée automatiquement.
 */
function setMetaTags(html, values) {
  const definitions = [
    ['property', 'og:title', values.ogTitle],
    ['property', 'og:description', values.ogDescription],
    ['property', 'og:image', values.ogImage],
    ['property', 'og:type', values.ogType],

    ['name', 'twitter:card', values.twitterCard],
    ['name', 'twitter:title', values.twitterTitle],
    ['name', 'twitter:description', values.twitterDescription],
    ['name', 'twitter:image', values.twitterImage]
  ];

  const missing = [];

  for (const [
    attributeName,
    attributeValue,
    dynamicValue
  ] of definitions) {
    const result = replaceMetaContent(
      html,
      attributeName,
      attributeValue,
      dynamicValue
    );

    html = result.html;

    if (!result.found) {
      missing.push(
        `<meta ${attributeName}="${attributeValue}" content="${escapeHTML(dynamicValue)}">`
      );
    }
  }

  if (missing.length > 0) {
    const tags = `
      ${missing.join('\n      ')}
    `;

    if (/<\/head>/i.test(html)) {
      html = html.replace(
        /<\/head>/i,
        `${tags}</head>`
      );
    }
  }

  return html;
}

/**
 * Remplace le <title> de façon robuste.
 */
function setTitle(html, dynamicTitle) {
  const safeTitle = escapeHTML(dynamicTitle);

  const titleRegex =
    /<title\b[^>]*>[^<]*<\/title>/i;

  if (titleRegex.test(html)) {
    return html.replace(
      titleRegex,
      `<title>${safeTitle}</title>`
    );
  }

  return html.replace(
    /<\/head>/i,
    `<title>${safeTitle}</title>\n</head>`
  );
}

module.exports = async (req, res) => {
  const rawId = Array.isArray(req.query?.id)
    ? req.query.id[0]
    : req.query?.id;

  const id =
    typeof rawId === 'string'
      ? rawId.trim()
      : '';

  /*
   * Valeurs par défaut.
   *
   * Elles sont conservées si :
   * - Firestore est indisponible ;
   * - FIREBASE_PROJECT_ID manque ;
   * - l'utilisateur n'existe pas ;
   * - l'ID est invalide ;
   * - une erreur Firestore survient.
   */
  const defaultTitle =
    'Linktreepro - Ta page de liens personnalisée';

  const defaultDescription =
    'Centralisez vos réseaux et projets en un clic.';

  const defaultImage =
    'https://ui-avatars.com/api/?name=Linktreepro&background=0a0b10&color=00f2fe&size=200';

  let dynamicTitle = defaultTitle;
  let dynamicDescription = defaultDescription;
  let dynamicImage = defaultImage;

  /*
   * ============================================================
   * FIRESTORE
   * ============================================================
   */
  try {
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      console.warn(
        'OG : ID utilisateur absent ou invalide. HTML par défaut utilisé.'
      );
    } else {
      /*
       * Variable Vercel :
       *
       * FIREBASE_PROJECT_ID=linkext-83984
       */
      const projectId =
        process.env.FIREBASE_PROJECT_ID;

      if (!projectId) {
        console.error(
          'OG Firestore : variable FIREBASE_PROJECT_ID absente sur Vercel. HTML par défaut utilisé.'
        );
      } else {
        const firestoreId =
          encodeURIComponent(id);

        const firestoreUrl =
          `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
          `/databases/(default)/documents/users/${firestoreId}`;

        const response =
          await fetch(firestoreUrl);

        if (!response.ok) {
          const errorBody =
            await response.text().catch(() => '');

          console.error(
            `OG Firestore : HTTP ${response.status} ${response.statusText || ''}`.trim(),
            errorBody
              ? `- ${errorBody.slice(0, 1000)}`
              : ''
          );
        } else {
          const firestoreDocument =
            await response.json();

          const user =
            firestoreDocumentToJs(
              firestoreDocument
            );

          const displayName =
            typeof user.displayName === 'string'
              ? user.displayName.trim()
              : '';

          const bio =
            typeof user.bio === 'string'
              ? user.bio.trim()
              : '';

          const photoURL =
            typeof user.photoURL === 'string'
              ? user.photoURL.trim()
              : '';

          /*
           * ======================================================
           * LIENS
           * ======================================================
           */
          const links =
            Array.isArray(user.links)
              ? user.links
              : [];

          const activeLinks =
            links.filter(
              (link) =>
                link &&
                link.active === true &&
                link.isSection !== true &&
                typeof link.url === 'string' &&
                link.url.trim() !== ''
            );

          /*
           * ======================================================
           * REDIRECTION UNIQUE
           * ======================================================
           *
           * LinkExt active réellement la redirection unique
           * lorsque :
           *
           * redirectUnique === true
           *
           * ET
           *
           * exactement un lien actif existe.
           */
          const uniqueRedirectActive =
            user.redirectUnique === true &&
            activeLinks.length === 1;

          if (uniqueRedirectActive) {
            /*
             * ====================================================
             * RÈGLE 1
             * ====================================================
             *
             * Redirection unique :
             *
             * - titre = titre du lien unique
             * - image = image du lien unique
             *
             * PAS de remplacement par la photo de profil.
             */
            const uniqueLink =
              activeLinks[0];

            const linkTitle =
              typeof uniqueLink.title === 'string' &&
              uniqueLink.title.trim()
                ? uniqueLink.title.trim()
                : typeof uniqueLink.name === 'string' &&
                  uniqueLink.name.trim()
                  ? uniqueLink.name.trim()
                  : 'Redirection sécurisée';

            const linkImage =
              typeof uniqueLink.imageUrl === 'string'
                ? uniqueLink.imageUrl.trim()
                : '';

            dynamicTitle =
              `${linkTitle} - LinkExt`;

            dynamicImage =
              sanitizeHttpUrl(
                linkImage,
                ''
              );

            /*
             * Le message de redirection est utilisé comme
             * description si disponible.
             */
            dynamicDescription =
              typeof user.redirect_message === 'string' &&
              user.redirect_message.trim()
                ? user.redirect_message.trim()
                : linkTitle;

          } else {
            /*
             * ====================================================
             * RÈGLE 2
             * ====================================================
             *
             * Pas de redirection unique :
             *
             * - photo = photo de profil
             * - description = bio
             * - titre = nom affiché
             */
            dynamicTitle =
              displayName
                ? `${displayName} - LinkExt`
                : defaultTitle;

            dynamicDescription =
              bio ||
              defaultDescription;

            dynamicImage =
              sanitizeHttpUrl(
                photoURL,
                defaultImage
              );
          }
        }
      }
    }
  } catch (error) {
    /*
     * IMPORTANT :
     * Une erreur Firestore ne doit jamais empêcher
     * l'envoi de index.html.
     */
    console.error(
      'OG Firestore : erreur de récupération/traitement :',
      error
    );
  }

  /*
   * ============================================================
   * LECTURE DE INDEX.HTML
   * ============================================================
   */
  try {
    const indexPath1 =
      path.join(
        process.cwd(),
        'index.html'
      );

    const indexPath2 =
      path.join(
        __dirname,
        '..',
        'index.html'
      );

    let html = '';

    try {
      if (fs.existsSync(indexPath1)) {
        html =
          fs.readFileSync(
            indexPath1,
            'utf8'
          );
      } else if (fs.existsSync(indexPath2)) {
        html =
          fs.readFileSync(
            indexPath2,
            'utf8'
          );
      } else {
        throw new Error(
          'Fichier index.html introuvable dans le bundle Vercel'
        );
      }
    } catch (err) {
      console.error(
        'Erreur lecture HTML :',
        err
      );

      return res
        .status(500)
        .send(
          'Erreur interne du serveur lors de la lecture du fichier.'
        );
    }

    /*
     * ============================================================
     * REMPLACEMENT DYNAMIQUE
     * ============================================================
     *
     * On ne dépend PAS du texte placeholder présent dans
     * index.html.
     */
    html =
      setTitle(
        html,
        dynamicTitle
      );

    html =
      setMetaTags(
        html,
        {
          ogTitle:
            dynamicTitle,

          ogDescription:
            dynamicDescription,

          ogImage:
            dynamicImage,

          ogType:
            'profile',

          twitterCard:
            'summary_large_image',

          twitterTitle:
            dynamicTitle,

          twitterDescription:
            dynamicDescription,

          twitterImage:
            dynamicImage
        }
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

  } catch (error) {
    console.error(
      'Erreur OG :',
      error
    );

    return res
      .status(500)
      .send(
        'Erreur serveur'
      );
  }
};
