const express = require('express');
const app = express();

// 1. Indispensable : Permet de lire les données POST (le JSON) envoyées par le site
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 2. Routage dynamique qui gère tous les niveaux de sous-dossiers
app.all('/api/*', async (req, res) => {
    try {
        // Sanitization anti path-traversal
        const routePath = String(req.params[0] || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!routePath || routePath.includes('..')) {
            return res.status(404).json({ error: "Endpoint API introuvable" });
        }
        const handler = require(`../backend/${routePath}.js`);
        return await handler(req, res);
    } catch (error) {
        console.error(`Erreur sur la route /api/${req.params[0]} :`, error.message || error);

        // 404 uniquement si le module n'existe pas
        if (error.code === 'MODULE_NOT_FOUND') {
            return res.status(404).json({ error: "Endpoint API introuvable" });
        }

        // Ne jamais exposer error.message au client (prévention de fuite d'informations)
        return res.status(500).json({ error: "Erreur interne du serveur" });
    }
});

module.exports = app;
