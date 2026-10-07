const express = require('express');
const app = express();

// Limite volontairement large pour les profils/catalogues, tout en évitant
// qu'une requête gigantesque monopolise une fonction serverless.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const ROUTE_NAME_RE = /^[A-Za-z0-9_-]+$/;

app.all('/api/*', async (req, res) => {
  const routePath = String(req.params[0] || '');

  // Le routeur ne doit jamais transformer une URL fournie par le client
  // en chemin de fichier arbitraire.
  if (!ROUTE_NAME_RE.test(routePath)) {
    return res.status(404).json({ error: 'Endpoint API introuvable' });
  }

  try {
    const handler = require(`../backend/${routePath}.js`);
    if (typeof handler !== 'function') {
      return res.status(404).json({ error: 'Endpoint API introuvable' });
    }
    return await handler(req, res);
  } catch (error) {
    console.error(`Erreur sur la route /api/${routePath} :`, error);

    // Ne jamais exposer error.message au client en production.
    // MODULE_NOT_FOUND peut arriver si une route n'existe pas.
    if (error && error.code === 'MODULE_NOT_FOUND') {
      return res.status(404).json({ error: 'Endpoint API introuvable' });
    }

    return res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

module.exports = app;
