// =============================================================================
// survival.js — analyse de survie / fiabilité (FMDS).
//  - Kaplan–Meier avec IC de Greenwood (transformation log(−log), comme fcn_KM_IC.m)
//  - Nelson–Aalen (+ variance d'Aalen), Fleming–Harrington
//  - Taux de défaillance lissé par noyau (estimateur de Ramlau-Hansen sur les incréments NA)
//  - Weibull MLE avec censure à droite (+ IC de Wald), exponentielle, lognormale
// Convention : events[i] = 1 si défaillance observée, 0 si censure.
// =============================================================================
import { norminv, lgamma, gamma, nelderMead, hessian, inv2x2, normcdf, mulberry32, quantile, chi2inv } from './stats.js';

function sortPairs(times, events) {
  const idx = times.map((_, i) => i).filter((i) => Number.isFinite(times[i])).sort((a, b) => times[a] - times[b]);
  return { t: idx.map((i) => times[i]), e: idx.map((i) => (events[i] ? 1 : 0)) };
}

/** Kaplan–Meier. Retourne les sauts aux temps de défaillance distincts. */
export function kaplanMeier(times, events, alpha = 0.05) {
  const { t, e } = sortPairs(times, events);
  const n = t.length, z = norminv(1 - alpha / 2);
  const out = { t: [0], S: [1], lo: [1], hi: [1], nRisk: [n], d: [0], censorT: [], censorS: [], n, events: e.reduce((a, b) => a + b, 0) };
  let S = 1, gw = 0, i = 0;
  while (i < n) {
    const ti = t[i];
    let d = 0, c = 0;
    const atRisk = n - i;
    while (i < n && t[i] === ti) { if (e[i]) d++; else c++; i++; }
    if (d > 0) {
      S *= 1 - d / atRisk;
      gw += atRisk - d > 0 ? d / (atRisk * (atRisk - d)) : Infinity;
      let lo, hi;
      if (S > 0 && S < 1 && Number.isFinite(gw)) {
        const se = Math.sqrt(gw) / Math.abs(Math.log(S));     // σ de log(−log S)
        const ll = Math.log(-Math.log(S));
        lo = Math.exp(-Math.exp(ll + z * se)); hi = Math.exp(-Math.exp(ll - z * se));
      } else { lo = S; hi = S; }
      out.t.push(ti); out.S.push(S); out.lo.push(lo); out.hi.push(hi); out.nRisk.push(atRisk); out.d.push(d);
    }
    if (c > 0) { out.censorT.push(ti); out.censorS.push(S); }
  }
  out.median = medianSurvival(out);
  out.rmst = rmst(out, t[n - 1]);
  out.tmax = t[n - 1];
  return out;
}
/** Valeur de S en un temps donné (fonction en escalier continue à droite). */
export function stepAt(km, x, key = 'S') {
  let v = km[key][0];
  for (let i = 0; i < km.t.length; i++) { if (km.t[i] <= x) v = km[key][i]; else break; }
  return v;
}
export function medianSurvival(km) {
  for (let i = 0; i < km.S.length; i++) if (km.S[i] <= 0.5) return km.t[i];
  return null; // non atteinte
}
/** Durée de vie moyenne restreinte (aire sous KM jusqu'à tau). */
export function rmst(km, tau) {
  let a = 0;
  for (let i = 0; i < km.t.length; i++) {
    const t0 = km.t[i], t1 = i + 1 < km.t.length ? Math.min(km.t[i + 1], tau) : tau;
    if (t1 > t0) a += km.S[i] * (t1 - t0);
  }
  return a;
}

/** Nelson–Aalen : risque cumulé H(t) et variance d'Aalen. */
export function nelsonAalen(times, events, alpha = 0.05) {
  const { t, e } = sortPairs(times, events);
  const n = t.length, z = norminv(1 - alpha / 2);
  const out = { t: [0], H: [0], lo: [0], hi: [0], dH: [0], Y: [n] };
  let H = 0, v = 0, i = 0;
  while (i < n) {
    const ti = t[i]; let d = 0; const Y = n - i;
    while (i < n && t[i] === ti) { if (e[i]) d++; i++; }
    if (d > 0) {
      const inc = d / Y; H += inc; v += d / (Y * Y);
      out.t.push(ti); out.H.push(H); out.dH.push(inc); out.Y.push(Y);
      out.lo.push(Math.max(0, H * Math.exp(-z * Math.sqrt(v) / H))); out.hi.push(H * Math.exp(z * Math.sqrt(v) / H));
    }
  }
  out.SFH = out.H.map((h) => Math.exp(-h)); // estimateur de Fleming–Harrington de S(t)
  return out;
}

const KERNELS = {
  epanechnikov: (u) => (Math.abs(u) <= 1 ? 0.75 * (1 - u * u) : 0),
  gaussian: (u) => Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI),
  triangle: (u) => (Math.abs(u) <= 1 ? 1 - Math.abs(u) : 0),
  box: (u) => (Math.abs(u) <= 1 ? 0.5 : 0),
};
/**
 * Taux de défaillance lissé ĥ(t) = (1/b) Σ K((t − t_j)/b) ΔĤ(t_j)  (Ramlau-Hansen).
 * Prend correctement en compte la censure (à la différence de f̂_KDE(défaillances)/R̂).
 */
export function kernelHazard(times, events, { bandwidth, kernel = 'epanechnikov', grid } = {}) {
  const na = nelsonAalen(times, events);
  const K = KERNELS[kernel] || KERNELS.epanechnikov;
  const tmax = na.t[na.t.length - 1] || 1;
  const b = bandwidth || silverman(times.filter((_, i) => events[i]));
  const g = grid || Array.from({ length: 120 }, (_, i) => (tmax * i) / 119);
  const h = g.map((x) => { let s = 0; for (let j = 1; j < na.t.length; j++) s += K((x - na.t[j]) / b) * na.dH[j]; return s / b; });
  // Bords : la zone t < b est biaisée (pas de correction de bord) → signalée.
  return { t: g, h, bandwidth: b, kernel, edgeBias: b };
}
function silverman(x) {
  const n = x.length; if (n < 2) return 1;
  const m = x.reduce((a, b) => a + b, 0) / n;
  const s = Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1));
  const iqr = quantile(x, 0.75) - quantile(x, 0.25);
  return 0.9 * Math.min(s, iqr / 1.34) * n ** -0.2 * 2.0; // ×2 : lissage plus fort adapté au taux
}

// ------------------------------------------------------------------ lois paramétriques
export const weibull = {
  R: (t, beta, eta) => Math.exp(-((t / eta) ** beta)),
  F: (t, beta, eta) => 1 - Math.exp(-((t / eta) ** beta)),
  h: (t, beta, eta) => (beta / eta) * (t / eta) ** (beta - 1),
  f: (t, beta, eta) => (beta / eta) * (t / eta) ** (beta - 1) * Math.exp(-((t / eta) ** beta)),
  mean: (beta, eta) => eta * gamma(1 + 1 / beta),
  /** Temps auquel R(t) = r (ex. r = 0.9 → durée B10). */
  tAtR: (r, beta, eta) => eta * (-Math.log(r)) ** (1 / beta),
  sample: (rand, beta, eta) => eta * (-Math.log(1 - rand())) ** (1 / beta),
};

/**
 * Weibull 2 paramètres par maximum de vraisemblance avec censure à droite.
 * Équation profilée en β résolue par bissection ; IC de Wald sur (ln η, ln β).
 */
export function weibullMLE(times, events, alpha = 0.05) {
  const t = [], e = [];
  times.forEach((x, i) => { if (Number.isFinite(x) && x > 0) { t.push(x); e.push(events[i] ? 1 : 0); } });
  const r = e.reduce((a, b) => a + b, 0);
  if (r < 2) return { ok: false, reason: 'Moins de 2 défaillances observées : ajustement Weibull impossible.' };
  const lt = t.map(Math.log), sumLtF = lt.reduce((s, v, i) => s + (e[i] ? v : 0), 0) / r;
  const g = (b) => {
    let s0 = 0, s1 = 0; const m = Math.max(...lt);
    for (let i = 0; i < t.length; i++) { const w = Math.exp(b * (lt[i] - m)); s0 += w; s1 += w * lt[i]; }
    return s1 / s0 - 1 / b - sumLtF;
  };
  let lo = 0.02, hi = 60;
  if (g(lo) > 0 || g(hi) < 0) return { ok: false, reason: 'Pas de racine pour β dans [0.02, 60].' };
  for (let k = 0; k < 200; k++) { const mid = (lo + hi) / 2; if (g(mid) > 0) hi = mid; else lo = mid; }
  const beta = (lo + hi) / 2;
  const eta = (t.reduce((s, x) => s + x ** beta, 0) / r) ** (1 / beta);
  const nll = (p) => { const le = p[0], lb = p[1], et = Math.exp(le), bt = Math.exp(lb); let L = 0;
    for (let i = 0; i < t.length; i++) { const z = (t[i] / et) ** bt; L += -z + (e[i] ? Math.log(bt / et) + (bt - 1) * Math.log(t[i] / et) : 0); } return -L; };
  const p = [Math.log(eta), Math.log(beta)];
  let ci = null;
  try {
    const C = inv2x2(hessian(nll, p, 1e-4)), zq = norminv(1 - alpha / 2);
    const se = [Math.sqrt(C[0][0]), Math.sqrt(C[1][1])];
    ci = { eta: [Math.exp(p[0] - zq * se[0]), Math.exp(p[0] + zq * se[0])], beta: [Math.exp(p[1] - zq * se[1]), Math.exp(p[1] + zq * se[1])], cov: C };
  } catch (err) { ci = null; }
  const logLik = -nll(p);
  return { ok: true, beta, eta, ci, logLik, aic: 4 - 2 * logLik, n: t.length, r, mttf: weibull.mean(beta, eta), b10: weibull.tAtR(0.9, beta, eta) };
}
/** Loi exponentielle (taux constant) avec censure : λ = r / TTT, IC du χ². */
export function exponentialMLE(times, events, alpha = 0.05) {
  const r = events.reduce((a, b) => a + (b ? 1 : 0), 0), T = times.reduce((a, b) => a + b, 0);
  if (r < 1) return { ok: false, reason: 'Aucune défaillance observée.' };
  const lambda = r / T;
  const logLik = r * Math.log(lambda) - lambda * T;
  return { ok: true, lambda, mttf: 1 / lambda, mttfCI: [2 * T / chi2inv(1 - alpha / 2, 2 * r + 2), 2 * T / chi2inv(alpha / 2, 2 * r)], logLik, aic: 2 - 2 * logLik, r, T };
}
/** Lognormale avec censure (Nelder–Mead). Utilisée pour les durées de réparation (MTTR). */
export function lognormalMLE(times, events) {
  const t = times.filter((x) => x > 0), e = events.filter((_, i) => times[i] > 0);
  const r = e.reduce((a, b) => a + (b ? 1 : 0), 0);
  if (r < 2) return { ok: false, reason: 'Moins de 2 observations non censurées.' };
  const lt = t.map(Math.log);
  const nll = ([mu, ls]) => { const s = Math.exp(ls); let L = 0;
    for (let i = 0; i < t.length; i++) { const z = (lt[i] - mu) / s;
      L += e[i] ? -Math.log(s * t[i] * Math.sqrt(2 * Math.PI)) - 0.5 * z * z : Math.log(Math.max(1e-300, 1 - normcdf(z))); }
    return -L; };
  const m0 = lt.reduce((a, b) => a + b, 0) / lt.length;
  const s0 = Math.sqrt(lt.reduce((a, v) => a + (v - m0) ** 2, 0) / Math.max(1, lt.length - 1)) || 0.5;
  const res = nelderMead(nll, [m0, Math.log(s0)]);
  const mu = res.x[0], sigma = Math.exp(res.x[1]);
  return { ok: true, mu, sigma, mean: Math.exp(mu + sigma * sigma / 2), median: Math.exp(mu), logLik: -res.fx, aic: 4 + 2 * res.fx };
}
/** Comparaison de modèles par AIC + écart maximal à Kaplan–Meier. */
export function compareModels(times, events) {
  const km = kaplanMeier(times, events);
  const w = weibullMLE(times, events), ex = exponentialMLE(times, events), ln = lognormalMLE(times, events);
  const dev = (Rf) => Math.max(...km.t.map((x, i) => Math.abs(km.S[i] - Rf(x))));
  const rows = [];
  if (w.ok) rows.push({ model: 'Weibull', aic: w.aic, maxDevKM: dev((x) => weibull.R(x, w.beta, w.eta)), params: `β = ${w.beta.toFixed(3)}, η = ${w.eta.toFixed(2)}` });
  if (ex.ok) rows.push({ model: 'Exponentielle', aic: ex.aic, maxDevKM: dev((x) => Math.exp(-ex.lambda * x)), params: `λ = ${ex.lambda.toExponential(3)}` });
  if (ln.ok) rows.push({ model: 'Lognormale', aic: ln.aic, maxDevKM: dev((x) => (x <= 0 ? 1 : 1 - normcdf((Math.log(x) - ln.mu) / ln.sigma))), params: `μ = ${ln.mu.toFixed(3)}, σ = ${ln.sigma.toFixed(3)}` });
  rows.sort((a, b) => a.aic - b.aic);
  return { rows, best: rows[0] ? rows[0].model : null };
}
/** Bootstrap non paramétrique des paramètres Weibull (graine fixée). */
export function bootstrapWeibull(times, events, B = 200, seed = 42) {
  const rand = mulberry32(seed), n = times.length, betas = [], etas = [];
  for (let b = 0; b < B; b++) {
    const tt = [], ee = [];
    for (let i = 0; i < n; i++) { const k = Math.floor(rand() * n); tt.push(times[k]); ee.push(events[k]); }
    const w = weibullMLE(tt, ee);
    if (w.ok) { betas.push(w.beta); etas.push(w.eta); }
  }
  return { B: betas.length, seed, beta: [quantile(betas, 0.05), quantile(betas, 0.5), quantile(betas, 0.95)], eta: [quantile(etas, 0.05), quantile(etas, 0.5), quantile(etas, 0.95)], betas, etas };
}
export { lgamma };
