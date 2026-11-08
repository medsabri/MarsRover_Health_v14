// =============================================================================
// main.js — point d'entrée : chargement, barre d'outils, routage par #hash.
// =============================================================================
import { state, loadPersisted, set, persist, on, emit } from './core/store.js';
import { loadAll, lifetimeDatasets, registry } from './core/data.js';
import { h, $, clear, STATUS, PROV, toast, icon, enhanceTables } from './core/dom.js';
import { themeCharts } from './core/charts.js';
import { globalHealth } from './core/analysis.js';
import { loadDefaultModel } from './three/rover.js';
import home from './views/home.js';
import dashboard from './views/dashboard.js';
import maintenance from './views/maintenance.js';
import catalog from './views/catalog.js';
import perturb from './views/perturb.js';
import terrain from './views/terrain.js';
import dataView from './views/data.js';
import une from './views/une.js';
import rapport from './views/rapport.js';
import ia from './views/ia.js';

export const ROUTES = [
  { path: 'une', label: 'À la une', short: 'À la une', view: une, group: 'Supervision', icon: 'play' },
  { path: 'accueil', label: 'Accueil 3D', short: 'Accueil 3D', view: home, group: 'Supervision', icon: 'cube' },
  { path: 'dashboard', label: 'Tableau de bord FMDS', short: 'Tableau de bord', view: dashboard, group: 'Supervision', icon: 'gauge' },
  { path: 'ia', label: 'IA & maintenance prédictive', short: 'IA prédictive', view: ia, group: 'Intelligence artificielle', icon: 'cpu' },
  { path: 'maintenance', label: 'Maintenance préventive', short: 'Maintenance', view: maintenance, group: 'Maintenance', icon: 'wrench' },
  { path: 'catalogue', label: 'Catalogue composants', short: 'Catalogue', view: catalog, group: 'Maintenance', icon: 'grid' },
  { path: 'perturbations', label: 'Tests de perturbation', short: 'Perturbations', view: perturb, group: 'Simulation', icon: 'zap' },
  { path: 'terrain', label: 'Terrain & simulation', short: 'Terrain', view: terrain, group: 'Simulation', icon: 'mountain' },
  { path: 'donnees', label: 'Données & provenance', short: 'Données', view: dataView, group: 'Données & outils', icon: 'database' },
  { path: 'rapport', label: 'Rapport technique', short: 'Rapport', view: rapport, group: 'Données & outils', icon: 'print' },
];
let current = null;

function parseHash() {
  const raw = (location.hash || '#/une').replace(/^#\/?/, '');
  const [path, q] = raw.split('?');
  return { path: path || 'une', params: Object.fromEntries(new URLSearchParams(q || '')) };
}
async function route() {
  const { path, params } = parseHash();
  const r = ROUTES.find((x) => x.path === path) || ROUTES[0];
  const app = $('#app');
  if (current && current.view.unmount) { try { current.view.unmount(); } catch (e) { console.error(e); } }
  clear(app);
  document.querySelectorAll('#nav a').forEach((a) => { const on = a.dataset.path === r.path; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  document.title = `${r.label} — MarsRover Health`;
  document.body.dataset.route = r.path;
  const act = document.querySelector('#nav a.active'); if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  current = r;
  try { await r.view.mount(app, params); } catch (e) { console.error(e); app.append(h('div.panel', h('h2', 'Erreur d\'affichage'), h('pre.mono', String(e.stack || e)))); }
  app.focus({ preventScroll: true });
}

function buildToolbar() {
  const nav = $('#nav');
  const groups = [...new Set(ROUTES.map((r) => r.group))];
  groups.forEach((g, i) => {
    if (i) nav.append(h('span.tb-sep', { 'aria-hidden': 'true' }));
    for (const r of ROUTES.filter((x) => x.group === g)) nav.append(h('a', { href: `#/${r.path}`, 'data-path': r.path, title: `${g} — ${r.label}` }, icon(r.icon), r.short || r.label));
  });
}
function startClock() {
  const el = $('#clock'); if (!el) return;
  const fd = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  const ft = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const tick = () => { const d = new Date(); el.querySelector('.cd').textContent = fd.format(d); el.querySelector('.ct').textContent = ft.format(d); el.dateTime = d.toISOString(); el.title = d.toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'medium' }); };
  tick(); setInterval(tick, 1000);
}
function applyTheme() {
  document.documentElement.dataset.theme = state.theme; themeCharts();
}
export function refreshStatus() {
  const g = globalHealth();
  const el = $('#globalStatus'); if (!el) return; clear(el);
  const s = STATUS[g.worst] || STATUS.nodata;
  el.append(h('span.dot', { style: { background: s.color } }), h('span.lbl', `Santé ${g.health === null ? '—' : Math.round(g.health * 100) + ' %'} · ${g.critical.length} critique${g.critical.length > 1 ? 's' : ''}`));
  el.title = `État le plus sévère : ${s.label}. Score de santé pondéré par criticité (données simulées / substitution).`;
}

async function boot() {
  loadPersisted(); state.theme = 'light'; state.provFilter = new Set(['mission', 'experimental', 'simulated', 'substituted']); applyTheme();
  buildToolbar(); startClock();
  await loadAll();
  refreshStatus();
  on('change', () => refreshStatus());
  window.addEventListener('hashchange', route);
  let pend = null; new MutationObserver(() => { clearTimeout(pend); pend = setTimeout(() => enhanceTables($('#app')), 60); }).observe($('#app'), { childList: true, subtree: true });
  route();
  loadDefaultModel().then((b) => { if (b.info.procedural) toast('Modèle GLB indisponible : modèle procédural de secours affiché. Glissez-déposez un .glb pour le remplacer.'); });
  window.MRH = { state, registry, ROUTES }; // accès console (débogage / tests)
}
boot();
