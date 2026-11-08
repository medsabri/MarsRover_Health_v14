# Projet MATLAB — MarsRover Health

Exécution : ouvrir MATLAB (R2021b ou plus récent conseillé), se placer dans `scripts/`, lancer `run_all`.
Toolboxes : Statistics and Machine Learning (ecdf, wblfit, chi2inv, iforest) ; Predictive Maintenance (exponentialDegradationModel, predictRUL) — facultative, un repli est prévu.
MATLAB Online : téléverser le dossier complet (Drive) puis exécuter `run_all`.

Arborescence : `scripts/` (fonctions .m), `data/` (CSV exportés par l'application, provenance dans data/README.md), `results/` (sorties : mrh_results.json, CSV, PNG).
Réimport : onglet « Laboratoire MATLAB » → « Importer des résultats » (JSON/CSV/PNG). Les résultats sont affichés avec leur badge de provenance.

Conventions : `'Censoring'` = 1 pour une observation CENSURÉE (corrige l'inversion présente dans certains scripts fournis). Séparation train/validation/test PAR ESSAI. Normalisation calculée sur l'apprentissage seulement.
Avertissement : aucun résultat issu de roulements de banc ou de données simulées n'est validé sur un rover réel (cahier des charges §9.4).
