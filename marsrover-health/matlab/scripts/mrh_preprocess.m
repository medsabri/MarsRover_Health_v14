%% mrh_preprocess — MarsRover Health (généré automatiquement)
% Prétraitement : tri temporel, gestion des manquants, normalisation calculée sur l’APPRENTISSAGE seulement.
% Prototype académique — aide à la décision uniquement. Provenance des données : voir data/README.md.
% Généré le 2026-11-06.

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
