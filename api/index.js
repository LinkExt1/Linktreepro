const express = require('express');
const app = express();

// 1. Indispensable : Permet de lire les données POST (le JSON) envoyées par le site
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 2. Routage dynamique qui gère tous les niveaux de sous-dossiers
app.all('/api/*', async (req, res) => {
    try {
        const routePath = req.params[0]; // Capture tout ce qui est après /api/
        const handler = require(`../backend/${routePath}.js`);
        return await handler(req, res);
    } catch (error) {
        console.error(`Erreur sur la route /api/${req.params[0]} :`, error);
        
        // 3. Renvoie 404 SEULEMENT si le fichier n'existe vraiment pas
        if (error.code === 'MODULE_NOT_FOUND') {
            return res.status(404).json({ error: "Endpoint API introuvable" });
        }
        
        // 4. Laisse passer les vraies erreurs du code pour pouvoir les corriger
        return res.status(500).json({ error: "Erreur interne du serveur", details: error.message });
    }
});

module.exports = app;
