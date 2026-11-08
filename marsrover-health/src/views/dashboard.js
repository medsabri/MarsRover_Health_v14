// =============================================================================
// Tableau de bord — santé, courbes, FMDS (KM, Weibull, MTBF/MTTR/A, AMDEC), anomalies,
// pronostic RUL, interprétation intelligente et assistant de correction.
// =============================================================================
import { icon, h, append, clear, fmt, pct, badge, demoBadge, statusEl, STATUS, panel, kpi, toCSV, download, PROV } from '../core/dom.js';
import { state, set, on, persist, log } from '../core/store.js';
import { components, component, fmecaModes, lifetimes, lifetimeDatasets, ds } from '../core/data.js';
import { tel, cursor, detect, alerts, detectionMetrics, allStates, globalHealth, rulBattery, rulVibration, fmdsFor, TRAIN_END_H, iforestMotors, NOT_COMPUTABLE, invalidate, LABEL_OF } from '../core/analysis.js';
import { kaplanMeier, nelsonAalen, weibullMLE, weibull, compareModels, kernelHazard } from '../ml/survival.js';
import { segments } from '../ml/anomaly.js';
import { boxStats } from '../ml/stats.js';
import { ChartBag, chartBox, lineChart, radarChart, boxplotSVG, criticalityHeatmap, color, doughnutChart, gaugeChart } from '../core/charts.js';
import { interpretKM, interpretAnomalies, interpretRUL, interpretFMDS } from '../core/interpret.js';

const bag = new ChartBag(); let unsub = [];
const visible = (prov) => state.provFilter.has(prov);
const masked = (prov) => h('div.nc-box', `Masqué par le filtre de provenance (${PROV[prov] ? PROV[prov].label : prov}).`);
const SUBSYS = ['Mobilité', 'Bras & outils', 'Énergie', 'Thermique', 'Communications', 'Électronique', 'Capteurs', 'Structure'];
let selVar = 'motor3_current_A', selComp = 'all', range = null, vue = '1';
const VUES = [['1', 'Vue d\'ensemble', 'gauge'], ['2', 'Fiabilité & FMDS', 'grid'], ['3', 'Anomalies & détection', 'alert']];

export default {
  mount(app, params) {
    if (params.v) selVar = params.v;
    if (['1', '2', '3'].includes(params.vue)) vue = params.vue;
    render(app);
    unsub.push(on('change', (k) => { if (['activeDataset', 'cursorTime', 'fmecaOverrides', 'overrides', 'terrainImpact'].includes(k)) render(app); }));
  },
  unmount() { bag.destroy(); unsub.forEach((u) => u()); unsub = []; },
};

function render(app) {
  bag.destroy(); clear(app);
  const T = tel(), tq = cursor();
  append(app, h('div.view-head.dash-head',
    h('h1', 'Tableau de bord FMDS — anomalies — pronostic'),
    h('label.dash-field', h('span', 'Sous-système'), h('select.inp', { on: { change: (e) => { selComp = e.target.value; render(app); } } }, h('option', { value: 'all' }, 'Tous'), SUBSYS.map((s) => h('option', { value: s, selected: selComp === s }, s)))),
    h('button.btn', { title: 'Exporter la synthèse (CSV)', on: { click: () => exportSummary() } }, icon('download'), h('span.lg', 'Exporter la synthèse'), '(CSV)'),
    h('nav.dash-tabs', { role: 'tablist', 'aria-label': 'Sous-interfaces du tableau de bord' }, VUES.map(([k, l, ic]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === vue), class: k === vue ? 'on' : '', on: { click: () => { vue = k; history.replaceState(null, '', `#/dashboard?vue=${k}`); render(app); } } }, h('span.n', k), icon(ic), l)))));
  const g = h('div.grid'); app.append(g);
  if (vue === '1') g.append(overviewPanel(tq), healthPanel(tq), timeSeriesPanel(T, tq));
  if (vue === '2') {
    g.append(interpretationPanel(tq), fmdsPanel(), mtbfPanel(), fmecaPanel(app), rulPanel());
  }
  if (vue === '3') g.append(anomalyPanel(tq), metricsPanel(), contextPanel(T));
}

// ------------------------------------------------------------------ synthèse visuelle (jauge, anneau des états, anneaux par sous-système)
function overviewPanel(tq) {
  const S = allStates(tq), G = globalHealth();
  const order = ['ok', 'warn', 'fault', 'overtemp', 'overload', 'sensor', 'nodata'];
  const counts = order.map((k) => S.filter((s) => s.status === k).length);
  const keep = order.map((k, i) => [k, counts[i]]).filter(([, n]) => n > 0);
  const gauge = chartBox('gauge'), donut = chartBox('donut');
  requestAnimationFrame(() => {
    if (gauge.canvas.isConnected) bag.add(gaugeChart(gauge.canvas, G.health, { text: G.health == null ? '—' : `${Math.round(G.health * 100)} %`, sub: 'santé pondérée' }));
    if (donut.canvas.isConnected) bag.add(doughnutChart(donut.canvas, keep.map(([k]) => STATUS[k].label), keep.map(([, n]) => n), keep.map(([k]) => STATUS[k].color), { text: String(S.length), sub: 'composants' }));
  });
  const subs = SUBSYS.map((sub) => { const hs = S.filter((s) => s.comp.subsystem === sub && s.health !== null); return [sub, hs.length ? hs.reduce((a, s) => a + s.health, 0) / hs.length : null]; });
  const ring = (v) => { const c = v == null ? '#94A3B8' : v >= 0.8 ? '#16A34A' : v >= 0.6 ? '#F59E0B' : '#DC2626', r = 26, L = 2 * Math.PI * r;
    const svg = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="${r}" fill="none" stroke="rgba(148,163,184,.22)" stroke-width="7"/><circle cx="32" cy="32" r="${r}" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(v || 0) * L} ${L}" transform="rotate(-90 32 32)"/></svg>`;
    const el = h('div.ring'); el.innerHTML = svg; el.append(h('b', v == null ? '—' : `${Math.round(v * 100)}`)); return el; };
  return panel('Synthèse visuelle de l\'état du rover', { cls: 'c12', badges: [badge('simulated'), badge('substituted')] },
    h('div.ov-grid',
      h('div.ov-tile.ov-blue', h('div.ov-k', 'Santé globale'), gauge.box, h('div.ov-foot', `${G.critical.length} composant(s) critique(s) · état le plus sévère : ${(STATUS[G.worst] || STATUS.nodata).label}`)),
      h('div.ov-tile.ov-violet', h('div.ov-k', 'Répartition des états'), donut.box),
      h('div.ov-tile.ov-green.ov-wide', h('div.ov-k', 'Santé moyenne par sous-système (%)'), h('div.ov-rings', subs.map(([sub, v]) => h('div.ov-ring', ring(v), h('span', sub)))))));
}

// ------------------------------------------------------------------ santé par sous-système
function healthPanel(tq) {
  const S = allStates(tq).filter((s) => selComp === 'all' || s.comp.subsystem === selComp);
  const bySub = {};
  for (const s of S) { (bySub[s.comp.subsystem] ||= []).push(s); }
  const labels = Object.keys(bySub);
  const vals = labels.map((k) => { const hs = bySub[k].filter((s) => s.health !== null); return hs.length ? hs.reduce((a, s) => a + s.health, 0) / hs.length : 0; });
  const { box, canvas } = chartBox('short');
  const p = panel('Santé par sous-système', { cls: 'c4', badges: [badge('simulated'), badge('substituted')] },
    box, h('div.small.muted', 'Santé moyenne des composants (1 = sain). Sous-système sans donnée → 0 (non renseigné). Instant : ' + fmt(tq, 0) + ' h.'),
    h('div.tbl-wrap', { style: { maxHeight: '220px', marginTop: '6px' } }, h('table.tbl.tbl-compact', h('thead', h('tr', h('th', 'Composant'), h('th', 'État'), h('th.num', 'Santé'), h('th', 'Prov.'))),
      h('tbody', S.map((s) => h('tr', h('td', h('a', { href: `#/accueil?c=${s.id}` }, s.comp.name)), h('td', statusEl(s.status)), h('td.num', s.health === null ? '—' : pct(s.health, 0)), h('td', badge(s.provenance))))))));
  requestAnimationFrame(() => bag.add(radarChart(canvas, labels, [{ label: 'Santé', data: vals, color: '#2563EB' }])));
  return p;
}

// ------------------------------------------------------------------ courbes temporelles
const VARS = () => (tel() ? ds('rover_telemetry_sim').columns.filter((c) => !/^(time_h|sol|op_mode|terrain|label_|comm_planned)/.test(c)) : []);
function timeSeriesPanel(T, tq) {
  if (!T) return panel('Courbes temporelles', { cls: 'c8' }, h('div.nc-box', 'Aucune télémétrie chargée.'));
  if (!visible('simulated')) return panel('Courbes temporelles', { cls: 'c8' }, masked('simulated'));
  const d = detect(selVar);
  const { box, canvas } = chartBox('tall');
  const sel = h('select.inp', { 'aria-label': 'Variable', on: { change: (e) => { selVar = e.target.value; const p = timeSeriesPanel(T, tq); this_.replaceWith(p); } } }, VARS().map((v) => h('option', { value: v, selected: v === selVar }, v)));
  const r0 = h('input.inp', { type: 'number', value: range ? range[0] : 0, style: { width: '80px' }, 'aria-label': 'Début (h)' });
  const r1 = h('input.inp', { type: 'number', value: range ? range[1] : T.tmax, style: { width: '80px' }, 'aria-label': 'Fin (h)' });
  const this_ = panel('Courbes temporelles, seuils et zones d\'alerte', { cls: 'c8', badges: [badge('simulated')] },
    h('div.row', sel, h('span.small.muted', 'Période'), r0, r1, h('button.btn.sm', { on: { click: () => { range = [+r0.value, +r1.value]; const p = timeSeriesPanel(T, tq); this_.replaceWith(p); } } }, 'Appliquer'), h('button.btn.sm', { on: { click: () => { range = null; const p = timeSeriesPanel(T, tq); this_.replaceWith(p); } } }, 'Tout')),
    box,
    h('div.small.muted', 'Zone grise : fenêtre d\'apprentissage (0–800 h, statistiques de référence). Zones rouges : alertes persistantes. Traits : seuils de démonstration. Trait bleu : instant d\'analyse.'));
  const pts = T.t.map((x, i) => ({ x, y: Number.isFinite(d ? d.values[i] : NaN) ? d.values[i] : null }));
  const flagged = d ? segments(d.flag.map((f, i) => (T.t[i] >= TRAIN_END_H ? f : 0)), T.t) : [];
  const th = d && d.threshold ? d.threshold : {};
  const hl = [];
  if (th.warn !== undefined) hl.push({ y: th.warn, color: '#D97706', label: `attention ${th.warn}` });
  if (th.fault !== undefined) hl.push({ y: th.fault, color: '#DC2626', label: `défaut ${th.fault}` });
  if (th.warn_low !== undefined) hl.push({ y: th.warn_low, color: '#D97706', label: `attention bas ${th.warn_low}` });
  if (th.fault_low !== undefined) hl.push({ y: th.fault_low, color: '#DC2626', label: `défaut bas ${th.fault_low}` });
  const bands = [{ x0: 0, x1: TRAIN_END_H, color: 'rgba(100,116,139,.12)', label: 'apprentissage', textColor: '#64748B' }, ...flagged.map((s) => ({ x0: s.t0 - 1, x1: s.t1 + 1 }))];
  const series = [{ label: selVar, data: pts, color: '#2563EB', width: 1.1 }];
  const lab = LABEL_OF[selVar];
  if (lab) series.push({ label: `vérité terrain (${lab}, simulée)`, data: T.t.map((x, i) => ({ x, y: +T.rows[i][lab] ? (d.values[i] ?? null) : null })), color: '#DC2626', pointRadius: 1.5, showLine: false });
  requestAnimationFrame(() => bag.add(lineChart(canvas, series, { xLabel: 'temps (h)', yLabel: selVar, bands, hlines: hl, vlines: [{ x: tq, label: 'analyse' }], xMin: range ? range[0] : 0, xMax: range ? range[1] : T.tmax })));
  return this_;
}

// ------------------------------------------------------------------ interprétation
function interpretationPanel(tq) {
  const al = alerts(tq), M = detectionMetrics();
  const items = [];
  const L = lifetimes(state.activeDataset);
  if (L && visible(L.prov)) { const km = kaplanMeier(L.times, L.events); items.push(['Fiabilité', interpretKM(L, km, weibullMLE(L.times, L.events), compareModels(L.times, L.events))]); }
  if (visible('simulated')) {
    items.push(['Anomalies', interpretAnomalies(al, M)]);
    items.push(['Pronostic', interpretRUL(rulBattery(), rulVibration())]);
    items.push(['MTBF / MTTR', interpretFMDS(components().map((c) => ({ c, f: fmdsFor(c.id) })))]);
  }
  const THEME = { 'Fiabilité': ['peach', 'gauge', '#/ia?tab=fiabilite', 'Analyse de fiabilité'], 'Anomalies': ['lavender', 'alert', '#/ia?tab=anomalies', 'Module anomalies'],
    'Pronostic': ['mint', 'refresh', '#/ia?tab=rul', 'Pronostic RUL'], 'MTBF / MTTR': ['rose', 'wrench', '#/ia?tab=disponibilite', 'Disponibilité'] };
  return panel('Interprétation intelligente', { cls: 'c12', badges: [h('span.pill', 'générée par règles à partir des résultats')] },
    h('div.ip-grid', items.map(([t, list]) => {
      const [tone, ic, href, cta] = THEME[t] || ['sky', 'info', '#/dashboard', 'Détails'];
      const n = (lv) => list.filter((x) => x.level === lv).length;
      return h(`article.ip-card.${tone}`, h('span.ip-deco', { 'aria-hidden': 'true' }),
        h('div.ip-head', h('span.ip-ic', icon(ic)), h('span.ip-label', `${list.length} constat${list.length > 1 ? 's' : ''}`)),
        h('h3', t),
        h('div.ip-tags', ['fait', 'estimation', 'limite', 'méthode', 'règle'].filter((lv) => n(lv)).map((lv) => h(`span.ip-tag.lv-${lv.normalize('NFD').replace(/[^a-z]/g, '')}`, `${lv} · ${n(lv)}`))),
        h('ul.ip-list', list.map((x) => h('li', h(`span.ip-dot.lv-${x.level.normalize('NFD').replace(/[^a-z]/g, '')}`), h('span', x.t)))),
        h('a.ip-more', { href }, cta, icon('chevronRight')));
    })));
}

// ------------------------------------------------------------------ fiabilité R(t)
function fmdsPanel() {
  const L = lifetimes(state.activeDataset);
  const dsSel = h('select.inp', { 'aria-label': 'Dataset de durées de vie', style: { maxWidth: '260px' }, on: { change: (e) => set('activeDataset', e.target.value) } }, lifetimeDatasets().map((d) => h('option', { value: d.id, selected: d.id === state.activeDataset }, d.name)));
  if (!L) return panel('Fiabilité R(t)', { cls: 'c6', badges: [dsSel] }, h('div.nc-box', 'Aucun dataset de durées de vie disponible.'));
  if (!visible(L.prov)) return panel('Fiabilité R(t)', { cls: 'c6' }, masked(L.prov));
  const km = kaplanMeier(L.times, L.events), na = nelsonAalen(L.times, L.events), w = weibullMLE(L.times, L.events), cmp = compareModels(L.times, L.events);
  const tabs = h('div.tabs'); const body = h('div');
  const showR = () => {
    clear(body); const { box, canvas } = chartBox(); body.append(box);
    const xs = km.t, tmax = Math.max(...L.times) * 1.05;
    const S = [
      { label: 'R(t) Kaplan–Meier', data: xs.map((x, i) => ({ x, y: km.S[i] })), color: '#2563EB', step: true, width: 2 },
      { label: 'IC 95 % inf. (Greenwood log-log)', data: xs.map((x, i) => ({ x, y: km.lo[i] })), color: '#2563EB', step: true, dashed: true, width: 1 },
      { label: 'IC 95 % sup.', data: xs.map((x, i) => ({ x, y: km.hi[i] })), color: '#2563EB', step: true, dashed: true, width: 1 },
      { label: 'Censures', data: km.censorT.map((x, i) => ({ x, y: km.censorS[i] })), color: '#D97706', pointRadius: 3, showLine: false, pointStyle: 'crossRot' },
    ];
    if (w.ok) S.push({ label: `Weibull β=${fmt(w.beta, 2)} η=${fmt(w.eta, 1)}`, data: Array.from({ length: 80 }, (_, i) => { const x = (tmax * i) / 79; return { x, y: weibull.R(x, w.beta, w.eta) }; }), color: '#C2410C', width: 1.6 });
    requestAnimationFrame(() => bag.add(lineChart(canvas, S, { xLabel: `temps (${L.unit})`, yLabel: 'R(t)', yMin: 0, yMax: 1.02, hlines: [{ y: 0.9, color: '#94A3B8', label: 'R = 0,9 (B10)' }] })));
  };
  const showH = () => {
    clear(body); const { box, canvas } = chartBox(); body.append(box);
    const kh = kernelHazard(L.times, L.events, {});
    requestAnimationFrame(() => {
      bag.add(lineChart(canvas, [
        { label: 'H(t) Nelson–Aalen', data: na.t.map((x, i) => ({ x, y: na.H[i] })), color: '#7C3AED', step: true, width: 2 },
        { label: 'IC 95 %', data: na.t.map((x, i) => ({ x, y: na.hi[i] })), color: '#7C3AED', step: true, dashed: true, width: 1 },
        ...(w.ok ? [{ label: 'H Weibull', data: na.t.map((x) => ({ x, y: (x / w.eta) ** w.beta })), color: '#C2410C' }] : []),
      ], { xLabel: `temps (${L.unit})`, yLabel: 'risque cumulé H(t)' }));
    });
    const { box: b2, canvas: c2 } = chartBox('short'); body.append(h('div.small', { style: { marginTop: '6px' } }, `Taux de défaillance lissé ĥ(t) — noyau d'Epanechnikov sur les incréments de Nelson–Aalen (Ramlau-Hansen), largeur b = ${fmt(kh.bandwidth, 2)} ${L.unit} ; zone t < b biaisée (bord).`), b2);
    requestAnimationFrame(() => bag.add(lineChart(c2, [{ label: 'ĥ(t) noyau', data: kh.t.map((x, i) => ({ x, y: kh.h[i] })), color: '#16A34A', width: 2 }, ...(w.ok ? [{ label: 'h(t) Weibull', data: kh.t.filter((x) => x > 0).map((x) => ({ x, y: weibull.h(x, w.beta, w.eta) })), color: '#C2410C', dashed: true }] : [])], { xLabel: `temps (${L.unit})`, yLabel: 'h(t)', bands: [{ x0: 0, x1: kh.bandwidth, color: 'rgba(217,119,6,.10)' }] })));
  };
  const showT = () => {
    clear(body);
    body.append(h('div.tbl-wrap', h('table.tbl', h('thead', h('tr', h('th', 'Modèle'), h('th', 'Paramètres'), h('th.num', 'AIC'), h('th.num', 'écart max à KM'))), h('tbody', cmp.rows.map((r, i) => h('tr', h('td', r.model + (i === 0 ? ' — préféré' : '')), h('td.mono', r.params), h('td.num', fmt(r.aic, 2)), h('td.num', fmt(r.maxDevKM, 3))))))),
      h('div.small.muted', { style: { marginTop: '6px' } }, 'Démarche « du non paramétrique au paramétrique » (cf. AnalyseValidation_Eolienne3.m, corrigé : ici la censure est passée correctement et l\'adéquation est mesurée, pas codée en dur).'),
      h('div.tbl-wrap', { style: { marginTop: '6px', maxHeight: '200px' } }, h('table.tbl', h('thead', h('tr', h('th.num', 't'), h('th.num', 'n à risque'), h('th.num', 'd'), h('th.num', 'R(t)'), h('th.num', 'IC inf'), h('th.num', 'IC sup'))), h('tbody', km.t.slice(1).map((x, i) => h('tr', h('td.num', fmt(x, 3)), h('td.num', km.nRisk[i + 1]), h('td.num', km.d[i + 1]), h('td.num', fmt(km.S[i + 1], 4)), h('td.num', fmt(km.lo[i + 1], 4)), h('td.num', fmt(km.hi[i + 1], 4))))))));
  };
  [['R(t)', showR], ['H(t) & h(t)', showH], ['Lois & tableau KM', showT]].forEach(([t, f], i) => { const b = h('button', { class: i === 0 ? 'on' : '', on: { click: () => { tabs.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); f(); } } }, t); tabs.append(b); });
  showR();
  return panel('Fiabilité R(t)', { cls: 'c6', badges: [dsSel, badge(L.prov)] },
    h('div.kpis', kpi('Unités / défaillances', `${km.n} / ${km.events}`), kpi('Médiane KM', km.median === null ? 'non atteinte' : fmt(km.median, 2), L.unit), kpi('MTTF (Weibull)', w.ok ? fmt(w.mttf, 1) : NOT_COMPUTABLE, L.unit), kpi('B10 (Weibull)', w.ok ? fmt(w.b10, 1) : NOT_COMPUTABLE, L.unit), kpi('β [IC 95 %]', w.ok && w.ci ? `${fmt(w.beta, 2)} [${fmt(w.ci.beta[0], 2)}–${fmt(w.ci.beta[1], 2)}]` : '—')),
    tabs, body);
}

// ------------------------------------------------------------------ MTBF / MTTR / disponibilité
function mtbfPanel() {
  const rows = components().filter((c) => selComp === 'all' || c.subsystem === selComp).map((c) => ({ c, f: fmdsFor(c.id) })).sort((a, b) => (b.f.computable ? 1 : 0) - (a.f.computable ? 1 : 0));
  const ok = rows.filter((r) => r.f.computable && visible(r.f.provenance));
  return panel('MTBF · MTTR · Disponibilité', { cls: 'c6', badges: [badge('simulated')] },
    h('div.infobox', 'Définitions : panne = indisponibilité NON planifiée ; temps requis TR = fenêtre − indisponibilités planifiées ; MTBF = (TR − Σ pannes) / nombre de pannes ; MTTR = durée moyenne de REMISE EN SERVICE (pas de réparation physique sur Mars) ; Ai = temps de bon fonctionnement / TR = MTBF / (MTBF + MTTR) ; Ao = temps de bon fonctionnement / fenêtre totale (arrêts planifiés inclus). IC du MTBF : loi du χ² (taux constant supposé).'),
    h('div.tbl-wrap', { style: { marginTop: '8px' } }, h('table.tbl',
      h('thead', h('tr', h('th', 'Composant'), h('th.num', 'Pannes'), h('th.num', 'MTBF (h)'), h('th', 'IC 90 %'), h('th.num', 'MTTR (h)'), h('th.num', 'Ai'), h('th.num', 'Ao'), h('th', 'Source'))),
      h('tbody', rows.map(({ c, f }) => f.computable && visible(f.provenance)
        ? h('tr', h('td', c.name), h('td.num', f.nFailures), h('td.num', f.mtbf === null ? NOT_COMPUTABLE : fmt(f.mtbf, 0)), h('td.mono', f.mtbfCI ? `${fmt(f.mtbfCI[0], 0)} – ${fmt(f.mtbfCI[1], 0)}` : f.mtbfNote || '—'), h('td.num', f.mttr === null ? NOT_COMPUTABLE : fmt(f.mttr, 2)), h('td.num', pct(f.availability, 2)), h('td.num', pct(f.availabilityAo, 2)), h('td', badge(f.provenance)))
        : h('tr', h('td', c.name), h('td', { colspan: 7, class: 'muted' }, f.computable ? 'Masqué (filtre de provenance)' : NOT_COMPUTABLE), ))))),
    h('div.small.muted', { style: { marginTop: '6px' } }, `${ok.length} composant(s) calculable(s). Pour les autres, importez un journal d'événements (colonnes component_id, type, start_h, end_h) dans « Données ».`));
}

// ------------------------------------------------------------------ AMDEC / FMECA
function fmecaPanel(app) {
  const modes = fmecaModes().filter((m) => selComp === 'all' || component(m.component).subsystem === selComp).sort((a, b) => b.RPN - a.RPN);
  const detail = h('div.small.muted', 'Cliquez une case de la matrice pour lister ses modes.');
  const edit = (m, k) => h('input.cell', { type: 'number', min: 1, max: 10, value: m[k], 'aria-label': `${k} ${m.id}`, on: { change: (e) => { const v = Math.max(1, Math.min(10, Math.round(+e.target.value || 1))); state.fmecaOverrides[m.id] = { ...(state.fmecaOverrides[m.id] || {}), [k]: v }; persist('fmecaOverrides'); log('Cotation AMDEC modifiée', { id: m.id, [k]: v }); set('fmecaOverrides', state.fmecaOverrides); } } });
  return panel('AMDEC / FMECA — matrice de criticité', { cls: 'c12', badges: [demoBadge('cotations de démonstration à valider')] },
    h('div.grid',
      h('div.c4', criticalityHeatmap(modes, (list) => { clear(detail); detail.append(...list.map((m) => h('div', `${m.id} — ${component(m.component).name} : ${m.mode} (RPN ${m.RPN})`))); }), detail),
      h('div.c8', h('div.tbl-wrap', { style: { maxHeight: '360px' } }, h('table.tbl',
        h('thead', h('tr', h('th', 'ID'), h('th', 'Composant'), h('th', 'Mode de défaillance'), h('th', 'Cause'), h('th', 'Effet'), h('th', 'Détection'), h('th.num', 'G'), h('th.num', 'O'), h('th.num', 'D'), h('th.num', 'RPN'), h('th', 'Maîtrise'))),
        h('tbody', modes.map((m) => h('tr', h('td', m.id), h('td', component(m.component).name), h('td', m.mode), h('td.small', m.cause), h('td.small', m.effect), h('td.small', m.detection), h('td.num', edit(m, 'G')), h('td.num', edit(m, 'O')), h('td.num', edit(m, 'D')),
          h('td.num', { style: { fontWeight: 700, color: m.RPN >= 150 ? '#DC2626' : m.RPN >= 80 ? '#D97706' : 'inherit' } }, m.RPN), h('td.small', m.mitigation)))))),
        h('div.row', { style: { marginTop: '6px' } }, h('span.small.muted', 'RPN = G × O × D. La sécurité ne se résume pas à un score ML : la matrice formalise gravité, occurrence et détectabilité (§8).'), h('span.spacer'),
          h('button.btn.sm', { on: { click: () => download('amdec.csv', toCSV(modes.map((m) => ({ ...m, component_name: component(m.component).name })), ['id', 'component', 'component_name', 'mode', 'cause', 'effect', 'detection', 'G', 'O', 'D', 'RPN', 'mitigation'])) } }, icon('download'), 'CSV'),
          h('button.btn.sm', { on: { click: () => { state.fmecaOverrides = {}; persist('fmecaOverrides'); set('fmecaOverrides', {}); } } }, 'Réinitialiser')))));
}

// ------------------------------------------------------------------ anomalies
function anomalyPanel(tq) {
  if (!visible('simulated')) return panel('Détection d\'anomalies', { cls: 'c8' }, masked('simulated'));
  let A = alerts(tq).filter((a) => selComp === 'all' || component(a.component).subsystem === selComp);
  const T = tel();
  const d = detect(selVar); const { box, canvas } = chartBox('xl');
  requestAnimationFrame(() => {
    const S = [{ label: `|z| robuste — ${selVar}`, data: T.t.map((x, i) => ({ x, y: d.z[i] === null ? null : Math.abs(d.z[i]) })), color: '#7C3AED', width: 1 }];
    if (/motor\d_current/.test(selVar)) { const ifo = iforestMotors(); S.push({ label: 'score Isolation Forest (×10)', data: T.t.map((x, i) => ({ x, y: ifo.score[i] === null ? null : ifo.score[i] * 10 })), color: '#16A34A', width: 1 }); }
    const ymax = Math.max(8, Math.ceil(Math.min(40, Math.max(...S[0].data.map((p0) => p0.y || 0))) * 1.08));
    bag.add(lineChart(canvas, S, { xLabel: 'temps (h)', yLabel: 'score d\'anomalie', hlines: [{ y: 6, color: '#DC2626', label: 'seuil |z| = 6' }], vlines: [{ x: tq, label: 'instant d\'analyse' }], yMin: 0, yMax: ymax }));
  });
  return panel(`Alertes (${A.length}) et scores d'anomalie`, { cls: 'c12', badges: [badge('simulated')] },
    box,
    h('div.tbl-wrap', { style: { maxHeight: '300px', marginTop: '6px' } }, h('table.tbl',
      h('thead', h('tr', h('th', 'Composant'), h('th', 'Horodatage'), h('th', 'Variable'), h('th', 'Observation'), h('th', 'Règle / modèle déclencheur'), h('th', 'Explication & facteurs contributifs'), h('th', 'Prov.'))),
      h('tbody', A.slice(0, 200).map((a) => h('tr', h('td', h('a', { href: `#/accueil?c=${a.component}` }, a.componentName), h('div', statusEl(a.severity))), h('td.mono', `${fmt(a.start, 0)}–${fmt(a.end, 0)} h`, h('div.muted', `sol ${a.sol}`)), h('td.mono', a.variable), h('td.num', fmt(a.value, 3)),
        h('td.small', a.model), h('td.small', a.rule, h('div.muted', a.factors.join(' · '))), h('td', badge(a.provenance))))))),
    h('div.row', { style: { marginTop: '6px' } }, h('span.small.muted', 'Chaque alerte est reliée à une période, une variable, une source et une méthode (traçabilité §13).'), h('span.spacer'), h('button.btn.sm', { on: { click: () => download('alertes.csv', toCSV(A.map((a) => ({ ...a, factors: a.factors.join(' | ') })), ['component', 'componentName', 'start', 'end', 'sol', 'variable', 'value', 'z', 'severity', 'model', 'rule', 'factors', 'provenance', 'dataset'])) } }, icon('download'), 'CSV')));
}
function metricsPanel() {
  if (!visible('simulated')) return panel('Performance de détection', { cls: 'c4' }, masked('simulated'));
  const M = detectionMetrics();
  return panel('Performance de détection (jeu après 800 h)', { cls: 'c6', badges: [badge('simulated')] },
    h('div.tbl-wrap', { style: { marginTop: '6px' } }, h('table.tbl', h('thead', h('tr', h('th', 'Variable'), h('th.num', 'Préc.'), h('th.num', 'Rappel'), h('th.num', 'Évts'), h('th.num', 'FA'), h('th.num', 'Délai (h)'))),
      h('tbody', M.map((m) => h('tr', { title: m.method }, h('td.mono', m.variable), h('td.num', m.precision === null ? '—' : pct(m.precision, 0)), h('td.num', m.recall === null ? '—' : pct(m.recall, 0)), h('td.num', `${m.eventsDetected}/${m.events.length}`), h('td.num', m.falseAlarms), h('td.num', m.meanDelay === null ? '—' : fmt(m.meanDelay, 0))))))),
    h('details', { style: { marginTop: '6px' } }, h('summary', 'Fausses alertes analysées'), h('ul.small', M.flatMap((m) => m.falseAlarmList.map((f) => h('li', `${m.variable} : ${fmt(f.start, 0)}–${fmt(f.end, 0)} h`)))), M.every((m) => !m.falseAlarmList.length) ? h('div.small.muted', 'Aucune fausse alerte sur ce jeu.') : null),
    h('div.small.muted', 'FA = fausses alertes (segments sans anomalie vraie). Préc./rappel au niveau échantillon ; « Évts » au niveau événement.'));
}

// ------------------------------------------------------------------ pronostic RUL
function rulPanel() {
  if (!visible('simulated')) return panel('Pronostic RUL', { cls: 'c8' }, masked('simulated'));
  const rb = rulBattery(), rv = rulVibration();
  const { box, canvas } = chartBox('tall');
  requestAnimationFrame(() => {
    const S = rb.trajs.filter((u) => u.id !== 'ROVER_PACK').map((u, i) => ({ label: `${u.id} (${rb.split.train.includes(u.id) ? 'train' : rb.split.validation.includes(u.id) ? 'val' : 'test'})`, data: u.t.map((x, k) => ({ x, y: u.y[k] })), color: color(i + 2), width: 1 }));
    const rp = rb.trajectory; S.push({ label: 'ROVER_PACK (en service)', data: rp.t.map((x, k) => ({ x, y: rp.y[k] })), color: '#2563EB', width: 2.5 });
    const c = rb.current, tc = c.tc;
    bag.add(lineChart(canvas, S, { xLabel: 'cycles', yLabel: 'capacité (Ah)', hlines: [{ y: 32, color: '#DC2626', label: 'fin de vie 80 % C0 (démo)' }], bands: [{ x0: tc + c.ci[0], x1: tc + c.ci[1], color: 'rgba(37,99,235,.15)', label: 'IC 90 % de la date de fin de vie', textColor: '#2563EB' }], vlines: [{ x: tc + c.value, label: 'fin de vie médiane', color: '#2563EB' }] }));
  });
  const mtab = (b) => h('table.tbl', h('thead', h('tr', h('th', 'Modèle'), h('th.num', 'RMSE val.'), h('th.num', 'MAE test'), h('th.num', 'RMSE test'), h('th.num', 'Couverture IC test'))),
    h('tbody', Object.entries(b.results).map(([k, r]) => h('tr', h('td', r.name + (k === b.chosen ? ' — retenu' : '')), h('td.num', fmt(r.val.rmse, 0)), h('td.num', fmt(r.test.mae, 0)), h('td.num', fmt(r.test.rmse, 0)), h('td.num', pct(r.test.coverage, 0))))));
  const c = rb.current;
  return panel('Pronostic — RUL (uniquement si fin de vie définie)', { cls: 'c12', badges: [badge('simulated')] },
    h('div.kpis', kpi('RUL batterie (pack en service)', fmt(c.value, 0), 'cycles'), kpi('IC 90 %', `${fmt(c.ci[0], 0)} – ${fmt(c.ci[1], 0)}`, 'cycles'), kpi('SOH actuel', pct(rb.soh, 1)), kpi('Autres composants', 'RUL masquée (pas de fin de vie)')),
    box,
    h('div.grid', { style: { marginTop: '8px' } },
      h('div.c6', h('div.small', { style: { fontWeight: 600 } }, `Batterie — split par pack (train ${rb.split.train.join(', ')} · val ${rb.split.validation.join(', ')} · test ${rb.split.test.join(', ')})`), h('div.tbl-wrap', mtab(rb))),
      h('div.c6', h('div.small', { style: { fontWeight: 600 } }, `Roulements (vib.) — split par essai (train R-001…R-006 · val R-007, R-008 · test R-009, R-010), unité : h`), h('div.tbl-wrap', mtab(rv)))));
}

// ------------------------------------------------------------------ contexte opérationnel (boîtes à moustaches)
function contextPanel(T) {
  if (!T || !visible('simulated')) return panel('Contexte opérationnel', { cls: 'c6' }, T ? masked('simulated') : h('div.nc-box', 'Pas de télémétrie.'));
  const v = T.g('motor1_current_A');
  const groups = ['nominal', 'pente', 'sable'].map((k, i) => ({ label: k, color: color(i), stats: boxStats(v.filter((x, j) => T.op[j] === 'drive' && T.terrain[j] === k && Number.isFinite(x))) })).filter((g) => g.stats.n > 0);
  return panel('Effet du terrain sur le courant (moteur 1, conduite)', { cls: 'c6', badges: [badge('simulated')] },
    boxplotSVG(groups, { unit: 'A', width: 760, height: 520, big: true }),
    h('div.small.muted', 'Toute la période (moteur 1 : sans anomalie injectée). Le courant dépend fortement du terrain : la détection compare chaque mesure à la référence de SON contexte, ce qui réduit les fausses alertes (question scientifique n°1).'));
}

function exportSummary() {
  const rows = allStates().map((s) => ({ id: s.id, name: s.comp.name, subsystem: s.comp.subsystem, status: s.status, health: s.health, confidence: s.confidence, provenance: s.provenance, regime: s.regime, rul: s.rul ? s.rul.value : '', rul_unit: s.rul ? s.rul.unit : '', rul_ci_low: s.rul ? s.rul.ci[0] : '', rul_ci_high: s.rul ? s.rul.ci[1] : '', reasons: s.reasons.join(' | '), instant_h: cursor() }));
  download('synthese_sante.csv', toCSV(rows)); log('Export synthèse', { instant: cursor() });
}

