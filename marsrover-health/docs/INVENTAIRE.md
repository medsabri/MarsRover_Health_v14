# Inventaire des ressources fournies (lecture initiale)

| Fichier / dossier | Type, taille | Contenu, variables, unités | Provenance | Rôle dans l'application | Statut |
|---|---|---|---|---|---|
| Cahier_des_charges_MarsRover_Health_Pro_2.pdf | PDF 13 p., 1,5 Mo | Contexte, objectifs, périmètre, datasets, protocole, FMDS (§8), ML (§9), dashboard (§12), validation (§14), risques | — | Référentiel des règles | Lu intégralement |
| Prompt_MarsRover_Health_WebApp.md | MD 16 Ko | Spécification de l'application (modules, stack, critères) | — | Spécification | Lu intégralement |
| ZIP_DE_PROJET.pdf | PDF 1 p. | Annexe A (page 7) d'un cahier des charges **v1.0** : liens PCoE/PDS, titre | — | Liens | Lu ; la v1.0 complète n'est pas fournie |
| Complément_DataSets.pdf | PDF 24 p., 5,5 Mo | Catalogue de datasets (C-MAPSS FD001–4 : 26 colonnes ; FEMTO ; IMS ; batteries ; survie…), conseils MATLAB/Python | — | Inventaire des sources externes | Lu |
| Guide_de_formation_…_vf.pdf | PDF 27 p., 9,6 Mo | Parcours Statistics & ML / PdM Toolbox, annexes fonctions | — | Choix des fonctions .m | Lu (texte + pages image) |
| Complément_pour_le_Guide….pdf | PDF 5 p. | Liens MathWorks, jeux pneumatic_motor / pump_turbine (liens GitHub) | — | Références | Lu |
| ML_en_FMDS.pdf | PDF 11 p. (captures) | ML non paramétrique : Cox, RSF, modes compétitifs, sécurité ; étude de cas éolienne | — | Méthodes | Lu (pages rastérisées) |
| 25042_Perseverance.glb | glTF 2.0 binaire, 11,7 Mo | 66 nœuds, 65 maillages, 48 matériaux, 24 textures, 213 130 sommets ; `Wheels_objs` (6 roues fusionnées), `suspension`, `arm*`, `turret_obj`, `corring_drill`, `PIXL`, `WATSON`, `rtg`, `antenna_hg/lg/uhf`, `head`, `Mastcam_Z_cams`, `NavCams`, `hazcams_*`… ; Y vers le haut, avant = +Z | — | Vue 3D ; roues et suspension découpées par géométrie | Analysé |
| 25042_Perseverance.usdz | USDZ 13,3 Mo | Même modèle (Apple) | — | Lien AR iOS | Inventorié |
| Démos Matlab.zip | 3 .mlx | RollingElementBearingFaultDiagnosis (MFPT), WindTurbineHighSpeedBearingPrognosis (exponentialDegradationModel), Demo_DefaultRatesForecasts (finance) | — | Inspiration ; jeux MathWorks non fournis ; finance hors périmètre | Lus |
| Exemples de scripts.zip | 41 .m, 4 .py, 2 .docx, 2 .png, 2 .mat, 1 .csv | KM/Greenwood, Nelson–Aalen, noyaux, Weibull MCO/MLE, bayésien Gamma, maintenabilité lognormale, RUL extrapolation, Cox | — | Méthodes réimplémentées | Lus ; dossier « Autres scripts » vide |
| degradation_vibration.csv | CSV 363 l. | `ID_Roulement` (R-001…R-010), `Cycle_Heure` (h, pas 100), `Vibration_RMS` (mm/s, 1,0–3,94), `Statut_Final_1_Panne_0_Censure` ; 10 pannes ; fin de vie = saut au dernier point | **SIMULÉ** (« généré par l'outil HTML ») | RUL, anomalies, substitution | Converti (BOM retiré) |
| reliability_data.mat (non paramétrique) | MAT, 500 obs. | `T_obs` (h), `C_ind` (1 = panne, 335) | **SIMULÉ** (cohérent avec Data_gen2.m) | KM, NA, Weibull, noyaux | Converti |
| reliability_data.mat (RUL extrapolation) | MAT, 100 obs. | `T_obs` = textes `BRG-0001…`, `C_ind` = 1 partout | — | Aucun | **Corrompu / incohérent** |
| DataReal.m | 23 valeurs | Durées de roulements (10⁶ cycles), dernière marquée censurée | **EXPÉRIMENTAL** | KM, forme β | Extrait ; incohérence : le jeu publié ne contient que des défaillances |
| EtudeCas_KM.m | 20 valeurs | Détecteurs incendie (mois), 9 censures | SIMULÉ / démo (source non documentée) | KM | Extrait |
| Docs_utiles.zip | 12 PDF (2 213 p.) + 1 .txt | Livres RUL data-driven, PHM énergie, thèse Blancke, polycopié FMD, Weibull, SdF, ebook PdM, PdM Toolbox UG R2025b ; liens MathWorks | — | Bibliographie, vérification des fonctions MATLAB | Titres/sommaires/extraits consultés, pas de lecture page à page ; « Data Driven Digital Twin… » scanné sans texte |
| Datasets IMS, FEMTO, RAT MER, NASA Battery, C-MAPSS, AI4I… | — | Liens seulement | — | Importables | **Non fournis** ; téléchargement bloqué depuis l'environnement de construction |

## Incohérences relevées dans les scripts fournis
- `AnalyseValidation_Eolienne3.m` : `wblfit(…, 'censoring', all_status)` reçoit l'indicateur de **panne** (censure inversée) ; p-value Anderson–Darling codée en dur (0,35).
- `RUL_ML_RSF.m`, `RUL_RSF_v0/v1.m`, `RUL_manuel.m` : `fitcox(…, 'Censoring', 'Event')` avec Event = 1 = panne → censure inversée. `RUL_RSF_v1.m` : `New_Data_Table` non définie. Les scripts « RSF » utilisent un modèle de Cox.
- `RUL_RSF_vf.m` : `B_level = 0.10` présenté comme B10 (calcule en réalité le B90).
- `reliability_analysis*.m` : `prognosetoRUL`, `fitDegradationModel` n'existent pas dans la PdM Toolbox.
- `KM_KernelSmoothing*.m` : ĥ = f̂(défaillances)/R̂ biaisé sous censure → remplacé par l'estimateur de Ramlau-Hansen.
- `Guide_KM_Kernel Smoothing.docx` cite `Nelson_Aalen_Lissage.m`, absent.
