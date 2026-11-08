// =============================================================================
// Tests de perturbation — avant/après, détection, fiabilité/RUL, propagation 3D, scénarios.
// =============================================================================
import { icon, h, append, clear, fmt, pct, badge, statusEl, panel, kpi, toCSV, download, toast } from '../core/dom.js';
import { state, persist, log } from '../core/store.js';
import { components, component, dependencies } from '../core/data.js';
import { tel, detect, isTemp, isCurrent, substitution, rulBattery, TRAIN_END_H } from '../core/analysis.js';
import { detectVariable } from '../ml/anomaly.js';
import { weibull } from '../ml/survival.js';
import { TYPES, perturb, accelerationFactor, propagate, typeSeverity } from '../sim/perturbation.js';
import { ChartBag, chartBox, lineChart, barChart } from '../core/charts.js';
import { loadDefaultModel, createInstance, applyStatus } from '../three/rover.js';
import { Viewer } from '../three/viewer.js';

const bag = new ChartBag(); let viewer = null, inst = null;
let P = { comp: 'motor_3', variable: null, type: 'overload', intensity: 0.6, duration: 60, start: 2200 };
let last = null;
export default {
  mount(app, params) { if (params.c) { P.comp = params.c; P.variable = null; } render(app); },
  unmount() { bag.destroy(); if (viewer) viewer.dispose(); viewer = null; inst = null; },
};
// couleurs distinctes par fonction (palette catégorielle validée, ordre fixe)
const FN_COLORS = ['#2563EB', '#E8590C', '#0D9488', '#9333EA', '#DB2777', '#65A30D', '#0284C7', '#B45309'];
function varsOf(c) { const v = c.dataset && c.dataset.id === 'rover_telemetry_sim' ? c.dataset.variables : (c.dataset && c.dataset.telemetry) || []; return v.length ? v : c.substitution && c.substitution.proxy_indicator ? [c.substitution.proxy_indicator] : []; }

function render(app) {
  bag.destroy(); if (viewer) { viewer.dispose(); viewer = null; } clear(app);
  const T = tel(), c = component(P.comp), vars = varsOf(c);
  if (!P.variable || !vars.includes(P.variable)) P.variable = vars[0] || null;
  append(app, h('div.view-head.pt-head', h('h1', 'Tests de perturbation des composants'), h('div', { id: 'pt-top' })));  // résultats dans l'en-tête
  const g = h('div.grid'); app.append(g);
  const num = (k, min, max, step, label, unit) => h('label.field', `${label} : ${P[k]} ${unit}`, h('input', { type: 'range', min, max, step, value: P[k], 'aria-label': label, on: { input: (e) => { P[k] = +e.target.value; e.target.parentElement.firstChild.textContent = `${label} : ${P[k]} ${unit}`; }, change: () => run(app) } }));
  const left = h('div.c4.pt-left'); g.append(left);
  left.append(panel('Scénario', {},
    h('div', { style: { display: 'grid', gap: '8px' } },
      h('label.field', 'Composant', h('select.inp', { on: { change: (e) => { P.comp = e.target.value; P.variable = null; render(app); } } }, components().map((x) => h('option', { value: x.id, selected: x.id === P.comp }, x.name)))),
      h('label.field', 'Variable perturbée', vars.length ? h('select.inp', { on: { change: (e) => { P.variable = e.target.value; run(app); } } }, vars.map((v) => h('option', { value: v, selected: v === P.variable }, v + (c.substitution && v === c.substitution.proxy_indicator ? ' (indicateur associé)' : '')))) : h('div.small.muted', 'Aucune variable : seule la propagation est évaluée.')),
      h('label.field', 'Type de perturbation', h('select.inp', { on: { change: (e) => { P.type = e.target.value; run(app); } } }, Object.entries(TYPES).map(([k, l]) => h('option', { value: k, selected: k === P.type }, l)))),
      num('intensity', 0.05, 1, 0.05, 'Intensité', ''), num('duration', 4, 400, 2, 'Durée', 'h'), num('start', TRAIN_END_H, T ? T.tmax - 4 : 2900, 2, 'Début', 'h'),
      h('button.btn.primary', { on: { click: () => run(app) } }, icon('play'), 'Lancer le test'),
      h('button.btn', { on: { click: () => saveScenario(app) } }, icon('save'), 'Sauvegarder le scénario'))));
  left.append(h('div', { id: 'pt-side', style: { display: 'grid', gap: '12px' } }));
  const res = h('div.c8', { id: 'pt-res', style: { display: 'grid', gap: '12px', alignContent: 'start' } }); g.append(res);
  g.append(scenariosPanel(app));
  run(app);
}

function run(app) {
  bag.destroy(); if (viewer) { viewer.dispose(); viewer = null; }
  const res = document.getElementById('pt-res'); if (!res) return; clear(res);
  const top = document.getElementById('pt-top'), side = document.getElementById('pt-side'); clear(top); clear(side);
  const T = tel(), c = component(P.comp);
  let sig = null;
  if (P.variable && T) {
    const v = P.variable, base = detect(v);
    const sigma = base.ref && Object.values(base.ref)[0] ? Object.values(base.ref)[0].mad : null;
    const pv = perturb(base.values, T.t, { ...P, seed: 5, sigma, isTemp: isTemp(v), isCurrent: isCurrent(v), isVoltage: /voltage/.test(v) });
    const d2 = detectVariable(pv, { t: T.t, trainMask: T.train, context: T.ctx, coarse: T.op, reference: isTemp(v) && v !== 'avionics_temp_C' ? T.amb : null, threshold: base.threshold, checkStuck: true });
    const win = T.t.map((x, i) => i).filter((i) => T.t[i] >= P.start && T.t[i] <= P.start + P.duration);
    const firstAfter = win.find((i) => d2.flag[i] && !base.flag[i]) ?? win.find((i) => d2.flag[i]);
    const flaggedBefore = win.filter((i) => base.flag[i]).length, flaggedAfter = win.filter((i) => d2.flag[i]).length;
    const af = accelerationFactor(base.values, pv, T.t, { ...P, isTemp: isTemp(v), isCurrent: isCurrent(v) });
    sig = { v, base, d2, pv, win, detected: firstAfter !== undefined, delay: firstAfter !== undefined ? T.t[firstAfter] - P.start : null, flaggedBefore, flaggedAfter, af, rule: firstAfter !== undefined ? d2.rule[firstAfter] : null };
    // graphiques avant / après
    const x0 = Math.max(0, P.start - 150), x1 = Math.min(T.tmax, P.start + P.duration + 150);
    const idx = T.t.map((x, i) => i).filter((i) => T.t[i] >= x0 && T.t[i] <= x1);
    const { box, canvas } = chartBox(); const { box: b2, canvas: c2 } = chartBox('short');
    res.append(panel(`Avant / après — ${v}`, { badges: [badge('simulated')] }, box, b2));
    requestAnimationFrame(() => {
      bag.add(lineChart(canvas, [{ label: 'avant (télémétrie simulée)', data: idx.map((i) => ({ x: T.t[i], y: Number.isFinite(base.values[i]) ? base.values[i] : null })), color: '#2563EB', width: 1.2 }, { label: `après (${TYPES[P.type]}, intensité ${P.intensity})`, data: idx.map((i) => ({ x: T.t[i], y: Number.isFinite(pv[i]) ? pv[i] : null })), color: '#C2410C', width: 1.4 }],
        { xLabel: 'temps (h)', yLabel: v, bands: [{ x0: P.start, x1: P.start + P.duration, color: 'rgba(194,65,12,.12)', label: 'fenêtre perturbée', textColor: '#C2410C' }], vlines: sig.detected ? [{ x: P.start + sig.delay, label: `détection +${fmt(sig.delay, 0)} h`, color: '#16A34A' }] : [] }));
      bag.add(lineChart(c2, [{ label: '|z| avant', data: idx.map((i) => ({ x: T.t[i], y: base.z[i] === null ? null : Math.abs(base.z[i]) })), color: '#2563EB', width: 1 }, { label: '|z| après', data: idx.map((i) => ({ x: T.t[i], y: d2.z[i] === null ? null : Math.abs(d2.z[i]) })), color: '#7C3AED', width: 1.2 }, { label: 'alerte après (1 = oui)', data: idx.map((i) => ({ x: T.t[i], y: d2.flag[i] * 10 })), color: '#DC2626', step: true, width: 1 }], { xLabel: 'temps (h)', yLabel: 'score d\'anomalie', hlines: [{ y: 6, label: 'seuil |z| = 6' }], yMax: 40 }));
    });
  }
  // fiabilité / RUL avant-après
  const AF = sig ? sig.af.AF : 1 + typeSeverity(P.type, P.intensity) * 0.5;
  const rel = []; let rulTxt = null;
  const sub = c.substitution ? substitution(c.id) : null;
  if (sub && sub.ok) {
    const rate = sub.plan.usagePerSol || 0, dUse = (P.duration / 24.66) * rate * (AF - 1);
    const Rb = sub.state.R, Ra = weibull.R(sub.state.usageNow + dUse, sub.params.beta, sub.params.eta);
    rel.push(['R(usage) avant → après', `${pct(Rb, 1)} → ${pct(Ra, 1)}`, `âge d'intervention avancé de ${fmt(dUse, 3)} ${sub.unit}`]);
  }
  if (c.id === 'battery') { const r = rulBattery().current; const lost = (P.duration / 24.66) * (AF - 1); rulTxt = `RUL batterie : ${fmt(r.value, 0)} → ${fmt(Math.max(0, r.value - lost), 0)} cycles (≈ 1 cycle/sol × (AF − 1) × durée)`; }
  // propagation
  const sev = typeSeverity(P.type, P.intensity) * (sig && !sig.detected ? 1.15 : 1);
  const pr = propagate(P.comp, Math.min(1, sev), dependencies(), components());
  last = { P: { ...P }, detected: sig ? sig.detected : null, delay: sig ? sig.delay : null, AF, risk: pr.risk, functions: pr.functions, n: pr.cascade.length, ts: new Date().toISOString() };
  state.perturbImpact = last;
  log('Test de perturbation', { ...P, AF: +AF.toFixed(3), detected: last.detected, risk: +pr.risk.toFixed(3) });
  // cartes de résultats intégrées à l'en-tête (couleur distincte par indicateur)
  const why = [sig && sig.rule ? `Règle déclenchante : ${sig.rule}` : sig ? 'Non détecté : perturbation dans la variabilité du contexte de référence.' : '', rulTxt || ''].filter(Boolean).join('\n');
  const cards = [
    ['blue', 'Détection', sig ? (sig.detected ? 'OUI' : 'NON') : 'sans objet', sig && sig.rule ? sig.rule : ''],
    ['green', 'Délai de détection', sig && sig.detected ? `${fmt(sig.delay, 0)} h` : '—', ''],
    ['violet', 'Échantillons en alerte', sig ? `${sig.flaggedBefore} → ${sig.flaggedAfter}` : '—', 'fenêtre perturbée'],
    ['amber', 'Facteur d\'accélération', fmt(AF, 2), sig ? sig.af.model : 'forfaitaire'],
    ['red', 'Risque global', pct(pr.risk, 0), 'propagation'],
    ...rel.map((r) => ['teal', ...r]),
  ];
  top.append(h('div.pt-kpis', { role: 'status', 'aria-label': 'Résultats du test', title: why }, cards.map(([tone, k, v, sub]) => h(`div.pt-kpi.${tone}`, h('span.k', k), h('b', v), sub ? h('span.s', sub) : null))));
  // 3D + cascade
  const stage = h('div.mini3d'); const { box: bf, canvas: cf } = chartBox('short');
  side.append(panel('Propagation sur le rover (3D)', { badges: [badge('simulated')] }, stage, h('div.small.muted', 'Couleur : impact (vert faible → rouge fort). Pièces grises : non affectées.')),
    panel('Impact fonctionnel', {}, bf, h('div.small.muted', 'Agrégation 1 − Π(1 − impact × poids de criticité) par fonction.')));
  requestAnimationFrame(() => bag.add(barChart(cf, Object.keys(pr.functions), [{ label: 'impact', data: Object.values(pr.functions).map((x) => x * 100), colors: Object.keys(pr.functions).map((k, i) => FN_COLORS[i % FN_COLORS.length]) }], { yLabel: '%', yMax: 100, legend: false })));
  res.append(panel('Effets en cascade', {}, h('div.tbl-wrap', h('table.tbl', h('thead', h('tr', h('th.num', 'Niveau'), h('th', 'Composant'), h('th', 'Via'), h('th', 'Effet'), h('th.num', 'Impact'))), h('tbody', pr.cascade.map((r) => h('tr', h('td.num', r.level), h('td', r.name), h('td', r.via), h('td', r.effect), h('td.num', pct(r.impact, 0))))))),
    h('div.row', { style: { marginTop: '6px' } }, h('button.btn.sm', { on: { click: () => download('perturbation_cascade.csv', toCSV(pr.cascade)) } }, icon('download'), 'CSV'), h('button.btn.sm', { on: { click: () => download('perturbation_resultat.json', JSON.stringify({ ...last, cascade: pr.cascade, provenance: 'simulated' }, null, 2), 'application/json') } }, icon('download'), 'JSON'))));
  loadDefaultModel().then(() => {
    if (!document.body.contains(stage)) return;
    viewer = new Viewer(stage, { fpsEl: false }); inst = createInstance(); viewer.scene.add(inst.root); viewer.frame(inst.box, 1.0);
    const imp = {}; components().forEach((x) => (imp[x.id] = pr.impact[x.id] ?? undefined));
    applyStatus(inst, {}, { impact: Object.fromEntries(Object.entries(pr.impact)) });
  });
}
function saveScenario(app) {
  if (!last) return;
  const name = `${component(last.P.comp).name} · ${TYPES[last.P.type]} ${last.P.intensity} · ${last.P.duration} h`;
  state.scenarios.unshift({ name, ...last }); state.scenarios = state.scenarios.slice(0, 30); persist('scenarios');
  toast('Scénario sauvegardé', 'ok'); render(app);
}
function scenariosPanel(app) {
  const S = state.scenarios; const { box, canvas } = chartBox('short');
  if (S.length) requestAnimationFrame(() => bag.add(barChart(canvas, S.map((s, i) => `#${i + 1}`), [{ label: 'Risque global (%)', data: S.map((s) => s.risk * 100), color: '#DC2626' }, { label: 'AF', data: S.map((s) => s.AF), color: '#2563EB' }], {})));
  return panel(`Scénarios sauvegardés (${S.length})`, { cls: 'c12' }, S.length ? box : h('div.small.muted', 'Aucun scénario : lancez un test puis « Sauvegarder ».'),
    S.length ? h('div.tbl-wrap', h('table.tbl', h('thead', h('tr', h('th', '#'), h('th', 'Scénario'), h('th', 'Détecté'), h('th.num', 'Délai (h)'), h('th.num', 'AF'), h('th.num', 'Risque'), h('th', ''))),
      h('tbody', S.map((s, i) => h('tr', h('td', `#${i + 1}`), h('td', s.name), h('td', s.detected === null ? '—' : s.detected ? 'oui' : 'non'), h('td.num', fmt(s.delay, 0)), h('td.num', fmt(s.AF, 2)), h('td.num', pct(s.risk, 0)), h('td', h('button.btn.sm', { on: { click: () => { P = { ...s.P }; render(app); } } }, 'Rejouer'))))))) : null,
    S.length ? h('div.row', { style: { marginTop: '6px' } }, h('button.btn.sm', { on: { click: () => download('scenarios.csv', toCSV(S.map((s) => ({ name: s.name, ...s.P, detected: s.detected, delay: s.delay, AF: s.AF, risk: s.risk, ts: s.ts })))) } }, icon('download'), 'Exporter (CSV)'), h('button.btn.sm', { on: { click: () => { state.scenarios = []; persist('scenarios'); render(app); } } }, 'Effacer')) : null);
}
