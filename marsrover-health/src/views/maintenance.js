// =============================================================================
// Maintenance préventive par composant — régime paramétrique (données propres) ou
// non paramétrique (dataset dérivé PAR SUBSTITUTION à partir de sources voisines).
// =============================================================================
import { icon, h, append, clear, fmt, pct, badge, demoBadge, statusEl, panel, kpi, toCSV, download, esc } from '../core/dom.js';
import { state, set, on, log, persist } from '../core/store.js';
import { components, component, lifetimeDatasets, setOverride } from '../core/data.js';
import { componentState, substitution, usageAt, usagePerSol, tel, detect, rulBattery, alerts, cursor } from '../core/analysis.js';
import { weibull } from '../ml/survival.js';
import { ChartBag, chartBox, lineChart, barChart, gantt } from '../core/charts.js';

const bag = new ChartBag(); let unsub = [], sel = null, opts = {};
const SOL = 24.66;
export default {
  mount(app, params) { sel = params.c || sel || 'wheel_3'; render(app); unsub.push(on('change', (k) => { if (['overrides', 'settings', 'cursorTime', 'terrainImpact'].includes(k)) render(app); })); },
  unmount() { bag.destroy(); unsub.forEach((u) => u()); unsub = []; },
};
function render(app) {
  bag.destroy(); clear(app);
  append(app, h('div.view-head', h('div', h('h1', 'Maintenance préventive par composant'))));
  const grid = h('div.grid'); app.append(grid);
  const list = h('div.comp-list');
  for (const c of components()) {
    const s = componentState(c.id);
    list.append(h(`button.comp-item${c.id === sel ? '.sel' : ''}`, { 'aria-pressed': c.id === sel, on: { click: () => { sel = c.id; opts = {}; render(app); } } },
      h('span', c.name), h('span.row', h('span.pill', s.regime.startsWith('param') ? 'param.' : s.regime.startsWith('non') ? 'subst.' : '∅'), statusEl(s.status))));
  }
  grid.append(panel('Composants', { cls: 'c3' }, h('div.small.muted', { style: { marginBottom: '6px' } }, 'param. = paramétrique · subst. = substitution · ∅ = aucune donnée'), list));
  const right = h('div.c9', { style: { display: 'grid', gap: '12px' } }); grid.append(right);
  const c = component(sel), s = componentState(sel);
  right.append(panel(`${c.name} — ${s.regime}`, { badges: [statusEl(s.status), badge(s.provenance)] },
    h('div.kpis', kpi('Verdict', verdict(s)), kpi('Confiance', pct(s.confidence, 0)), kpi('Usage consommé', fmt(usageAt(c).total, 2), c.design_life.unit), kpi('Durée nominale', fmt(c.design_life.value, 2), c.design_life.unit, demoBadge(c.design_life.source)), kpi('Rythme d\'usage', fmt(usagePerSol(c), 3), `${c.design_life.unit}/sol`)),
    h('ul.small', { style: { margin: '8px 0 0', paddingLeft: '18px' } }, s.reasons.map((r) => h('li', r)))));
  if (c.dataset && c.dataset.parametric) parametric(right, c, s);
  else if (c.substitution) nonParametric(right, c, app);
  else right.append(panel('Données insuffisantes', {}, h('div.nc-box', 'Ni dataset propre ni source de substitution pertinente : aucun plan basé sur les données ne peut être produit. Recommandation : définir les variables à instrumenter (tension/puissance de sortie, températures, courants) et importer un dataset dans « Données & provenance ». Seules les inspections calendaires de démonstration ci-dessous s\'appliquent.'), calendarGantt(c, [])));
}
function verdict(s) { if (s.subst) return s.subst.state.verdict; return { ok: 'Bon état', nodata: 'Indéterminé' }[s.status] || (['fault', 'overtemp', 'overload'].includes(s.status) ? 'Dégradé' : 'À surveiller'); }

// ------------------------------------------------------------------ régime paramétrique
function parametric(right, c, s) {
  const T = tel();
  const vars = c.dataset.id === 'rover_telemetry_sim' ? c.dataset.variables : c.dataset.telemetry || [];
  for (const v of vars) {
    const d = detect(v, c.id); if (!d) continue;
    const { box, canvas } = chartBox('short');
    right.append(panel(`Estimation de l'état par les données — ${v}`, { badges: [badge('simulated')] }, box));
    requestAnimationFrame(() => bag.add(lineChart(canvas, [{ label: v, data: T.t.map((x, i) => ({ x, y: Number.isFinite(d.values[i]) ? d.values[i] : null })), color: '#2563EB', width: 1 }], { xLabel: 'temps (h)', hlines: Object.entries(d.threshold || {}).filter(([k]) => /warn|fault/.test(k)).map(([k, y]) => ({ y, color: /fault/.test(k) ? '#DC2626' : '#D97706', label: k })), vlines: [{ x: cursor() }] })));
  }
  const tasks = [];
  const nowSol = cursor() / SOL;
  const A = alerts().filter((a) => a.component === c.id && a.end >= cursor() - 200);
  if (A.length) tasks.push({ label: 'Vérification conditionnelle (alerte récente)', start: nowSol, end: nowSol + 2, color: '#DC2626', title: A[0].rule });
  if (c.id === 'battery') {
    const rb = rulBattery(), r = rb.current;
    const solsPerCycle = 1; // hypothèse de démonstration : ~1 cycle charge/décharge par sol
    right.append(panel('Pronostic batterie (fin de vie définie : 80 % C0)', { badges: [badge('simulated')] },
      h('div.kpis', kpi('RUL', fmt(r.value, 0), 'cycles'), kpi('IC 90 %', `${fmt(r.ci[0], 0)} – ${fmt(r.ci[1], 0)}`, 'cycles'), kpi('SOH', pct(rb.soh, 1))),
      h('div.small.muted', `Méthode : ${rb.results[rb.chosen].name}. Hypothèse calendaire : 1 cycle ≈ 1 sol (démonstration). L'action préventive est planifiée sur la BORNE BASSE de l'IC (prudence).`)));
    tasks.push({ label: 'Mesures conservatoires : budget énergétique réduit, décharge limitée', start: nowSol + r.ci[0] * solsPerCycle * 0.6, end: nowSol + r.ci[0] * solsPerCycle, color: '#D97706' });
    tasks.push({ label: 'Fenêtre de fin de vie estimée (IC 90 %)', start: nowSol + r.ci[0] * solsPerCycle, end: nowSol + r.ci[1] * solsPerCycle, color: '#DC2626' });
  } else right.append(h('div.infobox', 'RUL masquée : aucune fin de vie n\'est définie pour ce composant. Le plan repose sur la surveillance des indicateurs (alertes) et des inspections calendaires.'));
  right.append(panel('Planning de maintenance préventive (sols)', { badges: [badge('simulated'), demoBadge('intervalles de démonstration')] }, calendarGantt(c, tasks), exportBtns(c, tasks, 'sol')));
}
function calendarGantt(c, extra) {
  const nowSol = cursor() / SOL, every = c.criticality === 'high' ? 10 : c.criticality === 'medium' ? 30 : 60;
  const insp = []; for (let k = Math.ceil(nowSol / every) * every; k < nowSol + 150; k += every) insp.push({ start: k, end: k + 0.8, label: '', color: '#2563EB', title: `Inspection planifiée (tous les ${every} sols, démonstration)` });
  const rows = [{ label: `Inspections calendaires (${every} sols)`, items: insp }, ...extra.map((t) => ({ label: t.label, items: [t] }))];
  return gantt(rows, { min: Math.floor(nowSol), max: Math.max(nowSol + 150, ...extra.map((t) => t.end + 5)), now: nowSol, unit: 'sol' });
}
function exportBtns(c, tasks, unit, plan) {
  return h('div.row', { style: { marginTop: '8px' } },
    h('button.btn.sm', { on: { click: () => download(`plan_${c.id}.csv`, toCSV(tasks.map((t) => ({ composant: c.id, tache: t.label, debut: t.start, fin: t.end, unite: unit, provenance: plan ? 'substituted' : 'simulated' })))) } }, icon('download'), 'Plan CSV'),
    h('button.btn.sm', { on: { click: () => printPlan(c, tasks, unit, plan) } }, icon('print'), 'Plan imprimable / PDF'));
}
function printPlan(c, tasks, unit, plan) {
  const w = window.open('', '_blank'); if (!w) return;
  const lab = plan ? `<p style="color:#7a2fa8;font-weight:700">${esc(plan.label)}</p><h3>Hypothèses</h3><ul>${plan.hypotheses.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p><b>Données SIMULÉES</b> — démonstration.</p>';
  w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Plan ${esc(c.name)}</title><style>body{font:13px sans-serif;margin:24px;color:#0B1F3A}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd;padding:4px 6px;text-align:left}</style></head><body><h1>Plan de maintenance préventive — ${esc(c.name)}</h1><p>MarsRover Health — prototype académique, aide à la décision uniquement. Généré le ${new Date().toLocaleString('fr-FR')}.</p>${lab}<table><tr><th>Tâche</th><th>Début (${unit})</th><th>Fin (${unit})</th></tr>${tasks.map((t) => `<tr><td>${esc(t.label)}</td><td>${fmt(t.start, 1)}</td><td>${fmt(t.end, 1)}</td></tr>`).join('')}</table><script>setTimeout(()=>print(),300)<\/script></body></html>`);
  w.document.close();
}

// ------------------------------------------------------------------ régime non paramétrique (substitution)
function nonParametric(right, c, app) {
  const p = substitution(c.id, opts);
  const srcs = lifetimeDatasets().filter((d) => c.substitution.sources.includes(d.id));
  const ctrl = h('div.form-grid',
    h('label.field', 'Source de la forme de loi (β)', h('select.inp', { on: { change: (e) => { opts.shapeSource = e.target.value; render(app); } } }, srcs.map((d) => h('option', { value: d.id, selected: d.id === (opts.shapeSource || p.shapeSource) }, `${d.name} (${d.prov})`)))),
    h('label.field', 'Interprétation de la durée nominale', h('select.inp', { on: { change: (e) => { state.settings.lifeInterpretation = e.target.value; persist('settings'); set('settings', state.settings); } } }, ['L10', 'MTTF'].map((v) => h('option', { value: v, selected: state.settings.lifeInterpretation === v }, v === 'L10' ? 'L10 (10 % de défaillance, ISO 281)' : 'MTTF (moyenne)')))),
    h('label.field', 'Fiabilité cible R* de l\'intervention', h('select.inp', { on: { change: (e) => { state.settings.Rstar = +e.target.value; persist('settings'); set('settings', state.settings); } } }, [0.99, 0.97, 0.95, 0.9, 0.8].map((v) => h('option', { value: v, selected: state.settings.Rstar === v }, String(v))))),
    h('label.field', `Durée nominale (${c.design_life.unit})`, h('input.inp', { type: 'number', value: c.design_life.value, min: 0, step: 'any', on: { change: (e) => setOverride(c.id, { design_life: { value: +e.target.value } }) } })));
  right.append(panel('Paramètres de la substitution', { badges: [badge('substituted')] }, ctrl));
  if (!p.ok) { right.append(panel('Substitution impossible', {}, h('div.nc-box', p.reason))); return; }
  // Dataset dérivé + loi
  const { box, canvas } = chartBox();
  const tmax = Math.max(p.plan.tPM * 2, p.state.usageNow * 1.5, p.params.mttf * 1.6);
  requestAnimationFrame(() => bag.add(lineChart(canvas, [
    { label: `R(t) dérivée — Weibull β=${fmt(p.params.beta, 2)}, η=${fmt(p.params.eta, 1)} ${p.unit}`, data: Array.from({ length: 100 }, (_, i) => { const x = (tmax * i) / 99; return { x, y: weibull.R(x, p.params.beta, p.params.eta) }; }), color: '#7C3AED', width: 2 },
    { label: 'β borne basse (bootstrap)', data: Array.from({ length: 100 }, (_, i) => { const x = (tmax * i) / 99, b = p.source.betaBoot90[0], e = p.params.L / (state.settings.lifeInterpretation === 'MTTF' ? Math.exp(0) * gammaApprox(1 + 1 / b) : (-Math.log(0.9)) ** (1 / b)); return { x, y: weibull.R(x, b, e) }; }), color: '#7C3AED', dashed: true, width: 1 },
  ], { xLabel: `usage (${p.unit})`, yLabel: 'R(t)', yMin: 0, yMax: 1.02, vlines: [{ x: p.state.usageNow, label: 'usage actuel', color: '#2563EB' }, { x: p.plan.tPM, label: `intervention (R*=${p.params.Rstar})`, color: '#DC2626' }], hlines: [{ y: p.params.Rstar, color: '#94A3B8', label: `R* = ${p.params.Rstar}` }] })));
  right.append(panel('Dataset paramétrique dérivé et loi de dégradation', { badges: [badge('substituted')] },
    h('div.kpis', kpi('β (source)', `${fmt(p.params.beta, 2)}`, '', h('div.small.muted', `bootstrap 90 % : ${fmt(p.source.betaBoot90[0], 2)}–${fmt(p.source.betaBoot90[1], 2)}`)), kpi('η dérivé', fmt(p.params.eta, 2), p.unit), kpi('MTTF dérivé', fmt(p.params.mttf, 2), p.unit), kpi('R(usage actuel)', pct(p.state.R, 1)), kpi('HI normalisé estimé', p.state.HIest === null ? '—' : fmt(p.state.HIest, 3), '', h('div.small.muted', '1 = seuil de fin de vie source'))),
    box,
    h('h3', { style: { fontSize: '13px' } }, 'Hypothèses'), h('ul.small', p.hypotheses.map((x) => h('li', x))),
    h('div.small', `Dataset dérivé : ${p.derived.n} durées simulées × 10 points (graine ${p.derived.seed}). ${p.derived.note}`),
    h('div.row', { style: { marginTop: '6px' } },
      h('button.btn.sm', { on: { click: () => { download(`dataset_derive_${c.id}.csv`, toCSV(p.derived.rows, p.derived.columns)); log('Export dataset dérivé', { id: c.id, seed: p.derived.seed }); } } }, icon('download'), 'Dataset dérivé (CSV)'),
      h('button.btn.sm', { on: { click: () => download(`substitution_${c.id}.json`, JSON.stringify({ label: p.label, component: c.id, params: p.params, source: p.source, template: p.template, hypotheses: p.hypotheses, warnings: p.warnings, plan: p.plan, sensitivity: p.sensitivity, derived_seed: p.derived.seed }, null, 2), 'application/json') } }, icon('download'), 'Paramètres (JSON)'))));
  // Sensibilité
  const { box: b2, canvas: c2 } = chartBox('short');
  requestAnimationFrame(() => bag.add(barChart(c2, p.sensitivity.map((s) => s.name), [{ label: 'borne basse', data: p.sensitivity.map((s) => [Math.min(s.lo, s.hi), Math.max(s.lo, s.hi)]), color: '#7C3AED' }], { horizontal: true, legend: false })));
  right.append(panel('Analyse de sensibilité de l\'âge d\'intervention', { badges: [badge('substituted')] }, b2, h('div.small.muted', `Âge d'intervention de référence : ${fmt(p.plan.tPM, 2)} ${p.unit}. Chaque barre = plage obtenue en faisant varier un seul paramètre.`)));
  // Plan
  const rate = p.plan.usagePerSol, nowSol = cursor() / SOL;
  const tasks = p.plan.tasks.map((t) => ({ label: t.action.slice(0, 70), start: rate ? nowSol + t.remaining / rate : t.age, end: rate ? nowSol + t.remaining / rate + 2 : t.age * 1.02, color: t.R === p.params.Rstar ? '#DC2626' : '#7C3AED', title: `${t.action} — âge ${fmt(t.age, 2)} ${p.unit}${t.due ? ' (DÉPASSÉ)' : ''}` }));
  right.append(panel('Nouveau plan de maintenance préventive (estimé par substitution)', { badges: [badge('substituted')] },
    h('div.tbl-wrap', h('table.tbl', h('thead', h('tr', h('th', 'Niveau R'), h('th.num', `Âge (${p.unit})`), h('th.num', `Restant (${p.unit})`), h('th.num', 'Échéance (sols)'), h('th', 'Action suggérée'))),
      h('tbody', p.plan.tasks.map((t) => h('tr', h('td', String(t.R)), h('td.num', fmt(t.age, 2)), h('td.num', fmt(t.remaining, 2)), h('td.num', t.sol === null ? '—' : t.due ? 'dépassé' : fmt(t.sol, 0)), h('td.small', t.action)))))),
    rate ? gantt(tasks.map((t) => ({ label: t.title.slice(0, 32), items: [t] })), { min: Math.floor(nowSol), max: Math.max(nowSol + 50, ...tasks.map((t) => t.end + 10)), now: nowSol, unit: 'sol (conversion au rythme d\'usage simulé)' }) : null,
    exportBtns(c, tasks, rate ? 'sol' : p.unit, p)));
}
function gammaApprox(x) { return Math.exp(lgam(x)); }
function lgam(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const k of c) s += k / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
