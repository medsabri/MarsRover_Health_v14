# Backend FMDS / ML — MarsRover Health

Services d'analyse (détection, diagnostic, fiabilité, RUL, maintenabilité, disponibilité, sécurité),
base SQLite, registre de modèles et API REST. Aucune dépendance web : le serveur utilise `http.server`.

## Installation
```
cd backend
python -m pip install -r requirements.txt        # Python ≥ 3.10 (testé en 3.13)
```

## Démarrage rapide (base et modèles déjà livrés)
```
python -m mrh.cli serve            # http://127.0.0.1:8765/  → application + API
```
Ouvrir `http://127.0.0.1:8765/#/ia` : la section « IA & maintenance prédictive » lit alors l'API en direct
(entraînement, validation des recommandations, édition AMDEC/FTA disponibles).
Sans backend, `index.html` ouvert en `file://` affiche l'instantané `data/ml_snapshot.js` (lecture seule).

## Reconstruire entièrement
```
python -m mrh.cli ingest --raw-dir <archives décompressées>   # facultatif : Milling, Batteries, IGBT, FEMTO, HIRF (.mat/.csv → CSV traités)
python -m mrh.cli all                                         # migrations + chargement + entraînement + recommandations + instantané (~4 min)
```
Commandes unitaires : `init`, `train [anomalies diagnostic fiabilite rul maintenabilite disponibilite securite]`,
`recommend`, `export`, `serve --port 8765`. Graine fixe (20261107) : les métriques sont reproductibles à l'identique.

## Tests
```
python -m unittest discover -s tests -v          # 28 tests : formules, Weibull, LSTM, FTA, garde-fous, API, persistance
```
Les tests d'écriture travaillent sur une copie temporaire de la base ; les données synthétiques de test ne sont jamais écrites en base.

## Arborescence
```
migrations/          001_schema.sql (14 tables + recommendations + audit_log), 002_payloads.sql
mrh/config.py        chemins, graine, seuils techniques sourcés
mrh/ingest.py        lecture des formats bruts (.txt NASA, .mat) → data/processed/*.csv
mrh/load.py          chargement en base (provenance, censure, QC)
mrh/ml/              weibull.py (MLE censuré), lstm.py (LSTM NumPy), common.py (découpages, métriques)
mrh/services/        anomaly, diagnosis, reliability, rul, maintainability, availability, safety,
                     recommendations, registry (versions/statuts), jobs (entraînement en arrière-plan)
mrh/views.py         réponses de lecture (API et instantané)
mrh/api.py           routes REST
mrh/snapshot.py      export hors ligne
data/raw/cmapss/     C-MAPSS (NASA) — fichiers d'origine
data/processed/      Milling, Batteries, IGBT extraits des .mat
data/mrh.sqlite      base livrée
models/              artefacts .joblib (un par version)
```

## Import d'un historique de maintenance réel (active les modules 5 et 6)
`POST /api/maintenance/import` (corps `text/csv`) — colonnes obligatoires
`equipment_id,type,t_start,t_end,provenance`, recommandées `failure_type,severity,complexity,spare_parts_available`.
Puis `POST /api/models/maintenabilite/train`. Les lignes invalides sont rejetées et listées, jamais corrigées.
