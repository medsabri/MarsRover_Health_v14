// =============================================================================
// Accueil 3D — rover interactif au centre, fiches des composants à gauche et à droite.
// Clic sur une fiche → mise en évidence de la pièce en 3D ; clic sur une pièce → fiche
// correspondante mise en évidence et amenée à l'écran. Glisser-déposer .glb/.gltf conservé.
// =============================================================================
import * as THREE from 'three';
import { h, clear, STATUS, toast } from '../core/dom.js';
import { on } from '../core/store.js';
import { components } from '../core/data.js';
import { allStates, componentState } from '../core/analysis.js';
import { loadDefaultModel, createInstance, applyStatus, compBox, loadModelFromFiles } from '../three/rover.js';
import { Viewer } from '../three/viewer.js';
import { componentCard, loadThumbs } from './catalog.js';

let viewer = null, inst = null, selected = null, hovered = null, unsub = [], cols = null, imgs = {};

export default {
  async mount(app, params) {
    selected = params.c || null;
    const stage = h('div.stage');
    const center = h('div.home-center', h('div.home-wrap', stage, h('div.drop-hint', 'Déposez un modèle .glb / .gltf')));
    const left = h('aside.home-col', { 'aria-label': 'Fiches composants (1/2)' }), right = h('aside.home-col', { 'aria-label': 'Fiches composants (2/2)' });
    cols = { left, right };
    app.append(h('div.home-layout', left, center, right));
    renderCards();
    viewer = new Viewer(stage); viewer.avoidOverlap = true;
    const wrap = center.firstChild;
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('dragging'); });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('dragging'));
    wrap.addEventListener('drop', async (e) => {
      e.preventDefault(); wrap.classList.remove('dragging');
      try { await loadModelFromFiles([...e.dataTransfer.files]); toast('Modèle chargé.', 'ok'); } catch (err) { toast('Échec du chargement du modèle : ' + err.message, 'err'); }
    });
    await loadDefaultModel();
    if (!viewer) return;
    attach();
    unsub.push(on('model', () => attach()));
    unsub.push(on('change', (k) => { if (['cursorTime', 'overrides', 'terrainImpact', 'settings'].includes(k)) { renderCards(); refresh(); } }));
    viewer.onPick = (id) => select(id, true);
    viewer.onHover = (id) => {
      if (id === hovered) return; hovered = id;
      viewer.renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
      if (inst) { applyStatus(inst, statusMap(), { highlight: id || selected }); updateLabels(); }
    };
    function attach() {
      if (inst) viewer.scene.remove(inst.root);
      inst = createInstance(); viewer.scene.add(inst.root); viewer.pickables = [inst.root];
      viewer.frame(inst.box, stage.clientWidth < 640 ? 0.82 : 0.6);  // zoom rapproché : le rover occupe l'essentiel de la scène
      buildLabels(); refresh();
    }
  },
  unmount() { unsub.forEach((u) => u()); unsub = []; if (viewer) viewer.dispose(); viewer = null; inst = null; cols = null; },
};
const statusMap = () => new Map(allStates().map((s) => [s.id, s.status]));

function renderCards() {
  if (!cols) return;
  const list = components(), half = Math.ceil(list.length / 2);
  imgs = {};
  for (const [el, part] of [[cols.left, list.slice(0, half)], [cols.right, list.slice(half)]]) {
    clear(el);
    for (const c of part) el.append(componentCard(c, { imgs, selected, onSelect: (id) => select(id, false) }));
  }
  loadThumbs(list.map((c) => c.id), imgs);
}
function select(id, fromScene) {
  selected = selected === id && !fromScene ? null : id;
  document.querySelectorAll('.home-col .comp-card').forEach((card) => { const on = card.id === `card-${selected}`; card.classList.toggle('sel', on); card.setAttribute('aria-pressed', String(on)); });
  if (selected && fromScene) { const el = document.getElementById(`card-${selected}`); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  if (selected && inst && !fromScene) { const b = compBox(inst, selected); if (b) { const c = b.getCenter(new THREE.Vector3()); viewer.controls.target.lerp(c, 0.5); } }
  refresh();
}
function refresh() {
  if (!inst) return;
  applyStatus(inst, statusMap(), { highlight: selected });
  updateLabels();
}
const PRIO = { fault: 5, overtemp: 4, overload: 4, sensor: 3, warn: 2, nodata: 1, ok: 0 };
function updateLabels() {
  if (!viewer) return;
  for (const it of viewer.labelItems) {
    let open = false;
    for (const row of it.el.querySelectorAll('.lr')) {
      const id = row.dataset.id, s = componentState(id), st = STATUS[s.status];
      row.querySelector('.dot').style.background = st.color;
      const stEl = row.querySelector('.ls');
      stEl.textContent = st.label; stEl.style.color = st.color;
      row.classList.toggle('compact', false);
      row.classList.toggle('sel', id === selected);
      open = open || id === selected || id === hovered;
    }
    // rectangle nom + état affiché seulement pour la partie cliquée (ou survolée) ; sinon pastilles d'état compactes
    it.el.classList.toggle('collapsed', !open);
  }
}
/** Étiquettes regroupées par partie : une étiquette par position de roue (roue + moteur), une par sous-système pour le reste. */
function buildLabels() {
  viewer.clearLabels();
  const comps = components(), byId = Object.fromEntries(comps.map((c) => [c.id, c]));
  const groups = [];
  for (let i = 1; i <= 6; i++) if (byId[`wheel_${i}`]) groups.push({ anchor: `wheel_${i}`, ids: [`wheel_${i}`, `motor_${i}`].filter((x) => byId[x]) });
  for (const c of comps) if (!/^(wheel|motor)_\d$/.test(c.id)) groups.push({ anchor: c.id, ids: [c.id] });
  for (const g of groups) {
    const rows = g.ids.map((id) => h('span.lr', { 'data-id': id, role: 'button', tabindex: 0, title: byId[id].name, 'aria-label': `${byId[id].name} — afficher la fiche`,
      on: { click: (e) => { e.stopPropagation(); select(id, true); }, keydown: (e) => { if (e.key === 'Enter') select(id, true); } } },
    h('span.dot'), h('span.lt', shortName(byId[id])), h('span.ls')));
    const el = h('div.label3d.grp', { 'data-anchor': g.anchor }, rows);
    const v = new THREE.Vector3();
    const it = viewer.addLabel(el, () => { const b = compBox(inst, g.anchor); if (!b) return null; b.getCenter(v); v.y = b.max.y + 0.04; return v; });
    it.priority = () => Math.max(...g.ids.map((id) => (id === selected ? 10 : 0) + (PRIO[componentState(id).status] || 0)));
  }
  updateLabels();
}
function shortName(c) { return c.name.replace(/\(.*\)/, '').replace('Moteur roue', 'Moteur').replace('Suspension rocker-bogie', 'Rocker-bogie').replace('Télécommunications', 'Télécom').trim(); }
