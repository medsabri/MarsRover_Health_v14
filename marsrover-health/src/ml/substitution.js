// =============================================================================
// substitution.js — régime NON PARAMÉTRIQUE (composant sans dataset propre).
// Construit un « dataset paramétrique dérivé » à partir de sources voisines puis un plan
// de maintenance préventive. TOUT résultat est étiqueté
//      ESTIMÉ PAR SUBSTITUTION — non validé sur le composant réel  (cf. §9.4)
// Hypothèses (affichées dans l'interface) :
//  H1  La FORME de la loi de défaillance (β Weibull) du composant est celle de la source.
//  H2  L'ÉCHELLE est fixée par la durée de vie nominale du composant, interprétée comme
//      L10 (10 % de défaillance — convention des roulements, ISO 281) ou comme MTTF (au choix).
//  H3  La loi de dégradation normalisée (indicateur de santé vs fraction de vie) est celle
//      des trajectoires run-to-failure de la source vibratoire.
//  H4  L'usage (km, cycles, h) est l'horloge de vieillissement ; l'environnement martien n'est pas modélisé.
// =============================================================================
import { weibullMLE, bootstrapWeibull, weibull } from './survival.js';
import { gamma, mulberry32, randn, quantile, mean } from './stats.js';

export function scaleFromLife(life, beta, interpretation = 'L10') {
  return interpretation === 'MTTF' ? life / gamma(1 + 1 / beta) : life / (-Math.log(0.9)) ** (1 / beta);
}

/** Gabarit de dégradation normalisée h(u) = (e^{cu} − 1)/(e^{c} − 1), u = t / T_fin, ajusté par moindres carrés. */
export function fitDegradationTemplate(trajs, threshold) {
  const pts = [];
  for (const tr of trajs) {
    const T = tr.t[tr.t.length - 1];
    const y0 = mean(tr.y.slice(0, Math.min(3, tr.y.length)));
    tr.t.forEach((t, i) => pts.push([t / T, (tr.y[i] - y0) / (threshold - y0)]));
  }
  const H = (u, c) => (Math.abs(c) < 1e-6 ? u : (Math.exp(c * u) - 1) / (Math.exp(c) - 1));
  let best = { c: 1, sse: Infinity };
  for (let c = 0.1; c <= 12; c += 0.05) { const s = pts.reduce((a, [u, h]) => a + (h - H(u, c)) ** 2, 0); if (s < best.sse) best = { c, sse: s }; }
  const res = pts.map(([u, h]) => h - H(u, best.c));
  return { c: best.c, sigma: Math.sqrt(best.sse / pts.length), q05: quantile(res, 0.05), q95: quantile(res, 0.95), H: (u) => H(Math.min(Math.max(u, 0), 1.2), best.c), nPoints: pts.length, nUnits: trajs.length };
}

/**
 * @param comp         configuration du composant (components.json)
 * @param sources      { lifetimes: {times, events, name, provenance, unit}, trajectories: {trajs, threshold, name} }
 * @param opts         { interpretation, Rstar, usageNow, usagePerSol, seed, nDerived, lifeOverride }
 */
export function substitutionPlan(comp, sources, opts = {}) {
  const { interpretation = 'L10', Rstar = 0.9, usageNow = 0, usagePerSol = null, seed = 2026, nDerived = 200 } = opts;
  const L = opts.lifeOverride ?? comp.design_life.value, unit = comp.design_life.unit;
  const out = { label: 'ESTIMÉ PAR SUBSTITUTION — non validé sur le composant réel', provenance: 'substituted', unit, hypotheses: [], warnings: [] };
  if (!L || L <= 0) return { ...out, ok: false, reason: 'Durée de vie nominale non renseignée (valeur à saisir dans le Catalogue).' };
  const lt = sources.lifetimes;
  const w = weibullMLE(lt.times, lt.events);
  if (!w.ok) return { ...out, ok: false, reason: 'Source de durées inexploitable : ' + w.reason };
  const bs = bootstrapWeibull(lt.times, lt.events, 200, seed);
  const beta = w.beta, eta = scaleFromLife(L, beta, interpretation);
  out.source = { name: lt.name, provenance: lt.provenance, beta, betaCI: w.ci ? w.ci.beta : null, betaBoot90: [bs.beta[0], bs.beta[2]], etaSource: w.eta, unitSource: lt.unit, n: w.n, r: w.r };
  out.params = { beta, eta, L, interpretation, Rstar, mttf: weibull.mean(beta, eta), b10: weibull.tAtR(0.9, beta, eta) };
  out.hypotheses.push(`H1 — Forme : β = ${beta.toFixed(2)} estimé (Weibull MLE) sur « ${lt.name} » (${w.r} défaillances / ${w.n}).`);
  out.hypotheses.push(`H2 — Échelle : durée nominale ${L} ${unit} interprétée comme ${interpretation === 'L10' ? 'L10 (10 % de défaillance, convention ISO 281)' : 'MTTF (moyenne)'} ⇒ η = ${eta.toFixed(2)} ${unit}.`);
  // Gabarit de dégradation
  let tpl = null;
  if (sources.trajectories && sources.trajectories.trajs.length >= 2) {
    tpl = fitDegradationTemplate(sources.trajectories.trajs, sources.trajectories.threshold);
    out.template = { c: tpl.c, sigma: tpl.sigma, source: sources.trajectories.name, nUnits: tpl.nUnits };
    out.hypotheses.push(`H3 — Dégradation normalisée h(u) = (e^{${tpl.c.toFixed(2)}u} − 1)/(e^{${tpl.c.toFixed(2)}} − 1) ajustée sur ${tpl.nUnits} trajectoires de « ${sources.trajectories.name} » (σ résiduel = ${tpl.sigma.toFixed(3)}).`);
  }
  out.hypotheses.push(`H4 — Horloge de vieillissement : usage cumulé en ${unit} ; effets environnementaux martiens (froid, poussière, radiations) non modélisés.`);
  // Dataset dérivé (reproductible)
  const rand = mulberry32(seed), rows = [];
  for (let k = 0; k < nDerived; k++) {
    const T = weibull.sample(rand, beta, eta);
    for (let j = 1; j <= 10; j++) {
      const u = j / 10, hi = tpl ? Math.max(0, tpl.H(u) + tpl.sigma * randn(rand)) : null;
      rows.push({ unit: `S${String(k + 1).padStart(3, '0')}`, usage: +(u * T).toFixed(4), HI_norm: hi === null ? '' : +hi.toFixed(4), event: j === 10 ? 1 : 0 });
    }
  }
  out.derived = { rows, columns: ['unit', 'usage', 'HI_norm', 'event'], seed, n: nDerived, note: `Usage en ${unit}. HI_norm = 1 ⇔ seuil de fin de vie de la source.` };
  // État courant
  const a = Math.max(0, usageNow);
  const Ra = weibull.R(a, beta, eta);
  const tMedCond = eta * ((a / eta) ** beta + Math.log(2)) ** (1 / beta);
  const tPM = weibull.tAtR(Rstar, beta, eta);
  out.state = {
    usageNow: a, R: Ra, hazard: weibull.h(Math.max(a, 1e-9), beta, eta), consumedPctOfTPM: (a / tPM) * 100,
    condR: (d) => weibull.R(a + d, beta, eta) / Ra,
    HIest: tpl ? tpl.H(a / tMedCond) : null, tMedCond,
  };
  const frac = a / tPM;
  out.state.verdict = frac < 0.6 ? 'Bon état' : frac < 1 ? 'À surveiller' : 'Dégradé';
  const relWidth = (bs.beta[2] - bs.beta[0]) / beta;
  out.state.confidence = Math.max(0.1, Math.min(0.5, 0.5 - 0.25 * relWidth)); // plafonnée à 0,5 : substitution
  // Plan préventif
  const levels = [0.99, 0.97, 0.95, Rstar].filter((v, i, s) => v >= Rstar && s.indexOf(v) === i).sort((x, y) => y - x);
  const tasks = levels.map((r) => {
    const age = weibull.tAtR(r, beta, eta);
    const isPM = r === Rstar;
    return { R: r, age, remaining: age - a, sol: usagePerSol ? (age - a) / usagePerSol : null, due: age <= a,
      action: isPM ? `Intervention préventive (R = ${r}) : inspection approfondie + mesures conservatoires (déclassement / limitation d'effort / planification d'itinéraire)` : `Inspection planifiée (R = ${r}) : imagerie / contrôle des indicateurs` };
  });
  out.plan = { tPM, tasks, Rstar, usagePerSol };
  // Analyse de sensibilité
  const base = tPM;
  const sens = [];
  const add = (name, lo, hi) => sens.push({ name, lo, hi, base });
  const bLo = bs.beta[0], bHi = bs.beta[2];
  add(`β ∈ [${bLo.toFixed(2)} ; ${bHi.toFixed(2)}] (bootstrap 90 %)`, weibull.tAtR(Rstar, bLo, scaleFromLife(L, bLo, interpretation)), weibull.tAtR(Rstar, bHi, scaleFromLife(L, bHi, interpretation)));
  add('Durée nominale ± 20 %', weibull.tAtR(Rstar, beta, scaleFromLife(0.8 * L, beta, interpretation)), weibull.tAtR(Rstar, beta, scaleFromLife(1.2 * L, beta, interpretation)));
  add('R* ∈ [0,95 ; 0,80]', weibull.tAtR(0.95, beta, eta), weibull.tAtR(0.8, beta, eta));
  const other = interpretation === 'L10' ? 'MTTF' : 'L10';
  const tOther = weibull.tAtR(Rstar, beta, scaleFromLife(L, beta, other));
  add(`Interprétation nominale ${interpretation} ↔ ${other}`, Math.min(base, tOther), Math.max(base, tOther));
  out.sensitivity = sens;
  out.ok = true;
  if (lt.provenance === 'simulated') out.warnings.push('La source de forme est SIMULÉE : la loi dérivée n\'a aucune valeur prédictive physique.');
  out.warnings.push('Modèle issu d\'un banc d\'essai / de données de laboratoire : jamais validé sur un rover réel (cahier des charges §9.4).');
  return out;
}
