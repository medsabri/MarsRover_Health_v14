%% mrh_rul — MarsRover Health (généré automatiquement)
% Pronostic RUL sur trajectoires run-to-failure, séparation PAR ESSAI : exponentialDegradationModel (PdM Toolbox) vs extrapolation linéaire vs survie conditionnelle Weibull.
% Prototype académique — aide à la décision uniquement. Provenance des données : voir data/README.md.
% Généré le 2026-11-06.

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
