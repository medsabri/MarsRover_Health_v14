%% mrh_config — MarsRover Health (généré automatiquement)
% Paramètres communs (chemins, graine, seuils de démonstration).
% Prototype académique — aide à la décision uniquement. Provenance des données : voir data/README.md.
% Généré le 2026-11-06.

function cfg = mrh_config()
    here = fileparts(mfilename('fullpath'));
    cfg.dataDir    = fullfile(here, '..', 'data');
    cfg.resultsDir = fullfile(here, '..', 'results');
    if ~exist(cfg.resultsDir, 'dir'), mkdir(cfg.resultsDir); end
    cfg.seed       = 20261106;
    cfg.trainEnd_h = 800;            % fenêtre d'apprentissage « normale » de la télémétrie simulée
    cfg.zLimit     = 6;              % seuil |z| robuste
    cfg.lifetime.file  = 'bearings_datareal_exp.csv';
    cfg.lifetime.time  = 'T_obs_Mcycles';
    cfg.lifetime.event = 'event_1_panne_0_censure';   % 1 = panne, 0 = censure
    cfg.lifetime.unit  = '10^6 cycles';
    cfg.vib.file = 'degradation_vibration.csv'; cfg.vib.threshold = 3.5;   % mm/s (seuil des scripts fournis)
    cfg.vib.train = {'R-001','R-002','R-003','R-004','R-005','R-006'};
    cfg.vib.val   = {'R-007','R-008'};
    cfg.vib.test  = {'R-009','R-010'};                                     % séparation PAR ESSAI (pas de fuite)
    cfg.tel.file = 'rover_telemetry_sim.csv'; cfg.tel.variable = 'motor3_current_A'; cfg.tel.label = 'label_motor3_drift';
    cfg.events.file = 'rover_events_sim.csv';
    rng(cfg.seed, 'twister');
end
