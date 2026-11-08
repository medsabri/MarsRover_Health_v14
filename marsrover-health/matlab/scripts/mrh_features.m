%% mrh_features — MarsRover Health (généré automatiquement)
% Caractéristiques glissantes (moyenne, écart-type, RMS, crête, kurtosis) sur fenêtres de N échantillons.
% Prototype académique — aide à la décision uniquement. Provenance des données : voir data/README.md.
% Généré le 2026-11-06.

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
