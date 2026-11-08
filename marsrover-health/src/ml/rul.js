// =============================================================================
// rul.js — pronostic de durée de vie résiduelle (RUL / DVR), §9.3.
//  Règles appliquées :
//   * RUL calculée UNIQUEMENT si un seuil de fin de vie est défini ; sinon { available:false }.
//   * Toujours une unité et un intervalle (quantiles 5 % – 95 %).
//   * Séparation train / validation / test PAR UNITÉ (essai, pack…), jamais par fenêtres.
//  Modèles :
//   (1) Baseline : extrapolation linéaire sur les 50 % derniers points (reproduit reliability_analysis*.m)
//   (2) Dégradation exponentielle bayésienne (équivalent conceptuel d'exponentialDegradationModel, PdM Toolbox) :
//         y(t) = φ + θ·exp(β·x),   x = t (modèle « exp ») ou x = ln t (modèle « power »)
//       prior (ln θ, β) appris sur les unités d'apprentissage, mise à jour bayésienne sur l'unité suivie,
//       RUL par Monte-Carlo (graine fixée).
// =============================================================================
import { linreg, bayesLinreg, mvn2, mulberry32, quantile, mean, randn } from './stats.js';

export function groupTrajectories(rows, { idCol, tCol, yCol }) {
  const map = new Map();
  for (const r of rows) {
    const id = r[idCol], t = +r[tCol], y = +r[yCol];
    if (!Number.isFinite(t) || !Number.isFinite(y)) continue;
    if (!map.has(id)) map.set(id, { id, t: [], y: [] });
    map.get(id).t.push(t); map.get(id).y.push(y);
  }
  for (const tr of map.values()) { const o = tr.t.map((_, i) => i).sort((a, b) => tr.t[a] - tr.t[b]); tr.t = o.map((i) => tr.t[i]); tr.y = o.map((i) => tr.y[i]); }
  return [...map.values()];
}

/** Transforme une trajectoire selon le sens de dégradation (down → y' = ref − y). */
function orient(tr, direction, ref) { return direction === 'down' ? { ...tr, y: tr.y.map((v) => ref - v) } : tr; }

export class ExpDegradationModel {
  constructor({ threshold, direction = 'up', kind = 'exp', ref = null, seed = 11, nSamples = 3000, unit = 'h' }) {
    Object.assign(this, { threshold, direction, kind, ref, seed, nSamples, unit });
  }
  _x(t) { return this.kind === 'power' ? Math.log(Math.max(t, 1e-9)) : t; }
  /** Ajustement non linéaire d'une trajectoire (Gauss-Newton en espace original, φ fixé). */
  _fitUnit(u, phi) {
    const X = [], Y = [];
    u.t.forEach((t, i) => { if (t > 0) { X.push(this._x(t)); Y.push(u.y[i]); } });
    const lx = [], ly = [];
    X.forEach((x, i) => { const v = Y[i] - phi; if (v > 0) { lx.push(x); ly.push(Math.log(v)); } });
    const lr = linreg(lx, ly); if (!lr) return null;
    let a = lr.a, b = lr.b;
    for (let it = 0; it < 30; it++) {
      let JtJ00 = 0, JtJ01 = 0, JtJ11 = 0, Jr0 = 0, Jr1 = 0;
      for (let i = 0; i < X.length; i++) {
        const e = Math.exp(a + b * X[i]), r = Y[i] - phi - e;
        const j0 = e, j1 = e * X[i];
        JtJ00 += j0 * j0; JtJ01 += j0 * j1; JtJ11 += j1 * j1; Jr0 += j0 * r; Jr1 += j1 * r;
      }
      const det = JtJ00 * JtJ11 - JtJ01 * JtJ01; if (!(Math.abs(det) > 1e-300)) break;
      const da = (JtJ11 * Jr0 - JtJ01 * Jr1) / det, db = (JtJ00 * Jr1 - JtJ01 * Jr0) / det;
      a += da; b += db; if (Math.abs(da) < 1e-10 && Math.abs(db) < 1e-14) break;
    }
    let sse = 0; for (let i = 0; i < X.length; i++) sse += (Y[i] - phi - Math.exp(a + b * X[i])) ** 2;
    return { a, b, sse, n: X.length };
  }
  fit(trainTrajs) {
    const tr = trainTrajs.map((x) => orient(x, this.direction, this.ref));
    if (tr.length < 2) throw new Error("Au moins 2 trajectoires d'apprentissage sont nécessaires.");
    const allY = tr.flatMap((x) => x.y), minY = Math.min(...allY), span = Math.max(...allY) - minY;
    // φ commun choisi par recherche sur grille (minimisation de la SSE totale en espace original)
    let best = null;
    for (let k = 1; k <= 40; k++) {
      const phi = minY - span * (k / 40) * 0.6 + (this.kind === 'power' ? 0 : 0);
      const fits = tr.map((u) => this._fitUnit(u, phi));
      if (fits.some((f) => !f || !Number.isFinite(f.sse))) continue;
      const sse = fits.reduce((s, f) => s + f.sse, 0);
      if (!best || sse < best.sse) best = { phi, fits, sse };
    }
    if (!best) throw new Error('Ajustement impossible.');
    this.phi = best.phi;
    const params = best.fits.map((f) => [f.a, f.b]);
    const m = [mean(params.map((p) => p[0])), mean(params.map((p) => p[1]))];
    const cov = [[0, 0], [0, 0]];
    for (const p of params) { const d = [p[0] - m[0], p[1] - m[1]]; cov[0][0] += d[0] * d[0]; cov[0][1] += d[0] * d[1]; cov[1][1] += d[1] * d[1]; }
    const k = params.length - 1;
    cov[0][0] /= k; cov[1][1] /= k; cov[0][1] /= k; cov[1][0] = cov[0][1];
    // inflation (petit nombre d'unités) pour ne pas sous-estimer la dispersion inter-unités
    const infl = 1 + 2 / params.length;
    cov[0][0] *= infl; cov[0][1] *= infl; cov[1][0] *= infl; cov[1][1] *= infl;
    this.prior = { mean: m, cov, perUnit: params, inflation: infl };
    this.sigmaY = Math.sqrt(best.sse / Math.max(1, best.fits.reduce((s, f) => s + f.n, 0) - 2 * params.length));
    this.noiseVar = this.sigmaY ** 2;
    const dts = tr.flatMap((u) => u.t.slice(1).map((t, i) => t - u.t[i]));
    this.dt = quantile(dts, 0.5);
    this.thrT = (this.direction === 'down' ? this.ref - this.threshold : this.threshold);
    return this;
  }
  /**
   * RUL à partir des observations de l'unité suivie (t, y) jusqu'à t_c.
   * Postérieur par échantillonnage d'importance (prior × vraisemblance gaussienne en espace original),
   * puis simulation de trajectoires FUTURES BRUITÉES : la panne = premier franchissement du seuil
   * par la mesure (même définition que dans les données d'apprentissage).
   */
  predict(t, y) {
    const o = orient({ t, y }, this.direction, this.ref);
    const rand = mulberry32(this.seed), tc = t[t.length - 1];
    const X = [], Y = [];
    o.t.forEach((tt, i) => { if (tt > 0) { X.push(this._x(tt)); Y.push(o.y[i]); } });
    const N = this.nSamples, P = [], logw = [];
    for (let s = 0; s < N; s++) {
      const [a, b] = mvn2(rand, this.prior.mean, this.prior.cov);
      let ll = 0; for (let i = 0; i < X.length; i++) ll -= (Y[i] - this.phi - Math.exp(a + b * X[i])) ** 2;
      P.push([a, b]); logw.push(ll / (2 * this.noiseVar));
    }
    const mx = Math.max(...logw); let w = logw.map((l) => Math.exp(l - mx)); const sw = w.reduce((s, v) => s + v, 0); w = w.map((v) => v / sw);
    const ess = 1 / w.reduce((s, v) => s + v * v, 0);
    // rééchantillonnage systématique
    const idx = []; let c = w[0], j = 0; const u0 = rand() / N;
    for (let s = 0; s < N; s++) { const uu = u0 + s / N; while (uu > c && j < N - 1) { j++; c += w[j]; } idx.push(j); }
    const yNow = o.y[o.y.length - 1];
    const crossed = yNow >= this.thrT;
    const horizon = Math.max(tc * 6, 50 * this.dt), ruls = []; let neverCross = 0;
    for (const k of idx) {
      const [a, b] = P[k]; let tt = tc, hit = null;
      while (tt < tc + horizon) { tt += this.dt; const yy = this.phi + Math.exp(a + b * this._x(tt)) + this.sigmaY * randn(rand); if (yy >= this.thrT) { hit = tt; break; } }
      if (hit === null) neverCross++; else ruls.push(hit - tc);
    }
    const am = [0, 0]; idx.forEach((k) => { am[0] += P[k][0] / N; am[1] += P[k][1] / N; });
    return {
      available: true, method: `Dégradation ${this.kind === 'power' ? 'puissance' : 'exponentielle'} bayésienne (φ + e^{a+b·${this.kind === 'power' ? 'ln t' : 't'}})`,
      unit: this.unit, tc, crossed, ess,
      value: crossed ? 0 : (ruls.length ? quantile(ruls, 0.5) : Infinity), ci: crossed ? [0, 0] : (ruls.length ? [quantile(ruls, 0.05), quantile(ruls, 0.95)] : [Infinity, Infinity]),
      pNeverCross: neverCross / N, posteriorMean: am,
      curve: (tq) => { const v = this.phi + Math.exp(am[0] + am[1] * this._x(tq)); return this.direction === 'down' ? this.ref - v : v; },
    };
  }
}

/** Baseline : extrapolation linéaire sur la seconde moitié des observations, IC par Monte-Carlo des coefficients. */
export function linearBaselineRUL(t, y, { threshold, direction = 'up', unit = 'h', seed = 3, frac = 0.5 }) {
  const n = t.length, s = Math.max(0, Math.floor(n * frac));
  const tt = t.slice(s), yy = y.slice(s);
  const lr = linreg(tt, yy);
  const tc = t[n - 1];
  if (!lr) return { available: false, reason: 'Pas assez de points pour la régression.' };
  const sign = direction === 'down' ? -1 : 1;
  if (sign * y[n - 1] >= sign * threshold) return { available: true, method: 'Extrapolation linéaire (baseline)', unit, tc, value: 0, ci: [0, 0], crossed: true, lr };
  if (sign * lr.b <= 0) return { available: true, method: 'Extrapolation linéaire (baseline)', unit, tc, value: Infinity, ci: [Infinity, Infinity], note: 'Tendance non dégradante : pas de croisement du seuil.', lr };
  const rand = mulberry32(seed), r = [];
  for (let k = 0; k < 2000; k++) {
    const b = lr.b + Math.sqrt(lr.varB) * randn(rand), a = lr.a + Math.sqrt(lr.varA) * randn(rand) ;
    if (sign * b <= 0) continue;
    r.push(Math.max(0, (threshold - a) / b - tc));
  }
  return { available: true, method: 'Extrapolation linéaire (baseline)', unit, tc, value: Math.max(0, (threshold - lr.a) / lr.b - tc), ci: [quantile(r, 0.05), quantile(r, 0.95)], lr };
}

/**
 * Protocole d'évaluation sur unités NON VUES (aucune fuite) :
 * pour chaque unité de test et chaque fraction de vie f, on coupe la trajectoire à f·T_fin et on compare à la RUL vraie.
 */
export function evaluateRUL(model, testTrajs, { fractions = [0.5, 0.7, 0.9], baseline = null } = {}) {
  const rows = [];
  for (const u of testTrajs) {
    const T = u.t[u.t.length - 1];
    for (const f of fractions) {
      const c = u.t.findIndex((x) => x > f * T); const k = c < 0 ? u.t.length : Math.max(3, c);
      const t = u.t.slice(0, k), y = u.y.slice(0, k);
      const truth = T - t[t.length - 1];
      const p = model.predict(t, y);
      const row = { unit: u.id, fraction: f, tc: t[t.length - 1], truth, pred: p.value, lo: p.ci[0], hi: p.ci[1], covered: truth >= p.ci[0] && truth <= p.ci[1] };
      if (baseline) { const b = baseline(t, y); row.base = b.value; }
      rows.push(row);
    }
  }
  const err = rows.map((r) => r.pred - r.truth).filter(Number.isFinite);
  const errB = rows.map((r) => r.base - r.truth).filter(Number.isFinite);
  const phm = (e) => e.reduce((s, d) => s + (d < 0 ? Math.exp(-d / 13) - 1 : Math.exp(d / 10) - 1), 0);
  return {
    rows,
    mae: mean(err.map(Math.abs)), rmse: Math.sqrt(mean(err.map((e) => e * e))), coverage: rows.filter((r) => r.covered).length / rows.length,
    maeBase: errB.length ? mean(errB.map(Math.abs)) : null, rmseBase: errB.length ? Math.sqrt(mean(errB.map((e) => e * e))) : null,
    phmScore: phm(err.map((e) => e / 100)), phmScoreBase: errB.length ? phm(errB.map((e) => e / 100)) : null,
    note: 'Score PHM (asymétrique, a1 = 13, a2 = 10) calculé sur l\'erreur exprimée en centaines d\'unités de temps.',
  };
}

/**
 * RUL par survie conditionnelle : Weibull ajustée sur les durées jusqu'à panne des unités d'apprentissage,
 * RUL(t_c) = quantiles de (T − t_c | T > t_c). N'utilise pas l'indicateur de santé (référence « fiabiliste »).
 */
import { weibullMLE } from './survival.js';
export class SurvivalRULModel {
  constructor({ threshold, direction = 'up', unit = 'h' }) { Object.assign(this, { threshold, direction, unit }); }
  fit(trainTrajs) {
    const T = [], E = [];
    for (const u of trainTrajs) {
      const last = u.y[u.y.length - 1];
      T.push(u.t[u.t.length - 1]); E.push((this.direction === 'down' ? last <= this.threshold : last >= this.threshold) ? 1 : 0);
    }
    this.w = weibullMLE(T, E);
    if (!this.w.ok) throw new Error(this.w.reason);
    return this;
  }
  predict(t) {
    const { beta, eta } = this.w, tc = t[t.length - 1];
    const Tq = (q) => eta * ((tc / eta) ** beta - Math.log(1 - q)) ** (1 / beta) - tc;
    return { available: true, method: `Survie conditionnelle Weibull (β = ${beta.toFixed(2)}, η = ${eta.toFixed(0)} ${this.unit})`, unit: this.unit, tc, value: Tq(0.5), ci: [Tq(0.05), Tq(0.95)] };
  }
}

/** Détecte un « saut terminal » (dernier incrément > 4 σ des incréments) : la panne n'est alors pas précédée d'une tendance. */
export function terminalJumpCheck(trajs) {
  const res = trajs.map((u) => {
    const inc = u.y.slice(1).map((v, i) => v - u.y[i]);
    const body = inc.slice(0, -1), s = Math.sqrt(mean(body.map((d) => d * d)));
    return { id: u.id, lastInc: inc[inc.length - 1], sigma: s, jump: inc[inc.length - 1] > 4 * s };
  });
  return { units: res, share: res.filter((r) => r.jump).length / res.length };
}

/**
 * Banc d'essai complet : 3 modèles appris sur TRAIN, sélection sur VALIDATION (RMSE), score final sur TEST.
 * `split` = { train:[ids], validation:[ids], test:[ids] } — séparation par unité.
 */
export function rulBenchmark(trajs, split, { threshold, direction = 'up', ref = null, unit = 'h', kind = 'exp', fractions = [0.5, 0.7, 0.9] }) {
  const S = (ids) => trajs.filter((u) => ids.includes(u.id));
  const train = S(split.train), val = S(split.validation), test = S(split.test);
  const models = {
    degradation: new ExpDegradationModel({ threshold, direction, ref, kind, unit }).fit(train),
    survival: new SurvivalRULModel({ threshold, direction, unit }).fit(train),
    baseline: { predict: (t, y) => linearBaselineRUL(t, y, { threshold, direction, unit }) },
  };
  const names = { degradation: models.degradation.predict(train[0].t, train[0].y).method, survival: models.survival.predict([1]).method, baseline: 'Extrapolation linéaire (baseline, scripts fournis)' };
  const results = {};
  for (const k of Object.keys(models)) {
    const v = evaluateRUL(models[k], val, { fractions }), te = evaluateRUL(models[k], test, { fractions });
    results[k] = { name: names[k], val: { mae: v.mae, rmse: v.rmse, coverage: v.coverage }, test: { mae: te.mae, rmse: te.rmse, coverage: te.coverage, phm: te.phmScore, rows: te.rows } };
  }
  const chosen = Object.keys(results).filter((k) => Number.isFinite(results[k].val.rmse)).sort((a, b) => results[a].val.rmse - results[b].val.rmse)[0];
  return { split, results, chosen, models, jump: terminalJumpCheck(train.concat(val, test)), unit, threshold };
}
