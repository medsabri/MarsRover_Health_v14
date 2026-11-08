# Hypothèses retenues et limites connues

## Hypothèses
1. **Données** : faute de datasets réels fournis, la télémétrie rover (3 000 h, pas de 2 h), la batterie (7 packs + pack en service) et le journal d'événements sont **SIMULÉS** (`tools/gen_datasets.py`, graine 20261106) avec 6 anomalies injectées et étiquetées. Les durées de 23 roulements (DataReal.m) sont traitées comme **EXPÉRIMENTALES**.
2. **Fenêtre d'apprentissage** de la détection : 0–800 h (aucune anomalie injectée), références par contexte mode × terrain, repli sur le mode puis global.
3. **Fin de vie** : batterie = 80 % de C0 (40 Ah, démonstration) ; roulements simulés = 3,5 mm/s (valeur des scripts fournis). Aucun autre composant n'a de fin de vie → RUL masquée.
4. **Substitution** (roues, suspension, outil d'abrasion) : forme β Weibull empruntée aux roulements (EXPÉRIMENTAL par défaut, sélectionnable), échelle fixée par la durée nominale interprétée comme L10 (ISO 281) ou MTTF, gabarit de dégradation issu des trajectoires vibratoires d'apprentissage, fiabilité cible R* = 0,95 (éditable).
5. **Usage** : odométrie (km), heures de conduite, cycles du bras dérivés de la télémétrie simulée ; 1 opération d'abrasion par 2 sessions « bras » ; 1 cycle batterie ≈ 1 sol (démonstration).
6. **Valeurs de démonstration** : durées nominales, seuils, cotations AMDEC, constantes K, I0, Crr, h_cg, Ea, intervalles d'inspection calendaires.
7. **Numérotation des roues** : 1 = avant gauche … 6 = arrière droite (gauche = +X du modèle GLB, avant = +Z).

## Limites
- Aucune conclusion ne porte sur un rover réel ; les résultats valident des **méthodes**.
- Transfert banc → rover non validé (§9.4) : avertissement permanent.
- MTBF/MTTR/disponibilité : seulement pour le calculateur et les communications (journal simulé) ; MTTR = remise en service.
- Couverture des IC de RUL imparfaite (peu d'unités) ; score PHM calculé sur l'erreur en centaines d'heures.
- Simulation de terrain quasi statique ; suspension non articulée dans la maquette (angles calculés, caisse basculée, roues suivant le sol).
- Batterie, calculateur, contrôle thermique : pas de maillage dédié dans le GLB → marqueur à position indicative.
- MATLAB : scripts générés non exécutés ici ; `iforest`/`isanomaly` requièrent R2021b/R2022b+, `exponentialDegradationModel` la PdM Toolbox (replis prévus).
- Performance ≥ 30 fps non vérifiable sans GPU dans l'environnement de test.
- Stockage local (localStorage / IndexedDB) : propre au navigateur ; exporter les configurations pour les partager.
