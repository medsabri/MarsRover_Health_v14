%% mrh_load_data — MarsRover Health (généré automatiquement)
% Lecture des CSV et contrôle qualité minimal (colonnes, lignes, valeurs manquantes).
% Prototype académique — aide à la décision uniquement. Provenance des données : voir data/README.md.
% Généré le 2026-11-06.

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
        fprintf('%-5s : %5d lignes, %2d colonnes, %d valeurs manquantes\n', names{k}, height(T), width(T), sum(miss));
    end
end
