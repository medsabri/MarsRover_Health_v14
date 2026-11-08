%% run_all — MarsRover Health (généré automatiquement)
% Chaîne complète : chargement → prétraitement → caractéristiques → anomalies → fiabilité/FMDS → RUL → figures → export.
% Prototype académique — aide à la décision uniquement. Provenance des données : voir data/README.md.
% Généré le 2026-11-06.

cfg = mrh_config();
D   = mrh_load_data(cfg);
P   = mrh_preprocess(D, cfg);
Fe  = mrh_features(P, 12);  %#ok<NASGU>
A   = mrh_anomaly(P, cfg);
R   = mrh_km_fmds(D, cfg);
Rr  = mrh_rul(D, cfg);
mrh_figures(R, P, A, cfg);
mrh_export_results(R, Rr, A, cfg);
