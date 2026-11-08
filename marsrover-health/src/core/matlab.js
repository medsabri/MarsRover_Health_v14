// =============================================================================
// matlab.js — générateur de projet MATLAB (scripts .m prêts à l'emploi) pour MarsRover Health.
// Fonctions utilisées (Statistics & ML Toolbox, Predictive Maintenance Toolbox) : readtable, ecdf,
// wblfit, lognfit, chi2inv, iforest (R2021b+), exponentialDegradationModel, fit, predictRUL.
// Conventions corrigées par rapport aux scripts fournis : 'Censoring' = 1 pour une CENSURE.
// =============================================================================
const HDR = (name, desc) => `%% ${name} — MarsRover Health (généré automatiquement)\n% ${desc}\n% Prototype académique — aide à la décision uniquement. Provenance des données : voir data/README.md.\n% Généré le ${new Date().toISOString().slice(0, 10)}.\n`;

export function matlabFiles(opts = {}) {
  const o = { lifetimeCsv: 'bearings_datareal_exp.csv', timeCol: 'T_obs_Mcycles', eventCol: 'event_1_panne_0_censure', timeUnit: '10^6 cycles', component: 'motor_3', variable: 'motor3_current_A', label: 'label_motor3_drift', seed: 20261106, ...opts };
  const F = {};
  F['mrh_config.m'] = `${HDR('mrh_config', 'Paramètres communs (chemins, graine, seuils de démonstration).')}
function cfg = mrh_config()
    here = fileparts(mfilename('fullpath'));
    cfg.dataDir    = fullfile(here, '..', 'data');
    cfg.resultsDir = fullfile(here, '..', 'results');
    if ~exist(cfg.resultsDir, 'dir'), mkdir(cfg.resultsDir); end
    cfg.seed       = ${o.seed};
    cfg.trainEnd_h = 800;            % fenêtre d'apprentissage « normale » de la télémétrie simulée
    cfg.zLimit     = 6;              % seuil |z| robuste
    cfg.lifetime.file  = '${o.lifetimeCsv}';
    cfg.lifetime.time  = '${o.timeCol}';
    cfg.lifetime.event = '${o.eventCol}';   % 1 = panne, 0 = censure
    cfg.lifetime.unit  = '${o.timeUnit}';
    cfg.vib.file = 'degradation_vibration.csv'; cfg.vib.threshold = 3.5;   % mm/s (seuil des scripts fournis)
    cfg.vib.train = {'R-001','R-002','R-003','R-004','R-005','R-006'};
    cfg.vib.val   = {'R-007','R-008'};
    cfg.vib.test  = {'R-009','R-010'};                                     % séparation PAR ESSAI (pas de fuite)
    cfg.tel.file = 'rover_telemetry_sim.csv'; cfg.tel.variable = '${o.variable}'; cfg.tel.label = '${o.label}';
    cfg.events.file = 'rover_events_sim.csv';
    rng(cfg.seed, 'twister');
end
`;
  F['mrh_load_data.m'] = `${HDR('mrh_load_data', 'Lecture des CSV et contrôle qualité minimal (colonnes, lignes, valeurs manquantes).')}
function D = mrh_load_data(cfg)
    rd = @(f) readtable(fullfile(cfg.dataDir, f), 'TextType', 'string', 'VariableNamingRule', 'preserve');
    D.life = rd(cfg.lifetime.file);
    D.vib  = rd(cfg.vib.file);
    D.tel  = rd(cfg.tel.file);
    D.ev   = rd(cfg.events.file);
    names = fieldnames(D);
    for k = 1:numel(names)
        T = D.(names{k});
        miss = sum(ismissing(T));
        fprintf('%-5s : %5d lignes, %2d colonnes, %d valeurs manquantes\\n', names{k}, height(T), width(T), sum(miss));
    end
end
`;
  F['mrh_preprocess.m'] = `${HDR('mrh_preprocess', 'Prétraitement : tri temporel, gestion des manquants, normalisation calculée sur l’APPRENTISSAGE seulement.')}
function P = mrh_preprocess(D, cfg)
    T = sortrows(D.tel, 'time_h');
    x = T.(cfg.tel.variable);
    train = T.time_h < cfg.trainEnd_h;
    % les manquants de link_margin_dB = coupures PROGRAMMÉES : on ne les impute pas
    P.t = T.time_h; P.x = x; P.train = train;
    P.ctx = strcat(string(T.op_mode), "|", string(T.terrain));
    P.mu = mean(x(train), 'omitnan'); P.sd = std(x(train), 'omitnan');   % statistiques du TRAIN uniquement
    P.xn = (x - P.mu) ./ P.sd;
    if ismember(cfg.tel.label, T.Properties.VariableNames), P.truth = T.(cfg.tel.label); else, P.truth = []; end
    P.T = T;
end
`;
  F['mrh_features.m'] = `${HDR('mrh_features', 'Caractéristiques glissantes (moyenne, écart-type, RMS, crête, kurtosis) sur fenêtres de N échantillons.')}
function Fe = mrh_features(P, N)
    if nargin < 2, N = 12; end
    x = P.x; n = numel(x); Fe = table();
    Fe.t = P.t(N:n);
    w = @(f) arrayfun(@(i) f(x(i-N+1:i)), (N:n)');
    Fe.mean = w(@(v) mean(v, 'omitnan'));
    Fe.std  = w(@(v) std(v, 'omitnan'));
    Fe.rms  = w(@(v) sqrt(mean(v.^2, 'omitnan')));
    Fe.peak = w(@(v) max(abs(v)));
    Fe.kurt = w(@(v) kurtosis(v(~isnan(v))));
end
`;
  F['mrh_anomaly.m'] = `${HDR('mrh_anomaly', 'Détection : z-score robuste CONTEXTUEL (médiane/MAD par mode×terrain appris sur le train) + Isolation Forest (iforest, R2021b+).')}
function A = mrh_anomaly(P, cfg)
    x = P.x; z = nan(size(x)); keys = unique(P.ctx);
    for k = 1:numel(keys)
        idx = P.ctx == keys(k); tr = idx & P.train & ~isnan(x);
        if nnz(tr) < 10, tr = P.train & ~isnan(x); end
        m = median(x(tr)); s = max(1.4826 * median(abs(x(tr) - m)), 1e-3 + 0.005 * abs(m));
        z(idx) = (x(idx) - m) ./ s;
    end
    raw = abs(z) >= cfg.zLimit;
    flag = raw & [false; raw(1:end-1)];                 % persistance : 2 échantillons consécutifs
    flag = flag | [flag(2:end); false];
    A.z = z; A.flag = flag;
    if exist('iforest', 'file')
        X = P.xn(:); ok = ~isnan(X);
        try
            [mdl, ~] = iforest(X(ok & P.train), 'ContaminationFraction', 0.01, 'NumLearners', 100);
            [isAnom, score] = isanomaly(mdl, X(ok));           % isanomaly : R2022b+
            A.ifScore = nan(size(X)); A.ifScore(ok) = score; A.ifFlag = false(size(X)); A.ifFlag(ok) = isAnom;
        catch err
            warning('Isolation Forest non exécutée : %s', err.message);
        end
    else
        warning('iforest indisponible (Statistics and ML Toolbox R2021b+) : Isolation Forest ignorée.');
    end
    if ~isempty(P.truth)
        ev = P.t >= cfg.trainEnd_h; y = P.truth(ev) == 1; p = flag(ev);
        A.precision = sum(p & y) / max(1, sum(p)); A.recall = sum(p & y) / max(1, sum(y));
        fprintf('Détection %s : précision %.2f, rappel %.2f (vérité terrain SIMULÉE)\\n', cfg.tel.variable, A.precision, A.recall);
    end
end
`;
  F['mrh_km_fmds.m'] = `${HDR('mrh_km_fmds', 'Fiabilité : Kaplan–Meier (ecdf, Greenwood), Nelson–Aalen, Weibull MLE avec censure, MTBF/MTTR/disponibilité depuis le journal d’événements.')}
function R = mrh_km_fmds(D, cfg)
    T = D.life.(cfg.lifetime.time); E = D.life.(cfg.lifetime.event);
    cens = (E == 0);                                     % CONVENTION MATLAB : 1 = censuré
    [S, tS, lo, hi] = ecdf(T, 'Censoring', cens, 'Function', 'survivor');
    [H, tH] = ecdf(T, 'Censoring', cens, 'Function', 'cumulative hazard');
    [pw, ci] = wblfit(T, 0.05, cens);                    % pw = [eta beta]
    R.km = table(tS, S, lo, hi, 'VariableNames', {'t','R','IC_inf','IC_sup'});
    R.na = table(tH, H, 'VariableNames', {'t','H'});
    R.weibull = struct('eta', pw(1), 'beta', pw(2), 'eta_ci', ci(:,1)', 'beta_ci', ci(:,2)', 'mttf', pw(1) * gamma(1 + 1/pw(2)), 'b10', pw(1) * (-log(0.9))^(1/pw(2)));
    fprintf('Weibull : beta = %.3f [%.3f ; %.3f], eta = %.3f %s\\n', pw(2), ci(1,2), ci(2,2), pw(1), cfg.lifetime.unit);
    % --- MTBF / MTTR / disponibilité (journal d'événements, définitions opérationnelles explicites)
    ev = D.ev; W = max(ev.end_h); comps = unique(ev.component_id);
    R.fmds = table();
    for k = 1:numel(comps)
        e = ev(ev.component_id == comps(k), :);
        f = e(e.type == "panne", :); pl = e(e.type == "planifiee", :);
        TR = W - sum(pl.end_h - pl.start_h); down = sum(f.end_h - f.start_h); TBF = TR - down; r = height(f);
        if r > 0
            mtbf = TBF / r; lo = 2*TBF / chi2inv(0.95, 2*r + 2); hi = 2*TBF / chi2inv(0.05, 2*r); mttr = mean(f.end_h - f.start_h);
        else
            mtbf = NaN; lo = NaN; hi = NaN; mttr = NaN;   % « non calculable avec les données retenues »
        end
        R.fmds = [R.fmds; table(comps(k), r, mtbf, lo, hi, mttr, TBF / TR, 'VariableNames', {'component','failures','MTBF_h','MTBF_IC90_inf','MTBF_IC90_sup','MTTR_h','availability'})]; %#ok<AGROW>
    end
    disp(R.fmds);
end
`;
  F['mrh_rul.m'] = `${HDR('mrh_rul', 'Pronostic RUL sur trajectoires run-to-failure, séparation PAR ESSAI : exponentialDegradationModel (PdM Toolbox) vs extrapolation linéaire vs survie conditionnelle Weibull.')}
function R = mrh_rul(D, cfg)
    V = D.vib; V.ID_Roulement = string(V.ID_Roulement);
    pick = @(ids) arrayfun(@(id) V(V.ID_Roulement == id, {'Cycle_Heure','Vibration_RMS'}), string(ids), 'UniformOutput', false);
    tr = pick(cfg.vib.train); te = pick(cfg.vib.test);
    for k = 1:numel(tr), tr{k}.Properties.VariableNames = {'Time','Condition'}; end
    for k = 1:numel(te), te{k}.Properties.VariableNames = {'Time','Condition'}; end
    thr = cfg.vib.threshold; rows = [];
    hasPdM = exist('exponentialDegradationModel', 'file') == 2;
    if hasPdM
        mdl = exponentialDegradationModel();
        fit(mdl, tr, "Time", "Condition");             % prior appris sur le TRAIN uniquement
    else
        warning('Predictive Maintenance Toolbox absente : seul le baseline est calculé.');
    end
    % survie conditionnelle (durées jusqu'à panne des unités d'apprentissage)
    Tf = cellfun(@(x) x.Time(end), tr); pw = wblfit(Tf);
    for k = 1:numel(te)
        u = te{k}; Tend = u.Time(end);
        for f = [0.5 0.7 0.9]
            c = find(u.Time <= f * Tend, 1, 'last'); obs = u(1:c, :); tc = obs.Time(end); truth = Tend - tc;
            p = polyfit(obs.Time(floor(c/2)+1:end), obs.Condition(floor(c/2)+1:end), 1);
            base = max(0, (thr - p(2)) / p(1) - tc);
            Tq = @(q) pw(1) * ((tc/pw(1))^pw(2) - log(1 - q))^(1/pw(2)) - tc;
            surv = Tq(0.5);
            expo = NaN; lo = NaN; hi = NaN;
            if hasPdM
                pr = mdl.Prior;                          % nouveau modèle initialisé avec le prior appris
                m2 = exponentialDegradationModel('Theta', pr.Theta, 'ThetaVariance', pr.ThetaVariance, 'Beta', pr.Beta, ...
                    'BetaVariance', pr.BetaVariance, 'Rho', pr.Rho, 'Phi', mdl.Phi, 'NoiseVariance', mdl.NoiseVariance);
                m2.SlopeDetectionLevel = [];
                for i = 1:height(obs), update(m2, obs(i, :)); end
                [r, ci] = predictRUL(m2, obs(end, :), thr);
                if isduration(r), r = hours(r); ci = hours(ci); end
                expo = double(r); lo = double(ci(1)); hi = double(ci(2));
            end
            rows = [rows; {cfg.vib.test{k}, f, truth, expo, lo, hi, base, surv}]; %#ok<AGROW>
        end
    end
    R.table = cell2table(rows, 'VariableNames', {'unit','fraction','RUL_true_h','RUL_exp_h','IC_inf','IC_sup','RUL_baseline_h','RUL_survival_h'});
    disp(R.table);
end
`;
  F['mrh_figures.m'] = `${HDR('mrh_figures', 'Figures de synthèse (exportées en PNG dans results/, réimportables dans l’application).')}
function mrh_figures(R, P, A, cfg)
    f1 = figure('Name', 'Kaplan–Meier'); stairs(R.km.t, R.km.R, 'LineWidth', 2); hold on;
    stairs(R.km.t, R.km.IC_inf, 'r--'); stairs(R.km.t, R.km.IC_sup, 'r--');
    t = linspace(0, max(R.km.t) * 1.05, 200); plot(t, exp(-(t / R.weibull.eta).^R.weibull.beta), 'k-');
    xlabel(['t (' cfg.lifetime.unit ')']); ylabel('R(t)'); legend('KM', 'IC 95 %', '', 'Weibull'); grid on; title('Fiabilité — provenance : voir data/README.md');
    exportgraphics(f1, fullfile(cfg.resultsDir, 'km_weibull.png'));
    f2 = figure('Name', 'Anomalies'); plot(P.t, P.x, 'b-'); hold on; plot(P.t(A.flag), P.x(A.flag), 'r.');
    xline(cfg.trainEnd_h, 'k--', 'fin apprentissage'); xlabel('temps (h)'); ylabel(cfg.tel.variable, 'Interpreter', 'none'); grid on; title('Alertes (données SIMULÉES)');
    exportgraphics(f2, fullfile(cfg.resultsDir, 'anomalies.png'));
end
`;
  F['mrh_export_results.m'] = `${HDR('mrh_export_results', 'Export des résultats au format attendu par l’import de l’application (results/mrh_results.json + CSV).')}
function mrh_export_results(R, Rr, A, cfg)
    out = struct('source', 'MATLAB', 'provenance', 'simulated', 'generated', char(datetime('now', 'Format', 'yyyy-MM-dd''T''HH:mm:ss')), 'items', {{}});
    w = R.weibull;
    out.items{end+1} = struct('type', 'reliability', 'component', 'dataset', 'name', 'Weibull beta', 'value', w.beta, 'unit', '', 'ci_low', w.beta_ci(1), 'ci_high', w.beta_ci(2), 'method', 'wblfit (censure)');
    out.items{end+1} = struct('type', 'reliability', 'component', 'dataset', 'name', 'MTTF Weibull', 'value', w.mttf, 'unit', cfg.lifetime.unit, 'ci_low', NaN, 'ci_high', NaN, 'method', 'eta*gamma(1+1/beta)');
    if isfield(A, 'precision')
        out.items{end+1} = struct('type', 'metrics', 'component', '${o.component}', 'name', 'précision détection', 'value', A.precision, 'unit', '', 'ci_low', NaN, 'ci_high', NaN, 'method', 'z robuste contextuel');
        out.items{end+1} = struct('type', 'metrics', 'component', '${o.component}', 'name', 'rappel détection', 'value', A.recall, 'unit', '', 'ci_low', NaN, 'ci_high', NaN, 'method', 'z robuste contextuel');
    end
    T = Rr.table;
    for i = 1:height(T)
        v = T.RUL_exp_h(i); if isnan(v), v = T.RUL_survival_h(i); m = 'survie conditionnelle Weibull'; else, m = 'exponentialDegradationModel'; end
        out.items{end+1} = struct('type', 'rul', 'component', char(T.unit(i)), 'name', sprintf('RUL @ %.0f %% de vie', 100*T.fraction(i)), 'value', v, 'unit', 'h', 'ci_low', T.IC_inf(i), 'ci_high', T.IC_sup(i), 'method', m);
    end
    fid = fopen(fullfile(cfg.resultsDir, 'mrh_results.json'), 'w'); fprintf(fid, '%s', jsonencode(out, 'PrettyPrint', true)); fclose(fid);
    writetable(Rr.table, fullfile(cfg.resultsDir, 'rul_test.csv'));
    writetable(R.fmds, fullfile(cfg.resultsDir, 'fmds_events.csv'));
    fprintf('Résultats écrits dans %s (à réimporter dans « Laboratoire MATLAB »).\\n', cfg.resultsDir);
end
`;
  F['run_all.m'] = `${HDR('run_all', 'Chaîne complète : chargement → prétraitement → caractéristiques → anomalies → fiabilité/FMDS → RUL → figures → export.')}
cfg = mrh_config();
D   = mrh_load_data(cfg);
P   = mrh_preprocess(D, cfg);
Fe  = mrh_features(P, 12);  %#ok<NASGU>
A   = mrh_anomaly(P, cfg);
R   = mrh_km_fmds(D, cfg);
Rr  = mrh_rul(D, cfg);
mrh_figures(R, P, A, cfg);
mrh_export_results(R, Rr, A, cfg);
`;
  return F;
}
export const MATLAB_README = `# Projet MATLAB — MarsRover Health

Exécution : ouvrir MATLAB (R2021b ou plus récent conseillé), se placer dans \`scripts/\`, lancer \`run_all\`.
Toolboxes : Statistics and Machine Learning (ecdf, wblfit, chi2inv, iforest) ; Predictive Maintenance (exponentialDegradationModel, predictRUL) — facultative, un repli est prévu.
MATLAB Online : téléverser le dossier complet (Drive) puis exécuter \`run_all\`.

Arborescence : \`scripts/\` (fonctions .m), \`data/\` (CSV exportés par l'application, provenance dans data/README.md), \`results/\` (sorties : mrh_results.json, CSV, PNG).
Réimport : onglet « Laboratoire MATLAB » → « Importer des résultats » (JSON/CSV/PNG). Les résultats sont affichés avec leur badge de provenance.

Conventions : \`'Censoring'\` = 1 pour une observation CENSURÉE (corrige l'inversion présente dans certains scripts fournis). Séparation train/validation/test PAR ESSAI. Normalisation calculée sur l'apprentissage seulement.
Avertissement : aucun résultat issu de roulements de banc ou de données simulées n'est validé sur un rover réel (cahier des charges §9.4).
`;
