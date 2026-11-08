// =============================================================================
// Catalogue des composants — fiche, vue 3D, durée nominale (éditable), état actuel, écart.
// =============================================================================
import { icon, h, append, clear, fmt, pct, badge, demoBadge, statusEl, STATUS, modal, toCSV, download } from '../core/dom.js';
import { state, on, set, persist, log } from '../core/store.js';
import { components, component, setOverride, config } from '../core/data.js';
import { componentState, usageAt, substitution, allStates } from '../core/analysis.js';
import { thumbnails } from '../three/thumbs.js';
import { weibull } from '../ml/survival.js';
import { ChartBag, chartBox, barChart } from '../core/charts.js';

const bag = new ChartBag(); let unsub = [], filt = { sub: 'all', crit: 'all', sort: 'gap' };
export function gapOf(c) {
  const u = usageAt(c), L = c.design_life.value;
  if (u.total === null || !L) return { consumed: null };
  const consumed = u.total / L;
  // incertitude : plage d'usage équivalent [usage mesuré ; usage + dommage terrain] et ±20 % sur la durée nominale (non sourcée)
  return { usage: u.total, measured: u.value, extra: u.extra, L, remaining: L - u.total, consumed, consumedRange: [u.value / (1.2 * L), u.total / (0.8 * L)], abs: u.total - L, unit: c.design_life.unit };
}
export default {
  mount(app, params) { render(app, params.c); unsub.push(on('change', (k) => { if (['overrides', 'cursorTime', 'terrainImpact'].includes(k)) render(app); })); },
  unmount() { bag.destroy(); unsub.forEach((u) => u()); unsub = []; },
};
function render(app, focus) {
  bag.destroy(); clear(app);
  let list = components().map((c) => ({ c, s: componentState(c.id), g: gapOf(c) }));
  if (filt.sub !== 'all') list = list.filter((x) => x.c.subsystem === filt.sub);
  if (filt.crit !== 'all') list = list.filter((x) => x.c.criticality === filt.crit);
  list.sort((a, b) => filt.sort === 'gap' ? (b.g.consumed ?? -1) - (a.g.consumed ?? -1) : filt.sort === 'crit' ? ['high', 'medium', 'low'].indexOf(a.c.criticality) - ['high', 'medium', 'low'].indexOf(b.c.criticality) : a.c.name.localeCompare(b.c.name));
  const subs = [...new Set(components().map((c) => c.subsystem))];
  append(app, h('div.view-head.cat-head', h('h1', 'Catalogue des composants'),
    h('div.cat-ctrl',
      h('label.dash-field', h('span', 'Sous-système'), h('select.inp', { on: { change: (e) => { filt.sub = e.target.value; render(app); } } }, h('option', { value: 'all' }, 'Tous'), subs.map((s) => h('option', { value: s, selected: filt.sub === s }, s)))),
      h('label.dash-field', h('span', 'Criticité'), h('select.inp', { on: { change: (e) => { filt.crit = e.target.value; render(app); } } }, [['all', 'Toutes'], ['high', 'Haute'], ['medium', 'Moyenne'], ['low', 'Basse']].map(([v, l]) => h('option', { value: v, selected: filt.crit === v }, l)))),
      h('label.dash-field', h('span', 'Tri'), h('select.inp', { on: { change: (e) => { filt.sort = e.target.value; render(app); } } }, [['gap', 'Écart (vie consommée)'], ['crit', 'Criticité'], ['name', 'Nom']].map(([v, l]) => h('option', { value: v, selected: filt.sort === v }, l)))),
      h('button.btn', { on: { click: () => download('components.json', JSON.stringify(exportConfig(), null, 2), 'application/json') } }, icon('download'), 'components.json (avec modifications)'),
      h('button.btn', { on: { click: () => download('catalogue.csv', toCSV(list.map(({ c, s, g }) => ({ id: c.id, nom: c.name, sous_systeme: c.subsystem, criticite: c.criticality, duree_nominale: c.design_life.value, unite: c.design_life.unit, source_nominale: c.design_life.source, usage: g.usage, vie_consommee_pct: g.consumed === null ? '' : g.consumed * 100, restant: g.remaining, etat: s.status, provenance: s.provenance })))) } }, icon('download'), 'CSV'))));
  // graphique comparatif
  const { box, canvas } = chartBox('xl');
  app.append(h('section.panel', { style: { marginBottom: '12px' } }, h('header', h('h2', 'Nominal vs actuel — vie consommée (%)'), h('div.row', badge('simulated'), demoBadge())), box));
  const withG = list.filter((x) => x.g.consumed !== null);
  requestAnimationFrame(() => bag.add(barChart(canvas, withG.map((x) => x.c.name.replace(/\(.*\)/, '').trim()), [
    { label: 'Consommé (%)', data: withG.map((x) => x.g.consumed * 100), colors: withG.map((x) => STATUS[x.s.status].color) },
    { label: 'Plage d\'incertitude (%)', data: withG.map((x) => [x.g.consumedRange[0] * 100, x.g.consumedRange[1] * 100]), color: 'rgba(37,99,235,.35)' }], { yLabel: '% de la durée nominale consommée', yMax: Math.min(100, Math.ceil(Math.max(5, ...withG.map((x) => x.g.consumedRange[1] * 100)) / 5) * 5 + 5) })));
  const cards = h('div.cards'); app.append(cards);
  const imgs = {};
  for (const { c } of list) cards.append(componentCard(c, { focus, imgs, onEdit: (cc) => editDialog(cc, app) }));
  if (focus) setTimeout(() => { const el = document.getElementById(`card-${focus}`); el && el.scrollIntoView({ block: 'center' }); }, 50);
  thumbnails(list.map((x) => x.c.id), new Map(allStates().map((s) => [s.id, s.status]))).then((t) => { for (const [id, url] of Object.entries(t)) if (imgs[id] && url) imgs[id].src = url; }).catch((e) => console.warn('Vignettes :', e.message));
}
/**
 * Fiche composant réutilisable (catalogue et accueil 3D).
 * opts : { focus, imgs (registre id → <img>), onEdit, onSelect, selected, compact }
 */
export function componentCard(c, opts = {}) {
  const s = componentState(c.id), g = gapOf(c), { focus, imgs = {}, onEdit, onSelect, selected } = opts;
    const img = h('img', { alt: `Vue 3D : ${c.name}`, on: { load: () => img.parentElement && img.parentElement.classList.remove('skeleton') } }); imgs[c.id] = img;
    const p = g.consumed === null ? null : Math.min(1, g.consumed);
    const unit = c.design_life.unit, pc = p === null ? null : Math.round(p * 100);
    const tone = p === null ? 'none' : p > 0.9 ? 'fault' : p > 0.6 ? 'warn' : 'ok';
    const src = c.dataset && c.dataset.id ? c.dataset.id : c.substitution ? 'substitution' : 'aucune';
    const card = h('article.card.comp-card', { id: `card-${c.id}`, style: focus === c.id ? { outline: '2px solid var(--accent)', outlineOffset: '2px' } : {} },
      h('div.thumb.skeleton', img, h('div.chip-tl', statusEl(s.status))),
      h('div.body',
        h('div.cc-head', h('div', h('div.cc-sub', c.subsystem), h('strong', c.name)), badge(s.provenance)),
        h('p.cc-fn', c.function),
        h('div.cc-life',
          h('div.cc-life-top', h('span', 'Vie consommée'), h('b', { class: `t-${tone}` }, pc === null ? '—' : `${pc} %`)),
          h('div.gauge', { role: 'meter', 'aria-valuenow': pc ?? 0, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Vie consommée' }, h('i', { style: { width: `${(p ?? 0) * 100}%`, background: `var(--${tone === 'none' ? 'line-strong' : tone})` } })),
          g.consumed !== null ? h('div.cc-range', `Plage d'incertitude ${pct(g.consumedRange[0], 0)} – ${pct(g.consumedRange[1], 0)}`) : null),
        h('dl.cc-stats',
          h('div', h('dt', 'Nominal'), h('dd', fmt(c.design_life.value, 2), h('small', ' ' + unit))),
          h('div', h('dt', 'Actuel'), h('dd', fmt(g.usage, 2), h('small', ' ' + unit))),
          h('div', h('dt', 'Restant'), h('dd', g.consumed === null ? '—' : fmt(g.remaining, 2), h('small', g.consumed === null ? '' : ' ' + unit)))),
        h('dl.cc-specs',
          ...Object.entries(c.specs || {}).map(([k, v]) => h('div', h('dt', k), h('dd', String(v).replace(/\s*\((démonstration|indicatif)\)/g, '')))),
          h('div', h('dt', 'Source de données'), h('dd', src)),
          s.subst ? h('div', h('dt', 'F(usage)'), h('dd', pct(1 - s.subst.state.R, 2))) : null,
          c.design_life.source === 'démonstration' ? null : h('div', h('dt', 'Durée nominale'), h('dd', c.design_life.source))),
        h('div.actions', onEdit ? h('button.btn.sm', { on: { click: () => onEdit(c) } }, icon('edit'), 'Éditer') : null, h('a.btn.sm', { href: `#/accueil?c=${c.id}` }, icon('cube'), 'Vue 3D'), h('span.spacer'), h('a.btn.sm.ghost', { href: `#/maintenance?c=${c.id}` }, 'Maintenance', icon('chevronRight')))));
  if (onSelect) { card.classList.add('selectable'); card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-pressed', String(selected === c.id)); if (selected === c.id) card.classList.add('sel');
    card.addEventListener('click', (e) => { if (!e.target.closest('a,button')) onSelect(c.id); }); card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) onSelect(c.id); }); }
  return card;
}
export function loadThumbs(ids, imgs) {
  return thumbnails(ids, new Map(allStates().map((x) => [x.id, x.status]))).then((t) => { for (const [id, url] of Object.entries(t)) if (imgs[id] && url) imgs[id].src = url; }).catch((e) => console.warn('Vignettes :', e.message));
}
function editDialog(c, app) {
  const v = h('input.inp', { type: 'number', step: 'any', value: c.design_life.value }), src = h('input.inp', { value: c.design_life.source === 'démonstration' ? '' : c.design_life.source, placeholder: 'ex. fiche constructeur réf. …' });
  const ths = Object.entries(c.thresholds || {}).map(([k, th]) => ({ k, inputs: Object.fromEntries(['warn', 'fault', 'warn_low', 'fault_low'].filter((x) => th[x] !== undefined).map((x) => [x, h('input.inp', { type: 'number', step: 'any', value: th[x] })])) }));
  const d = modal(`Éditer — ${c.name}`, h('div',
    h('div.form-grid', h('label.field', `Durée de vie nominale (${c.design_life.unit})`, v), h('label.field', 'Source (laisser vide = démonstration)', src)),
    ths.length ? h('div', h('h3', { style: { fontSize: '13px' } }, 'Seuils'), ...ths.map((t) => h('div.form-grid', h('div.small.mono', t.k), ...Object.entries(t.inputs).map(([n, i]) => h('label.field', n, i))))) : null,
    h('div.row', { style: { marginTop: '10px' } }, h('button.btn.primary', { on: { click: () => {
      const patch = { design_life: { value: +v.value, source: src.value.trim() || 'démonstration' } };
      if (ths.length) patch.thresholds = Object.fromEntries(ths.map((t) => [t.k, Object.fromEntries(Object.entries(t.inputs).map(([n, i]) => [n, +i.value]))]));
      setOverride(c.id, patch); d.close(); } } }, 'Enregistrer (local)'),
      h('button.btn', { on: { click: () => { delete state.overrides[c.id]; persist('overrides'); set('overrides', state.overrides); d.close(); } } }, 'Rétablir la configuration'),
      h('span.small.muted', 'Les modifications sont stockées dans ce navigateur et exportables en components.json.'))));
}
function exportConfig() {
  const base = JSON.parse(JSON.stringify(config().components));
  base.components = components();
  base._export = { date: new Date().toISOString(), note: 'Inclut les modifications locales.' };
  return base;
}
