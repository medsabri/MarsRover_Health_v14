%% mrh_anomaly — MarsRover Health (généré automatiquement)
% Détection : z-score robuste CONTEXTUEL (médiane/MAD par mode×terrain appris sur le train) + Isolation Forest (iforest, R2021b+).
% Prototype académique — aide à la décision uniquement. Provenance des données : voir data/README.md.
% Généré le 2026-11-06.

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
        fprintf('Détection %s : précision %.2f, rappel %.2f (vérité terrain SIMULÉE)\n', cfg.tel.variable, A.precision, A.recall);
    end
end
