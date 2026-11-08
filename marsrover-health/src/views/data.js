// =============================================================================
// Données & provenance — inventaire, fiches d'identité, dictionnaire, import avec mapping,
// contrôle qualité, journal des traitements, ressources fournies, limites.
// =============================================================================
import { icon, h, append, clear, fmt, pct, badge, PROV, panel, toCSV, download, readText, toast } from '../core/dom.js';
import { state, on, persist } from '../core/store.js';
import { registry, quality, parseAny, addImported, removeImported, detectUnit } from '../core/data.js';
import { RESOURCES, SCRIPT_ISSUES } from '../core/resources.js';
import { modelInfo } from '../three/rover.js';

let tab = 'inventaire', sel = null, unsub = [], pending = null;
const TABS = [['inventaire', 'Inventaire'], ['import', 'Import & mapping']];
export default {
  mount(app, params) { if (params.tab) tab = params.tab; if (params.id) sel = params.id; render(app); unsub.push(on('datasets', () => render(app)), on('journal', () => tab === 'journal' && render(app))); },
  unmount() { unsub.forEach((u) => u()); unsub = []; },
};
function render(app) {
  clear(app);
  append(app, h('div.view-head', h('div', h('h1', 'Données & provenance'))));
  const tabs = h('div.tabs', { role: 'tablist' }, TABS.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': tab === k, class: tab === k ? 'on' : '', on: { click: () => { tab = k; render(app); } } }, l)));
  app.append(tabs);
  const body = h('div'); app.append(body);
  if (!TABS.some(([k]) => k === tab)) tab = 'inventaire';
  ({ inventaire, import: importTab })[tab](body, app);
}
function inventaire(el, app) {
  const rows = [...registry.values()];
  el.append(panel('Datasets chargés', {}, h('div.tbl-wrap', h('table.tbl', h('thead', h('tr', h('th', 'ID'), h('th', 'Nom'), h('th', 'Provenance'), h('th.num', 'Lignes'), h('th.num', 'Colonnes'), h('th', 'Contrôle qualité'), h('th', 'Origine'), h('th', ''))),
    h('tbody', rows.map((d) => h('tr', h('td.mono', d.id), h('td', d.meta.name), h('td', badge(d.meta.provenance)), h('td.num', d.rows.length), h('td.num', d.columns.length), h('td.small', d.quality.issues.length ? d.quality.issues.slice(0, 3).join(' ; ') + (d.quality.issues.length > 3 ? ' …' : '') : 'aucun problème détecté'), h('td.small', d.imported ? 'importé (IndexedDB)' : 'embarqué (data/datasets)'),
      h('td', h('div.row', h('button.btn.sm', { on: { click: () => download(`${d.id}.csv`, toCSV(d.rows, d.columns)) } }, icon('download')), d.imported ? h('button.btn.sm', { on: { click: () => removeImported(d.id) } }, 'Suppr.') : null)))))))));
}
function fiche(el) {
  const ids = [...registry.keys()]; if (!sel || !registry.has(sel)) sel = ids[0];
  const d = registry.get(sel), m = d.meta;
  const row = (k, v) => h('tr', h('th', { style: { width: '220px' } }, k), h('td', v));
  el.append(h('div.row', { style: { marginBottom: '8px' } }, h('label.field', 'Dataset', h('select.inp', { on: { change: (e) => { sel = e.target.value; clear(el); fiche(el); } } }, ids.map((i) => h('option', { value: i, selected: i === sel }, `${i} — ${registry.get(i).meta.name}`))))));
  el.append(panel(`Fiche d'identité — ${m.name}`, { badges: [badge(m.provenance)] }, h('table.tbl',
    h('tbody',
      row('Provenance', h('span', badge(m.provenance), ' ', m.origin || '')), row('Citation', m.citation || '—'), row('Licence / droits d\'usage', m.license || '—'),
      row('Structure', `${m.structure ? Object.entries(m.structure).map(([k, v]) => `${k} : ${v}`).join(' · ') : ''} — ${d.rows.length} lignes × ${d.columns.length} colonnes`),
      row('Événements / fin de vie / censure', m.events ? Object.entries(m.events).map(([k, v]) => `${k} : ${typeof v === 'object' && v ? JSON.stringify(v) : v}`).join(' · ') : '—'),
      row('Séparation train / val / test', m.split ? `${m.split.rule} — train : ${m.split.train.join(', ')} · validation : ${m.split.validation.join(', ')} · test : ${m.split.test.join(', ')}` : m.train_window ? `${m.train_window.rule} (${m.train_window.from_h}–${m.train_window.to_h} h)` : '—'),
      row('Prétraitement', m.preprocessing || '—'), row('Rôles dans l\'application', (m.roles || []).join(' · ')),
      row('Traçabilité', `version : ${m.version || '1.0 (projet)'} · graine : ${m.seed || (m.origin && /graine (\d+)/.exec(m.origin) ? /graine (\d+)/.exec(m.origin)[1] : '—')} · script : ${d.imported ? 'import utilisateur' : 'tools/gen_datasets.py'}`),
      row('Avertissement de transfert', m.transfer_warning ? 'OUI — résultats non transférables tels quels au rover (§9.4)' : 'non applicable')))));
  el.append(panel('Contrôle qualité', {}, h('div.tbl-wrap', h('table.tbl', h('thead', h('tr', h('th', 'Colonne'), h('th', 'Type'), h('th', 'Unité détectée'), h('th.num', 'Manquants'), h('th.num', 'Min'), h('th.num', 'Max'), h('th.num', 'Moyenne'), h('th.num', 'Valeurs distinctes'), h('th', 'Problèmes'))),
    h('tbody', d.quality.cols.map((c) => h('tr', h('td.mono', c.name), h('td', c.type), h('td', c.unit), h('td.num', pct(c.missingRate, 1)), h('td.num', fmt(c.min, 3)), h('td.num', fmt(c.max, 3)), h('td.num', fmt(c.mean, 3)), h('td.num', c.unique), h('td.small', c.issues.join(' ; ') || '—')))))),
    h('div.small.muted', `${d.quality.duplicates} ligne(s) dupliquée(s). Les valeurs manquantes de link_margin_dB correspondent aux coupures de liaison PROGRAMMÉES (documenté).`)));
}
function dictionnaire(el) {
  const rows = [];
  for (const d of registry.values()) for (const v of d.meta.variables || d.columns.map((c) => ({ name: c, unit: detectUnit(c) }))) rows.push({ dataset: d.id, provenance: d.meta.provenance, variable: v.name, description: v.description || '', unit: v.unit || '', expected_range: v.expected_range || '' });
  el.append(panel('Dictionnaire de données', {}, h('div.tbl-wrap', { style: { maxHeight: '640px' } }, h('table.tbl', h('thead', h('tr', h('th', 'Dataset'), h('th', 'Prov.'), h('th', 'Variable'), h('th', 'Description'), h('th', 'Unité'), h('th', 'Plage attendue'))),
    h('tbody', rows.map((r) => h('tr', h('td.mono', r.dataset), h('td', badge(r.provenance)), h('td.mono', r.variable), h('td.small', r.description), h('td', r.unit), h('td.small', r.expected_range)))))),
    h('button.btn.sm', { style: { marginTop: '6px' }, on: { click: () => download('dictionnaire_donnees.csv', toCSV(rows)) } }, icon('download'), 'CSV')));
  el.append(panel('Tableau de provenance', {}, h('table.tbl', h('thead', h('tr', h('th', 'Provenance'), h('th', 'Datasets'))), h('tbody', Object.keys(PROV).map((p) => h('tr', h('td', badge(p)), h('td', [...registry.values()].filter((d) => d.meta.provenance === p).map((d) => d.id).join(', ') || (p === 'substituted' ? 'résultats dérivés (onglet Maintenance)' : 'aucun'))))))));
}
function importTab(el, app) {
  const fileIn = h('input', { type: 'file', accept: '.csv,.txt,.json,.tsv', 'aria-label': 'Fichier à importer' });
  const zone = h('div');
  fileIn.addEventListener('change', async () => { const f = fileIn.files[0]; if (!f) return; try { const text = await readText(f); const p = parseAny(text, f.name); pending = { file: f.name, text, ...p }; draw(); } catch (e) { toast('Lecture impossible : ' + e.message, 'err'); } });
  el.append(panel('Importer un dataset (CSV / TXT / JSON)', {}, h('div.small.muted', 'Fichiers .mat : convertir d\'abord en CSV (MATLAB : writetable ; Python : scipy.io.loadmat). Le fichier reste dans ce navigateur (IndexedDB).'), fileIn, zone));
  function draw() {
    clear(zone); if (!pending) return;
    const q = quality(pending.rows, pending.columns);
    const cols = pending.columns;
    const sel = (label, key, opts = cols) => h('label.field', label, h('select.inp', { 'data-k': key }, h('option', { value: '' }, '—'), opts.map((c) => h('option', { value: c }, c))));
    const f = {
      name: h('input.inp', { value: pending.file.replace(/\.\w+$/, '') }), prov: h('select.inp', { required: true }, h('option', { value: '' }, '— à déclarer (obligatoire) —'), Object.entries(PROV).filter(([k]) => k !== 'substituted').map(([k, p]) => h('option', { value: k }, p.label))),
      role: h('select.inp', h('option', { value: 'lifetime' }, 'Durées de vie (temps + statut)'), h('option', { value: 'trajectory' }, 'Trajectoires de dégradation (id + temps + indicateur)'), h('option', { value: 'events' }, 'Journal d\'événements (component_id, type, start_h, end_h)'), h('option', { value: 'other' }, 'Autre (consultation seulement)')),
      origin: h('input.inp', { placeholder: 'organisme, mission, essai…' }), citation: h('input.inp'), license: h('input.inp'), version: h('input.inp', { value: '1' }), seed: h('input.inp'), unit: h('input.inp', { placeholder: 'unité de temps' }), threshold: h('input.inp', { type: 'number', step: 'any', placeholder: 'seuil de fin de vie (optionnel)' }), direction: h('select.inp', h('option', { value: 'up' }, 'dégradation croissante'), h('option', { value: 'down' }, 'décroissante')), prep: h('textarea.inp', { rows: 2, placeholder: 'prétraitements appliqués' }),
    };
    const maps = h('div.form-grid', sel('Colonne identifiant (unité/essai)', 'id'), sel('Colonne temps', 'time'), sel('Colonne indicateur / valeur', 'value'), sel('Colonne statut (1 = panne, 0 = censure)', 'event'));
    zone.append(
      h('h3', { style: { fontSize: '13px' } }, `Aperçu — ${pending.rows.length} lignes, ${cols.length} colonnes${pending.errors.length ? `, ${pending.errors.length} erreur(s) de lecture` : ''}`),
      h('div.tbl-wrap', { style: { maxHeight: '200px' } }, h('table.tbl', h('thead', h('tr', cols.map((c) => h('th', c)))), h('tbody', pending.rows.slice(0, 10).map((r) => h('tr', cols.map((c) => h('td.mono', String(r[c] ?? '')))))))),
      h('div.small', { style: { margin: '6px 0' } }, 'Contrôle qualité : ', q.issues.length ? q.issues.join(' ; ') : 'aucun problème détecté', ' · unités détectées : ', q.cols.map((c) => `${c.name} → ${c.unit}`).join(', ')),
      h('div.form-grid', h('label.field', 'Nom', f.name), h('label.field', 'Provenance (obligatoire)', f.prov), h('label.field', 'Rôle', f.role), h('label.field', 'Origine', f.origin), h('label.field', 'Citation', f.citation), h('label.field', 'Licence / droits', f.license), h('label.field', 'Version', f.version), h('label.field', 'Graine aléatoire (si simulé)', f.seed), h('label.field', 'Unité de temps', f.unit), h('label.field', 'Seuil de fin de vie', f.threshold), h('label.field', 'Sens de dégradation', f.direction)),
      h('h3', { style: { fontSize: '13px' } }, 'Assistant de mapping des colonnes'), maps, h('label.field', 'Prétraitement', f.prep),
      h('div.row', { style: { marginTop: '8px' } }, h('button.btn.primary', { on: { click: async () => {
        if (!f.prov.value) { toast('Déclarez la provenance : aucune donnée sans provenance (règle n° 1).', 'err'); f.prov.focus(); return; }
        const mp = Object.fromEntries([...maps.querySelectorAll('select')].map((s) => [s.dataset.k, s.value]).filter(([, v]) => v));
        const mapping = { role: f.role.value, id: mp.id, time: mp.time, value: mp.value, event: mp.event, unit: f.unit.value, threshold: f.threshold.value === '' ? undefined : +f.threshold.value, direction: f.direction.value };
        if (mapping.role === 'lifetime' && !(mapping.time && mapping.event)) { toast('Rôle « durées de vie » : colonnes temps et statut requises.', 'err'); return; }
        if (mapping.role === 'trajectory' && !(mapping.id && mapping.time && mapping.value)) { toast('Rôle « trajectoires » : colonnes identifiant, temps et indicateur requises.', 'err'); return; }
        if (mapping.role === 'events' && !['component_id', 'type', 'start_h', 'end_h'].every((c) => cols.includes(c))) { toast('Journal d\'événements : colonnes component_id, type, start_h, end_h requises.', 'err'); return; }
        const id = 'imp_' + f.name.value.replace(/[^\w]+/g, '_').slice(0, 30) + '_' + Date.now().toString(36);
        const meta = { id, file: pending.file, name: f.name.value, provenance: f.prov.value, origin: f.origin.value, citation: f.citation.value, license: f.license.value, version: f.version.value, seed: f.seed.value, preprocessing: f.prep.value || 'aucun', structure: { format: pending.file.split('.').pop(), rows: pending.rows.length }, events: { eol_threshold: mapping.threshold ?? null }, roles: [mapping.role], transfer_warning: f.prov.value !== 'mission' };
        const ok = await addImported({ id, meta, text: pending.text, mapping });
        toast(ok ? 'Dataset importé et enregistré.' : 'Importé pour cette session (stockage navigateur indisponible).', ok ? 'ok' : '');
        pending = null; tab = 'inventaire'; render(app);
      } } }, 'Importer'), h('button.btn', { on: { click: () => { pending = null; draw(); } } }, 'Annuler')));
  }
  draw();
}
function journal(el) {
  el.append(panel(`Journal des traitements (${state.journal.length})`, {}, h('div.small.muted', 'Chaque calcul notable est tracé avec ses paramètres (reproductibilité). Graines : simulation 20261106, Isolation Forest 7, bootstrap 2026/42, RUL 11.'),
    h('div.tbl-wrap', { style: { maxHeight: '600px', marginTop: '6px' } }, h('table.tbl', h('thead', h('tr', h('th', 'Horodatage'), h('th', 'Action'), h('th', 'Paramètres'))), h('tbody', state.journal.map((e) => h('tr', h('td.mono', e.ts), h('td', e.action), h('td.mono', JSON.stringify(e.params))))))),
    h('div.row', { style: { marginTop: '6px' } }, h('button.btn.sm', { on: { click: () => download('journal_traitements.json', JSON.stringify(state.journal, null, 2), 'application/json') } }, icon('download'), 'JSON'), h('button.btn.sm', { on: { click: () => { state.journal = []; persist('journal'); clear(el); journal(el); } } }, 'Vider'))));
}
function ressources(el) {
  el.append(panel('Inventaire des ressources fournies (lecture initiale)', {}, h('div.tbl-wrap', { style: { maxHeight: '640px' } }, h('table.tbl', h('thead', h('tr', h('th', 'Fichier / dossier'), h('th', 'Type / taille'), h('th', 'Contenu'), h('th', 'Provenance'), h('th', 'Rôle dans l\'application'), h('th', 'Statut'))),
    h('tbody', RESOURCES.map(([f, t, c, p, r, s]) => h('tr', h('td.small', f), h('td.small', t), h('td.small', c), h('td', p === '—' ? '—' : p && PROV[p] ? badge(p) : p ? h('span.small', p) : badge(null)), h('td.small', r), h('td.small', { style: { color: /CORROMPU|NON FOURNI/.test(s) ? 'var(--fault)' : '' } }, s))))))));
  el.append(panel('Incohérences relevées dans les scripts fournis', {}, h('ul.small', SCRIPT_ISSUES.map((x) => h('li', x)))));
}
function limites(el) {
  const L = [
    ['Données', 'Aucune télémétrie réelle de mission. Télémétrie rover, batterie et journal d\'événements : SIMULÉS (tools/gen_datasets.py, graine 20261106). Durées de roulements : EXPÉRIMENTALES (banc). Datasets RAT/IMS/FEMTO/NASA non fournis.'],
    ['Transfert (§9.4)', 'Aucun modèle appris sur banc d\'essai n\'est présenté comme validé sur le rover. Les plans « par substitution » sont des hypothèses de travail, systématiquement étiquetées.'],
    ['Valeurs de démonstration', 'Durées de vie nominales, seuils, cotations AMDEC, constantes de la simulation (K, I0, Crr, h_cg, Ea) : non sourcées, éditables (data/components.json, data/fmeca.json ou interface).'],
    ['FMDS', 'MTBF/MTTR/disponibilité calculés seulement pour les composants présents dans un journal d\'événements (simulé ici) ; sinon « non calculable avec les données retenues ». MTTR = remise en service, pas de réparation physique.'],
    ['RUL', 'Affichée uniquement avec fin de vie définie (batterie simulée : 80 % C0 ; roulements simulés : 3,5 mm/s). Couverture d\'intervalle imparfaite sur peu d\'unités (rapportée).'],
    ['Détection', 'Métriques de détection calculées grâce à la vérité terrain des anomalies injectées : ne préjugent pas des performances sur données réelles. Seuils de décision non optimisés sur le test.'],
    ['Simulation de terrain', 'Modèle quasi statique simplifié ; suspension non articulée dans la maquette 3D (angles calculés, caisse basculée).'],
    ['3D', 'Batterie, calculateur et contrôle thermique n\'ont pas de maillage dédié : position indicative. Roues/suspension découpées géométriquement dans le maillage fusionné fourni.'],
    ['MATLAB', 'Le navigateur n\'exécute pas MATLAB : scripts .m générés et données exportées ; résultats réimportés. Scripts non exécutés lors de la construction (pas de licence MATLAB dans l\'environnement).'],
    ['Usage', 'Outil d\'aide à la décision : aucune commande n\'est envoyée ; toute recommandation est à vérifier par l\'équipe.'],
  ];
  el.append(panel('Hypothèses retenues et limites connues', {}, h('table.tbl', h('tbody', L.map(([k, v]) => h('tr', h('th', { style: { width: '200px' } }, k), h('td', v)))))));
}
