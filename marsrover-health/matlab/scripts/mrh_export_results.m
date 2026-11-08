%% mrh_export_results — MarsRover Health (généré automatiquement)
% Export des résultats au format attendu par l’import de l’application (results/mrh_results.json + CSV).
% Prototype académique — aide à la décision uniquement. Provenance des données : voir data/README.md.
% Généré le 2026-11-06.

function mrh_export_results(R, Rr, A, cfg)
    out = struct('source', 'MATLAB', 'provenance', 'simulated', 'generated', char(datetime('now', 'Format', 'yyyy-MM-dd''T''HH:mm:ss')), 'items', {{}});
    w = R.weibull;
    out.items{end+1} = struct('type', 'reliability', 'component', 'dataset', 'name', 'Weibull beta', 'value', w.beta, 'unit', '', 'ci_low', w.beta_ci(1), 'ci_high', w.beta_ci(2), 'method', 'wblfit (censure)');
    out.items{end+1} = struct('type', 'reliability', 'component', 'dataset', 'name', 'MTTF Weibull', 'value', w.mttf, 'unit', cfg.lifetime.unit, 'ci_low', NaN, 'ci_high', NaN, 'method', 'eta*gamma(1+1/beta)');
    if isfield(A, 'precision')
        out.items{end+1} = struct('type', 'metrics', 'component', 'motor_3', 'name', 'précision détection', 'value', A.precision, 'unit', '', 'ci_low', NaN, 'ci_high', NaN, 'method', 'z robuste contextuel');
        out.items{end+1} = struct('type', 'metrics', 'component', 'motor_3', 'name', 'rappel détection', 'value', A.recall, 'unit', '', 'ci_low', NaN, 'ci_high', NaN, 'method', 'z robuste contextuel');
    end
    T = Rr.table;
    for i = 1:height(T)
        v = T.RUL_exp_h(i); if isnan(v), v = T.RUL_survival_h(i); m = 'survie conditionnelle Weibull'; else, m = 'exponentialDegradationModel'; end
        out.items{end+1} = struct('type', 'rul', 'component', char(T.unit(i)), 'name', sprintf('RUL @ %.0f %% de vie', 100*T.fraction(i)), 'value', v, 'unit', 'h', 'ci_low', T.IC_inf(i), 'ci_high', T.IC_sup(i), 'method', m);
    end
    fid = fopen(fullfile(cfg.resultsDir, 'mrh_results.json'), 'w'); fprintf(fid, '%s', jsonencode(out, 'PrettyPrint', true)); fclose(fid);
    writetable(Rr.table, fullfile(cfg.resultsDir, 'rul_test.csv'));
    writetable(R.fmds, fullfile(cfg.resultsDir, 'fmds_events.csv'));
    fprintf('Résultats écrits dans %s (à réimporter dans « Laboratoire MATLAB »).\n', cfg.resultsDir);
end
