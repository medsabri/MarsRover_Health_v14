// =============================================================================
// stats.js — fonctions statistiques de base (sans dépendance).
// Toutes les fonctions aléatoires reçoivent un générateur seedé (reproductibilité).
// =============================================================================

/** Générateur pseudo-aléatoire Mulberry32 (graine entière) → fonction () => [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Tirage normal N(0,1) (Box-Muller) à partir d'un générateur uniforme. */
export function randn(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const sum = (a) => a.reduce((s, x) => s + x, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : NaN);
export function variance(a, ddof = 1) {
  if (a.length <= ddof) return NaN;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - ddof);
}
export const std = (a, ddof = 1) => Math.sqrt(variance(a, ddof));
export function quantile(a, q) {
  const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export const median = (a) => quantile(a, 0.5);
/** Écart absolu médian, mis à l'échelle (×1.4826) pour être cohérent avec σ sous normalité. */
export function mad(a) {
  const m = median(a);
  return 1.4826 * median(a.map((x) => Math.abs(x - m)));
}
export const finite = (a) => a.filter((x) => x !== null && Number.isFinite(x));

/** Régression linéaire simple y = a + b x. Retourne coefficients, covariance et σ résiduel. */
export function linreg(x, y) {
  const n = x.length;
  if (n < 2) return null;
  const mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  if (sxx === 0) return null;
  const b = sxy / sxx, a = my - b * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (y[i] - a - b * x[i]) ** 2;
  const s2 = n > 2 ? sse / (n - 2) : 0;
  return {
    a, b, sigma: Math.sqrt(s2), n,
    varB: s2 / sxx, varA: s2 * (1 / n + mx * mx / sxx), covAB: -mx * s2 / sxx,
    r2: 1 - sse / y.reduce((s, v) => s + (v - my) ** 2, 0),
  };
}
/** Régression bayésienne linéaire y = X·w + ε, prior w ~ N(m0, S0), ε ~ N(0, s2). */
export function bayesLinreg(X, y, m0, S0, s2) {
  // Dimension 2 uniquement (suffisant pour les modèles de dégradation).
  const inv2 = (M) => { const d = M[0][0] * M[1][1] - M[0][1] * M[1][0]; return [[M[1][1] / d, -M[0][1] / d], [-M[1][0] / d, M[0][0] / d]]; };
  const S0i = inv2(S0);
  const A = [[S0i[0][0], S0i[0][1]], [S0i[1][0], S0i[1][1]]];
  const bvec = [S0i[0][0] * m0[0] + S0i[0][1] * m0[1], S0i[1][0] * m0[0] + S0i[1][1] * m0[1]];
  for (let i = 0; i < y.length; i++) {
    const x = X[i];
    A[0][0] += x[0] * x[0] / s2; A[0][1] += x[0] * x[1] / s2; A[1][0] += x[1] * x[0] / s2; A[1][1] += x[1] * x[1] / s2;
    bvec[0] += x[0] * y[i] / s2; bvec[1] += x[1] * y[i] / s2;
  }
  const SN = inv2(A);
  const mN = [SN[0][0] * bvec[0] + SN[0][1] * bvec[1], SN[1][0] * bvec[0] + SN[1][1] * bvec[1]];
  return { mN, SN };
}
/** Tirage d'un vecteur gaussien bivarié N(m, S) (Cholesky 2×2). */
export function mvn2(rand, m, S) {
  const l11 = Math.sqrt(Math.max(S[0][0], 1e-300));
  const l21 = S[1][0] / l11;
  const l22 = Math.sqrt(Math.max(S[1][1] - l21 * l21, 1e-300));
  const z1 = randn(rand), z2 = randn(rand);
  return [m[0] + l11 * z1, m[1] + l21 * z1 + l22 * z2];
}

// ------------------------------------------------------------ fonctions spéciales
/** ln Γ(x) — approximation de Lanczos (précision ~1e-14). */
export function lgamma(x) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
export const gamma = (x) => Math.exp(lgamma(x));
/** Fonction gamma incomplète régularisée P(a, x). */
export function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a, s = 1 / a, d = s;
    for (let n = 0; n < 500; n++) { ap += 1; d *= x / ap; s += d; if (Math.abs(d) < Math.abs(s) * 1e-15) break; }
    return s * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  // fraction continue (Lentz)
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
/** Quantile de la loi du χ² à k degrés de liberté (inversion par bissection). */
export function chi2inv(p, k) {
  if (k <= 0) return 0;
  let lo = 0, hi = Math.max(10, k * 10);
  while (gammaP(k / 2, hi / 2) < p) hi *= 2;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (gammaP(k / 2, mid / 2) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
/** Quantile de la loi normale centrée réduite (Acklam). */
export function norminv(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
export function normcdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
export function erf(x) {
  // Abramowitz-Stegun 7.1.26 raffiné (erreur < 1.5e-7)
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

/** Optimisation de Nelder-Mead (minimisation) — utilisée pour la vraisemblance lognormale censurée. */
export function nelderMead(f, x0, { maxIter = 2000, tol = 1e-10, step = 0.1 } = {}) {
  const n = x0.length;
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += x[i] !== 0 ? step * Math.abs(x[i]) : step; simplex.push(x); }
  let fv = simplex.map(f);
  for (let it = 0; it < maxIter; it++) {
    const idx = fv.map((v, i) => i).sort((a, b) => fv[a] - fv[b]);
    simplex = idx.map((i) => simplex[i]); fv = idx.map((i) => fv[i]);
    if (Math.abs(fv[n] - fv[0]) < tol * (Math.abs(fv[0]) + tol)) break;
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i][j] / n;
    const xr = c.map((v, j) => v + (v - simplex[n][j])), fr = f(xr);
    if (fr < fv[0]) {
      const xe = c.map((v, j) => v + 2 * (v - simplex[n][j])), fe = f(xe);
      if (fe < fr) { simplex[n] = xe; fv[n] = fe; } else { simplex[n] = xr; fv[n] = fr; }
    } else if (fr < fv[n - 1]) { simplex[n] = xr; fv[n] = fr; }
    else {
      const xc = c.map((v, j) => v + 0.5 * (simplex[n][j] - v)), fc = f(xc);
      if (fc < fv[n]) { simplex[n] = xc; fv[n] = fc; }
      else for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])); fv[i] = f(simplex[i]); }
    }
  }
  return { x: simplex[0], fx: fv[0] };
}

/** Hessienne numérique (différences centrées) — pour les intervalles de Wald. */
export function hessian(f, x, h = 1e-4) {
  const n = x.length, H = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const xpp = x.slice(), xpm = x.slice(), xmp = x.slice(), xmm = x.slice();
    xpp[i] += h; xpp[j] += h; xpm[i] += h; xpm[j] -= h; xmp[i] -= h; xmp[j] += h; xmm[i] -= h; xmm[j] -= h;
    H[i][j] = (f(xpp) - f(xpm) - f(xmp) + f(xmm)) / (4 * h * h);
  }
  return H;
}
export function inv2x2(M) { const d = M[0][0] * M[1][1] - M[0][1] * M[1][0]; return [[M[1][1] / d, -M[0][1] / d], [-M[1][0] / d, M[0][0] / d]]; }

/** Statistiques de résumé pour boîte à moustaches. */
export function boxStats(a) {
  const f = finite(a);
  const q1 = quantile(f, 0.25), q3 = quantile(f, 0.75), iqr = q3 - q1;
  const lo = Math.min(...f.filter((x) => x >= q1 - 1.5 * iqr)), hi = Math.max(...f.filter((x) => x <= q3 + 1.5 * iqr));
  return { min: Math.min(...f), q1, med: median(f), q3, max: Math.max(...f), wLo: lo, wHi: hi, outliers: f.filter((x) => x < lo || x > hi), n: f.length };
}
