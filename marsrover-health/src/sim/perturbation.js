// =============================================================================
// perturbation.js — injection de perturbations sur un signal, effet sur la détection,
// la fiabilité et propagation en cascade dans le graphe de dépendances du rover.
// Modèles de stress (documentés dans l'interface) :
//   - courant / effort : facteur d'accélération AF = (I_pert / I_nom)^3  (loi charge–vie cubique, ISO 281)
//   - température     : AF = exp[(Ea/k)(1/T_nom − 1/T_pert)], Ea = 0,7 eV (valeur de démonstration)
//   - capteur (bruit, valeur figée, intermittent) : AF = 1 (pas de dommage physique) mais détectabilité dégradée
// =============================================================================
import { mulberry32, randn, std, mean } from '../ml/stats.js';

export const TYPES = {
  drift: 'Dérive', noise: 'Bruit', stuck: 'Valeur figée', overload: 'Surcharge', overheat: 'Échauffement',
  voltage_loss: 'Perte de tension', blockage: 'Blocage', intermittent: 'Panne intermittente',
};
const TYPE_SEVERITY = { drift: 0.5, noise: 0.3, stuck: 0.4, overload: 0.8, overheat: 0.7, voltage_loss: 0.8, blockage: 1.0, intermittent: 0.6 };

export function perturb(values, t, { type, intensity, start, duration, seed = 5, sigma, isTemp = false, isCurrent = false, isVoltage = false }) {
  const rand = mulberry32(seed), out = values.slice(), s = sigma || std(values.filter(Number.isFinite)) || 1;
  const end = start + duration;
  let held = null;
  for (let i = 0; i < t.length; i++) {
    if (t[i] < start || t[i] > end || !Number.isFinite(values[i])) continue;
    const u = (t[i] - start) / Math.max(duration, 1e-9), x = values[i];
    switch (type) {
      case 'drift': out[i] = x + intensity * 8 * s * u; break;
      case 'noise': out[i] = x + intensity * 4 * s * randn(rand); break;
      case 'stuck': if (held === null) held = x; out[i] = held; break;
      case 'overload': out[i] = isCurrent ? x * (1 + 1.5 * intensity) + (x > 0.1 ? 0 : 0) : x + intensity * 6 * s; break;
      case 'overheat': out[i] = isTemp ? x + intensity * 35 * (1 - Math.exp(-u * 4)) : x + intensity * 5 * s * (1 - Math.exp(-u * 4)); break;
      case 'voltage_loss': out[i] = isVoltage ? x - intensity * 6 : x * (1 - 0.5 * intensity); break;
      case 'blockage': out[i] = isCurrent ? Math.max(x, 0.2) * (1 + 2.5 * intensity) : x + intensity * 10 * s; break;
      case 'intermittent': if (rand() < 0.15 + 0.35 * intensity) out[i] = rand() < 0.5 ? NaN : x + (rand() < 0.5 ? -1 : 1) * intensity * 10 * s; break;
      default: break;
    }
  }
  return out;
}
export function accelerationFactor(orig, pert, t, { start, duration, isTemp, isCurrent, type }) {
  const idx = t.map((x, i) => i).filter((i) => t[i] >= start && t[i] <= start + duration && Number.isFinite(orig[i]) && Number.isFinite(pert[i]));
  if (!idx.length || ['noise', 'stuck', 'intermittent'].includes(type)) return { AF: 1, model: 'défaut capteur : pas de dommage physique (AF = 1)' };
  if (isCurrent) { const a = mean(idx.map((i) => Math.abs(orig[i]))), b = mean(idx.map((i) => Math.abs(pert[i]))); return { AF: a > 1e-6 ? Math.max(1, (b / a) ** 3) : 1, model: 'AF = (I_pert/I_nom)^3' }; }
  if (isTemp) { const k = 8.617e-5, Ea = 0.7; const Tn = mean(idx.map((i) => orig[i])) + 273.15, Tp = mean(idx.map((i) => pert[i])) + 273.15; return { AF: Math.max(1, Math.exp((Ea / k) * (1 / Tn - 1 / Tp))), model: 'Arrhenius Ea = 0,7 eV (démo)' }; }
  return { AF: 1 + TYPE_SEVERITY[type] * 0.5, model: 'facteur forfaitaire 1 + 0,5·sévérité (démo)' };
}

/** Propagation en cascade (parcours en largeur, impact = impact parent × poids de dépendance). */
export function propagate(source, severity, deps, comps) {
  const impact = { [source]: severity }, level = { [source]: 0 }, via = {}, effects = {};
  const q = [source];
  while (q.length) {
    const u = q.shift();
    for (const d of deps.filter((x) => x.from === u)) for (const v of d.to) {
      const val = impact[u] * d.weight;
      if (val < 0.05 || (impact[v] !== undefined && impact[v] >= val)) continue;
      impact[v] = val; level[v] = level[u] + 1; via[v] = u; effects[v] = d.effect; q.push(v);
    }
  }
  const W = { high: 3, medium: 2, low: 1 };
  const byId = Object.fromEntries(comps.map((c) => [c.id, c]));
  const fnMap = { 'Mobilité': 'Mobilité', 'Capteurs': 'Mobilité', 'Structure': 'Mobilité', 'Énergie': 'Énergie', 'Thermique': 'Énergie', 'Communications': 'Communication', 'Électronique': 'Communication', 'Bras & outils': 'Science' };
  const functions = { 'Mobilité': 0, 'Énergie': 0, 'Communication': 0, 'Science': 0 };
  for (const [id, v] of Object.entries(impact)) { const f = fnMap[byId[id].subsystem]; functions[f] = 1 - (1 - functions[f]) * (1 - v * (W[byId[id].criticality] || 1) / 3); }
  const risk = 1 - Object.entries(impact).reduce((p, [id, v]) => p * (1 - 0.35 * v * (W[byId[id].criticality] || 1) / 3), 1); // 0,35 : pondération de démonstration
  const cascade = Object.keys(impact).sort((a, b) => level[a] - level[b] || impact[b] - impact[a]).map((id) => ({ id, name: byId[id].name, level: level[id], impact: impact[id], via: via[id] ? byId[via[id]].name : '—', effect: effects[id] || 'Perturbation injectée' }));
  return { impact, cascade, functions, risk };
}
export const typeSeverity = (type, intensity) => Math.min(1, TYPE_SEVERITY[type] * (0.4 + 0.6 * intensity) + 0.1);
