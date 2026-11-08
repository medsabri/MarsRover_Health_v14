# MarsRover Health — application web FMDS · PHM · ML

Prototype académique d'**aide à la décision** pour la surveillance de santé, la détection d'anomalies, le pronostic (RUL) et les indicateurs FMDS des sous-systèmes d'un rover martien (cahier des charges *MarsRover Health*, v2).
**Aucune commande n'est envoyée au rover. Aucune donnée « réel mission » n'est incluse.**

## Lancement

Backend (facultatif, active les résultats en direct de la section IA) : `cd backend && pip install -r requirements.txt && python -m mrh.cli serve` puis http://127.0.0.1:8765/ — voir `backend/README.md` et `docs/RAPPORT_TECHNIQUE_IA.md`.


| Mode | Commande | Remarques |
|---|---|---|
| Sans serveur | double-cliquer `index.html` | Fonctionne en `file://` : données, configuration et modèle 3D sont embarqués (`data/*.js`, `assets/models/perseverance.glb.js`). |
| Serveur local | `python3 -m http.server 8765` puis http://localhost:8765 | Le modèle est alors chargé depuis `assets/models/perseverance.glb`. Nécessaire pour appeler un MATLAB Production Server. |

Navigateur récent (Chrome, Edge, Firefox, Safari) avec WebGL. Aucune installation requise pour l'utilisation.

## Sous-interfaces (barre d'outils, routage `#/…`)

| Route | Contenu |
|---|---|
| `#/une` À la une | Page d'ouverture : vidéo en boucle sans son à droite ; à gauche, fiches de l'équipe (Mohamed Sabri BEN SLIMENE, binôme Wassim FARHAT, encadrant M. Faycel BEN HMIDA) et accès à l'application. |
| `#/accueil` Accueil 3D | Rover Perseverance (GLB fourni) ou modèle procédural de secours au centre, encadré à gauche et à droite par les fiches composants du catalogue ; clic sur une fiche → pièce mise en évidence en 3D, clic sur une pièce → fiche sélectionnée ; couleurs d'état (OK, Attention, Défaut, Température haute, Surcharge, Capteur suspect, Données insuffisantes) ; étiquettes ; glisser-déposer `.glb/.gltf`. Sur tablette/mobile, les fiches passent sous la vue 3D. |
| `#/dashboard` Tableau de bord | Santé par sous-système (radar), courbes avec seuils et zones d'alerte, R(t) Kaplan–Meier + IC Greenwood + Weibull, Nelson–Aalen, taux lissé par noyau, comparaison de lois (AIC), MTBF/MTTR/disponibilité ou « non calculable avec les données retenues », AMDEC éditable + matrice de criticité, alertes traçables, métriques de détection, RUL avec unité et IC, interprétation intelligente. |
| `#/maintenance` | Régime **paramétrique** (données du composant → verdict, tendances, RUL si fin de vie) et **non paramétrique** (dataset dérivé **par substitution**, hypothèses, sensibilité, nouveau plan préventif, Gantt, export CSV/JSON/imprimable). |
| `#/catalogue` | Fiches avec vignette 3D, spécifications, durée nominale (éditable, « démonstration »), usage actuel, écart (restant, % consommé avec incertitude, écart absolu/relatif), tri/filtre, export `components.json`. |
| `#/perturbations` | Dérive, bruit, valeur figée, surcharge, échauffement, perte de tension, blocage, intermittent ; avant/après, détection + délai, facteur d'accélération, R/RUL avant/après, propagation 3D, cascade, risque global, scénarios sauvegardés/comparés/exportés. |
| `#/terrain` | Terrain 3D (cratère, virage, pente, rochers, sable), simulation rocker-bogie quasi statique (équations affichées), lecture synchronisée avec les graphiques, nominal vs perturbé, **application de l'impact** aux composants (3D, tableau de bord, maintenance, catalogue). |
| `#/ia` IA & maintenance prédictive | 11 onglets alimentés par le **backend** (`backend/`) : anomalies (Isolation Forest / One-Class SVM / autoencodeur), diagnostic (RF / XGBoost / SVM), fiabilité (Weibull, Weibull AFT, Random Survival Forest), RUL (XGBoost / LSTM), maintenabilité et disponibilité (historique ; prévision en attente de données), AMDEC / FTA / risque, comparaison des algorithmes, registre des modèles, recommandations traçables, audit. Données de référence NASA PCoE (C-MAPSS simulé ; Milling, Batteries, IGBT expérimentaux). |
| `#/rapport` Rapport | Rapport technique détaillé (système, architecture, données, méthodes FMDS, méthode de comparaison des détecteurs, résultats, décisions de correction, validation) avec graphiques et images ; bouton de téléchargement du PDF (`docs/Rapport_MarsRover_Health.pdf`, logos inclus). Régénérer le PDF : `node tools/build_report_pdf.cjs`. |
| `#/donnees` | Inventaire des datasets et **import avec mapping** (provenance obligatoire, contrôle qualité). |

## Règles scientifiques appliquées
1. **Provenance** : badge `RÉEL MISSION` / `EXPÉRIMENTAL` / `SIMULÉ` / `ESTIMÉ PAR SUBSTITUTION` sur chaque bloc ; import impossible sans provenance.
2. **Pas de valeur fabriquée** : MTBF/MTTR/A affichés « non calculable avec les données retenues » sans journal d'événements.
3. **RUL** uniquement avec fin de vie définie (batterie simulée 80 % C0, roulements simulés 3,5 mm/s), toujours avec unité et IC 90 %.
4. **Pas de fuite** : séparation par essai/pack (train/validation/test), références de détection apprises sur 0–800 h uniquement.
5. **Transfert** : avertissement permanent ; tout plan par substitution est étiqueté « non validé sur le composant réel ».
6. **Aide à la décision uniquement**.
7. **Valeurs de démonstration** éditables dans `data/components.json`, `data/fmeca.json` ou dans l'interface.

## Interface (design system)
Thème clair « premium white », image d'arrière-plan `assets/img/background.jpg` sous un voile blanc à 10 % (variable `--veil` dans `app.css`), date et heure en direct à l'extrême droite de la barre d'outils, mise en page responsive (1920 → 390 px), logo `assets/img/logo.png`. Tous les jetons — couleurs, typographie Inter embarquée (`assets/fonts`, licence OFL), espacements, rayons, ombres, états sémantiques et provenance — sont centralisés en tête de `assets/css/app.css`. Barre d'outils unique noire et jaune citron (#E7E625) intégrant le logo, le nom et les 10 sous-interfaces (défilement horizontal sur petit écran), fil d'Ariane, boutons (primaire, secondaire, ghost, danger, icône, chargement), formulaires, onglets segmentés, tableaux avec recherche et pagination automatiques au-delà de 30 lignes, toasts, dialogues animés, squelettes de chargement, icônes SVG en ligne (aucune dépendance ajoutée).

## Arborescence
```
index.html                 point d'entrée
assets/css/app.css         design system (jetons, composants, responsive)
assets/fonts/              police Inter (woff2, OFL)
assets/js/app.bundle.js    bundle (three.js 0.160.1, Chart.js 4.4.1, PapaParse 5.4.1, JSZip 3.10.1)
assets/models/             perseverance.glb (+ .glb.js base64 pour file://), perseverance.usdz
data/components.json       composants, durées nominales, seuils, dépendances (éditable)
data/fmeca.json            AMDEC (cotations de démonstration)
data/datasets_meta.json    fiches d'identité des datasets
data/datasets/*.csv        datasets (convertis depuis les ressources fournies ou simulés)
data/components.js, data/datasets.js   copies embarquées (générées)
src/                       code source (modules ES) : core/, ml/, sim/, three/, views/
matlab/                    projet MATLAB (scripts/, data/, results/, README)
tools/                     gen_datasets.py, build.sh, gen_matlab.mjs
tests/                     ml_check.mjs, crosscheck_lifelines.py, e2e.cjs (+ rapports et captures)
docs/                      INVENTAIRE.md, HYPOTHESES_LIMITES.md, GUIDE.md, RAPPORT_TESTS.md, RAPPORT_TECHNIQUE_IA.md
backend/                   API REST, services FMDS/ML, base SQLite, modèles, tests (voir backend/README.md)
data/ml_snapshot.js        instantané des résultats du backend (mode hors ligne)
```

## Ajouter un dataset
- **Sans code** : `#/donnees` → *Import & mapping* (CSV/TXT/JSON) ; déclarer la provenance, le rôle (durées de vie, trajectoires, journal d'événements) et les colonnes. Stocké dans le navigateur (IndexedDB).
  - Journal d'événements : colonnes `component_id,type,start_h,end_h` (`type` = `panne` ou `planifiee`) → MTBF/MTTR/A calculés pour les composants présents.
- **Dans le projet** : déposer le CSV dans `data/datasets/`, ajouter sa fiche dans `data/datasets_meta.json`, relancer `python3 tools/gen_datasets.py` puis `bash tools/build.sh`.

## Ajouter / modifier un composant
Éditer `data/components.json` (`id`, `subsystem`, `model3dNode` = noms de nœuds du GLB séparés par `|`, `design_life`, `usage`, `dataset`, `substitution`, `thresholds`, `criticality`, `dependencies`) puis `bash tools/build.sh`. Les durées et seuils peuvent aussi être modifiés depuis le Catalogue (export `components.json`).

## Reconstruire / tester
```
npm install            # dépendances de build (three, chart.js, papaparse, jszip, esbuild)
npm run data           # régénère les CSV et data/datasets.js (graine 20261106)
npm run build          # bundle + projet matlab/
npm run test:ml        # vérifications numériques + validation croisée lifelines
npm run test:e2e       # test d'intégration Playwright (file://)
```
Voir `docs/RAPPORT_TESTS.md` et `docs/HYPOTHESES_LIMITES.md`.

## Sources et citations
Modèle 3D Perseverance fourni avec le projet (NASA/JPL, Blender glTF I/O). Datasets de référence cités dans le cahier des charges (NASA PCoE, PDS) : non inclus. Durées de roulements de `DataReal.m` : valeurs du jeu classique Lieblein & Zelen (1956), à confirmer.
