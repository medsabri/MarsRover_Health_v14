%% mrh_km_fmds — MarsRover Health (généré automatiquement)
% Fiabilité : Kaplan–Meier (ecdf, Greenwood), Nelson–Aalen, Weibull MLE avec censure, MTBF/MTTR/disponibilité depuis le journal d’événements.
% Prototype académique — aide à la décision uniquement. Provenance des données : voir data/README.md.
% Généré le 2026-11-06.

function R = mrh_km_fmds(D, cfg)
    T = D.life.(cfg.lifetime.time); E = D.life.(cfg.lifetime.event);
    cens = (E == 0);                                     % CONVENTION MATLAB : 1 = censuré
    [S, tS, lo, hi] = ecdf(T, 'Censoring', cens, 'Function', 'survivor');
    [H, tH] = ecdf(T, 'Censoring', cens, 'Function', 'cumulative hazard');
    [pw, ci] = wblfit(T, 0.05, cens);                    % pw = [eta beta]
    R.km = table(tS, S, lo, hi, 'VariableNames', {'t','R','IC_inf','IC_sup'});
    R.na = table(tH, H, 'VariableNames', {'t','H'});
    R.weibull = struct('eta', pw(1), 'beta', pw(2), 'eta_ci', ci(:,1)', 'beta_ci', ci(:,2)', 'mttf', pw(1) * gamma(1 + 1/pw(2)), 'b10', pw(1) * (-log(0.9))^(1/pw(2)));
    fprintf('Weibull : beta = %.3f [%.3f ; %.3f], eta = %.3f %s\n', pw(2), ci(1,2), ci(2,2), pw(1), cfg.lifetime.unit);
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
