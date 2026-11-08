// =============================================================================
// anomaly.js — détection d'anomalies (§9.1 du cahier des charges).
//  - Référence simple : seuils physiques documentés (ici valeurs de démonstration)
//  - Statistiques glissantes : z-score robuste (médiane / MAD) CONTEXTUEL
//    (référence calculée par mode opératoire sur la fenêtre d'apprentissage uniquement)
//  - Isolation Forest (non supervisé) sur caractéristiques sélectionnées
//  - Détection de capteur figé (variance nulle glissante)
//  - Filtre de persistance (k échantillons consécutifs) : anomalie persistante ≠ variation ponctuelle
//  - Évaluation : précision, rappel, F1, taux de fausses alertes, délai de détection
// =============================================================================
import { median, mad, mean, std, mulberry32 } from './stats.js';

// ------------------------------------------------------------ Isolation Forest
function cFactor(n) { return n <= 1 ? 0 : 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n; }
function buildTree(X, idx, depth, maxDepth, rand) {
  if (depth >= maxDepth || idx.length <= 1) return { size: idx.length };
  const d = X[0].length, q = Math.floor(rand() * d);
  let mn = Infinity, mx = -Infinity;
  for (const i of idx) { const v = X[i][q]; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (mn === mx) return { size: idx.length };
  const p = mn + rand() * (mx - mn), L = [], R = [];
  for (const i of idx) (X[i][q] < p ? L : R).push(i);
  return { q, p, l: buildTree(X, L, depth + 1, maxDepth, rand), r: buildTree(X, R, depth + 1, maxDepth, rand) };
}
function pathLen(x, node, depth) {
  if (node.size !== undefined) return depth + cFactor(node.size);
  return pathLen(x, x[node.q] < node.p ? node.l : node.r, depth + 1);
}
export class IsolationForest {
  constructor({ nTrees = 100, sampleSize = 256, seed = 7 } = {}) { Object.assign(this, { nTrees, sampleSize, seed }); }
  fit(X) {
    const rand = mulberry32(this.seed), n = X.length, psi = Math.min(this.sampleSize, n);
    this.psi = psi; this.trees = [];
    const maxDepth = Math.ceil(Math.log2(psi));
    for (let t = 0; t < this.nTrees; t++) {
      // sous-échantillon SANS remise (Liu, Ting & Zhou 2008) — mélange de Fisher–Yates partiel
      const pool = Array.from({ length: n }, (_, i) => i);
      for (let k = 0; k < psi; k++) { const j = k + Math.floor(rand() * (n - k)); [pool[k], pool[j]] = [pool[j], pool[k]]; }
      const idx = pool.slice(0, psi);
      this.trees.push(buildTree(X, idx, 0, maxDepth, rand));
    }
    return this;
  }
  /** Score d'anomalie s ∈ (0,1) : ~0.5 normal, → 1 anomalie. */
  score(X) {
    const c = cFactor(this.psi);
    return X.map((x) => { let h = 0; for (const tr of this.trees) h += pathLen(x, tr, 0); return 2 ** (-(h / this.trees.length) / c); });
  }
}

// ------------------------------------------------------------ détecteurs élémentaires
/**
 * z-score robuste contextuel : référence (médiane, MAD) par contexte fin (ex. « mode|terrain »),
 * repli sur un contexte grossier (ex. « mode ») puis global si < minN échantillons d'apprentissage.
 * Les références sont apprises sur `trainMask` UNIQUEMENT (pas de fuite).
 * Option `reference` : tableau de covariable (ex. température ambiante) → z du RÉSIDU d'une régression
 * linéaire apprise sur le train (écart à une référence nominale).
 */
export function robustZ(values, { trainMask, context = null, coarse = null, minN = 10, reference = null }) {
  let v0 = values, refModel = null;
  if (reference) {
    const xs = [], ys = [];
    values.forEach((x, i) => { if (trainMask[i] && Number.isFinite(x) && Number.isFinite(reference[i])) { xs.push(reference[i]); ys.push(x); } });
    const n = xs.length, mx = mean(xs), my = mean(ys);
    let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
    const b = sxx ? sxy / sxx : 0, a = my - b * mx; refModel = { a, b };
    v0 = values.map((x, i) => (Number.isFinite(x) && Number.isFinite(reference[i]) ? x - (a + b * reference[i]) : NaN));
  }
  const floorOf = (m) => 1e-3 + 0.005 * Math.abs(m);
  const build = (keys) => {
    const ref = {};
    if (!keys) return ref;
    const groups = {};
    v0.forEach((x, i) => { if (trainMask[i] && Number.isFinite(x)) (groups[keys[i]] ||= []).push(x); });
    for (const k in groups) if (groups[k].length >= minN) { const m = median(groups[k]); ref[k] = { med: m, mad: Math.max(mad(groups[k]), floorOf(m)), n: groups[k].length }; }
    return ref;
  };
  const refFine = build(context), refCoarse = build(coarse);
  const glob = v0.filter((x, i) => trainMask[i] && Number.isFinite(x));
  const gm = median(glob);
  const g = { med: gm, mad: Math.max(mad(glob), floorOf(gm)), n: glob.length };
  const used = [];
  const z = v0.map((x, i) => {
    if (!Number.isFinite(x)) { used.push(null); return null; }
    let r = context && refFine[context[i]], lvl = context ? context[i] : 'global';
    if (!r && coarse) { r = refCoarse[coarse[i]]; lvl = coarse[i]; }
    if (!r) { r = g; lvl = 'global'; }
    used.push(lvl); return (x - r.med) / r.mad;
  });
  return { z, ref: refFine, refCoarse, global: g, used, refModel };
}
/** Détection de valeur figée : écart-type glissant nul sur `win` échantillons. */
export function stuckDetector(values, win = 8, eps = 1e-9) {
  const out = new Array(values.length).fill(0);
  for (let i = win - 1; i < values.length; i++) {
    const w = values.slice(i - win + 1, i + 1);
    if (w.every(Number.isFinite) && Math.max(...w) - Math.min(...w) <= eps) for (let k = i - win + 1; k <= i; k++) out[k] = 1;
  }
  return out;
}
/** Filtre de persistance : ne garde que les alarmes présentes sur ≥ k échantillons consécutifs. */
export function persist(flags, k = 2) {
  const out = new Array(flags.length).fill(0);
  let run = 0;
  for (let i = 0; i < flags.length; i++) {
    run = flags[i] ? run + 1 : 0;
    if (run >= k) for (let j = i - run + 1; j <= i; j++) out[j] = 1;
  }
  return out;
}
/** Seuils physiques (valeurs de démonstration éditables). */
export function thresholdFlags(values, th) {
  return values.map((x) => {
    if (!Number.isFinite(x) || !th) return 0;
    if ((th.fault !== undefined && x >= th.fault) || (th.fault_low !== undefined && x <= th.fault_low)) return 2;
    if ((th.warn !== undefined && x >= th.warn) || (th.warn_low !== undefined && x <= th.warn_low)) return 1;
    return 0;
  });
}

// ------------------------------------------------------------ évaluation
/** Segments contigus de 1 dans un vecteur binaire. */
export function segments(flags, t) {
  const segs = []; let s = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && flags[i]) { if (s < 0) s = i; }
    else if (s >= 0) { segs.push({ i0: s, i1: i - 1, t0: t ? t[s] : s, t1: t ? t[i - 1] : i - 1 }); s = -1; }
  }
  return segs;
}
/**
 * Évalue une détection contre une vérité terrain (disponible UNIQUEMENT pour les données simulées).
 * Niveau échantillon (précision/rappel) + niveau événement (détecté ?, délai).
 */
export function evaluate(pred, truth, t, { evalMask = null, dtHours = 2, mergeGap = 60 } = {}) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < pred.length; i++) {
    if (evalMask && !evalMask[i]) continue;
    const p = !!pred[i], y = !!truth[i];
    if (p && y) tp++; else if (p && !y) fp++; else if (!p && y) fn++; else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : null, recall = tp + fn ? tp / (tp + fn) : null;
  // Les segments de vérité séparés de moins de `mergeGap` h forment UN événement (ex. dérive visible seulement en conduite)
  const rawSegs = segments(truth, t).filter((s) => !evalMask || evalMask[s.i0]);
  const merged = [];
  for (const sg of rawSegs) { const last = merged[merged.length - 1]; if (last && sg.t0 - last.t1 <= mergeGap) { last.i1 = sg.i1; last.t1 = sg.t1; } else merged.push({ ...sg }); }
  const evs = merged.map((s) => {
    let det = null;
    for (let i = s.i0; i <= Math.min(pred.length - 1, s.i1 + 6); i++) if (pred[i]) { det = i; break; }
    return { start: s.t0, end: s.t1, detected: det !== null, delay: det !== null ? t[det] - s.t0 : null };
  });
  const alarmSegs = segments(pred, t).filter((s) => !evalMask || evalMask[s.i0]);
  const falseAlarms = alarmSegs.filter((a) => { for (let i = a.i0; i <= a.i1; i++) if (truth[i]) return false; return true; });
  const hoursEval = (evalMask ? evalMask.filter(Boolean).length : pred.length) * dtHours;
  return {
    tp, fp, fn, tn, precision, recall,
    f1: precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null,
    events: evs, eventsDetected: evs.filter((e) => e.detected).length,
    meanDelay: evs.filter((e) => e.detected).length ? mean(evs.filter((e) => e.detected).map((e) => e.delay)) : null,
    falseAlarms: falseAlarms.length, falseAlarmRatePer1000h: hoursEval ? (falseAlarms.length / hoursEval) * 1000 : null,
    falseAlarmList: falseAlarms.map((a) => ({ start: a.t0, end: a.t1 })),
  };
}

/**
 * Pipeline complet pour une variable : z robuste contextuel + seuils + figé + persistance.
 * Retourne pour chaque échantillon un score [0,1], un drapeau, et la règle déclenchante (explicabilité).
 */
export function detectVariable(values, { t, trainMask, context, coarse = null, reference = null, threshold, zLimit = 6, persistK = 2, stuckWin = 8, checkStuck = false }) {
  const rz = robustZ(values, { trainMask, context, coarse, reference });
  const th = thresholdFlags(values, threshold);
  const stuck = checkStuck ? stuckDetector(values, stuckWin) : values.map(() => 0);
  const raw = values.map((x, i) => (rz.z[i] !== null && Math.abs(rz.z[i]) >= zLimit) || th[i] > 0 || stuck[i] ? 1 : 0);
  const flag = persist(raw, persistK).map((f, i) => (stuck[i] ? 1 : f));
  const score = values.map((x, i) => (rz.z[i] === null ? null : Math.min(1, Math.abs(rz.z[i]) / (2 * zLimit))));
  const rule = values.map((x, i) => {
    if (!flag[i]) return null;
    if (stuck[i]) return 'Valeur figée (variance nulle sur ' + stuckWin + ' échantillons)';
    if (th[i] === 2) return 'Seuil de défaut dépassé';
    if (th[i] === 1) return 'Seuil d\'attention dépassé';
    return `|z robuste| = ${Math.abs(rz.z[i]).toFixed(1)} ≥ ${zLimit} (réf. ${reference ? 'résidu / ambiante, ' : ''}contexte « ${rz.used[i]} »)`;
  });
  return { z: rz.z, ref: rz.ref, used: rz.used, refModel: rz.refModel, th, stuck, flag, score, rule };
}

/** Isolation Forest multivariée : apprentissage sur la fenêtre normale, normalisation (μ, σ) du train seul. */
export function iforestDetect(columns, trainMask, { seed = 7, contamination = 0.01, nTrees = 100 } = {}) {
  const n = columns[0].length, d = columns.length;
  const mu = [], sd = [];
  for (let j = 0; j < d; j++) {
    const v = columns[j].filter((x, i) => trainMask[i] && Number.isFinite(x));
    mu.push(mean(v)); sd.push(std(v) || 1);
  }
  const X = []; const valid = [];
  for (let i = 0; i < n; i++) {
    const row = []; let ok = true;
    for (let j = 0; j < d; j++) { const x = columns[j][i]; if (!Number.isFinite(x)) { ok = false; break; } row.push((x - mu[j]) / sd[j]); }
    if (ok) { X.push(row); valid.push(i); }
  }
  const trainX = X.filter((_, k) => trainMask[valid[k]]);
  const forest = new IsolationForest({ nTrees, seed }).fit(trainX);
  const sTrain = forest.score(trainX).sort((a, b) => a - b);
  const thr = sTrain[Math.min(sTrain.length - 1, Math.floor((1 - contamination) * sTrain.length))];
  const s = forest.score(X);
  const score = new Array(n).fill(null), flag = new Array(n).fill(0);
  valid.forEach((i, k) => { score[i] = s[k]; flag[i] = s[k] > thr ? 1 : 0; });
  return { score, flag: persist(flag, 2), threshold: thr, normalization: { mu, sd }, seed, nTrees };
}
