# Rapport de tests — MarsRover Health

Date : 2026-11-06. Environnement : Chromium headless (Playwright), rendu WebGL **logiciel** (SwiftShader), Node 22, Python 3.

## 1. Test d'intégration de bout en bout (`node tests/e2e.cjs file|http`)
Résultat : **31/31 en `file://`** et **31/31 en `http://`** (serveur `python3 -m http.server`). Console sans erreur (hors avertissements de performance du pilote GL logiciel).

| Vérification | Résultat | Détail |
|---|---|---|
| Chargement des datasets embarqués | ✔ | vib_bearings_sim:363, rel500_sim:500, bearings_exp:23, fire_demo:20, rover_telemetry_sim:1500, battery_sim:892, rover_events_sim:10 |
| Aucune donnée étiquetée « réel mission » | ✔ |  |
| Rover 3D chargé (GLB ou procédural) | ✔ | Modèle : assets/models/perseverance |
| Étiquettes 3D par composant | ✔ | 25 étiquettes |
| Panneau de détail composant | ✔ |  |
| Toolbar : 9 sous-interfaces | ✔ | #/accueil #/dashboard #/maintenance #/catalogue #/perturbations #/terrain #/donnees #/matlab #/assistant |
| Dashboard : KM / Weibull | ✔ |  |
| Dashboard : « non calculable » affiché | ✔ |  |
| Dashboard : RUL avec unité et IC | ✔ |  |
| Dashboard : avertissement de transfert | ✔ |  |
| Dashboard : interprétation + assistant | ✔ |  |
| Dashboard : graphiques rendus | ✔ | 5 canvas |
| Maintenance non paramétrique : plan « estimé par substitution » | ✔ |  |
| Export du dataset dérivé | ✔ |  |
| Maintenance paramétrique (batterie, RUL) | ✔ |  |
| Catalogue : nominal / actuel / écart | ✔ |  |
| Catalogue : vignettes 3D | ✔ | 25 vignettes |
| Perturbation : avant/après + détection | ✔ |  |
| Perturbation : propagation 3D + cascade | ✔ |  |
| Perturbation : scénario sauvegardé | ✔ |  |
| Terrain : lecture synchronisée | ✔ | pas 76 |
| Terrain → impact appliqué aux composants / tableau de bord | ✔ |  |
| Import refusé sans provenance déclarée | ✔ |  |
| Import avec mapping + provenance | ✔ | 8 datasets |
| MATLAB : scripts .m générés | ✔ |  |
| MATLAB : projet zip exporté | ✔ | 410594 octets |
| MATLAB : réimport des résultats | ✔ |  |
| Assistant : diagnostic + justification | ✔ |  |
| Responsive : pas de défilement horizontal (390 px) | ✔ |  |
| Mesure fps (indicative, rendu logiciel) | ✔ | 1 fps |
| Console sans erreur | ✔ |  |

Modèle procédural de secours (GLB bloqué, `tests/fallback.cjs`) : chargé, 25 étiquettes, aucune erreur. Captures : `tests/shots/`.

**Performance 3D** : non mesurable ici (rendu logiciel sans GPU : 1 fps avec le GLB de 213 k sommets, 18 fps avec le modèle procédural). Le critère ≥ 30 fps doit être vérifié sur un poste avec GPU (compteur fps affiché en bas à droite de chaque vue 3D).

## 2. Validation numérique des estimateurs (`tests/crosscheck_lifelines.py`) — JS vs lifelines 0.30
| Dataset | KM + IC, écart max | β Weibull JS / lifelines | η JS / lifelines | Médiane JS / lifelines |
|---|---|---|---|---|
| bearings_datareal_exp.csv | 3.6e-10 | 1.9927 / 1.9926 | 82.760 / 82.760 | 67.8 / 67.8 |
| reliability_500_sim.csv | 2.2e-11 | 0.7116 / 0.7116 | 1083.801 / 1083.801 | 811.0863 / 811.0863 |
| fire_detectors_demo.csv | 4.0e-10 | 1.6092 / 1.6092 | 24.111 / 24.111 | 18 / 18.0 |

Nelson–Aalen identique sauf en présence d'ex-æquo (bearings : 2,7252 vs 2,7343, convention de traitement des égalités différente).

## 3. Détection d'anomalies (télémétrie SIMULÉE, évaluation après 800 h, vérité terrain connue)
| Variable | Précision | Rappel | Événements détectés | Délai moyen (h) | Fausses alertes |
|---|---|---|---|---|---|
| motor3_current_A | 1 | 0.60 | 1/1 | 148 | 0 |
| arm_current_A | 1 | 0.75 | 3/3 | 0 | 0 |
| bat_voltage_V | 1 | 1.00 | 2/2 | 0 | 0 |
| avionics_temp_C | 1 | 0.83 | 1/1 | 10 | 0 |
| link_margin_dB | 1 | 0.60 | 3/3 | 16 | 0 |
| hazcam_temp_C | 1 | 1.00 | 1/1 | 0 | 0 |

La dérive lente du moteur 3 n'est détectée qu'après ≈ 148 h (écart devenu significatif vis-à-vis de la variabilité du contexte). L'Isolation Forest inter-roues est moins sensible que le z robuste sur cette dérive (rapporté dans le tableau de bord).

## 4. Pronostic (split par unité, aucun recouvrement)
- Roulements (SIMULÉ) : modèle retenu sur validation = survie conditionnelle Weibull (RMSE test ≈ 514 h, couverture IC 100 %) ; dégradation exponentielle RMSE ≈ 734 h ; baseline linéaire ≈ 5 745 h. 100 % des trajectoires se terminent par un saut brutal : la tendance vibratoire ne prévient pas la panne.
- Batterie (SIMULÉ) : modèle retenu = dégradation puissance bayésienne (MAE test ≈ 23 cycles) mais couverture de l'IC 90 % = 17 % → incertitude sous-estimée (4 packs d'apprentissage) ; signalé dans l'interface. RUL du pack en service : 105 cycles [IC 90 % 90–120].

## 5. Non testé
- Scripts MATLAB générés : **non exécutés** (pas de MATLAB dans l'environnement de construction) ; syntaxe et fonctions vérifiées par relecture contre le guide utilisateur PdM Toolbox R2025b fourni.
- Mode LLM de l'assistant : non appelé (nécessite une clé utilisateur) ; le repli sur le système expert local est implémenté.
- Appel MATLAB Production Server : non testé (aucun serveur).

## Version 5 — intégration FMDS / ML (07/11/2026)
- Backend : `cd backend && python -m unittest discover -s tests -v` → 23/23 (formules MTBF/MTTR/Ai/Ao, Weibull vs lifelines et récupération de paramètres sur données synthétiques, gradient LSTM par différences finies, FTA ET/OU et bornes, refus de prédiction sans modèle entraîné, pipeline MTTR, API : filtres, erreurs, persistance AMDEC/validation, import rejetant les lignes sans provenance).
- E2E `node tests/e2e.cjs file` → 43/43 ; `node tests/e2e.cjs http` (backend lancé) → 43/43.
- Captures de la section IA : `node tests/shots_ia.cjs` (1 440, 1 024, 820, 390 px) — aucun débordement, aucune erreur console.
