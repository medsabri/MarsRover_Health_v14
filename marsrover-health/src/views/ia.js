// =============================================================================
// ia.js — « Intelligence artificielle & maintenance prédictive ».
// Affiche les résultats calculés par le backend (backend/mrh) : aucun entraînement ni calcul analytique ici.
// Sous-sections : anomalies, diagnostic, fiabilité, RUL, maintenabilité, disponibilité, AMDEC/FTA,
// comparaison des algorithmes, gestion des modèles, recommandations, audit.
// =============================================================================
import { h, clear, fmt, pct, badge, icon, toast, download, toCSV, panel, modal } from '../core/dom.js';
import { ChartBag, chartBox, lineChart, barChart } from '../core/charts.js';
import * as ML from '../core/mlapi.js';
import { AUDIT, ARCHI } from './ia_audit.js';

// Palette catégorielle validée (ordre fixe ; ΔE CVD ≥ 11) — rôle constant : 1 = principal / réel, 2 = comparé, 3, 4
const C = ['#2563EB', '#E8590C', '#0D9488', '#9333EA'];
const NEUTRAL = '#94A3B8', FAULT = '#B91C1C', WARN = '#B45309', OK = '#15803D';
const ALGO = {
  isolation_forest: 'Isolation Forest', one_class_svm: 'One-Class SVM', autoencoder: 'Autoencodeur', isolation_forest_igbt: 'Isolation Forest (IGBT)',
  xgboost: 'XGBoost', random_forest: 'Random Forest', svm: 'SVM', lstm: 'LSTM', weibull: 'Weibull', weibull_batterie: 'Weibull (batteries)',
  weibull_population: 'Weibull (sans covariable)', weibull_aft: 'Weibull AFT', random_survival_forest: 'Random Survival Forest', regression_lineaire: 'Régression linéaire',
};
const TABS = [
  { id: 'anomalies', label: 'Anomalies', ic: 'alert' }, { id: 'diagnostic', label: 'Diagnostic', ic: 'search' }, { id: 'fiabilite', label: 'Fiabilité', ic: 'gauge' },
  { id: 'rul', label: 'Pronostic RUL', ic: 'refresh' }, { id: 'maintenabilite', label: 'Maintenabilité', ic: 'wrench' }, { id: 'disponibilite', label: 'Disponibilité', ic: 'check' },
  { id: 'securite', label: 'AMDEC / FTA', ic: 'zap' }, { id: 'comparaison', label: 'Comparaison', ic: 'grid' }, { id: 'modeles', label: 'Modèles', ic: 'database' },
  { id: 'references', label: 'FEMTO & HIRF', ic: 'database' }, { id: 'recommandations', label: 'Recommandations', ic: 'chat' }, { id: 'audit', label: 'Audit', ic: 'info' },
];
let bag = new ChartBag(), state = {}, slot = null;

// ------------------------------------------------------------------ petits composants
const algo = (a) => ALGO[a] || a;
const dateFR = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const STATUS_PILL = { valide: ['ok', 'Validé'], entraine: ['info', 'Entraîné'], attente_donnees: ['warn', 'En attente de données'], entrainement: ['info', 'En cours d\'entraînement'],
  erreur: ['fault', 'Erreur'], non_entraine: ['none', 'Non entraîné'] };
const statusPill = (s) => { const [c, l] = STATUS_PILL[s] || ['none', s]; return h(`span.ia-pill.${c}`, l); };
const PRIO = { haute: 'fault', moyenne: 'warn', basse: 'info' };
const prioPill = (p) => h(`span.ia-pill.${PRIO[p] || 'none'}`, p);
const metric = (label, value, sub = null, tone = '') => h(`div.ia-kpi${tone ? '.' + tone : ''}`, h('span.k', label), h('span.v', value), sub ? h('span.s', sub) : null);
const kpis = (...items) => h('div.ia-kpis', items);
const note = () => null;   // notes explicatives retirées de l'affichage
// avertissements / notes retirés ; seuls les messages d'erreur bloquants (kind 'err') restent affichés
const callout = (kind, title, ...body) => (kind === 'err' ? h('div.ia-callout.warn', icon('alert'), h('div', title ? h('strong', title) : null, ...body)) : null);
function method(title, lines) { return h('details.ia-method', h('summary', title), h('ul', lines.map((l) => h('li', l)))); }
function table(cols, rows, { max = 400, empty = 'Aucune donnée pour ces filtres.' } = {}) {
  if (!rows.length) return h('div.ia-empty', empty);
  return h('div.tbl-wrap', h('table.tbl', h('thead', h('tr', cols.map((c) => h(c.num ? 'th.num' : 'th', c.label)))),
    h('tbody', rows.slice(0, max).map((r) => h('tr', cols.map((c) => { const v = c.fmt ? c.fmt(r[c.k], r) : r[c.k]; return h(c.num ? 'td.num' : 'td', v instanceof Node ? v : String(v ?? '—')); }))))));
}
const exportBtn = (name, rows) => h('button.btn.sm', { on: { click: () => rows().length ? download(`${name}.csv`, toCSV(rows())) : toast('Rien à exporter.', 'err') } }, icon('download'), 'Exporter CSV');
const plot = (cls, fn) => { const { box, canvas } = chartBox(cls); requestAnimationFrame(() => { if (canvas.isConnected) bag.add(fn(canvas)); }); return box; };
const legend = (items) => h('div.ia-legend', items.map(([c, l, dash]) => h('span', h(`i${dash ? '.dash' : ''}`, { style: { borderColor: c, background: dash ? 'transparent' : c } }), l)));
const sec = (title, sub, at, ...extra) => h('div.ia-sec-head', h('div', h('h2', title), sub ? h('p', sub) : null), h('div.row', ...extra));

function filterBar({ options, value, unit, from, to, onApply, exportFn, label = 'Équipement' }) {
  const sel = h('select.inp', { 'aria-label': label }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  const f = h('input.inp', { type: 'number', placeholder: 'début', value: from ?? '', 'aria-label': `Début de période (${unit})` });
  const t = h('input.inp', { type: 'number', placeholder: 'fin', value: to ?? '', 'aria-label': `Fin de période (${unit})` });
  const apply = () => onApply({ equipment: sel.value, t_from: f.value, t_to: t.value });
  sel.addEventListener('change', apply);
  return h('div.ia-filters', h('label.fld', h('span', label), sel), h('label.fld.sm', h('span', `Période (${unit})`), h('div.row.nowrap', f, h('span.muted', '→'), t)),
    h('button.btn.sm', { on: { click: apply } }, icon('filter'), 'Appliquer'), h('span.spacer'), exportFn || null);
}

// ------------------------------------------------------------------ montage
export default {
  async mount(app, params) {
    bag.destroy();
    const tab = TABS.some((t) => t.id === params.tab) ? params.tab : 'anomalies';
    state = { ...params, tab };
    const body = h('div.ia-body', h('div.ia-loading', h('div.skeleton'), h('div.skeleton'), h('div.skeleton')));
    const srcChip = h('span.ia-src', 'Connexion…');
    slot = h('div.ia-frame-slot');
    // un seul cadre : titre, source, sous-onglets, en-tête de section, filtres, indicateurs clés
    app.append(
      h('section.ia-frame', { 'aria-label': 'Intelligence artificielle & maintenance prédictive' },
        h('nav.ia-tabs', { role: 'tablist', 'aria-label': 'Sous-sections' }, TABS.map((t) => h('a', { href: `#/ia?tab=${t.id}`, role: 'tab', 'aria-selected': String(t.id === tab), class: t.id === tab ? 'on' : '' }, icon(t.ic), t.label))),
        slot),
      body);
    requestAnimationFrame(() => { const on = app.querySelector('.ia-tabs a.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' }); });
    try {
      const mode = await ML.init();
      document.body.dataset.mlSource = mode;  // source des résultats (api | snapshot), sans encart visible
      clear(srcChip).append(h('span.dot', { style: { background: mode === 'api' ? OK : WARN } }), mode === 'api' ? 'Backend connecté — résultats en direct' : `Instantané hors ligne du ${dateFR(ML.snapshotDate())}`);
      srcChip.title = mode === 'api' ? 'Données lues via l\'API REST (base SQLite).' : 'Lecture seule : lancez « python -m mrh.cli serve » puis ouvrez http://127.0.0.1:8765/ pour entraîner, valider et éditer.';
      clear(body);
      await RENDER[tab](body, params);
      place(body);
    } catch (e) {
      console.error(e);
      clear(body).append(callout('err', 'Résultats indisponibles', h('p', String(e.message || e)), h('p', 'Générez l\'instantané : cd backend && python -m mrh.cli all')));
    }
  },
  unmount() { bag.destroy(); },
};
async function rerender(body, params) { bag.destroy(); clear(body); clear(slot); await RENDER[state.tab](body, params); place(body); }
/** Déplace l'en-tête de section, les filtres, les KPI et les avertissements de tête dans le cadre unique. */
function place(body) {
  while (body.firstElementChild && body.firstElementChild.matches('.ia-sec-head, .ia-filters, .ia-seg, .ia-kpis, .ia-callout')) slot.append(body.firstElementChild);
  // titre, sélecteurs, filtres et export regroupés sur une seule ligne (sous-titre retiré)
  const head = slot.querySelector(':scope > .ia-sec-head'); if (!head) return;
  head.querySelectorAll(':scope > div:first-child > p').forEach((p) => p.remove());
  const f = slot.querySelector(':scope > .ia-filters');
  if (f) head.insertBefore(f, head.children[1] || null);
  const seg = slot.querySelector(':scope > .ia-seg');
  if (seg) head.insertBefore(seg, head.children[1] || null);
  head.classList.add('merged');
  colorKpis(slot); colorKpis(body);
}
/** Cartes de résultats compactes et colorées (même design que les tests de perturbation). */
function colorKpis(root) {
  const TONES = ['blue', 'green', 'violet', 'amber', 'red', 'teal'];
  root.querySelectorAll('.ia-kpis').forEach((k) => { k.classList.add('pt-kpis', 'ia-kpis-c'); [...k.children].forEach((c, i) => c.classList.add('tone-' + TONES[i % TONES.length])); });
}

// ================================================================== 1. ANOMALIES
async function renderAnomalies(body, params) {
  const d = await ML.module('anomalies', params);
  const P = d.payload, cm = P.cmapss, comp = cm.comparison, iso = comp.isolation_forest;
  const units = Object.keys(cm.series);
  const eq = params.equipment && cm.series[params.equipment] ? params.equipment : (units.find((u) => u.includes('-TE-') && cm.series[u].rul.some((r) => r <= 30)) || units[0]);
  const s = cm.series[eq];
  const hist = d.history;
  body.append(sec('Détection intelligente des anomalies', null, d.computed_at));
  body.append(filterBar({ options: [['', 'Tous les équipements'], ['IGBT-DC-01', 'IGBT — vieillissement thermique'], ...units.filter((u) => u.includes('-TE-')).map((u) => [u, `Turboréacteur test ${u.slice(-3)}`]), ...units.filter((u) => u.includes('-TR-')).map((u) => [u, `Turboréacteur validation ${u.slice(-3)}`])],
    value: params.equipment || '', unit: 'cycle / s', from: params.t_from, to: params.t_to, onApply: (p) => rerender(body, p),
    exportFn: exportBtn('anomalies', () => hist.map((r) => ({ ...r, sensors: (JSON.parse(r.sensors || '[]')).map((x) => x.sensor).join(' ') }))) }));
  const nHigh = hist.filter((r) => r.priority === 'haute').length;
  body.append(kpis(
    metric('F1 (test NASA)', fmt(iso.f1, 3), `Précision ${pct(iso.precision, 1)} · Rappel ${pct(iso.recall, 1)}`),
    metric('AUC-ROC', fmt(iso.auc_roc, 4), 'normal RUL > 125 vs anormal RUL ≤ 30'),
    metric('Taux de fausses alertes', pct(iso.fpr, 1), `seuil ${fmt(cm.threshold, 3)} (quantile 99 %)`),
    metric('Avance médiane', `${fmt(iso.lead_median_cycles, 0)} cycles`, `avant défaillance · ${iso.detected_units_val} unités`),
    metric('Épisodes enregistrés', String(hist.length), `${nHigh} priorité haute`, nHigh ? 'fault' : '')));
  // score d'anomalie de l'équipement sélectionné
  const grid = h('div.grid');
  if (s) {
    const pts = s.cycle.map((c, i) => ({ x: c, y: s.score[i] }));
    const risk = s.cycle.filter((c, i) => s.rul[i] <= 30);
    grid.append(panel(`Score d'anomalie — ${eq}`, { cls: 'c8', badges: [badge('simulated')] },
      legend([[C[0], 'Score Isolation Forest'], [FAULT, 'Seuil de détection', true]]),
      plot('tall', (cv) => lineChart(cv, [{ label: 'Score', data: pts, color: C[0], width: 2 }], {
        xLabel: 'cycle', yLabel: 'score', legend: false, hlines: [{ y: cm.threshold, label: 'seuil', color: FAULT }],
        bands: risk.length ? [{ x0: risk[0], x1: risk[risk.length - 1], label: 'RUL ≤ 30 (vérité NASA)', color: 'rgba(185,28,28,.08)', textColor: FAULT }] : [] })),
      note('Bande rouge : fenêtre où la RUL réelle est ≤ 30 cycles (référence d\'évaluation, jamais utilisée pour l\'apprentissage).')));
  }
  // évolution des anomalies (épisodes par tranche de début)
  const cm_ = hist.filter((r) => r.unit === 'cycle');
  const bins = [0, 50, 100, 150, 200, 250, 300, 350];
  const counts = bins.map((b, i) => cm_.filter((r) => r.t_start >= b && r.t_start < (bins[i + 1] ?? 1e9)).length);
  grid.append(panel('Évolution des anomalies', { cls: 'c4' },
    plot('tall', (cv) => barChart(cv, bins.map((b, i) => (bins[i + 1] ? `${b}–${bins[i + 1]}` : `≥ ${b}`)), [{ label: 'Épisodes', data: counts, color: C[0] }], { yLabel: 'épisodes', legend: false })),
    note('Nombre d\'épisodes persistants (≥ 3 cycles) selon le cycle de début.')));
  // comparaison des 3 algorithmes
  const rows = Object.entries(comp).map(([a, m]) => ({ a, ...m }));
  grid.append(panel('Comparaison des détecteurs (même seuil de validation, même jeu de test)', { cls: 'c7' },
    table([{ k: 'a', label: 'Algorithme', fmt: (v) => algo(v) }, { k: 'precision', label: 'Précision', num: true, fmt: (v) => pct(v, 1) }, { k: 'recall', label: 'Rappel', num: true, fmt: (v) => pct(v, 1) },
      { k: 'f1', label: 'F1', num: true, fmt: (v) => fmt(v, 3) }, { k: 'auc_roc', label: 'AUC-ROC', num: true, fmt: (v) => fmt(v, 4) }, { k: 'lead_median_cycles', label: 'Avance (cycles)', num: true, fmt: (v) => fmt(v, 0) },
      { k: 'train_time_s', label: 'Entraîn. (s)', num: true, fmt: (v) => fmt(v, 2) }, { k: 'status', label: 'Statut', fmt: (v) => statusPill(v) }], rows),
    plot('short', (cv) => barChart(cv, rows.map((r) => algo(r.a)), [{ label: 'F1', data: rows.map((r) => r.f1), color: C[0] }, { label: 'AUC-ROC', data: rows.map((r) => r.auc_roc), color: C[1] }], { yMax: 1 }))));
  // IGBT
  const ig = P.igbt;
  grid.append(panel('IGBT — essai réel de vieillissement (sans vérité terrain)', { cls: 'c5', badges: [badge('experimental')] },
    plot('', (cv) => lineChart(cv, [{ label: 'Score', data: ig.t.map((t, i) => ({ x: t / 60, y: ig.score[i] })), color: C[0] }], { xLabel: 'minutes sous contrainte', yLabel: 'score', legend: false,
      hlines: [{ y: ig.threshold, label: 'seuil', color: FAULT }], vlines: ig.first_episode_s ? [{ x: ig.first_episode_s / 60, label: '1er épisode', color: WARN }] : [] })),
    callout('info', 'Performance non évaluable', h('p', ig.note, ` ${ig.episodes} épisode(s) détecté(s) ; le premier à ${fmt(ig.first_episode_s / 60, 1)} min sur ${fmt(ig.duration_s / 60, 0)} min d'essai.`))));
  // historique
  grid.append(panel('Historique des anomalies', { cls: 'c12' },
    table([{ k: 'equipment_id', label: 'Équipement' }, { k: 't_start', label: 'Début', num: true, fmt: (v, r) => `${fmt(v, 0)} ${r.unit}` }, { k: 't_end', label: 'Fin', num: true, fmt: (v, r) => `${fmt(v, 0)} ${r.unit}` },
      { k: 'value', label: 'Score max', num: true, fmt: (v) => fmt(v, 3) }, { k: 'sensors', label: 'Capteurs concernés (z moyen)', fmt: (v) => (JSON.parse(v || '[]')).map((x) => `${x.sensor} (${x.z > 0 ? '+' : ''}${fmt(x.z, 1)})`).join(' · ') },
      { k: 'priority', label: 'Priorité', fmt: prioPill }, { k: 'computed_at', label: 'Détecté le', fmt: dateFR }, { k: 'provenance', label: 'Prov.', fmt: (v) => badge(v) }], hist, { max: 300 })));
  body.append(grid, method('Méthode, hypothèses et règles', [
    `Fonctionnement normal : ${cm.normal_def} ; normalisation z-score et moyenne glissante causale (5 cycles) sur 14 capteurs.`,
    `Seuil : ${cm.threshold_rule}.`, `Évaluation : ${cm.eval_def}.`,
    'Priorité : haute si épisode ≥ 5 observations et ≥ 3 capteurs |z| > 3 ; moyenne si épisode ≥ 3 observations. Règle proposée, à valider par l\'exploitant.',
    'Une anomalie n\'est jamais requalifiée en panne sans le modèle de diagnostic ou une règle technique.']));
}

// ================================================================== 2. DIAGNOSTIC
async function renderDiagnostic(body, params) {
  const d = await ML.module('diagnostic', params);
  const P = d.payload, comp = P.comparison, best = comp[P.principal];
  const tools = [...new Set((await ML.module('diagnostic')).history.map((r) => r.equipment_id))];
  const eq = params.equipment || 'MILL-C11';
  const hist = d.history;
  body.append(sec('Diagnostic intelligent des défaillances', 'Classification de l\'état d\'usure d\'outils de fraisage (mesures réelles) selon le critère ISO 3685.', d.computed_at));
  body.append(filterBar({ options: [['', 'Tous les outils'], ...tools.map((t) => [t, `Outil ${t.slice(-2)}`])], value: params.equipment || '', unit: 'min', from: params.t_from, to: params.t_to,
    onApply: (p) => rerender(body, p), label: 'Outil', exportFn: exportBtn('diagnostic', () => hist.map((r) => ({ ...r, probabilities: r.probabilities }))) }));
  body.append(kpis(
    metric('Modèle retenu', algo(P.principal), `meilleur F1 macro hors outil (critère de validation)`),
    metric('F1 macro', fmt(best.f1_macro, 3), `± ${fmt(best.f1_macro_fold_std, 2)} entre outils`),
    metric('Exactitude', pct(best.accuracy, 1), `référence classe majoritaire : ${pct(P.majority_baseline.accuracy, 1)}`),
    metric('Passes étiquetées', String(P.split.n_labelled), `${P.split.n_unlabelled} sans mesure VB (prédites, non évaluées)`)));
  const grid = h('div.grid');
  // matrice de confusion
  const L = P.labels, cmx = best.confusion, mx = Math.max(...cmx.flat());
  const short = { normal: 'Normal', usure_critique: 'Usure critique', defaut_mecanique: 'Défaut méca.' };
  const conf = h('div.ia-conf', { style: { gridTemplateColumns: `120px repeat(${L.length}, 1fr)` } }, h('div.ax'), L.map((l) => h('div.ax.top', short[l])),
    L.map((l, i) => [h('div.ax.left', short[l]), cmx[i].map((v, j) => h('div.cell', { title: `réel ${short[l]} → prédit ${short[L[j]]} : ${v}`, style: { background: i === j ? `rgba(37,99,235,${0.12 + 0.75 * v / mx})` : (v ? `rgba(194,65,12,${0.12 + 0.6 * v / mx})` : 'var(--surface-2)'), color: v / mx > 0.55 ? '#fff' : 'var(--text)' } }, String(v)))]));
  grid.append(panel(`Matrice de confusion — ${algo(P.principal)} (hors outil)`, { cls: 'c5', badges: [badge('experimental')] }, h('div.ia-conf-wrap', h('span.ia-axis-y', 'Classe réelle'), conf), h('div.ia-axis-x', 'Classe prédite'),
    note('Validation leave-one-tool-out : chaque passe est prédite par un modèle n\'ayant jamais vu son outil.')));
  // probabilités dans le temps pour l'outil choisi
  const th = hist.filter((r) => r.equipment_id === eq).sort((a, b) => a.t - b.t);
  const series = L.map((l, i) => ({ label: short[l], data: th.map((r) => ({ x: r.t, y: JSON.parse(r.probabilities)[l] })), color: C[i], width: 2, pointRadius: 2 }));
  const truth = th.filter((r) => r.true_label);
  grid.append(panel(`Probabilités par classe — outil ${eq.slice(-2)}`, { cls: 'c7' },
    legend(L.map((l, i) => [C[i], short[l]])),
    th.length ? plot('', (cv) => lineChart(cv, series, { xLabel: 'temps de coupe (min)', yLabel: 'probabilité', yMin: 0, yMax: 1, legend: false })) : h('div.ia-empty', 'Sélectionnez un outil.'),
    truth.length ? note(`Vérité mesurée (VB) : ${truth.map((r) => `${fmt(r.t, 0)} min → ${short[r.true_label]}`).join(' · ')}`) : null));
  // comparaison
  const rows = Object.entries(comp).map(([a, m]) => ({ a, ...m }));
  grid.append(panel('Comparaison Random Forest / XGBoost / SVM', { cls: 'c7' },
    table([{ k: 'a', label: 'Algorithme', fmt: (v) => h('span', algo(v), v === P.principal ? h('span.ia-best', 'retenu') : null) }, { k: 'accuracy', label: 'Exactitude', num: true, fmt: (v) => pct(v, 1) },
      { k: 'precision_macro', label: 'Précision', num: true, fmt: (v) => fmt(v, 3) }, { k: 'recall_macro', label: 'Rappel', num: true, fmt: (v) => fmt(v, 3) }, { k: 'f1_macro', label: 'F1 macro', num: true, fmt: (v) => fmt(v, 3) },
      { k: 'per_class_f1', label: 'F1 par classe (N / C / D)', fmt: (v) => v ? L.map((l) => fmt(v[l], 2)).join(' / ') : '—' }, { k: 'status', label: 'Statut', fmt: statusPill }], rows),
    note(`Référence « classe majoritaire » : F1 macro ${fmt(P.majority_baseline.f1_macro, 3)}. XGBoost était le candidat principal du cahier des charges ; le modèle retenu est celui qui obtient le meilleur F1 macro hors outil.`)));
  grid.append(panel('Variables les plus influentes', { cls: 'c5' },
    plot('tall', (cv) => barChart(cv, P.importance.slice(0, 10).map((r) => r.feature), [{ label: 'Importance par permutation (Δ F1)', data: P.importance.slice(0, 10).map((r) => r.perm_mean), color: C[0] }], { horizontal: true, legend: false }))));
  grid.append(panel('Historique des diagnostics', { cls: 'c12' },
    table([{ k: 'equipment_id', label: 'Outil' }, { k: 't', label: 'Temps (min)', num: true }, { k: 'value', label: 'Classe prédite', fmt: (v) => h(`span.ia-pill.${v === 'normal' ? 'ok' : v === 'usure_critique' ? 'warn' : 'fault'}`, short[v]) },
      { k: 'confidence', label: 'Confiance', num: true, fmt: (v) => pct(v, 0) }, { k: 'true_label', label: 'Vérité (VB)', fmt: (v) => (v ? short[v] : 'non mesurée') },
      { k: 'validation', label: 'VB (mm)', num: true, fmt: (v) => fmt(JSON.parse(v || '{}').VB_mm, 2) }, { k: 'status', label: 'Évaluation', fmt: (v) => (v === 'hors_outil' ? 'hors outil' : 'sans vérité') }], hist, { max: 300 })));
  body.append(grid);
  await renderDefauts(body);
  body.append(
    method('Méthode', ['Classes : normal VB < 0,3 mm ; usure critique 0,3 ≤ VB < 0,6 mm (fin de vie ISO 3685) ; défaut mécanique VB ≥ 0,6 mm.',
      '6 signaux (courant broche AC/DC, vibrations, émission acoustique) × 6 statistiques, en valeur brute et en écart à la première passe du même outil, + conditions de coupe et temps de coupe.',
      `Variables exclues (indéfinies) : ${(P.excluded_features || []).join(', ') || 'aucune'}.`, P.rule]));
}

// ------------------------------------------------------------------ diagnostic des 5 classes de défaut (maintenance préventive)
async function renderDefauts(body) {
  let d;
  try { d = await ML.module('defauts'); } catch { return; }
  const P = d.payload; if (!P) return;
  const CL = P.classes, ev = P.rover_eval, keys = Object.keys(CL);
  const tone = { surchauffe: 'fault', surpression: 'warn', defaut_electrique: 'info', defaut_capteur: 'none', surcharge_moteur: 'warn' };
  const SRC = ['HIRF (réel)', 'FEMTO (réel)', 'C-MAPSS (simulé NASA)', 'Rover (simulé)'];
  body.append(h('div.ia-sec-head.ia-sub-head', h('div', h('h2', 'Maintenance préventive — diagnostic des 5 classes de défaut'),
    h('p', 'Surchauffe, surpression, défaut électrique, défaut de capteur et surcharge moteur : règles techniques à seuils documentés, évaluées sur la vérité injectée de la télémétrie rover simulée puis appliquées aux mesures réelles HIRF et FEMTO.')),
  h('div.row')));
  const cnt = (cls) => P.counts.find((c) => c.classe === cls) || {};
  const card = (k) => { const e = ev[k], c = cnt(k), real = (c['HIRF (réel)'] || 0) + (c['FEMTO (réel)'] || 0);
    return h(`article.df-card.${k}`, h('div.df-top', h(`span.ia-pill.${tone[k]}`, CL[k].label), h('span.df-n', `${real} détection(s) réelle(s)`)),
      e ? h('div.df-metrics', h('div', h('b', pct(e.rappel_episodes, 0)), h('span', `épisodes détectés (${e.episodes_detectes}/${e.episodes})`)), h('div', h('b', pct(e.precision_echantillons, 0)), h('span', 'précision (échantillons)')),
        h('div', h('b', e.delai_median_h == null ? '—' : `${fmt(e.delai_median_h, 0)} h`), h('span', 'délai médian')))
        : h('div.df-metrics', h('div', h('b', `${P.surpression.units}/${P.surpression.units_total}`), h('span', 'turboréacteurs détectés')), h('div', h('b', `${fmt(P.surpression.median_rul_at_detection, 1)}`), h('span', 'cycles avant défaillance (médiane)'))),
      h('p.df-act', icon('wrench'), CL[k].action)); };
  body.append(h('div.df-grid', keys.map(card)));
  const grid = h('div.grid');
  const L = P.confusion.labels, M = P.confusion.matrix, mx = Math.max(...M.flat());
  const nm = (k) => (k === 'normal' ? 'Normal' : CL[k].label);
  grid.append(panel('Matrice de confusion — télémétrie rover simulée (après 800 h)', { cls: 'c6', badges: [badge('simulated')] },
    h('div.ia-conf-wrap', h('span.ia-axis-y', 'Classe réelle (injectée)'), h('div.ia-conf', { style: { gridTemplateColumns: `120px repeat(${L.length}, 1fr)` } }, h('div.ax'), L.map((l) => h('div.ax.top', nm(l))),
      L.map((l, i) => [h('div.ax.left', nm(l)), M[i].map((v, j) => h('div.cell', { title: `${nm(l)} → ${nm(L[j])} : ${v}`, style: { fontSize: '14px', background: i === j ? `rgba(37,99,235,${0.12 + 0.75 * v / mx})` : (v ? `rgba(232,89,12,${0.15 + 0.7 * Math.sqrt(v / mx)})` : 'rgba(255,255,255,.5)'), color: v / mx > 0.5 ? '#fff' : 'var(--text)' } }, String(v)))]))),
    h('div.ia-axis-x', 'Classe prédite (première règle déclenchée)'),
    note('Les surcharges sont parfois classées « défaut électrique » : une forte consommation fait aussi chuter la tension batterie (couplage physique). La perte de liaison, hors périmètre, est exclue.')));
  const srcCol = { 'HIRF (réel)': C[0], 'FEMTO (réel)': C[2], 'C-MAPSS (simulé NASA)': C[3], 'Rover (simulé)': C[1] };
  grid.append(panel('Détections par classe et par source', { cls: 'c6' },
    plot('', (c) => barChart(c, keys.map((k) => CL[k].label), SRC.map((sname) => ({ label: sname, data: keys.map((k) => cnt(k)[sname] || 0), color: srcCol[sname] })), { stacked: true, yLabel: 'détections' })),
    note('Données réelles (HIRF, FEMTO) : alertes à vérifier, sans vérité terrain. Surpression : aucun capteur de pression sur le rover ni sur HIRF / FEMTO, règle appliquée à la pression statique Ps30 des turboréacteurs C-MAPSS.')));
  const evs = P.events;
  grid.append(panel('Historique des défauts détectés et actions de maintenance préventive', { cls: 'c12' },
    h('div.row', { style: { marginBottom: '8px' } }, exportBtn('defauts_detectes', () => evs)),
    table([{ k: 'classe', label: 'Classe', fmt: (v) => h(`span.ia-pill.${tone[v]}`, CL[v].label) }, { k: 'source', label: 'Source' }, { k: 'equipement', label: 'Équipement / voie' },
      { k: 'debut', label: 'Début', num: true, fmt: (v, r) => `${fmt(v, 1)} ${r.unite}` }, { k: 'preuve', label: 'Preuve (règle)' }, { k: 'classe', label: 'Action préventive', fmt: (v) => CL[v].action },
      { k: 'provenance', label: 'Prov.', fmt: (v) => badge(v) }], evs, { max: 600 })));
  body.append(grid);
}

// ================================================================== 3. FIABILITÉ
async function renderFiabilite(body) {
  const d = await ML.module('fiabilite');
  const P = d.payload, wb = P.weibull_cmapss, wbb = P.weibull_battery, sv = P.survival;
  body.append(sec('Estimation intelligente de la fiabilité', 'Loi de Weibull (maximum de vraisemblance avec censure) et Random Survival Forest S(t | X).', d.computed_at,
    exportBtn('fiabilite', () => d.results)));
  const r200 = wb.horizons.find((x) => x.t === 200);
  body.append(kpis(metric('β (forme)', fmt(wb.beta, 2), `IC 90 % ${fmt(wb.beta_ci[0], 2)} – ${fmt(wb.beta_ci[1], 2)} · usure (β > 1)`),
    metric('η (échelle)', `${fmt(wb.eta, 0)} cycles`, `IC 90 % ${fmt(wb.eta_ci[0], 0)} – ${fmt(wb.eta_ci[1], 0)}`),
    metric('MTTF', `${fmt(wb.mttf, 0)} cycles`, 'η Γ(1 + 1/β)'), metric('R(200 cycles)', pct(r200.R, 1), `IC ${pct(r200.R_lo, 0)} – ${pct(r200.R_hi, 0)}`),
    metric('Observations', `${wb.n}`, `${wb.failures} défaillances · ${wb.censored} censurées`)));
  const grid = h('div.grid');
  const cv = wb.curve, km = wb.km;
  const kmPts = [{ x: 0, y: 1 }, ...km.map(([t, s]) => ({ x: t, y: s }))];
  grid.append(panel('Fonction de fiabilité R(t) — turboréacteurs FD001', { cls: 'c7', badges: [badge('simulated')] },
    legend([[C[0], 'Weibull R(t)'], [C[0] + '55', 'IC 90 %'], [C[1], 'Kaplan–Meier (non paramétrique)']]),
    plot('tall', (c) => lineChart(c, [{ label: 'IC haut', data: cv.t.map((t, i) => ({ x: t, y: cv.R_hi[i] })), color: C[0] + '00', fill: '+1', fillColor: C[0] + '22' },
      { label: 'IC bas', data: cv.t.map((t, i) => ({ x: t, y: cv.R_lo[i] })), color: C[0] + '00' },
      { label: 'Weibull', data: cv.t.map((t, i) => ({ x: t, y: cv.R[i] })), color: C[0], width: 2 },
      { label: 'Kaplan–Meier', data: kmPts, color: C[1], step: true, width: 1.5 }], { xLabel: 'cycles', yLabel: 'R(t)', yMin: 0, yMax: 1, legend: false }))));
  grid.append(panel('F(t) et taux de défaillance λ(t)', { cls: 'c5' },
    plot('', (c) => lineChart(c, [{ label: 'F(t)', data: cv.t.map((t, i) => ({ x: t, y: cv.F[i] })), color: C[1], width: 2 }], { xLabel: 'cycles', yLabel: 'F(t)', yMin: 0, yMax: 1, legend: false })),
    plot('short', (c) => lineChart(c, [{ label: 'λ(t)', data: cv.t.map((t, i) => ({ x: t, y: cv.h[i] })), color: C[2], width: 2 }], { xLabel: 'cycles', yLabel: 'λ(t) (1/cycle)', legend: false }))));
  grid.append(panel('Fiabilité à différents horizons', { cls: 'c6' },
    table([{ k: 't', label: 'Horizon (cycles)', num: true }, { k: 'R', label: 'R(t)', num: true, fmt: (v) => pct(v, 1) }, { k: 'R_lo', label: 'IC 90 %', num: true, fmt: (v, r) => `${pct(r.R_lo, 1)} – ${pct(r.R_hi, 1)}` },
      { k: 'F', label: 'F(t)', num: true, fmt: (v) => pct(v, 1) }, { k: 'h', label: 'λ(t) (×10⁻³/cycle)', num: true, fmt: (v) => fmt(v * 1000, 2) }], wb.horizons)));
  grid.append(panel('Cellules Li-ion NASA — Weibull (effectif faible)', { cls: 'c6', badges: [badge('experimental'), badge('substituted')] },
    wbb.ok ? kpis(metric('β', fmt(wbb.beta, 2), `IC ${fmt(wbb.beta_ci[0], 1)} – ${fmt(wbb.beta_ci[1], 1)}`), metric('η', `${fmt(wbb.eta, 0)} déch.`, `IC ${fmt(wbb.eta_ci[0], 0)} – ${fmt(wbb.eta_ci[1], 0)}`),
      metric('Cellules', `${wbb.n}`, `${wbb.failures} fins de vie · ${wbb.censored} censurées`)) : h('div.ia-empty', wbb.reason),
    callout('warn', 'Résultat indicatif', h('p', 'Quatre fins de vie observées seulement : intervalles larges. Le transfert vers la batterie du rover est une substitution non validée (conditions d\'essai différentes).'))));
  // RSF vs Weibull
  const comp = sv.comparison;
  const crow = Object.entries(comp).map(([a, m]) => ({ a, ...m }));
  grid.append(panel('S(t | X) : Random Survival Forest vs Weibull — C-MAPSS FD001–FD004', { cls: 'c7', badges: [badge('simulated')] },
    table([{ k: 'a', label: 'Modèle', fmt: algo }, { k: 'c_index', label: 'C-index ↑', num: true, fmt: (v) => fmt(v, 3) }, { k: 'ibs', label: 'Brier intégré ↓', num: true, fmt: (v) => fmt(v, 4) },
      { k: 'ibs_km', label: 'IBS Kaplan–Meier', num: true, fmt: (v) => fmt(v, 4) }, { k: 'train_time_s', label: 'Entraîn. (s)', num: true, fmt: (v) => fmt(v, 2) }], crow),
    plot('short', (c) => barChart(c, crow.map((r) => algo(r.a)), [{ label: 'C-index', data: crow.map((r) => r.c_index), color: C[0] }, { label: 'Brier intégré', data: crow.map((r) => r.ibs), color: C[1] }])),
    note(`${comp.random_survival_forest.n_train} unités d'apprentissage / ${comp.random_survival_forest.n_test} de test, ${pct(comp.random_survival_forest.censure_test, 0)} censurées. ${sv.note}`)));
  const ex = sv.examples.slice(0, 3);
  grid.append(panel('Survie conditionnelle de trois unités de test', { cls: 'c5' },
    legend([[C[0], 'RSF'], [C[1], 'Weibull AFT'], [NEUTRAL, 'Weibull population', true]]),
    plot('tall', (c) => lineChart(c, [...ex.flatMap((e, i) => [{ label: `RSF ${e.equipment_id.slice(7)}`, data: sv.grid.map((t, k) => ({ x: t, y: e.rsf[k] })), color: C[0], width: 1.4 + i * 0.4 },
      { label: `AFT ${e.equipment_id.slice(7)}`, data: sv.grid.map((t, k) => ({ x: t, y: e.aft[k] })), color: C[1], width: 1.4 + i * 0.4 }]),
      { label: 'Weibull population', data: sv.grid.map((t, k) => ({ x: t, y: sv.weibull_curve[k] })), color: NEUTRAL, dashed: true }], { xLabel: 'cycles', yLabel: 'S(t | X)', yMin: 0, yMax: 1, legend: false })),
    note(ex.map((e) => `${e.equipment_id} : ${e.event ? 'défaillance' : 'censure'} à ${fmt(e.t_obs, 0)} cycles`).join(' · '))));
  body.append(grid, method('Formules', ['R(t) = exp(−(t/η)^β) ; F(t) = 1 − R(t) ; λ(t) = (β/η)(t/η)^(β−1) ; MTTF = η Γ(1 + 1/β).',
    'Log-vraisemblance avec censure : ℓ = Σ δᵢ[ln β − β ln η + (β−1) ln tᵢ] − Σ (tᵢ/η)^β ; IC par information de Fisher observée (méthode delta).',
    'Censure : trajectoires de test interrompues avant défaillance (event = 0) ; aucune durée de vie inconnue n\'est remplacée par une date inventée.',
    'C-index de Harrell ; Brier score intégré pondéré IPCW (Graf et al., 1999) ; référence Kaplan–Meier sans covariable.']));
}

// ================================================================== 4. RUL
async function renderRul(body, params) {
  const d = await ML.module('rul');
  const P = d.payload, comp = P.comparison, best = P.best;
  const thr = { critique: +(params.crit || P.thresholds.critique), alerte: +(params.alert || P.thresholds.alerte) };
  const stateOf = (r) => (r <= thr.critique ? 'critique' : r <= thr.alerte ? 'alerte' : 'sain');
  const units = P.units.map((u) => ({ ...u, state: stateOf(u[best]) }));
  const eq = params.equipment && P.trajectories[params.equipment] ? params.equipment : units.slice().sort((a, b) => a[best] - b[best])[3].equipment_id;
  body.append(sec('Pronostic de durée de vie restante (RUL)', 'XGBoost (caractéristiques de fenêtre) et LSTM (séquences) sur les turboréacteurs C-MAPSS FD001.', d.computed_at,
    exportBtn('rul', () => units)));
  const crit = h('input.inp', { type: 'number', value: thr.critique, min: 1, 'aria-label': 'Seuil critique (cycles)' }), al = h('input.inp', { type: 'number', value: thr.alerte, min: 1, 'aria-label': 'Seuil d\'alerte (cycles)' });
  const sel = h('select.inp', { 'aria-label': 'Unité' }, P.units.map((u) => h('option', { value: u.equipment_id, selected: u.equipment_id === eq }, `Turboréacteur test ${u.equipment_id.slice(-3)}`)));
  const apply = () => rerender(body, { equipment: sel.value, crit: crit.value, alert: al.value });
  sel.addEventListener('change', apply);
  body.append(h('div.ia-filters', h('label.fld', h('span', 'Équipement'), sel), h('label.fld.sm', h('span', 'Seuil critique (cycles)'), crit), h('label.fld.sm', h('span', 'Seuil d\'alerte (cycles)'), al),
    h('button.btn.sm', { on: { click: apply } }, icon('filter'), 'Appliquer')));
  const b = comp[best], nCrit = units.filter((u) => u.state === 'critique').length, nAl = units.filter((u) => u.state === 'alerte').length;
  body.append(kpis(metric('Meilleur modèle (RMSE)', algo(best), `RMSE ${fmt(b.RMSE, 2)} · MAE ${fmt(b.MAE, 2)} cycles`), metric('R²', fmt(b.R2, 3), `référence constante RMSE ${fmt(P.baseline_constant.RMSE, 1)}`),
    metric('Score PHM08', fmt(b.score_PHM08, 0), 'pénalise davantage les retards'), metric('Unités critiques', String(nCrit), `RUL ≤ ${thr.critique} cycles`, nCrit ? 'fault' : ''),
    metric('Unités en alerte', String(nAl), `RUL ≤ ${thr.alerte} cycles`, nAl ? 'warn' : '')));
  const grid = h('div.grid');
  const tr = P.trajectories[eq], u = units.find((x) => x.equipment_id === eq);
  grid.append(panel(`Évolution de la RUL — ${eq}`, { cls: 'c8', badges: [badge('simulated')] },
    legend([[NEUTRAL, 'RUL réelle (vérité NASA)', true], [C[0], 'XGBoost'], [C[1], 'LSTM']]),
    plot('tall', (c) => lineChart(c, [{ label: 'RUL réelle', data: tr.cycle.map((x, i) => ({ x, y: tr.true[i] })), color: NEUTRAL, dashed: true, width: 2 },
      { label: 'XGBoost', data: tr.cycle.map((x, i) => ({ x, y: tr.xgboost[i] })), color: C[0], width: 2 }, { label: 'LSTM', data: tr.cycle.map((x, i) => ({ x, y: tr.lstm[i] })), color: C[1], width: 2 }],
    { xLabel: 'cycle', yLabel: 'RUL (cycles)', legend: false, yMin: 0, hlines: [{ y: thr.alerte, label: `alerte ${thr.alerte}`, color: WARN }, { y: thr.critique, label: `critique ${thr.critique}`, color: FAULT }] }))));
  grid.append(panel('État de santé et recommandation', { cls: 'c4' },
    h('div.ia-health', h(`div.ia-health-ring.${u.state}`, h('b', fmt(u[best], 0)), h('span', 'cycles')), h('div', h('strong', { class: `t-${u.state === 'sain' ? 'ok' : u.state === 'alerte' ? 'warn' : 'fault'}` }, u.state === 'sain' ? 'Sain' : u.state === 'alerte' ? 'Alerte' : 'Critique'),
      h('p', `Indice de santé HI = ${pct(Math.min(u[best], P.cap) / P.cap, 0)} · prédiction au cycle ${u.last_cycle}`), h('p.muted', `Calculé le ${dateFR(d.computed_at)} · RUL réelle ${fmt(u.true_rul, 0)} cycles`))),
    h('p.ia-reco', u.state === 'critique' ? 'Intervention préventive à planifier immédiatement ; vérifier l\'état réel avant décision.' : u.state === 'alerte' ? 'Préparer l\'intervention (pièces, ressources) et resserrer la surveillance.' : 'Aucune action ; poursuivre la surveillance.'),
    h('div.ia-mini', ['xgboost', 'lstm'].map((a) => h('div', h('span', algo(a)), h('b', `${fmt(u[a], 0)} cycles`))))));
  grid.append(panel('RUL prédite vs réelle au dernier cycle (100 unités de test)', { cls: 'c6' },
    legend([[C[0], 'XGBoost'], [C[1], 'LSTM'], [NEUTRAL, 'Prédiction parfaite', true]]),
    plot('tall', (c) => lineChart(c, [{ label: 'XGBoost', data: units.map((x) => ({ x: x.true_rul, y: x.xgboost })), color: C[0], showLine: false, pointRadius: 3.5 },
      { label: 'LSTM', data: units.map((x) => ({ x: x.true_rul, y: x.lstm })), color: C[1], showLine: false, pointRadius: 3.5, pointStyle: 'triangle' },
      { label: 'y = x', data: [{ x: 0, y: 0 }, { x: 150, y: 150 }], color: NEUTRAL, dashed: true }], { xLabel: 'RUL réelle (cycles)', yLabel: 'RUL prédite (cycles)', legend: false, xMin: 0, yMin: 0 }))));
  const rows = Object.entries(comp).map(([a, m]) => ({ a, ...m }));
  grid.append(panel('Comparaison XGBoost / LSTM', { cls: 'c6' },
    table([{ k: 'a', label: 'Modèle', fmt: (v) => h('span', algo(v), v === best ? h('span.ia-best', 'meilleur') : null) }, { k: 'MAE', label: 'MAE', num: true, fmt: (v) => fmt(v, 2) }, { k: 'RMSE', label: 'RMSE', num: true, fmt: (v) => fmt(v, 2) },
      { k: 'R2', label: 'R²', num: true, fmt: (v) => fmt(v, 3) }, { k: 'score_PHM08', label: 'Score PHM08', num: true, fmt: (v) => fmt(v, 0) }, { k: 'train_time_s', label: 'Entraîn. (s)', num: true, fmt: (v) => fmt(v, 1) },
      { k: 'predict_time_ms_per_obs', label: 'Prédiction (ms/obs)', num: true, fmt: (v) => fmt(v, 3) }], rows),
    P.lstm_history.length ? plot('short', (c) => lineChart(c, [{ label: 'Apprentissage', data: P.lstm_history.map((e) => ({ x: e.epoch, y: Math.sqrt(e.train_mse) * P.cap })), color: C[1], width: 2 },
      { label: 'Validation', data: P.lstm_history.map((e) => ({ x: e.epoch, y: Math.sqrt(e.val_mse) * P.cap })), color: C[0], width: 2 }], { xLabel: 'époque LSTM', yLabel: 'RMSE (cycles)' })) : null));
  grid.append(panel('Parc de turboréacteurs (test) — RUL au dernier cycle', { cls: 'c12' },
    table([{ k: 'equipment_id', label: 'Équipement' }, { k: 'last_cycle', label: 'Cycle', num: true }, { k: 'xgboost', label: 'RUL XGBoost', num: true }, { k: 'lstm', label: 'RUL LSTM', num: true },
      { k: 'true_rul', label: 'RUL réelle', num: true, fmt: (v) => fmt(v, 0) }, { k: 'state', label: 'État', fmt: (v) => h(`span.ia-pill.${v === 'sain' ? 'ok' : v === 'alerte' ? 'warn' : 'fault'}`, v) }],
    units.slice().sort((a, b) => a[best] - b[best]), { max: 100 })));
  body.append(grid, method('Méthode', [`Cible : RUL plafonnée à ${P.cap} cycles (début de vie non dégradé) ; fenêtre ${P.window} cycles ; normalisation min–max sur les unités d'apprentissage.`,
    '80 unités d\'apprentissage / 20 de validation (arrêt précoce) ; test = 100 unités NASA au dernier cycle observé.', P.note,
    'LSTM implémenté en NumPy (BPTT, Adam) — gradient vérifié par différences finies dans les tests.']));
}

// ================================================================== 5. MAINTENABILITÉ
async function renderMaint(body) {
  const d = await ML.module('maintenabilite');
  const P = d.payload, H = P.historical;
  body.append(sec('Maintenabilité et MTTR', 'MTTR historique (calcul) clairement séparé du MTTR prévisionnel (modèle).', d.computed_at, exportBtn('mttr', () => H.repairs || [])));
  body.append(kpis(metric('MTTR historique global', `${fmt(H.global_MTTR_h, 2)} h`, `${H.n_completed} réparations terminées`), metric('Réparations en cours', String(H.n_open), 'exclues du calcul'),
    metric('MTTR prévisionnel', 'non calculé', 'modèles en attente de données', 'warn')));
  const grid = h('div.grid');
  grid.append(panel('MTTR historique par équipement', { cls: 'c6', badges: [badge('simulated')] },
    plot('short', (c) => barChart(c, H.per_equipment.map((r) => r.equipment_id.replace('ROVER-', '')), [{ label: 'MTTR (h)', data: H.per_equipment.map((r) => r.MTTR_h), color: C[0] }], { yLabel: 'heures', legend: false })),
    table([{ k: 'equipment_id', label: 'Équipement' }, { k: 'n_repairs', label: 'Réparations', num: true }, { k: 'MTTR_h', label: 'MTTR (h)', num: true, fmt: (v) => fmt(v, 2) },
      { k: 'min_h', label: 'Min (h)', num: true, fmt: (v) => fmt(v, 2) }, { k: 'max_h', label: 'Max (h)', num: true, fmt: (v) => fmt(v, 2) }, { k: 'provenance', label: 'Prov.', fmt: (v) => badge(v) }], H.per_equipment)));
  grid.append(panel('Évolution du MTTR cumulé', { cls: 'c6' },
    legend(H.per_equipment.map((r, i) => [C[i], r.equipment_id.replace('ROVER-', '')])),
    plot('', (c) => lineChart(c, H.per_equipment.map((r, i) => ({ label: r.equipment_id, data: r.evolution.t.map((t, k) => ({ x: t, y: r.evolution.mttr_cum[k] })), color: C[i], step: true, width: 2, pointRadius: 3 })), { xLabel: 'temps de mission (h)', yLabel: 'MTTR cumulé (h)', legend: false, logY: true }))));
  grid.append(panel('MTTR prévisionnel — régression linéaire / Random Forest / XGBoost', { cls: 'c12' },
    h('div.ia-pending', Object.entries(P.models).map(([a, m]) => h('div', h('strong', algo(a)), statusPill(m.status)))),
    callout('warn', 'Aucune prédiction produite', h('p', P.models.xgboost && 'Le pipeline d\'entraînement est opérationnel et testé, mais aucun jeu fourni ne contient d\'interventions de réparation réelles.'), h('p', h('b', 'Données nécessaires : '), P.needed))));
  grid.append(panel('Historique des réparations', { cls: 'c12' },
    table([{ k: 'equipment_id', label: 'Équipement' }, { k: 't_start', label: 'Début (h)', num: true, fmt: (v) => fmt(v, 2) }, { k: 't_end', label: 'Fin (h)', num: true, fmt: (v) => fmt(v, 2) },
      { k: 'duration_h', label: 'Durée (h)', num: true, fmt: (v) => fmt(v, 2) }, { k: 'failure_type', label: 'Description' }, { k: 'source', label: 'Source' }, { k: 'provenance', label: 'Prov.', fmt: (v) => badge(v) }], H.repairs)));
  body.append(grid, method('Définitions', [P.definition, 'Seules les réparations terminées (date de fin renseignée) entrent dans le MTTR.', `Seuil d'entraînement : ${P.min_repairs} réparations terminées avec variables explicatives.`]));
}

// ================================================================== 6. DISPONIBILITÉ
async function renderDispo(body) {
  const d = await ML.module('disponibilite');
  const P = d.payload, E = P.equipment;
  body.append(sec('Disponibilité — historique et prévision', 'Indicateurs FMDS calculés sur le journal d\'événements ; la prévision reste distincte et n\'est produite qu\'avec des données suffisantes.', d.computed_at,
    exportBtn('disponibilite', () => E.map(({ evolution, periods, ...r }) => r))));
  body.append(kpis(...E.map((e) => metric(e.equipment_id.replace('ROVER-', ''), `Ao ${pct(e.Ao, 2)}`, `Ai ${pct(e.Ai, 2)} · MTBF ${fmt(e.MTBF_h, 0)} h · MTTR ${fmt(e.MTTR_h, 2)} h`)),
    metric('Disponibilité prévisionnelle', 'non calculée', 'en attente de données', 'warn')));
  const grid = h('div.grid');
  const per = E[0].periods.map((p) => p.period);
  grid.append(panel('Disponibilité opérationnelle par période de 500 h', { cls: 'c7', badges: [badge('simulated')] },
    legend(E.map((e, i) => [C[i], e.equipment_id.replace('ROVER-', '')])),
    plot('', (c) => barChart(c, per, E.map((e, i) => ({ label: e.equipment_id.replace('ROVER-', ''), data: e.periods.map((p) => p.Ao), color: C[i] })), { yLabel: 'Ao', legend: false }))));
  grid.append(panel('Évolution du MTBF cumulé', { cls: 'c5' },
    plot('', (c) => lineChart(c, E.map((e, i) => ({ label: e.equipment_id.replace('ROVER-', ''), data: e.evolution.map((v) => ({ x: v.t, y: v.MTBF_h })), color: C[i], width: 2, pointRadius: 3 })), { xLabel: 'temps (h)', yLabel: 'MTBF (h)' }))));
  grid.append(panel('Comparaison des équipements', { cls: 'c12' },
    table([{ k: 'equipment_id', label: 'Équipement' }, { k: 'failures', label: 'Pannes', num: true }, { k: 'uptime_h', label: 'Fonctionnement (h)', num: true, fmt: (v) => fmt(v, 1) },
      { k: 'downtime_failure_h', label: 'Arrêt panne (h)', num: true, fmt: (v) => fmt(v, 2) }, { k: 'downtime_planned_h', label: 'Arrêt planifié (h)', num: true, fmt: (v) => fmt(v, 2) },
      { k: 'MTBF_h', label: 'MTBF (h)', num: true, fmt: (v) => fmt(v, 1) }, { k: 'MTTR_h', label: 'MTTR (h)', num: true, fmt: (v) => fmt(v, 2) }, { k: 'Ai', label: 'Ai', num: true, fmt: (v) => pct(v, 2) },
      { k: 'Ao', label: 'Ao', num: true, fmt: (v) => pct(v, 2) }, { k: 'provenance', label: 'Prov.', fmt: (v) => badge(v) }], E)));
  grid.append(panel('Prévision de la disponibilité — régression linéaire / Random Forest / XGBoost', { cls: 'c12' },
    h('div.ia-pending', Object.entries(P.models).map(([a, m]) => h('div', h('strong', algo(a)), statusPill(m.status)))), callout('warn', 'Aucune prévision produite', h('p', P.reason), h('p', h('b', 'Données nécessaires : '), P.needed))));
  body.append(grid, method('Formules', Object.entries(P.formulas).map(([k, v]) => `${k} = ${v}`).concat(['U : temps de fonctionnement ; D_p : arrêts sur panne ; D_s : arrêts planifiés ; r : nombre de défaillances.',
    'Correction apportée à l\'application existante : l\'indicateur affiché « disponibilité » valait TBF / TR, c\'est-à-dire Ai ; Ao (tous arrêts) est désormais calculé séparément.'])));
}

// ================================================================== 7. SÉCURITÉ
function ftaNode(n, nodes, depth = 0) {
  const kids = nodes.filter((k) => k.parent_id === n.event_id);
  const p = n.p ?? n.probability;
  const val = p != null ? h('b', fmt(p, 4)) : n.bound ? h('span.muted', `non calculable · borne [${fmt(n.bound[0], 3)} ; ${fmt(n.bound[1], 3)}]`) : h('span.muted', 'probabilité non renseignée');
  const editable = n.kind === 'basic' && ML.canWrite();
  return h('li', h(`div.fta-node.${n.kind}`, n.gate ? h(`span.gate.${n.gate.toLowerCase()}`, n.gate === 'AND' ? 'ET' : 'OU') : null, h('div', h('span.lbl', n.label), h('span.val', val),
    n.prob_source ? h('span.src', n.prob_source) : null), editable ? h('button.btn.ghost.sm.icon', { title: 'Saisir la probabilité', 'aria-label': `Saisir la probabilité de ${n.label}`, on: { click: () => editProb(n) } }, icon('edit')) : null),
  kids.length ? h('ul', kids.map((k) => ftaNode(k, nodes, depth + 1))) : null);
}
function editProb(n) {
  const p = h('input.inp', { type: 'number', step: 'any', min: 0, max: 1, value: n.probability ?? '' }), src = h('input.inp', { placeholder: 'Source (base de données, retour d\'expérience…)' }), who = h('input.inp', { placeholder: 'Nom de l\'analyste' });
  const dlg = modal(`Probabilité — ${n.label}`, h('div.ia-form', h('label.fld', h('span', 'Probabilité sur l\'horizon (0–1, vide = non renseignée)'), p), h('label.fld', h('span', 'Source'), src), h('label.fld', h('span', 'Analyste'), who),
    h('div.row', h('button.btn.primary', { on: { click: async () => { try { await ML.setFtaProbability(n.event_id, p.value === '' ? null : +p.value, src.value, who.value); dlg.close(); toast('Probabilité enregistrée.', 'ok'); location.reload(); } catch (e) { toast(e.message, 'err'); } } } }, 'Enregistrer'))));
}
async function renderSecurite(body) {
  const d = await ML.module('securite');
  const P = d.payload, F = d.fmea, T = d.fta, ml = P.ml;
  body.append(sec('Analyse intelligente de la sécurité', 'AMDEC (NPR = G × O × D), arbre de défaillances et classification des situations à risque.', d.computed_at, exportBtn('amdec', () => F.rows)));
  const top = T.top;
  body.append(kpis(metric('Modes AMDEC', String(F.rows.length), `${F.rows.filter((r) => r.NPR >= F.thresholds.NPR_eleve).length} avec NPR ≥ ${F.thresholds.NPR_eleve}`),
    metric('NPR maximal', String(F.rows[0].NPR), F.rows[0].mode), metric('P(événement redouté)', top.p != null ? fmt(top.p, 4) : 'non calculable', top.bound ? `borne inférieure ${fmt(top.bound[0], 3)}` : `horizon ${P.horizon} décharges`, top.p == null ? 'warn' : ''),
    metric('Coupes minimales', String(T.cut_sets.length), `${T.cut_sets.filter((c) => c.length === 1).length} d'ordre 1`), metric('F1 risque (XGBoost)', fmt(ml.comparison.xgboost.f1, 3), `AUC ${fmt(ml.comparison.xgboost.auc_roc, 4)}`)));
  const grid = h('div.grid');
  const amdec = F.rows.map((r) => ({ ...r }));
  grid.append(panel('Tableau de criticité AMDEC', { cls: 'c12', badges: [] },
    table([{ k: 'fmea_id', label: 'ID' }, { k: 'equipment_name', label: 'Équipement' }, { k: 'subsystem', label: 'Sous-système' }, { k: 'mode', label: 'Mode de défaillance' }, { k: 'cause', label: 'Cause' }, { k: 'effect', label: 'Effet' },
      { k: 'G', label: 'G', num: true }, { k: 'O', label: 'O', num: true }, { k: 'D', label: 'D', num: true },
      { k: 'NPR', label: 'NPR', num: true, fmt: (v) => h(`span.ia-pill.${v >= 150 ? 'fault' : v >= 100 ? 'warn' : 'none'}`, String(v)) },
      ...(ML.canWrite() ? [{ k: 'fmea_id', label: '', fmt: (v, r) => h('button.btn.ghost.sm.icon', { 'aria-label': `Éditer ${v}`, on: { click: () => editFmea(r) } }, icon('edit')) }] : [])], amdec)));
  // matrice G × O
  const mtx = h('div.ia-risk', h('div.ax'), ...Array.from({ length: 10 }, (_, o) => h('div.ax.top', String(o + 1))));
  for (let g = 10; g >= 1; g--) {
    mtx.append(h('div.ax.left', String(g)));
    for (let o = 1; o <= 10; o++) {
      const here = F.rows.filter((r) => r.G === g && r.O === o), c = g * o;
      const zone = c >= 40 ? 'z4' : c >= 20 ? 'z3' : c >= 10 ? 'z2' : 'z1';
      mtx.append(h(`div.cell.${zone}${here.length ? '.has' : ''}`, { title: here.length ? here.map((r) => `${r.fmea_id} ${r.mode} (NPR ${r.NPR})`).join('\n') : `G ${g} × O ${o}` }, here.length ? String(here.length) : ''));
    }
  }
  grid.append(panel('Matrice des risques (gravité × occurrence)', { cls: 'c5' }, h('div.ia-risk-wrap', h('span.ia-axis-y', 'Gravité G'), mtx), h('div.ia-axis-x', 'Occurrence O'),
    legend([['#16A34A', 'G·O < 10'], ['#0284C7', '10–19'], ['#D97706', '20–39'], ['#DC2626', '≥ 40']])));
  grid.append(panel('Arbre de défaillances — perte de mobilité du rover', { cls: 'c7' },
    h('ul.fta', ftaNode(T.nodes.find((n) => n.kind === 'top'), T.nodes)),
    note('Hypothèse : événements de base indépendants. P(ET) = Π pᵢ ; P(OU) = 1 − Π(1 − pᵢ). Une probabilité manquante rend le parent non calculable ; la borne affichée est mathématiquement garantie.')));
  const imp = ml.importance.xgboost || [];
  const BAR = ['#2563EB', '#E8590C', '#0D9488', '#9333EA', '#DB2777', '#65A30D', '#0891B2', '#CA8A04', '#4F46E5', '#DC2626'];
  grid.append(panel('Variables associées au risque (XGBoost)', { cls: 'c5' },
    plot('tall', (c) => barChart(c, imp.map((r) => r[0]), [{ label: 'Gain', data: imp.map((r) => r[1]), colors: imp.map((_, i) => BAR[i % BAR.length]) }], { horizontal: true, legend: false }))));
  const rows = Object.entries(ml.comparison).map(([a, m]) => ({ a, ...m }));
  grid.append(panel(`Classification des situations à risque (${ml.risk_def})`, { cls: 'c7', badges: [badge('simulated')] },
    table([{ k: 'a', label: 'Modèle', fmt: algo }, { k: 'precision', label: 'Précision', num: true, fmt: (v) => pct(v, 1) }, { k: 'recall', label: 'Rappel', num: true, fmt: (v) => pct(v, 1) },
      { k: 'f1', label: 'F1', num: true, fmt: (v) => fmt(v, 3) }, { k: 'auc_roc', label: 'AUC', num: true, fmt: (v) => fmt(v, 4) }, { k: 'status', label: 'Statut', fmt: statusPill }], rows),
    legend(Object.keys(ml.roc).map((a, i) => [C[i], algo(a)])),
    plot('', (c) => lineChart(c, [...Object.entries(ml.roc).map(([a, r], i) => ({ label: algo(a), data: r.fpr.map((x, k) => ({ x, y: r.tpr[k] })), color: C[i], width: 2 })),
      { label: 'hasard', data: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: NEUTRAL, dashed: true }], { xLabel: 'taux de faux positifs', yLabel: 'taux de vrais positifs', xMin: 0, xMax: 1, yMin: 0, yMax: 1, legend: false })),
    note(rows.find((r) => r.a === 'isolation_forest')?.note || '')));
  body.append(grid);
}
function editFmea(r) {
  const f = (k) => h('input.inp', { type: 'number', min: 1, max: 10, value: r[k] });
  const G = f('G'), O = f('O'), D = f('D'), who = h('input.inp', { placeholder: 'Nom de l\'auteur (obligatoire)' });
  const dlg = modal(`${r.fmea_id} — ${r.mode}`, h('div.ia-form', h('div.row', h('label.fld.sm', h('span', 'Gravité G'), G), h('label.fld.sm', h('span', 'Occurrence O'), O), h('label.fld.sm', h('span', 'Détectabilité D'), D)),
    h('label.fld', h('span', 'Auteur'), who), h('button.btn.primary', { on: { click: async () => { try { const x = await ML.updateFmea(r.fmea_id, { G: +G.value, O: +O.value, D: +D.value }, who.value); toast(`NPR recalculé : ${x.NPR}`, 'ok'); dlg.close(); location.reload(); } catch (e) { toast(e.message, 'err'); } } } }, 'Enregistrer')));
}

// ================================================================== 8. COMPARAISON
const CMP = ['#2563EB', '#E8590C', '#0D9488', '#9333EA', '#DB2777', '#65A30D'];
async function renderComparaison(body) {
  const tasks = await ML.comparison();
  body.append(sec('Comparaison des algorithmes', 'Le meilleur modèle est désigné uniquement selon le critère de validation propre à chaque tâche, sur des données jamais vues à l\'apprentissage.', null,
    exportBtn('comparaison', () => tasks.flatMap((t) => t.rows.map((r) => ({ tache: t.task, algorithme: r.algorithm, statut: r.status, critere: t.criterion, valeur: r.key, ...r.metrics, train_time_s: r.train_time_s, predict_time_ms: r.predict_time_ms, n_train: r.n_train, n_test: r.n_test }))))));
  const LBL = { precision: 'Précision', recall: 'Rappel', f1: 'F1', auc_roc: 'AUC-ROC', fpr: 'Fausses alertes', lead_median_cycles: 'Avance (cycles)', accuracy: 'Exactitude', precision_macro: 'Précision macro',
    recall_macro: 'Rappel macro', f1_macro: 'F1 macro', f1_macro_fold_std: 'σ F1 (outils)', c_index: 'C-index', ibs: 'Brier intégré', ibs_km: 'IBS Kaplan–Meier', MAE: 'MAE', RMSE: 'RMSE', R2: 'R²', score_PHM08: 'Score PHM08', val_RMSE: 'RMSE validation' };
  const grid = h('div.grid');
  for (const t of tasks) {
    const cols = [{ k: 'algorithm', label: 'Algorithme', fmt: (v) => h('span', algo(v), v === t.best ? h('span.ia-best', 'meilleur') : null) }, { k: 'status', label: 'Statut', fmt: statusPill },
      ...t.metrics.map((m) => ({ k: m, label: LBL[m] || m, num: true, fmt: (v, r) => fmt(r.metrics[m], m.includes('PHM') || m.includes('lead') ? 0 : 3) })),
      { k: 'train_time_s', label: 'Entraîn. (s)', num: true, fmt: (v) => fmt(v, 2) }, { k: 'predict_time_ms', label: 'Préd. (ms/obs)', num: true, fmt: (v) => fmt(v, 3) },
      { k: 'n_train', label: 'n appr.', num: true }, { k: 'n_test', label: 'n test', num: true }];
    const scored = t.rows.filter((r) => r.key != null);
    grid.append(panel(t.task, { cls: 'c12', badges: [h('span.pill', `critère : ${LBL[t.criterion] || t.criterion} (${t.sense === 'max' ? 'max' : 'min'})`)] },
      h('div.ia-cmp', h('div', table(cols, t.rows)), scored.length ? h('div.ia-cmp-chart', plot('short', (c) => barChart(c, scored.map((r) => algo(r.algorithm)), [{ label: LBL[t.criterion], data: scored.map((r) => r.key), colors: scored.map((r, i) => CMP[i % CMP.length]) }], { legend: false, horizontal: true }))) : null),
      t.note ? callout('warn', null, h('p', t.note)) : null));
  }
  body.append(grid);
}

// ================================================================== 9. MODÈLES
async function renderModeles(body) {
  const regs = await ML.models();
  const live = ML.canWrite();
  const mods = [...new Set(regs.map((r) => r.module))];
  body.append(sec('Gestion et performance des modèles', 'Registre versionné : statut, jeu de données, découpage, métriques, temps et règle de validation. Le tableau de bord ne réentraîne jamais un modèle.', null,
    exportBtn('modeles', () => regs.map(({ metrics, hyperparams, features, split, ...r }) => ({ ...r, metrics: JSON.stringify(metrics) })))));
  const count = (s) => regs.filter((r) => r.is_active && r.status === s).length;
  body.append(kpis(metric('Modèles actifs', String(regs.filter((r) => r.is_active).length)), metric('Validés', String(count('valide')), null, 'ok'), metric('Entraînés (non validés)', String(count('entraine'))),
    metric('En attente de données', String(count('attente_donnees')), null, 'warn'), metric('En erreur (historique)', String(regs.filter((r) => r.status === 'erreur').length), 'entraînements interrompus', regs.some((r) => r.status === 'erreur') ? 'fault' : '')));
  for (const m of mods) {
    const rows = regs.filter((r) => r.module === m);
    const btn = live ? h('button.btn.sm.primary', { on: { click: async (e) => { e.currentTarget.classList.add('loading'); try { await ML.train(m); toast(`Entraînement « ${m} » lancé en arrière-plan.`, 'ok'); pollJobs(m); } catch (err) { toast(err.message, 'err'); } } } }, icon('refresh'), 'Réentraîner') : null;
    body.append(panel(`Module : ${m}`, { badges: [btn] },
      table([{ k: 'model_id', label: 'Identifiant', fmt: (v, r) => h('span', h('code', v), r.is_active ? h('span.ia-best', 'actif') : null) }, { k: 'algorithm', label: 'Algorithme', fmt: algo }, { k: 'version', label: 'Version', num: true },
        { k: 'status', label: 'Statut', fmt: statusPill }, { k: 'dataset', label: 'Jeu de données' }, { k: 'n_train', label: 'n appr.', num: true }, { k: 'n_test', label: 'n test', num: true },
        { k: 'train_time_s', label: 'Entraîn. (s)', num: true, fmt: (v) => fmt(v, 2) }, { k: 'created_at', label: 'Créé le', fmt: dateFR }, { k: 'validation_rule', label: 'Règle de validation' },
        { k: 'message', label: 'Message', fmt: (v) => v || '—' }], rows)));
  }
}
async function pollJobs(m) {
  for (let k = 0; k < 120; k++) {
    await new Promise((r) => setTimeout(r, 3000));
    const j = (await ML.jobs())[m];
    if (j && j.state !== 'en_cours') { toast(j.state === 'termine' ? `Module « ${m} » réentraîné.` : `Échec : ${j.error}`, j.state === 'termine' ? 'ok' : 'err'); location.reload(); return; }
  }
}

// ================================================================== 10. RECOMMANDATIONS
async function renderReco(body, params) {
  const all = await ML.recommendations();
  const RULE = { R1: 'Anomalie détectée', R2: 'Diagnostic d\'usure', R3: 'RUL sous le seuil', R4: 'Risque élevé', R5: 'Criticité AMDEC', R6: 'MTTR prédit élevé' };
  const prio = params.prio || '', rule = params.rule || '', q = (params.q || '').toLowerCase();
  const rows = all.filter((r) => (!prio || r.priority === prio) && (!rule || r.rule_id === rule) && (!q || r.equipment_id.toLowerCase().includes(q)));
  body.append(sec('Recommandations de maintenance', 'Générées par règles explicites à partir des résultats analytiques ; chacune reste à valider par un technicien ou un responsable.', all[0] ? all[0].generated_at : null,
    exportBtn('recommandations', () => rows)));
  const by = (p) => all.filter((r) => r.priority === p).length;
  body.append(kpis(metric('Recommandations', String(all.length), `${all.filter((r) => r.status === 'a_valider').length} à valider`), metric('Priorité haute', String(by('haute')), null, 'fault'),
    metric('Priorité moyenne', String(by('moyenne')), null, 'warn'), metric('Validées / rejetées', `${all.filter((r) => r.status === 'validee').length} / ${all.filter((r) => r.status === 'rejetee').length}`),
    metric('Règle R6 (MTTR prédit)', 'inactive', 'modèle en attente de données')));
  const selP = h('select.inp', { 'aria-label': 'Priorité' }, [['', 'Toutes priorités'], ['haute', 'Haute'], ['moyenne', 'Moyenne']].map(([v, l]) => h('option', { value: v, selected: v === prio }, l)));
  const selR = h('select.inp', { 'aria-label': 'Règle' }, [['', 'Toutes règles'], ...Object.entries(RULE)].map(([v, l]) => h('option', { value: v, selected: v === rule }, v ? `${v} — ${l}` : l)));
  const txt = h('input.inp', { placeholder: 'Équipement…', value: params.q || '', 'aria-label': 'Rechercher un équipement' });
  const apply = () => rerender(body, { prio: selP.value, rule: selR.value, q: txt.value });
  [selP, selR].forEach((s) => s.addEventListener('change', apply)); txt.addEventListener('keydown', (e) => e.key === 'Enter' && apply());
  body.append(h('div.ia-filters', h('label.fld', h('span', 'Priorité'), selP), h('label.fld', h('span', 'Règle'), selR), h('label.fld', h('span', 'Équipement'), txt), h('button.btn.sm', { on: { click: apply } }, icon('filter'), 'Filtrer')));
  const list = h('div.ia-recos');
  for (const r of rows.slice(0, 150)) {
    const ev = JSON.parse(r.evidence || '[]');
    list.append(h(`article.ia-reco-card.${r.priority}`, h('div.top', prioPill(r.priority), h('span.pill', `${r.rule_id} · ${RULE[r.rule_id]}`), h('strong', r.equipment_id), h('span.spacer'),
      h(`span.ia-pill.${r.status === 'validee' ? 'ok' : r.status === 'rejetee' ? 'none' : 'info'}`, r.status === 'a_valider' ? 'à valider' : r.status)),
    h('p.reason', r.reason), h('p.action', icon('wrench'), r.action),
    h('div.meta', h('span', `Généré le ${dateFR(r.generated_at)}`), h('span', 'Preuves : ', ev.map((e) => h('code', `${e.table}#${e.id}`))), r.validated_by ? h('span', `Décision : ${r.validated_by} le ${dateFR(r.validated_at)}${r.comment ? ' — ' + r.comment : ''}`) : null),
    r.status === 'a_valider' && ML.canWrite() ? h('div.row', h('button.btn.sm.primary', { on: { click: () => decide(r, 'validee') } }, icon('check'), 'Valider'), h('button.btn.sm', { on: { click: () => decide(r, 'rejetee') } }, icon('x'), 'Rejeter')) : null));
  }
  body.append(rows.length ? list : h('div.ia-empty', 'Aucune recommandation pour ces filtres.'));
}
function decide(r, decision) {
  const who = h('input.inp', { placeholder: 'Nom et fonction (obligatoire)' }), com = h('input.inp', { placeholder: 'Commentaire (facultatif)' });
  const dlg = modal(`${decision === 'validee' ? 'Valider' : 'Rejeter'} la recommandation`, h('div.ia-form', h('p', r.reason), h('label.fld', h('span', 'Validateur'), who), h('label.fld', h('span', 'Commentaire'), com),
    h('button.btn.primary', { on: { click: async () => { try { await ML.validateReco(r.id, decision, who.value, com.value); toast('Décision enregistrée et tracée.', 'ok'); dlg.close(); location.reload(); } catch (e) { toast(e.message, 'err'); } } } }, 'Confirmer')));
}

// ================================================================== 11. AUDIT
async function renderAudit(body) {
  const a = await ML.audit();
  body.append(sec('Audit de l\'application initiale et des données', 'État de chaque fonctionnalité avant intervention, corrections apportées et données disponibles.', null, exportBtn('audit', () => AUDIT)));
  const k = (s) => AUDIT.filter((x) => x.state === s).length;
  body.append(kpis(metric('Correctes', String(k('correct')), null, 'ok'), metric('Incorrectes (corrigées)', String(k('incorrect')), null, 'fault'), metric('Partielles', String(k('partiel')), null, 'warn'),
    metric('Absentes (ajoutées)', String(k('absent'))), metric('Non validables (données)', String(k('impossible')), null, 'warn')));
  const LBL = { correct: ['ok', 'Existante et correcte'], incorrect: ['fault', 'Existante mais incorrecte'], partiel: ['warn', 'Partiellement implémentée'], absent: ['info', 'Absente → ajoutée'], impossible: ['none', 'Impossible à valider (données)'] };
  body.append(panel('Rapport d\'audit par fonctionnalité', {},
    table([{ k: 'area', label: 'Domaine' }, { k: 'feature', label: 'Fonctionnalité' }, { k: 'state', label: 'Constat', fmt: (v) => h(`span.ia-pill.${LBL[v][0]}`, LBL[v][1]) }, { k: 'finding', label: 'Analyse' }, { k: 'action', label: 'Action' }], AUDIT, { max: 200 })));
  const grid = h('div.grid');
  grid.append(panel('Données disponibles en base', { cls: 'c12' },
    table([{ k: 'dataset', label: 'Jeu' }, { k: 'kind', label: 'Équipement' }, { k: 'n', label: 'Unités', num: true }, { k: 'unit', label: 'Unité de temps' }, { k: 'provenance', label: 'Provenance', fmt: (v) => badge(v) }], a.datasets),
    kpis(metric('Mesures', fmt(a.sensor_data, 0)), metric('Valeurs manquantes', fmt(a.missing_values, 0), 'conservées, jamais imputées'), metric('Durées de vie', String(a.failure_history), `${a.failures_observed} défaillances · ${a.censored} censures`))));
  body.append(grid);
}

// ================================================================== 12. FEMTO & HIRF
function heatmap(cols, m, short = (c) => c) {
  const n = cols.length;
  const g = h('div.ia-heat', { style: { gridTemplateColumns: `110px repeat(${n}, minmax(0, 1fr))` } }, h('div'), cols.map((c) => h('div.ax.top', { title: c }, short(c))));
  cols.forEach((r, i) => { g.append(h('div.ax.left', { title: r }, short(r)));
    m[i].forEach((v, j) => { const a = Math.abs(v ?? 0), col = (v ?? 0) >= 0 ? `rgba(37,99,235,${a})` : `rgba(232,89,12,${a})`;
      g.append(h('div.cell', { title: `${r} × ${cols[j]} : ρ = ${fmt(v, 2)}`, style: { background: col, color: a > .55 ? '#fff' : 'var(--text)' } }, n <= 14 ? fmt(v, 1) : '')); }); });
  return h('div.ia-heat-wrap', g, legend([['#2563EB', 'corrélation positive'], ['#E8590C', 'corrélation négative']]));
}
async function renderRefs(body, params) {
  const d = await ML.module('references');
  const P = d.payload || {}, F = P.femto, Hh = P.hirf;
  if (!F && !Hh) { body.append(callout('err', 'Jeux non chargés', h('p', 'Lancez : python -m mrh.cli ingest --raw-dir <dossier> puis python -m mrh.cli all.'))); return; }
  body.append(sec('Jeux de référence FEMTO (roulements) et HIRF (batteries d\'avion électrique)', 'Analyse statistique complète, fiabilité, anomalies et pronostic sur les mesures réelles de laboratoire fournies.', d.computed_at));
  const sub = params.part === 'hirf' ? 'hirf' : 'femto';
  body.append(h('div.ia-seg', ['femto', 'hirf'].map((k) => h('a', { href: `#/ia?tab=references&part=${k}`, class: k === sub ? 'on' : '' }, k === 'femto' ? 'Roulements FEMTO / PRONOSTIA' : 'Batteries HIRF — Edge 540'))));
  const grid = h('div.grid');
  if (sub === 'femto' && F) {
    const r = F.reliability, cmp = F.rul.comparison, det = F.detection, B = F.bearings;
    const nDet = det.filter((x) => x.if_alarm_h != null).length;
    body.append(kpis(metric('Roulements', String(B.length), `${B.filter((b) => b.split === 'learning').length} apprentissage · ${B.filter((b) => b.split !== 'learning').length} test · ${F.n_snapshots.toLocaleString('fr-FR')} instantanés`),
      metric('Weibull β · η', `${fmt(r.beta, 2)} · ${fmt(r.eta, 2)} h`, `IC 90 % β ${fmt(r.beta_ci[0], 2)}–${fmt(r.beta_ci[1], 2)}`),
      metric('MTTF · B10', `${fmt(r.mttf, 2)} h · ${fmt(r.b10, 2)} h`, `adéquation KS p = ${fmt(r.ks_p, 2)}`),
      metric('Meilleure RUL (MAE test)', `${fmt(cmp[F.rul.best].MAE, 2)} h`, algo(F.rul.best === 'weibull_mrl' ? 'Weibull MRL' : F.rul.best), F.rul.best === 'weibull_mrl' ? 'warn' : 'ok'),
      metric('Alarmes Isolation Forest', `${nDet} / ${det.length}`, 'roulements avec alarme persistante')));
    const condCol = { 1: C[0], 2: C[1], 3: C[2] };
    const T = F.trajectories;
    grid.append(panel('Évolution du RMS horizontal en fonction de la fraction de vie (17 roulements)', { cls: 'c8', badges: [badge('experimental')] },
      legend(Object.entries(F.conditions).map(([k, v]) => [condCol[k], `Condition ${k} — ${v}`])),
      plot('tall', (c) => lineChart(c, Object.entries(T).map(([b, t]) => ({ label: b, data: t.frac.map((x, i) => ({ x, y: t.h_rms[i] })), color: condCol[+b[7]], width: 1.4, fill: false })), { xLabel: 'fraction de la durée de vie', yLabel: 'RMS horizontal (g)', logY: true, legend: false })),
      note(`Le RMS reste stable sur la majeure partie de la vie puis croît brutalement : rapport fin / début médian ×${fmt(median(B.map((b) => b.ratio_h_rms)), 1)} (min ×${fmt(Math.min(...B.map((b) => b.ratio_h_rms)), 1)}, max ×${fmt(Math.max(...B.map((b) => b.ratio_h_rms)), 1)}). La dégradation est tardive et non linéaire, ce qui limite toute extrapolation précoce.`)));
    const hb = F.hist, mids = hb.edges_log10.slice(0, -1).map((e, i) => (e + hb.edges_log10[i + 1]) / 2);
    grid.append(panel('Distribution du RMS horizontal par phase de vie', { cls: 'c4' },
      plot('tall', (c) => barChart(c, mids.map((x) => fmt(10 ** x, 2)), Object.entries(hb.counts).map(([k, v], i) => ({ label: k, data: v, color: C[i] })), { yLabel: 'instantanés' })),
      note('Échelle logarithmique en abscisse (g). La phase 90–100 % se déplace nettement vers les fortes amplitudes : signature exploitable pour la détection, pas pour l\'anticipation lointaine.')));
    grid.append(panel('Corrélations de Spearman entre indicateurs et fraction de vie', { cls: 'c6' },
      heatmap(F.corr.cols, F.corr.m, (c) => c.replace('_band_', ' ').replace('life_frac', 'vie')),
      note(`Corrélation avec la fraction de vie : ${F.corr.cols.slice(0, -1).map((c, i) => [c, F.corr.m[i][F.corr.cols.length - 1]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3).map(([c, v]) => `${c} ρ = ${fmt(v, 2)}`).join(', ')}. Les RMS horizontaux et verticaux sont fortement liés entre eux (redondance).`)));
    grid.append(panel('Fiabilité R(t) — Weibull sur les 17 durées de vie', { cls: 'c6', badges: [badge('experimental')] },
      legend([[C[0], 'Weibull R(t)'], [C[0] + '55', 'IC 90 %'], [C[1], 'Kaplan–Meier']]),
      plot('', (c) => lineChart(c, [{ label: 'IC haut', data: r.grid.map((t, i) => ({ x: t, y: r.R_hi[i] })), color: C[0] + '00', fill: '+1', fillColor: C[0] + '22' },
        { label: 'IC bas', data: r.grid.map((t, i) => ({ x: t, y: r.R_lo[i] })), color: C[0] + '00', fill: false },
        { label: 'Weibull', data: r.grid.map((t, i) => ({ x: t, y: r.R[i] })), color: C[0], width: 2.4, fill: false },
        { label: 'Kaplan–Meier', data: [{ x: 0, y: 1 }, ...r.km.map(([t, v]) => ({ x: t, y: v }))], color: C[1], step: true, fill: false }], { xLabel: 'heures d\'essai accéléré', yLabel: 'R(t)', yMin: 0, yMax: 1, legend: false })),
      table([{ k: 'condition', label: 'Condition' }, { k: 'count', label: 'n', num: true }, { k: 'median', label: 'Médiane (h)', num: true, fmt: (v) => fmt(v, 2) }, { k: 'min', label: 'Min (h)', num: true, fmt: (v) => fmt(v, 2) }, { k: 'max', label: 'Max (h)', num: true, fmt: (v) => fmt(v, 2) }], r.by_condition),
      note(`β = ${fmt(r.beta, 2)} > 1 : taux de défaillance croissant (usure). Les durées diffèrent selon la condition (Kruskal–Wallis p = ${fmt(r.kruskal_p, 3)}) : la loi commune mélange trois régimes, résultat valable pour ce banc d'essai accéléré uniquement.`)));
    const sel = params.fb && F.det_series[params.fb] ? params.fb : 'Bearing1_3';
    const ds = F.det_series[sel], dd = det.find((x) => x.bearing === sel);
    const pick = h('select.inp', { 'aria-label': 'Roulement', on: { change: (e) => rerender(body, { ...params, part: 'femto', fb: e.target.value }) } }, Object.keys(F.det_series).map((b) => h('option', { value: b, selected: b === sel }, b)));
    grid.append(panel('Détection d\'anomalies — score Isolation Forest', { cls: 'c6', badges: [pick] },
      plot('', (c) => lineChart(c, [{ label: 'score', data: ds.t_h.map((x, i) => ({ x, y: ds.score[i] })), color: C[3], width: 1.6 }], { xLabel: 'heures', yLabel: 'score', legend: false,
        hlines: [{ y: ds.thr, label: 'seuil', color: FAULT }], vlines: [dd.if_alarm_h != null ? { x: dd.if_alarm_h, label: 'alarme IF', color: WARN } : null, dd.rule_alarm_h != null ? { x: dd.rule_alarm_h, label: 'RMS × 3', color: C[0] } : null].filter(Boolean) })),
      note(`${sel} : vie ${fmt(dd.life_h, 2)} h ; alarme IF ${dd.if_alarm_h != null ? `à ${fmt(dd.if_alarm_h, 2)} h (${pct(dd.if_alarm_frac, 0)} de la vie)` : 'absente'} ; règle RMS × 3 ${dd.rule_alarm_h != null ? `à ${fmt(dd.rule_alarm_h, 2)} h` : 'jamais franchie'}.`)));
    grid.append(panel('Avance de détection avant défaillance', { cls: 'c6' },
      plot('', (c) => barChart(c, det.map((x) => x.bearing.replace('Bearing', '')), [{ label: 'Isolation Forest', data: det.map((x) => x.if_lead_h ?? 0), color: C[3] }, { label: 'Règle RMS × 3', data: det.map((x) => x.rule_lead_h ?? 0), color: C[0] }], { yLabel: 'heures avant fin' })),
      note(`Isolation Forest : alarme médiane à ${pct(median(det.map((x) => x.if_alarm_frac).filter((v) => v != null)), 0)} de la vie — souvent juste après la période de référence, ce qui traduit la non-stationnarité du début d'essai plus qu'un défaut certain (risque de fausse alarme). Règle RMS × 3 : alarme tardive (médiane ${pct(median(det.map((x) => x.rule_alarm_frac).filter((v) => v != null)), 0)} de la vie), ${det.filter((x) => x.rule_alarm_h == null).length} roulement(s) jamais détecté(s). Sans instant de défaut de référence, précision et rappel ne sont pas calculables.`)));
    const rows = Object.entries(cmp).map(([a, m]) => ({ a, ...m }));
    const tsel = params.tb && F.rul.trajectories[params.tb] ? params.tb : Object.keys(F.rul.trajectories)[0];
    const tr = F.rul.trajectories[tsel];
    const pickT = h('select.inp', { 'aria-label': 'Roulement de test', on: { change: (e) => rerender(body, { ...params, part: 'femto', tb: e.target.value }) } }, Object.keys(F.rul.trajectories).map((b) => h('option', { value: b, selected: b === tsel }, b)));
    grid.append(panel('Pronostic RUL — roulements de test jamais vus', { cls: 'c7', badges: [pickT] },
      legend([[NEUTRAL, 'RUL réelle', true], [C[2], 'Weibull MRL (référence)'], [C[0], 'XGBoost'], [C[1], 'Random Forest']]),
      plot('', (c) => lineChart(c, [{ label: 'RUL réelle', data: tr.t_h.map((x, i) => ({ x, y: tr.true[i] })), color: NEUTRAL, dashed: true, width: 2 },
        { label: 'Weibull MRL', data: tr.t_h.map((x, i) => ({ x, y: tr.weibull_mrl[i] })), color: C[2], fill: false },
        { label: 'XGBoost', data: tr.t_h.map((x, i) => ({ x, y: tr.xgboost[i] })), color: C[0], fill: false },
        { label: 'Random Forest', data: tr.t_h.map((x, i) => ({ x, y: tr.random_forest[i] })), color: C[1], fill: false }], { xLabel: 'heures d\'essai', yLabel: 'RUL (h)', yMin: 0, legend: false }))));
    grid.append(panel('Comparaison des modèles de RUL (11 roulements de test)', { cls: 'c5' },
      table([{ k: 'a', label: 'Modèle', fmt: (v) => h('span', v === 'weibull_mrl' ? 'Weibull MRL' : algo(v), v === F.rul.best ? h('span.ia-best', 'meilleur') : null) }, { k: 'MAE', label: 'MAE (h)', num: true, fmt: (v) => fmt(v, 2) },
        { k: 'RMSE', label: 'RMSE (h)', num: true, fmt: (v) => fmt(v, 2) }, { k: 'R2', label: 'R²', num: true, fmt: (v) => fmt(v, 2) }, { k: 'MAE_90pct', label: 'MAE à 90 % vie', num: true, fmt: (v) => fmt(v, 2) }], rows),
      plot('short', (c) => barChart(c, ['50 %', '75 %', '90 %'], rows.map((r0, i) => ({ label: r0.a === 'weibull_mrl' ? 'Weibull MRL' : algo(r0.a), data: [r0.MAE_50pct, r0.MAE_75pct, r0.MAE_90pct], color: [C[2], C[0], C[1]][i] })), { yLabel: 'MAE (h)' })),
      note(`Avec 6 roulements d'apprentissage et des durées de vie très dispersées (${fmt(Math.min(...B.map((b) => b.life_h)), 2)} à ${fmt(Math.max(...B.map((b) => b.life_h)), 2)} h), les modèles par apprentissage ${F.rul.best === 'weibull_mrl' ? 'ne battent pas' : 'battent'} la référence statistique fondée sur le seul temps écoulé : ils ne sont pas validés. Validation croisée « un roulement exclu » XGBoost : MAE ${fmt(cmp.xgboost.cv_mae_mean, 2)} ± ${fmt(cmp.xgboost.cv_mae_std, 2)} h.`)));
    grid.append(panel('Synthèse par roulement', { cls: 'c12' }, table([{ k: 'bearing', label: 'Roulement' }, { k: 'split', label: 'Jeu', fmt: (v) => (v === 'learning' ? 'apprentissage' : 'test complet') }, { k: 'condition', label: 'Cond.', num: true },
      { k: 'life_h', label: 'Durée de vie (h)', num: true, fmt: (v) => fmt(v, 2) }, { k: 'snapshots', label: 'Instantanés', num: true }, { k: 'h_rms_ref', label: 'RMS réf. (g)', num: true, fmt: (v) => fmt(v, 3) },
      { k: 'ratio_h_rms', label: 'RMS fin / réf.', num: true, fmt: (v) => `×${fmt(v, 1)}` }, { k: 'h_kurt_max', label: 'Kurtosis max', num: true, fmt: (v) => fmt(v, 1) }, { k: 'peak_end_g', label: 'Crête finale (g)', num: true, fmt: (v) => fmt(v, 1) }], B)));
    body.append(grid);
  }
  if (sub === 'hirf' && Hh) {
    const R = Hh.runs, Tn = Hh.trend, S = Hh.series, q = Hh.qc;
    const sig = Tn.filter((t) => t.p_value < 0.05);
    body.append(kpis(metric('Essais', String(R.length), `${fmt(R.reduce((a, r) => a + r.duration_s, 0) / 3600, 1)} h d'enregistrement à 200 Hz`),
      metric('Résistance interne (médiane)', `${fmt(Tn[0].R_median_ohm * 1000, 0)} / ${fmt(Tn[2].R_median_ohm * 1000, 0)} mΩ`, 'packs 20 V / 40 V'),
      metric('Hausse significative de R', `${sig.length} / 4 packs`, sig.map((t) => `${t.pack} (p = ${fmt(t.p_value, 3)})`).join(' · ') || 'aucune', sig.length ? 'warn' : ''),
      metric('Essais avec mesures invalides', String(q.runs_with_invalid), `températures inexploitables : essais ${q.temp_all_invalid_runs.join(', ') || '—'}`, 'warn'),
      metric('Essais atypiques (IF)', String(Hh.anomalies.length), Hh.anomalies.map((a) => a.run).join(', '))));
    const t = S.t_s.map((x) => x / 60);
    const sv = (k) => t.map((x, i) => ({ x, y: S[k] ? S[k][i] : null }));
    grid.append(panel(`Essai représentatif n° ${Hh.rep_run} — régime moteur et tensions des packs`, { cls: 'c6', badges: [badge('experimental')] },
      plot('short', (c) => lineChart(c, [{ label: 'RPM', data: sv('RPM'), color: C[3] }], { xLabel: 'minutes', yLabel: 'tr/min', legend: false })),
      legend(['LLF20V', 'ULA20V', 'LRF20V', 'URA20V'].filter((k) => S[k]).map((k, i) => [C[i], k])),
      plot('', (c) => lineChart(c, ['LLF20V', 'ULA20V', 'LRF20V', 'URA20V'].filter((k) => S[k]).map((k, i) => ({ label: k, data: sv(k), color: C[i], fill: false, spanGaps: true })), { xLabel: 'minutes', yLabel: 'tension (V)', legend: false })),
      note('Moyennes par fenêtre de 10 s. Chaque montée en régime provoque une chute de tension immédiate (résistance interne) puis une décroissance lente (décharge).')));
    grid.append(panel('Courants et températures (même essai)', { cls: 'c6' },
      legend(['LLF20C', 'ULA20C'].filter((k) => S[k]).map((k, i) => [C[i], k])),
      plot('short', (c) => lineChart(c, ['LLF20C', 'ULA20C'].filter((k) => S[k]).map((k, i) => ({ label: k, data: sv(k), color: C[i], fill: false })), { xLabel: 'minutes', yLabel: 'courant (A)', legend: false })),
      legend(['LLF20T', 'ULA20T', 'LRF40T', 'URA40T'].map((k, i) => [C[i], k])),
      plot('short', (c) => lineChart(c, ['LLF20T', 'ULA20T', 'LRF40T', 'URA40T'].map((k, i) => ({ label: k, data: sv(k), color: C[i], fill: false, spanGaps: true })), { xLabel: 'minutes', yLabel: 'température (unité non documentée)', legend: false })),
      note('LLF20 et LRF40 ont des courants identiques, de même que ULA20 et URA40 : les packs sont montés en série deux à deux (deux circuits : LLF20 + LRF40 et ULA20 + URA40). Températures : unité non fournie ; valeurs initiales ≈ 75 compatibles avec des °F.')));
    if (Hh.bhm) {
      const bt = Hh.bhm.t_s.map((x) => x / 60);
      grid.append(panel('Moniteur de santé embarqué (BHM) — SOC et RUL prédits', { cls: 'c6' },
        legend(['LLF', 'ULA', 'LRF', 'URA'].map((p, i) => [C[i], p])),
        plot('short', (c) => lineChart(c, ['LLF', 'ULA', 'LRF', 'URA'].map((p, i) => ({ label: p, data: bt.map((x, k) => ({ x, y: Hh.bhm[`${p}_SOC_med`][k] })), color: C[i], fill: false })), { xLabel: 'minutes', yLabel: 'SOC (%)', legend: false })),
        plot('short', (c) => lineChart(c, [{ label: 'RUL ULA (médiane)', data: bt.map((x, k) => ({ x, y: Hh.bhm.ULA_RUL_med[k] })), color: C[1] },
          { label: 'p95', data: bt.map((x, k) => ({ x, y: Hh.bhm.ULA_RUL_p95[k] })), color: C[1] + '66', dashed: true }, { label: 'p05', data: bt.map((x, k) => ({ x, y: Hh.bhm.ULA_RUL_p05[k] })), color: C[1] + '66', dashed: true }], { xLabel: 'minutes', yLabel: 'RUL prédite (s)', legend: false })),
        table([{ k: 'pack', label: 'Pack' }, { k: 'eod_iqr_median_s', label: 'Dispersion EOD (s)', num: true }, { k: 'soc_end_median', label: 'SOC final médian (%)', num: true }, { k: 'rul_end_median_s', label: 'RUL finale médiane (s)', num: true }], Hh.bhm_stability),
        note('Les sorties BHM (27 échantillons par instant, résumés ici par médiane et percentiles 5–95) sont des prédictions de l\'algorithme embarqué. Aucune décharge n\'atteint le seuil de fin de décharge : la justesse de ces prédictions n\'est pas vérifiable avec ces données ; seule leur stabilité est mesurée.')));
    }
    grid.append(panel('Résistance interne apparente au fil des essais', { cls: 'c6', badges: [badge('experimental')] },
      legend(PACKS_H.map((p, i) => [C[i], p])),
      plot('', (c) => lineChart(c, PACKS_H.map((p, i) => ({ label: p, data: R.map((r, k) => ({ x: k + 1, y: r[`${p}_R_ohm`] != null ? r[`${p}_R_ohm`] * 1000 : null })), color: C[i], showLine: false, pointRadius: 3.5 })), { xLabel: 'rang de l\'essai (ordre des numéros)', yLabel: 'R (mΩ)', legend: false })),
      table([{ k: 'pack', label: 'Pack' }, { k: 'R_first10', label: 'R 10 premiers (mΩ)', num: true, fmt: (v) => fmt(v * 1000, 1) }, { k: 'R_last10', label: 'R 10 derniers (mΩ)', num: true, fmt: (v) => fmt(v * 1000, 1) },
        { k: 'slope_mohm_per_run', label: 'Pente (mΩ/essai)', num: true, fmt: (v, r0) => `${fmt(v, 2)} ± ${fmt(r0.slope_ci95_mohm, 2)}` }, { k: 'spearman_rho', label: 'ρ Spearman', num: true, fmt: (v) => fmt(v, 2) }, { k: 'p_value', label: 'p', num: true, fmt: (v) => fmt(v, 3) }], Tn),
      note('R estimée par moindres carrés V = E₀ − R·I − k·Ah sur les points I > 2 A. Les packs 40 V (≈ 10 éléments) ont une résistance ≈ double des packs 20 V, cohérent avec un montage série. Packs à hausse significative (p < 0,05) : ' + (sig.map((t0) => t0.pack).join(', ') || 'aucun') + ' — ULA20 et URA40 forment le même circuit série. La hausse reste confondue avec la température et l\'état de charge initial, qui varient d\'un essai à l\'autre.')));
    grid.append(panel('Énergie et charge débitées par essai', { cls: 'c6' },
      plot('', (c) => barChart(c, R.map((r) => String(r.run)), [{ label: 'LLF20 (Ah)', data: R.map((r) => r.LLF20_Ah), color: C[0] }, { label: 'ULA20 (Ah)', data: R.map((r) => r.ULA20_Ah), color: C[1] }], { yLabel: 'Ah' })),
      note(`Charge débitée par essai : médiane ${fmt(median(R.map((r) => r.LLF20_Ah)), 2)} Ah (min ${fmt(Math.min(...R.map((r) => r.LLF20_Ah)), 2)}, max ${fmt(Math.max(...R.map((r) => r.LLF20_Ah)), 2)}). Les essais sont des décharges partielles : la capacité totale n'est pas mesurable, donc aucune courbe de perte de capacité ni durée de vie n'est calculée.`)));
    grid.append(panel('Perturbations ponctuelles (pics) sur tensions et températures', { cls: 'c6' },
      plot('', (c) => barChart(c, R.map((r) => String(r.run)), [{ label: 'pics', data: R.map((r) => r.spikes_V_T), colors: R.map((r) => ({ Set1: C[0], Set2: C[1], Set3: C[2], Set4: C[3], Set5: '#DB2777', Set6: '#65A30D' })[r.set]) }], { yLabel: 'nombre de pics', legend: false })),
      legend(['Set1', 'Set2', 'Set3', 'Set4', 'Set5', 'Set6'].map((s0, i) => [[C[0], C[1], C[2], C[3], '#DB2777', '#65A30D'][i], s0])),
      note(`${q.spikes_total.toLocaleString('fr-FR')} sauts brusques détectés (|Δx| > 8 MAD). Ils se concentrent sur certains essais (Set6 notamment) ; dans une chambre HIRF, ils peuvent provenir de perturbations électromagnétiques des capteurs. Cette attribution n'est pas vérifiable sans le journal d'exposition aux champs.`)));
    grid.append(panel('Essais atypiques (Isolation Forest sur 20 caractéristiques par essai)', { cls: 'c6' },
      plot('short', (c) => barChart(c, Hh.anomaly_scores.map((a) => String(a.run)), [{ label: 'score', data: Hh.anomaly_scores.map((a) => a.score), colors: Hh.anomaly_scores.map((a) => (a.flag ? '#B91C1C' : '#94A3B8')) }], { legend: false, yLabel: 'score' })),
      table([{ k: 'run', label: 'Essai', num: true }, { k: 'set', label: 'Lot' }, { k: 'score', label: 'Score', num: true, fmt: (v) => fmt(v, 3) }, { k: 'variables', label: 'Variables les plus écartées (z)', fmt: (v) => v.map((x) => `${x.var} (${fmt(x.z, 1)})`).join(' · ') }], Hh.anomalies),
      note('Contamination fixée à 10 % : l\'algorithme désigne les essais les plus éloignés du comportement commun (tension finale basse, échauffement fort, décharge atypique). Ce sont des essais à examiner, pas des pannes avérées.')));
    grid.append(panel('Corrélations entre caractéristiques par essai', { cls: 'c6' }, heatmap(Hh.corr.cols, Hh.corr.m, (c) => c.replace('_ohm', '').replace('spikes_V_T', 'pics').replace('duration_s', 'durée').replace('active_s', 'vol'))));
    body.append(grid);
  }
}
const median = (a) => { const s = a.filter((x) => x != null).slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const PACKS_H = ['LLF20', 'ULA20', 'LRF40', 'URA40'];

const RENDER = { anomalies: renderAnomalies, diagnostic: renderDiagnostic, fiabilite: renderFiabilite, rul: renderRul, maintenabilite: renderMaint, disponibilite: renderDispo,
  securite: renderSecurite, references: renderRefs, comparaison: renderComparaison, modeles: renderModeles, recommandations: renderReco, audit: renderAudit };
