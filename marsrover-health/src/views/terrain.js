// =============================================================================
// Terrain & simulation 3D — trous/cratères, virages, montées, rochers, sable.
// Sorties synchronisées avec la lecture 3D ; effet sur l'état des composants (retour
// vers la vue 3D et le tableau de bord). Simulation NON VALIDÉE sur rover réel.
// =============================================================================
import * as THREE from 'three';
import { icon, h, append, clear, fmt, pct, badge, panel, kpi, toCSV, download, toast, statusEl } from '../core/dom.js';
import { state, set, log, persist } from '../core/store.js';
import { component } from '../core/data.js';
import { buildTerrain, simulate, DEFAULTS, nominalParams, WHEELS, CONST } from '../sim/terrain.js';
import { ChartBag, chartBox, lineChart, color } from '../core/charts.js';
import { loadDefaultModel, createInstance, applyStatus } from '../three/rover.js';
import { Viewer } from '../three/viewer.js';

const bag = new ChartBag(); let viewer = null, inst = null, carrier = null, P = { ...DEFAULTS }, sim = null, nom = null, ter = null, k = 0, playing = false, speedX = 4, follow = true, charts = [];
export default {
  mount(app) { render(app); },
  unmount() { playing = false; bag.destroy(); if (viewer) viewer.dispose(); viewer = null; inst = null; charts = []; },
};
const EQ = `W = m·g_Mars (m = ${CONST.m} kg, g = ${CONST.g} m/s², indicatif)
N_i = W/6·cosθ·cosφ ∓ W·h_cg·sinθ/(2L) ± W·h_cg·sinφ/(3B), × (1 + 2,5·Δh_i) (bosse/rocher)
bogie = atan((h_milieu − h_arrière)/${CONST.lBogie}) ; rocker = atan((h_avant − h_pivot)/${CONST.lRocker})
s = ${CONST.s0} + ${CONST.kSlip}·tanθ_local + ${CONST.dsSand}·[sable]          (glissement, ≤ 0,95)
F_i = N_i·Crr (${CONST.crr} ferme / ${CONST.crrSand} sable) + (W/6)·sinθ_local + F_virage
τ_i = F_i·r/(1 − s/2) ; I_i = τ_i/K + I0 (K = ${CONST.K} N·m/A, I0 = ${CONST.I0} A, démo) ; P = Σ ${CONST.Vbus} V·I_i
dT/dt = (T_amb + 30·I² − T)/τ_th (τ_th = ${CONST.tauTh} s, T_amb = ${CONST.Tamb} °C)
usage équivalent : Σ Δs·[(N/N0)³ − 1]⁺ (roues/suspension) ; Σ Δt·[(I/I_nom)³ − 1]⁺ (moteurs)`;

function render(app) {
  playing = false; bag.destroy(); if (viewer) { viewer.dispose(); viewer = null; } clear(app); charts = [];
  append(app, h('div.view-head', h('div', h('h1', 'Terrain & simulation 3D')), h('div.row', badge('simulated'))));
  const g = h('div.grid'); app.append(g);
  const R = (key, min, max, step, label, unit) => h('label.field', `${label} : ${P[key]} ${unit}`, h('input', { type: 'range', min, max, step, value: P[key], 'aria-label': label, on: { input: (e) => { P[key] = +e.target.value; e.target.parentElement.firstChild.textContent = `${label} : ${P[key]} ${unit}`; } } }));
  g.append(panel('Paramètres du terrain', { cls: 'c3' }, h('div', { style: { display: 'grid', gap: '6px' } },
    R('slopeDeg', 0, 30, 1, 'Pente de la colline', '°'), R('craterDepth', 0, 0.8, 0.05, 'Profondeur du cratère', 'm'), R('craterRadius', 0.8, 4, 0.1, 'Rayon du cratère', 'm'),
    R('turnRadius', 2, 20, 0.5, 'Rayon du virage', 'm'), R('rocks', 0, 1, 0.05, 'Densité de rochers', ''), R('sandLength', 0, 18, 1, 'Longueur zone de sable', 'm'), R('speed', 0.02, 0.1, 0.002, 'Vitesse', 'm/s'),
    h('label.row.small', h('input', { type: 'checkbox', checked: P.sand, on: { change: (e) => (P.sand = e.target.checked) } }), 'Sable meuble'),
    h('button.btn.primary', { on: { click: () => render(app) } }, icon('play'), 'Simuler'),
    h('button.btn', { on: { click: () => { P = { ...DEFAULTS }; render(app); } } }, 'Valeurs par défaut'))));
  ter = buildTerrain(P); sim = simulate(ter); nom = simulate(buildTerrain(nominalParams(P)), nominalParams(P)); k = 0;
  log('Simulation terrain', { ...P });
  const stage = h('div.terrain-wrap');
  const slider = h('input', { type: 'range', min: 0, max: sim.t.length - 1, step: 1, value: 0, style: { flex: 1 }, 'aria-label': 'Position dans la simulation', on: { input: (e) => { k = +e.target.value; update(); } } });
  const lbl = h('span.small.mono', '');
  const playBtn = h('button.btn.sm', { on: { click: () => { playing = !playing; playBtn.replaceChildren(icon(playing ? 'pause' : 'play'), playing ? 'Pause' : 'Lecture'); } } }, icon('play'), 'Lecture');
  g.append(panel('Lecture 3D', { cls: 'c9', badges: [badge('simulated')] }, stage,
    h('div.row', { style: { marginTop: '6px' } }, playBtn, h('select.inp', { 'aria-label': 'Vitesse de lecture', on: { change: (e) => (speedX = +e.target.value) } }, [[1, 'ralenti ×1'], [4, '×4'], [12, '×12'], [30, '×30']].map(([v, l]) => h('option', { value: v, selected: v === speedX }, l))),
      h('label.row.small', h('input', { type: 'checkbox', checked: follow, on: { change: (e) => (follow = e.target.checked) } }), 'caméra de suivi'), slider, lbl)));
  // KPIs
  const comp = (a, b) => `${fmt(a, 2)} (nominal ${fmt(b, 2)})`;
  const effects = deriveEffects(sim);
  g.append(panel('Synthèse : terrain perturbé vs nominal', { cls: 'c12', badges: [badge('simulated')] },
    h('div.kpis', kpi('Distance', fmt(sim.distance, 1), 'm'), kpi('Durée', fmt(sim.t.at(-1) / 60, 1), 'min'),
      kpi('Courant max', fmt(Math.max(...sim.maxI), 2), 'A', h('div.sub2', `nominal ${fmt(Math.max(...nom.maxI), 2)} A`)),
      kpi('Température moteur max', fmt(Math.max(...sim.maxT), 1), '°C', h('div.sub2', `nominal ${fmt(Math.max(...nom.maxT), 1)} °C`)),
      kpi('Glissement max', pct(Math.max(...sim.maxSlip), 0), '', h('div.sub2', `nominal ${pct(Math.max(...nom.maxSlip), 0)}`)),
      kpi('Tangage / roulis max', `${fmt(Math.max(...sim.pitch.map(Math.abs)), 1)}° / ${fmt(Math.max(...sim.roll.map(Math.abs)), 1)}°`),
      kpi('Énergie', fmt(sim.energy.at(-1), 1), 'Wh', h('div.sub2', `nominal ${fmt(nom.energy.at(-1), 1)} Wh`))),
    h('div.tbl-wrap', { style: { marginTop: '8px' } }, h('table.tbl', h('thead', h('tr', h('th', 'Composant'), h('th', 'Effet'), h('th', 'État résultant'), h('th.num', 'Usage équivalent ajouté'))),
      h('tbody', Object.entries(effects.rows).map(([id, r]) => h('tr', h('td', component(id).name), h('td.small', r.reason), h('td', statusEl(r.status)), h('td.num', `${fmt(r.extra, 4)} ${component(id).design_life.unit}`)))))),
    h('div.row', { style: { marginTop: '8px' } },
      h('button.btn.primary', { on: { click: () => { set('terrainImpact', { applied: true, ts: new Date().toISOString(), params: { ...P }, status: effects.status, equivalentUsage: effects.extra, summary: { maxI: Math.max(...sim.maxI), maxT: Math.max(...sim.maxT) } }); toast('Impact appliqué à la vue 3D, au tableau de bord et à la maintenance (provenance SIMULÉ).', 'ok'); } } }, 'Appliquer l\'impact aux composants'),
      h('button.btn', { on: { click: () => { set('terrainImpact', null); toast('Impact retiré.'); } } }, 'Retirer l\'impact'),
      h('button.btn', { on: { click: () => download('simulation_terrain.csv', toCSV(sim.t.map((t, i) => ({ t_s: t, s_m: sim.s[i], x: sim.x[i], z: sim.z[i], pitch_deg: sim.pitch[i], roll_deg: sim.roll[i], power_W: sim.power[i], energy_Wh: sim.energy[i], ...Object.fromEntries(WHEELS.flatMap((w, j) => [[`N${w.id}_N`, sim.wheel[j].N[i]], [`I${w.id}_A`, sim.wheel[j].I[i]], [`T${w.id}_C`, sim.wheel[j].T[i]], [`slip${w.id}`, sim.wheel[j].slip[i]]])) })))) } }, icon('download'), 'Résultats CSV'),
      state.terrainImpact && state.terrainImpact.applied ? h('span.pill', `impact appliqué (${new Date(state.terrainImpact.ts).toLocaleTimeString('fr-FR')})`) : null)));
  // graphiques synchronisés
  const mk = (title, series, y) => { const { box, canvas } = chartBox('short'); g.append(panel(title, { cls: 'c6', badges: [badge('simulated')] }, box)); requestAnimationFrame(() => { const c = lineChart(canvas, series, { xLabel: 'distance (m)', yLabel: y, vlines: [{ x: 0 }] }); bag.add(c); charts.push(c); }); };
  const S = (arr) => sim.s.map((x, i) => ({ x, y: arr[i] }));
  mk('Courant par moteur (A)', [...WHEELS.map((w, j) => ({ label: `M${w.id}`, data: S(sim.wheel[j].I), color: color(j), width: 1.2 })), { label: 'M1 nominal', data: nom.s.map((x, i) => ({ x, y: nom.wheel[0].I[i] })), color: '#94A3B8', dashed: true }], 'A');
  mk('Charge normale par roue (N)', WHEELS.map((w, j) => ({ label: `R${w.id}`, data: S(sim.wheel[j].N), color: color(j), width: 1.2 })), 'N');
  mk('Tangage, roulis, rocker / bogie (°)', [{ label: 'tangage', data: S(sim.pitch), color: '#2563EB' }, { label: 'roulis', data: S(sim.roll), color: '#C2410C' }, { label: 'bogie G', data: S(sim.bogieL), color: '#16A34A', dashed: true }, { label: 'rocker G', data: S(sim.rockerL), color: '#7C3AED', dashed: true }], '°');
  mk('Glissement, puissance, température', [{ label: 'glissement max (×100 %)', data: sim.s.map((x, i) => ({ x, y: Math.max(...sim.wheel.map((w) => w.slip[i])) * 100 })), color: '#D97706' }, { label: 'puissance (W)', data: S(sim.power), color: '#2563EB' }, { label: 'puissance nominale (W)', data: nom.s.map((x, i) => ({ x, y: nom.power[i] })), color: '#94A3B8', dashed: true }, { label: 'T moteur 6 (°C)', data: S(sim.wheel[5].T), color: '#DC2626' }], '');
  g.append(panel('Équations du modèle (documentées)', { cls: 'c12' }, h('div.eq', EQ), h('div.small.muted', { style: { marginTop: '6px' } }, 'Hypothèses : quasi statique (pas de dynamique de caisse), sol homogène par zone, suspension représentée par les angles rocker/bogie calculés à partir des hauteurs de roues ; la maquette 3D bascule en tangage/roulis et chaque roue suit le sol. Valeurs K, I0, Crr, h_cg : démonstration.')));
  function update() {
    if (!sim) return;
    slider.value = k; lbl.textContent = `s = ${fmt(sim.s[k], 1)} m · t = ${fmt(sim.t[k] / 60, 1)} min · tangage ${fmt(sim.pitch[k], 1)}° · P = ${fmt(sim.power[k], 0)} W`;
    for (const c of charts) { c.options.plugins.bands.vlines = [{ x: sim.s[k], color: '#2563EB' }]; c.update('none'); }
    if (inst) placeRover();
  }
  function placeRover() {
    const r = carrier;
    r.position.set(sim.x[k], sim.y[k], sim.z[k]);
    r.rotation.set(0, 0, 0); r.rotation.order = 'YXZ'; r.rotation.y = sim.hd[k]; r.rotation.x = -(sim.pitch[k] * Math.PI) / 180; r.rotation.z = (sim.roll[k] * Math.PI) / 180;
    WHEELS.forEach((w, j) => { const pv = inst.wheelPivots[w.key]; if (!pv) return; pv.userData.y0 ??= pv.position.y; pv.position.y = pv.userData.y0 + sim.wheel[j].dy[k] * 0.5; pv.rotation.x = sim.s[k] / (pv.userData.radius || 0.26); });
    const st = {}; WHEELS.forEach((w, j) => { const I = sim.wheel[j].I[k], T = sim.wheel[j].T[k]; st[`motor_${w.id}`] = I >= 1.5 ? 'overload' : I >= 1.1 ? 'warn' : T >= 35 ? 'overtemp' : 'ok'; st[`wheel_${w.id}`] = sim.wheel[j].slip[k] > 0.6 ? 'fault' : sim.wheel[j].slip[k] > 0.3 ? 'warn' : 'ok'; });
    applyStatus(inst, st, {});
    if (follow) { const tgt = new THREE.Vector3(sim.x[k], sim.y[k] + 1, sim.z[k]); const back = new THREE.Vector3(-Math.sin(sim.hd[k]) * 6 + 3, 3.2, -Math.cos(sim.hd[k]) * 6); viewer.controls.target.lerp(tgt, 0.2); viewer.camera.position.lerp(tgt.clone().add(back), 0.08); }
  }
  // scène 3D
  viewer = new Viewer(stage, { ground: false, exposure: 1.0 });
  viewer.scene.background = new THREE.Color(0xd9a07a); viewer.scene.fog = new THREE.Fog(0xd9a07a, 25, 75);
  viewer.sun.shadow.camera.left = -30; viewer.sun.shadow.camera.right = 30; viewer.sun.shadow.camera.top = 30; viewer.sun.shadow.camera.bottom = -30;
  viewer.scene.add(terrainMesh(ter));
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ter.path.pts.filter((_, i) => i % 5 === 0).map((q) => new THREE.Vector3(q.x, ter.height(q.x, q.z) + 0.03, q.z))), new THREE.LineDashedMaterial({ color: 0x4cc3ff, dashSize: 0.3, gapSize: 0.2 }));
  line.computeLineDistances(); viewer.scene.add(line);
  viewer.camera.position.set(8, 6, -6); viewer.controls.target.set(0, 1, 2);
  loadDefaultModel().then(() => { if (!viewer) return; inst = createInstance(); carrier = new THREE.Group(); carrier.add(inst.root); viewer.scene.add(carrier); update(); });
  let acc = 0;
  viewer.tickers.add((dt) => { if (!playing || !sim) return; acc += dt * speedX * 10; const n = Math.floor(acc); if (n > 0) { acc -= n; k = Math.min(sim.t.length - 1, k + n); if (k >= sim.t.length - 1) { playing = false; playBtn.replaceChildren(icon('play'), 'Lecture'); } update(); } });
  update();
}
function terrainMesh(ter) {
  const size = 90, seg = 220, geo = new THREE.PlaneGeometry(size, size, seg, seg); geo.rotateX(-Math.PI / 2); geo.translate(10, 0, 30);
  const pos = geo.attributes.position, col = new Float32Array(pos.count * 3), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), y = ter.height(x, z); pos.setY(i, y);
    const sand = ter.sandAt(x, z) && Math.abs(x) < 60;
    c.setHSL(0.055, sand ? 0.45 : 0.55, sand ? 0.62 + 0.02 * Math.sin(x * 3) : 0.36 + 0.06 * y + 0.03 * Math.sin(x * 1.7 + z));
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
  m.receiveShadow = true; m.userData.ownGeometry = true;
  const grp = new THREE.Group(); grp.add(m);
  const rg = new THREE.DodecahedronGeometry(1, 0), rm = new THREE.MeshStandardMaterial({ color: 0x5a3322, roughness: 0.95 });
  for (const r of ter.rocks) { const s = new THREE.Mesh(rg, rm); s.scale.setScalar(r.r * 0.9); s.position.set(r.x, ter.height(r.x, r.z) - r.r * 0.3, r.z); s.castShadow = true; grp.add(s); }
  return grp;
}
/** Effets de la simulation sur l'état des composants (seuils de démonstration des composants). */
function deriveEffects(o) {
  const rows = {}, status = {}, extra = {};
  WHEELS.forEach((w, j) => {
    const mid = `motor_${w.id}`, wid = `wheel_${w.id}`, th = component(mid).thresholds[`motor${w.id}_current_A`] || { warn: 1.1, fault: 1.5 }, tt = component(mid).thresholds[`motor${w.id}_temp_C`] || { warn: 35, fault: 50 };
    const I = o.maxI[j], T = o.maxT[j], s = o.maxSlip[j];
    const ms = I >= th.fault ? 'overload' : T >= tt.fault ? 'overtemp' : I >= th.warn ? 'warn' : T >= tt.warn ? 'overtemp' : 'ok';
    status[mid] = { status: ms, reason: `courant max ${fmt(I, 2)} A, T max ${fmt(T, 1)} °C (seuils démo ${th.warn}/${th.fault} A)` };
    extra[mid] = o.dmg.motors[j] / 3600;
    rows[mid] = { reason: status[mid].reason, status: ms, extra: extra[mid] };
    const ws = s > 0.6 ? 'fault' : s > 0.3 ? 'warn' : 'ok';
    status[wid] = { status: ws, reason: `glissement max ${pct(s, 0)}${s > 0.6 ? ' — risque d\'enlisement' : ''}` };
    extra[wid] = o.dmg.wheels[j] / 1000;
    rows[wid] = { reason: status[wid].reason, status: ws, extra: extra[wid] };
  });
  extra.rocker_bogie_l = o.dmg.rockerL / 1000; extra.rocker_bogie_r = o.dmg.rockerR / 1000;
  rows.rocker_bogie_l = { reason: `surcharge cumulée côté gauche, |roulis| max ${fmt(Math.max(...o.roll.map(Math.abs)), 1)}°`, status: 'ok', extra: extra.rocker_bogie_l };
  rows.rocker_bogie_r = { reason: 'surcharge cumulée côté droit', status: 'ok', extra: extra.rocker_bogie_r };
  return { rows, status, extra };
}
