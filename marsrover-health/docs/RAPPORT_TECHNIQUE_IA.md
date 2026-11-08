# Rapport technique — Intégration FMDS et Machine Learning dans MarsRover Health

*Version du 7 novembre 2026. Ce rapport couvre l'audit, les corrections, l'architecture, les méthodes, la base de données, l'API, les tests et la comparaison des algorithmes. Tous les chiffres viennent de la base livrée (`backend/data/mrh.sqlite`) et sont reproductibles avec `python -m mrh.cli all` (graine 20261107).*

---

## 1. Rapport d'audit de l'application initiale

Point de départ : une SPA en JavaScript (modules ES, bundle esbuild, ouverture en `file://`). Elle ne comprenait ni serveur, ni base SQL, ni API, et tous les calculs tournaient dans le navigateur. Le détail ligne par ligne (27 fonctionnalités) se trouve dans l'application, onglet **IA → Audit**.

| Constat | Nombre | Exemples |
|---|---|---|
| Existante et correcte | 8 | Kaplan–Meier / Greenwood et Weibull MLE (identiques à lifelines) ; MTBF = TBF / r avec IC χ² ; provenance ; unités |
| Existante mais incorrecte | 3 | « Disponibilité opérationnelle » qui était en réalité Ai ; Isolation Forest JS avec tirage **avec** remise ; C-MAPSS présenté comme « réel » |
| Partiellement implémentée | 4 | AMDEC (cotations de démonstration, éditions non tracées) ; recommandations non tracées ; qualité Milling et Batteries |
| Absente → ajoutée | 8 | Backend, SQL, OCSVM, autoencodeur, classification, RSF, XGBoost/LSTM RUL, FTA, registre de modèles |
| Impossible à valider faute de données | 4 | MTTR prévisionnel ; disponibilité prévisionnelle ; classes de panne surchauffe / électrique / capteur… ; capteur de dissipateur IGBT |

## 2. Anomalies et problèmes détectés (et traitement)

1. **Disponibilité mal nommée.** L'application calculait TBF / TR en excluant les arrêts planifiés et l'appelait « opérationnelle ». C'est Ai. → Le libellé devient **Ai**, et **Ao** = U / (U + D_p + D_s) est ajoutée au tableau de bord et dans le backend. Exemple du calculateur : Ai = 99,77 %, Ao = 99,57 %.
2. **Isolation Forest (JS).** L'algorithme de Liu et al. (2008) tire ses sous-échantillons sans remise ; l'implémentation JS tirait avec remise. → Corrigé par un Fisher–Yates partiel.
3. **C-MAPSS n'est pas un jeu mesuré.** Il est produit par le simulateur NASA (Saxena et al., 2008). → Provenance **SIMULÉ** partout. Milling, Batteries et IGBT sont des mesures de laboratoire, avec la provenance **EXPÉRIMENTAL**.
4. **Batteries NASA.** 14 cellules sont déjà sous 1,4 Ah au départ (essais à 4 °C, autres profils). On trouve aussi des capacités nulles et les cellules B0025–B0028 livrées en double. → `qc_flag` sans correction des valeurs ; fiabilité calculée sur les cellules saines (C₀ ≥ 1,7 Ah) ; critère EOL appliqué sur une médiane glissante de 3 décharges.
5. **IGBT.** `HEAT_SINK_TEMP` ≈ 0,2 n'a pas d'unité documentée. → Variable stockée telle quelle sous `heatsink_raw` et exclue des modèles. La phase de mise en température (≤ 120 s) est également exclue.
6. **Milling.** 21 passes n'ont pas de mesure VB, et le courant DC est parfois constant (kurtosis indéfinie). → Ces passes sont prédites mais n'entrent pas dans les métriques ; `smcDC_kurt` est exclue.
7. **Archive MATLAB fournie.** C'est l'export de l'application elle-même : elle ne contient aucun résultat nouveau.
8. **Aucune donnée de réparation réelle.** Les modules 5 et 6 (prévision) restent « En attente de données ». Aucune performance n'est simulée.

## 3. Architecture technique mise à jour

```
Navigateur ── SPA existante (inchangée) + route #/ia
   │  mode API : fetch /api/…            mode hors ligne : data/ml_snapshot.js (lecture seule)
   ▼
API REST  backend/mrh/api.py  (http.server, JSON, codes HTTP explicites, export CSV)
   ▼
Services  anomaly · diagnosis · reliability · rul · maintainability · availability · safety
          recommendations · registry · jobs (entraînement en arrière-plan, jamais à la lecture)
   ▼
SQLite  backend/data/mrh.sqlite (migrations versionnées)      Artefacts  backend/models/*.joblib
```

Les calculs complexes ne s'exécutent plus dans le navigateur : la section IA affiche seulement des résultats déjà stockés. Les calculs historiques de l'application (KM, Weibull JS…) sont conservés, comme l'exigeait la consigne de ne pas les supprimer.

## 4. Méthodes FMDS

| Indicateur | Formule | Remarque |
|---|---|---|
| MTBF | U / r | U = W − D_p − D_s |
| MTTR historique | Σ durées des réparations **terminées** / leur nombre | Les réparations ouvertes sont exclues et comptées à part |
| Ai | MTBF / (MTBF + MTTR) | Arrêts sur panne seulement |
| Ao | U / (U + D_p + D_s) | Tous les arrêts |
| R(t), F(t), λ(t) | exp(−(t/η)^β), 1 − R, (β/η)(t/η)^(β−1) | MTTF = η Γ(1 + 1/β) |
| NPR | G × O × D | Colonne générée par la base, donc impossible à désynchroniser |
| FTA | P(ET) = Π pᵢ ; P(OU) = 1 − Π(1 − pᵢ) | Indépendance supposée ; bornes si une probabilité manque ; coupes minimales (MOCUS) |

## 5. Algorithmes de Machine Learning

| Module | Données | Protocole sans fuite | Algorithmes |
|---|---|---|---|
| 1 Anomalies | C-MAPSS FD001 (14 capteurs) ; IGBT | Apprentissage sur le normal (50 premiers cycles) ; seuil = quantile 99 % du normal de **validation** ; test NASA (normal RUL > 125, anormal RUL ≤ 30) | Isolation Forest, One-Class SVM, autoencodeur 14-8-4-8-14 |
| 2 Diagnostic | Milling, 146 passes étiquetées (ISO 3685 : VB 0,3 / 0,6 mm) | Leave-one-tool-out (16 plis), écart à la 1ʳᵉ passe de l'outil | Random Forest, XGBoost, SVM (calibré) |
| 3 Fiabilité | FD001 (Weibull) ; FD001–FD004 : 1 416 unités, 49 % censurées (RSF) | Découpage 70/30 par unité ; covariables connues à la mise en service (15 premiers cycles) | Weibull MLE, Weibull AFT, Random Survival Forest |
| 4 RUL | FD001, fenêtres de 30 cycles | 80 / 20 unités (arrêt précoce) ; test NASA au dernier cycle | XGBoost (pente, moyenne, écart-type…), **LSTM NumPy** (BPTT, Adam ; gradient vérifié) |
| 5 MTTR | Aucune réparation réelle | Chronologique 80/20 (pipeline testé) | Linéaire, RF, XGBoost — en attente |
| 6 Disponibilité | Journal simulé (10 événements) | — | Linéaire, RF, XGBoost — en attente |
| 7 Sécurité | AMDEC (18 modes), FTA mobilité, FD001 | Seuil de décision choisi sur la validation | RF, XGBoost (risque RUL ≤ 30) + Isolation Forest |

Le LSTM est implémenté en NumPy parce que PyTorch n'était pas installable dans l'environnement. Son gradient analytique est vérifié par différences finies (erreur relative de l'ordre de 10⁻⁷).

## 6. Modifications de la base de données

`migrations/001_schema.sql` crée les 14 tables demandées (equipment, sensor_data, failure_history, maintenance_history, operating_history, anomaly_history, diagnosis_results, reliability_results, rul_predictions, availability_results, fmea, fta_events, model_registry, model_evaluation), plus recommendations et audit_log. `002_payloads.sql` crée module_payload. Chaque résultat porte l'équipement, la date de calcul, l'algorithme, la version du modèle, la valeur, l'unité, le statut, la validation et la provenance. Le contenu chargé :

- 1 492 équipements et 497 078 mesures ;
- 1 429 durées de vie, dont 713 défaillances et 716 censures ;
- les valeurs manquantes restent NULL, sans imputation.

Les migrations sont idempotentes (`schema_migrations`), et des index portent sur (équipement, temps).

## 7. Services backend et API

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/health`, `/api/equipment`, `/api/data/audit` | État, équipements, qualité des données |
| GET | `/api/ia/<module>?equipment=&t_from=&t_to=` | Résultats d'un module (filtres équipement et période) |
| GET | `/api/models`, `/api/comparison`, `/api/recommendations`, `/api/jobs` | Registre, comparaison, recommandations, tâches |
| GET | `/api/export/<module>.csv` | Export |
| POST | `/api/models/<module>/train` | Réentraînement en arrière-plan (202) |
| POST | `/api/recommendations/<id>/validate` | Décision nominative (validée / rejetée) |
| PUT | `/api/fmea/<id>` | Cotation G/O/D avec auteur ; NPR recalculé par la base |
| POST | `/api/fta/<id>/probability` | Probabilité de base avec sa source |
| POST | `/api/maintenance/import` | Historique réel ; provenance obligatoire |

Le registre de modèles gère six statuts : non entraîné, en attente de données, en cours, entraîné, validé, erreur. Un entraînement interrompu est détecté au démarrage et passe en « erreur ». Toute prédiction est refusée pour un modèle non entraîné (`NotTrained`).

## 8. Nouveaux modules du tableau de bord

Le menu reçoit l'entrée **IA & maintenance prédictive** (`#/ia`), avec 11 onglets : Anomalies, Diagnostic, Fiabilité, Pronostic RUL, Maintenabilité, Disponibilité, AMDEC / FTA, Comparaison, Modèles, Recommandations, Audit. Chaque onglet comporte :

- des KPI, des graphiques et des tableaux paginés avec recherche ;
- des filtres par équipement et par période, et un export CSV ;
- la date de dernière actualisation et un encart méthode.

La palette catégorielle a été validée (séparation CVD ΔE ≥ 13,6). La mise en page est responsive de 1 920 à 390 px.

## 9. Résultats des tests

| Suite | Résultat |
|---|---|
| Backend `python -m unittest` (formules FMDS, Weibull contre lifelines, LSTM, FTA, garde-fous, API, persistance) | **28 / 28** |
| E2E Playwright `file://` (application + section IA, instantané) | **46 / 46** |
| E2E Playwright `http` (backend réel, résultats en direct) | **46 / 46** |
| Rendu multi-écrans (1 920, 1 440, 1 280, 1 024, 820, 390 px) | Aucun débordement horizontal |
| Reproductibilité (reconstruction complète) | Métriques identiques |

## 10. Tableau comparatif des algorithmes (jeux de test, jamais vus à l'apprentissage)

| Tâche | Algorithme | Métriques principales | Entraîn. | Retenu |
|---|---|---|---|---|
| Anomalies FD001 | Isolation Forest | F1 0,853 · AUC 0,9995 · FPR 1,4 % · avance 60 cycles | 0,16 s | |
| | One-Class SVM | F1 **0,854** · AUC 0,9991 · FPR 1,3 % · avance 70 cycles | 0,01 s | ✔ (F1) |
| | Autoencodeur | F1 0,801 · AUC 0,967 · précision 82 % | 1,4 s | |
| Diagnostic Milling (hors outil) | Random Forest | F1 macro **0,671** · exactitude 71 % | 0,6 s | ✔ |
| | XGBoost | F1 macro 0,580 · exactitude 65 % | 0,4 s | |
| | SVM | F1 macro 0,601 · exactitude 66 % | 0,03 s | |
| | *Classe majoritaire* | *F1 macro 0,228* | | |
| Survie FD001–FD004 | Weibull (sans covariable) | C-index 0,5 (par construction) · IBS 0,216 | | |
| | Weibull AFT | C-index **0,692** · IBS **0,178** | 0,3 s | ✔ |
| | Random Survival Forest | C-index 0,643 · IBS 0,190 | 3,0 s | |
| RUL FD001 (100 unités) | XGBoost | RMSE **13,08** · MAE 9,57 · R² 0,901 · PHM08 252 | 1,6 s | ✔ |
| | LSTM | RMSE 15,34 · MAE 11,77 · R² 0,864 · PHM08 346 | 52 s | |
| | *Prédicteur constant* | *RMSE 41,97* | | |
| Risque (RUL ≤ 30) | Random Forest | F1 0,845 · AUC 0,998 | 6,2 s | |
| | XGBoost | F1 **0,863** · AUC 0,998 · rappel 92 % | 0,9 s | ✔ |
| MTTR / Disponibilité prévisionnels | Linéaire, RF, XGBoost | **Non entraînés** (données absentes) | — | — |

**Lecture critique de ces résultats :**

- Les meilleurs modèles ne sont pas toujours ceux qu'annonçait le cahier des charges. Random Forest l'emporte sur XGBoost pour le diagnostic, et Weibull AFT sur la RSF pour la survie. Le choix suit uniquement le critère de validation.
- Les AUC proches de 1 en détection et en risque s'expliquent par l'exclusion de la zone ambiguë (30 < RUL ≤ 125) : le problème évalué est volontairement bien séparé.
- Le diagnostic Milling repose sur peu de données (16 outils) : l'écart-type du F1 entre outils atteint 0,17.
- Le RMSE RUL de 13 à 15 cycles se situe dans l'ordre de grandeur publié pour FD001.

## 11. Données nécessaires pour compléter le système

- **MTTR prévisionnel.** Au moins 30 réparations terminées (début, fin) avec type de panne, gravité, complexité, disponibilité des pièces et équipement.
- **Disponibilité prévisionnelle.** Au moins 24 périodes × équipement avec temps de fonctionnement, nombre de pannes, arrêts, conditions d'utilisation et disponibilité de la période suivante.
- **Diagnostic multi-pannes** (surchauffe, surpression, défaut électrique, capteur, surcharge). Un historique horodaté et étiqueté par cause confirmée (≥ 30 cas par classe), aligné sur les capteurs.
- **Transfert vers le rover.** Des données de mission réelles pour valider les substitutions (batterie, variateur, outil d'abrasion). Elles restent marquées « non validées » d'ici là.

## 12. Installation et utilisation

- **Hors ligne.** Double-cliquer `index.html`, puis ouvrir *IA & maintenance prédictive*. L'onglet affiche l'instantané, en lecture seule.
- **Complet.** `cd backend && pip install -r requirements.txt && python -m mrh.cli serve`, puis ouvrir http://127.0.0.1:8765/#/ia. Cela donne les résultats en direct, le réentraînement, la validation des recommandations et l'édition AMDEC/FTA.
- **Reconstruction.** `python -m mrh.cli all` (environ 4 minutes). Tests : `python -m unittest discover -s tests` et `node tests/e2e.cjs file|http`.

**Avertissement.** Les modèles sont une aide à la décision. Ils ne remplacent jamais les fonctions de sécurité, les interverrouillages ni les arrêts d'urgence, et aucune action n'est déclenchée automatiquement.

### Références
Saxena A. et al. (2008) *Damage propagation modeling for aircraft engine run-to-failure simulation*, PHM08 · Heimes F. (2008) *Recurrent neural networks for RUL estimation*, PHM08 · Liu F. T., Ting K. M., Zhou Z.-H. (2008) *Isolation Forest*, ICDM · Ishwaran H. et al. (2008) *Random survival forests*, Ann. Appl. Stat. · Graf E. et al. (1999) *Assessment and comparison of prognostic classification schemes for survival data*, Stat. Med. · Agogino A., Goebel K. (2007) *Milling data set*, NASA PCoE · Saha B., Goebel K. (2007) *Battery data set*, NASA PCoE · Celaya J. et al. (2009) *IGBT accelerated aging data set*, NASA PCoE · ISO 3685:1993 *Tool-life testing with single-point turning tools*.

---

## 13. Jeux complémentaires FEMTO (roulements) et HIRF (batteries) — v8

### Données lues

| Jeu | Contenu réellement lu | Provenance | Contrôle qualité |
|---|---|---|---|
| FEMTO / PRONOSTIA (IEEE PHM 2012) | 17 roulements (6 apprentissage + 11 test complet), 24 889 instantanés de 0,1 s à 25,6 kHz toutes les 10 s, 2 axes ; températures pour 13 roulements | Expérimental (FEMTO-ST) | Séparateur « ; » pour Bearing1_4 (détecté) ; 3 pas temporels irréguliers (Bearing1_1) ; températures aberrantes (jusqu'à 867) non exploitées |
| HIRF — Edge 540 (NASA PCoE) | 53 essais (Set1–Set6), 200 Hz, 36,8 h : régime moteur, tension / courant / température de 4 packs, courants ESC ou moteur, sorties du moniteur BHM (45 essais) | Expérimental (NASA Ames) | 9 essais avec valeurs hors plage (exclues) ; températures des essais 63–64 sur une autre échelle (exclues) ; 753 109 sauts brusques comptés ; unité des températures non documentée |

### Résultats principaux

**FEMTO.**
- **Fiabilité.** Weibull sur les 17 durées de vie : β = 1,80 [1,30 ; 2,51] (usure), η = 4,58 h, MTTF = 4,07 h, B10 = 1,31 h. L'adéquation n'est pas rejetée (KS p = 0,57). Les durées diffèrent selon la condition (Kruskal–Wallis p = 0,027).
- **Détection.** L'Isolation Forest déclenche une alarme sur 16 roulements sur 17, souvent juste après la période de référence (≈ 31–35 % de la vie), ce qui laisse soupçonner des fausses alarmes. La règle RMS > 3 × référence alarme tardivement (≥ 77 % de la vie, médiane 98 %) et ne détecte jamais 5 roulements.
- **Durée de vie restante (RUL) sur les 11 roulements de test.** La référence statistique Weibull MRL donne une erreur moyenne (MAE) de 1,47 h. XGBoost (1,60 h) et Random Forest (1,76 h) font moins bien : ils ne sont pas validés. Six durées d'apprentissage très dispersées (0,6 à 7,8 h) ne suffisent pas à un modèle supervisé.

**HIRF.**
- **Résistance interne.** Elle vaut ≈ 48 mΩ pour les packs 20 V et ≈ 97 mΩ pour les packs 40 V, soit un rapport ≈ 2 cohérent avec deux fois plus d'éléments en série.
- **Hausse au fil des essais.** Elle est significative pour ULA20 (ρ = 0,40, p = 0,003) et URA40 (ρ = 0,37, p = 0,006), qui forment le même circuit série. Cette hausse reste confondue avec la température et l'état de charge initial.
- **Essais atypiques.** 6 essais sont signalés (5, 7, 9, 74, 80, 81).
- **Moniteur BHM.** La dispersion de la fin de décharge prédite est d'environ 700 s par essai. Sa justesse n'est pas vérifiable, car aucune décharge n'atteint le seuil de fin de décharge.

### Limites
- FEMTO repose sur des essais accélérés (4–5 kN, quelques heures). Le transfert vers un roulement de roue de rover est une substitution non validée.
- HIRF ne contient que des décharges partielles, sans fin de vie observée. Weibull, capacité et RUL supervisée y sont donc non calculables.
- L'attribution des pics de mesure aux champs HIRF n'est pas vérifiable sans le journal d'exposition.

Reconstruction : `python -m mrh.cli ingest --raw-dir <dossier contenant Learning_set, Full_Test_Set et Set1..Set6>` puis `python -m mrh.cli all`.


---

## 14. Maintenance préventive — diagnostic des 5 classes de défaut (v9)

Aucun jeu ne contient de pannes réelles étiquetées par cause. Un classifieur supervisé n'est donc pas entraînable. Les classes surchauffe, surpression, défaut électrique, défaut de capteur et surcharge moteur sont traitées par des **règles techniques explicites** :
- la référence est apprise sur une période saine ;
- le seuil vaut 4 σ robustes, avec une persistance de 2 à 3 échantillons ;
- un capteur est déclaré défaillant si sa valeur reste figée ou devient physiquement impossible.

| Classe | Évaluation sur la télémétrie rover simulée (vérité injectée, après 800 h) | Application aux données réelles |
|---|---|---|
| Surchauffe | 1 / 1 épisode, précision 81 %, délai médian 10 h | HIRF : échauffements atypiques par pack (22 détections) |
| Défaut électrique | 2 / 2 épisodes, précision 32 % (couplage avec les surcharges) | HIRF : chutes de tension / coupures (16) |
| Défaut de capteur | 1 / 1 épisode (valeur figée), précision 76 % | HIRF : échelle de température aberrante, pics anormaux (14) ; FEMTO : sondes > 200 (2) |
| Surcharge moteur | 16 / 25 épisodes, précision 75 % | HIRF : pics de courant (7) |
| Surpression | Non évaluable (aucun capteur de pression sur le rover) | C-MAPSS (simulé) : Ps30 > 4 σ sur 18 / 200 turboréacteurs, médiane 3,5 cycles avant défaillance |

Chaque détection donne une action de maintenance préventive, consultable dans *IA prédictive › Diagnostic*. Les détections sur données réelles sont des alertes à vérifier : aucune métrique de performance n'y est calculable.

Autres modifications de la v9 :
- le tableau de bord est découpé en 3 sous-interfaces (vue d'ensemble, fiabilité et FMDS, anomalies et détection) ;
- l'assistant de correction est retiré du tableau de bord ;
- dans les tests de perturbation, les résultats sont placés en tête et la 3D ainsi que l'impact fonctionnel passent sous le scénario ;
- l'histogramme d'impact utilise une couleur distincte par fonction.
