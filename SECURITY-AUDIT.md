# LinkExt — Audit sécurité & correction production

Date: 2026-10-07

## Incident critique

Symptôme:
- `POST /api/auth-rate-limit` répondait HTTP 500.
- L'interface affichait « Service de sécurité temporairement indisponible. »
- Les logs indiquaient successivement une lecture de `length` sur `undefined`, puis `credential.cert` sur `undefined`.

### Cause racine

`backend/_security.js` utilisait `require('firebase-admin')` comme namespace global et tentait de détecter dynamiquement une éventuelle propriété `default` afin de gérer CommonJS/ESM.

Le projet utilise `firebase-admin` `14.5.0`. La voie robuste et documentée pour cette version est d'utiliser les points d'entrée modulaires:
- `firebase-admin/app`
- `firebase-admin/auth`
- `firebase-admin/firestore`

Le correctif remplace donc la détection heuristique par `getApps()`, `initializeApp()`, `cert()`, `getAuth()` et `getFirestore()`.

Une façade interne conserve les appels existants `getAdminApp().firestore()` et `getAdminApp().auth()`, ce qui limite le périmètre de modification et évite une réécriture de toutes les routes.

## Corrections appliquées

### 1. `backend/_security.js`
- Initialisation Firebase Admin avec API modulaire.
- Réutilisation de l'application déjà initialisée avec `getApps()`.
- Normalisation robuste de `FIREBASE_PRIVATE_KEY` (`\n`, guillemets, CRLF).
- Support conservé de `FIREBASE_SERVICE_ACCOUNT`.
- Validation explicite de la clé privée.
- Aucun secret n'est renvoyé au client.
- `verifyBearerUser()` utilise désormais `getAuth(app).verifyIdToken()`.

### 2. `backend/auth-rate-limit.js`
- Correction de la dépendance Firebase indirecte.
- Vérification stricte de l'origine.
- `Cache-Control: no-store`.
- Validation et limitation de l'identifiant.
- Correction d'une vulnérabilité de déni de service: le compteur combine désormais compte + IP au lieu de permettre à n'importe quelle IP de verrouiller un compte ciblé par email.
- Les réponses d'erreur internes ne sont pas exposées.

### 3. `api/index.js`
- Limitation de taille des corps JSON/urlencoded à 1 MiB.
- Validation stricte du nom de route `[A-Za-z0-9_-]+`.
- Suppression de l'exposition de `error.message`.
- Réduction du risque de traversal/path loading arbitraire via le routeur dynamique.

### 4. `backend/save-profile.js`
- Les champs sensibles gérés par le serveur (`email`, compteurs, abonnés, etc.) ne peuvent plus être injectés dans une sauvegarde de profil utilisateur.

### 5. `firestore.rules`
- Renforcement des champs protégés des profils.
- `analytics_events` n'accepte plus des documents arbitraires.
- L'utilisateur authentifié ne peut écrire des analytics qu'à son propre UID.
- Un visiteur anonyme ne peut utiliser que l'identifiant `anonymous`.
- Taille/types des champs analytics contrôlés.
- Mise à jour des analytics interdite après création.

### 6. Nettoyage
Suppression de plusieurs imports directs inutilisés de `firebase-admin` dans les routes afin d'éviter de réintroduire l'ancien namespace global.

### 7. `package.json`
- Moteur Node aligné sur Node.js >= 22, cohérent avec `firebase-admin` 14.5.0.

## Tests effectués

- Vérification syntaxique Node.js de 30 fichiers JavaScript: OK.
- `scripts/build-check.js`: OK.
- Smoke test de l'initialisation Firebase modulaire: OK avec modules simulés.
- Smoke test du rate-limit: OK avec Firestore simulé.
- Vérification statique des routes et des usages de `_security.js`.
- Vérification de la cohérence JSON de `package.json` et `vercel.json`.

## Point à valider sur Vercel

Le runtime de production doit utiliser Node.js 22+ et les variables suivantes doivent être présentes:
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `RATE_LIMIT_SALT`
- `APP_ORIGIN`

Pour `FIREBASE_PRIVATE_KEY`, une valeur contenant des `\n` littéraux est désormais acceptée et convertie automatiquement en retours à la ligne.

Aucune clé privée Firebase ne doit être placée dans le frontend, Git ou les logs.

## Limitation du test

Le ZIP ne contient pas `node_modules` et l'installation locale des dépendances n'a pas pu être menée à terme dans l'environnement d'audit. Les tests runtime Firebase ont donc été effectués avec des modules de simulation, en plus des contrôles syntaxiques/statistiques. Une vérification finale avec les vraies variables Vercel et Firebase reste nécessaire après déploiement.

## Niveau de risque après correction

- Crash Firebase Admin: corrigé dans le code.
- Exposition de détails d'erreur API: corrigée sur le routeur et auth-rate-limit.
- Verrouillage d'un compte distant par email: corrigé.
- Chargement de fichiers par chemin API arbitraire: fortement restreint.
- Écriture analytics arbitraire: restreinte par règles Firestore.
- Intégrité des champs sensibles de profil: renforcée.

