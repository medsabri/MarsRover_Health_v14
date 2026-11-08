%% mrh_figures — MarsRover Health (généré automatiquement)
% Figures de synthèse (exportées en PNG dans results/, réimportables dans l’application).
% Prototype académique — aide à la décision uniquement. Provenance des données : voir data/README.md.
% Généré le 2026-11-06.

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
