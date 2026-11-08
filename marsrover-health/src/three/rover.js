// =============================================================================
// rover.js — modèle 3D du rover : chargement GLB/GLTF, découpage des pièces fusionnées,
// association composant ↔ maillages, coloration par état, modèle procédural de secours.
//  - En http(s) : fetch('assets/models/perseverance.glb')
//  - En file:// : injection de assets/models/perseverance.glb.js (base64) — fetch() y est interdit
//  - À tout moment : sélecteur de fichier / glisser-déposer .glb / .gltf (+ .bin, textures)
// Le maillage « Wheels_objs » du modèle fourni regroupe les 6 roues : il est découpé par
// géométrie (côté = signe de X, position avant/milieu/arrière = bandes de Z). Idem « suspension ».
// =============================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { emit } from '../core/store.js';
import { components } from '../core/data.js';
import { STATUS } from '../core/dom.js';

let base = null;        // { scene, source, info }
let loading = null;
export const WHEEL_KEYS = ['L_front', 'L_mid', 'L_rear', 'R_front', 'R_mid', 'R_rear'];

export function modelInfo() { return base ? base.info : null; }
export function hasModel() { return !!base; }

function b64ToBuffer(b64) {
  const bin = atob(b64); const len = bin.length; const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Script introuvable : ' + src)); document.head.append(s); });
}
function parseGLB(buffer, path = '') {
  return new Promise((res, rej) => new GLTFLoader().parse(buffer, path, res, rej));
}

/** Charge le modèle par défaut (une seule fois). Retourne une promesse résolue avec la scène de base. */
export function loadDefaultModel() {
  if (base) return Promise.resolve(base);
  if (loading) return loading;
  loading = (async () => {
    let gltf = null, source = '';
    try {
      if (/^https?:/.test(location.protocol)) {
        const r = await fetch('assets/models/perseverance.glb');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        gltf = await parseGLB(await r.arrayBuffer()); source = 'assets/models/perseverance.glb (fetch)';
      } else {
        await loadScript('assets/models/perseverance.glb.js');
        gltf = await parseGLB(b64ToBuffer(window.MRH_GLB_B64)); source = 'assets/models/perseverance.glb.js (embarqué, file://)';
        delete window.MRH_GLB_B64;
      }
    } catch (e) {
      console.warn('Modèle GLB non chargé, modèle procédural utilisé :', e.message);
      base = { scene: buildProcedural(), source: 'modèle procédural de secours', info: { procedural: true, error: e.message } };
      finalize(base); emit('model', base); return base;
    }
    base = { scene: gltf.scene, source, info: {} };
    finalize(base); emit('model', base); return base;
  })();
  return loading;
}
/** Remplace le modèle par un fichier utilisateur (.glb, ou .gltf + ressources). */
export async function loadModelFromFiles(files) {
  const main = files.find((f) => /\.(glb|gltf)$/i.test(f.name));
  if (!main) throw new Error('Aucun fichier .glb / .gltf fourni.');
  const urls = new Map(files.map((f) => [f.name, URL.createObjectURL(f)]));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((u) => { const name = decodeURIComponent(u.split('/').pop()); return urls.get(name) || u; });
  const loader = new GLTFLoader(manager);
  const gltf = await new Promise((res, rej) => loader.load(urls.get(main.name), res, undefined, rej));
  base = { scene: gltf.scene, source: `fichier utilisateur : ${main.name}`, info: {} };
  finalize(base); emit('model', base);
  return base;
}

// ------------------------------------------------------------------ préparation
function finalize(b) {
  const s = b.scene;
  s.updateMatrixWorld(true);
  splitMerged(s);
  // statistiques
  let meshes = 0, verts = 0; const names = new Set();
  s.traverse((o) => { if (o.name) names.add(o.name); if (o.isMesh) { meshes++; verts += o.geometry.attributes.position.count; o.castShadow = true; o.receiveShadow = true; } });
  b.info = { ...b.info, source: b.source, meshes, vertices: verts, nodes: names.size };
  // association composant → maillages (correspondance exacte des noms ; un sous-arbre nommé pour
  // un AUTRE composant n'est pas absorbé — ex. la tourelle, enfant du bras dans le GLB)
  const allKeys = new Set(components().flatMap((c) => (c.indicative3d ? [] : (c.model3dNode || '').split('|').filter(Boolean))));
  const byName = new Map(); s.traverse((o) => { if (o.name) { if (!byName.has(o.name)) byName.set(o.name, []); byName.get(o.name).push(o); } });
  const map = new Map(); const taken = new Set();
  const collect = (o, key, out) => {
    if (o !== null && o.name && o.name !== key && allKeys.has(o.name)) return;
    if (o.isMesh && !taken.has(o.uuid)) { taken.add(o.uuid); out.push(o); }
    o.children.forEach((ch) => collect(ch, key, out));
  };
  for (const c of components()) {
    if (c.indicative3d) { map.set(c.id, []); continue; }
    const objs = [];
    for (const k of (c.model3dNode || '').split('|').filter(Boolean)) for (const o of byName.get(k) || []) collect(o, k, objs);
    objs.forEach((m) => (m.userData.comp = c.id));
    map.set(c.id, objs);
  }
  b.info.unmapped = [...map.entries()].filter(([id, o]) => !o.length && !components().find((c) => c.id === id).indicative3d).map(([id]) => id);
  // centrage : sol à y = 0
  const box = new THREE.Box3().setFromObject(s);
  s.position.y -= box.min.y; s.position.x -= (box.min.x + box.max.x) / 2; s.position.z -= (box.min.z + box.max.z) / 2;
  s.updateMatrixWorld(true);
  b.box = new THREE.Box3().setFromObject(s);
}
function classifyWheel(x, z) { return (x > 0 ? 'L_' : 'R_') + (z > 0.3 ? 'front' : z < -0.6 ? 'rear' : 'mid'); }

/** Découpe « Wheels_objs » en 6 roues (+ moyeux) pivotables et « suspension » en G/D. */
function splitMerged(scene) {
  const wheels = scene.getObjectByName('Wheels_objs');
  if (wheels) {
    const groups = Object.fromEntries(WHEEL_KEYS.map((k) => [k, { tire: [], hub: [] }]));
    const meshes = []; wheels.traverse((o) => { if (o.isMesh) meshes.push(o); });
    for (const m of meshes) {
      const g = m.geometry, pos = g.attributes.position, idx = g.index ? g.index.array : null;
      const nTri = (idx ? idx.length : pos.count) / 3;
      const buckets = Object.fromEntries(WHEEL_KEYS.map((k) => [k, []]));
      for (let t = 0; t < nTri; t++) {
        const a = idx ? idx[3 * t] : 3 * t, b = idx ? idx[3 * t + 1] : 3 * t + 1, c = idx ? idx[3 * t + 2] : 3 * t + 2;
        const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
        buckets[classifyWheel(x, z)].push(a, b, c);
      }
      const isHub = m.material && /hub/i.test(m.material.name);
      for (const k of WHEEL_KEYS) {
        if (!buckets[k].length) continue;
        const ng = new THREE.BufferGeometry();
        for (const [n, att] of Object.entries(g.attributes)) ng.setAttribute(n, att);
        ng.setIndex(buckets[k]);
        // boîte englobante calculée sur les SEULS sommets indexés (computeBoundingBox utiliserait tout l'attribut partagé)
        const bb = new THREE.Box3(), v = new THREE.Vector3();
        for (const ix of buckets[k]) { v.fromBufferAttribute(pos, ix); bb.expandByPoint(v); }
        ng.boundingBox = bb; ng.boundingSphere = bb.getBoundingSphere(new THREE.Sphere());
        const nm = new THREE.Mesh(ng, m.material);
        nm.name = `Wheels_objs#${k}${isHub ? ':hub' : ':part'}`;
        groups[k][isHub ? 'hub' : 'tire'].push(nm);
      }
      m.parent.remove(m);
    }
    for (const k of WHEEL_KEYS) {
      const all = [...groups[k].tire, ...groups[k].hub]; if (!all.length) continue;
      const bb = new THREE.Box3(); all.forEach((m) => bb.union(m.geometry.boundingBox));
      const c = bb.getCenter(new THREE.Vector3());
      const pivot = new THREE.Group(); pivot.name = `Wheels_objs#${k}`; pivot.position.copy(c); pivot.userData.wheelKey = k; pivot.userData.radius = (bb.max.y - bb.min.y) / 2;
      const hubG = new THREE.Group(); hubG.name = `Wheels_objs#${k}:hub`;
      groups[k].tire.forEach((m) => { m.position.sub(c); pivot.add(m); });
      groups[k].hub.forEach((m) => { m.position.sub(c); hubG.add(m); });
      pivot.add(hubG);
      wheels.add(pivot);
    }
  }
  const susp = scene.getObjectByName('suspension');
  if (susp) {
    const meshes = []; susp.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const L = new THREE.Group(); L.name = 'suspension#L'; const R = new THREE.Group(); R.name = 'suspension#R';
    for (const m of meshes) {
      const g = m.geometry, pos = g.attributes.position, idx = g.index ? g.index.array : null;
      const nTri = (idx ? idx.length : pos.count) / 3, bl = [], br = [];
      for (let t = 0; t < nTri; t++) {
        const a = idx ? idx[3 * t] : 3 * t, b = idx ? idx[3 * t + 1] : 3 * t + 1, c = idx ? idx[3 * t + 2] : 3 * t + 2;
        ((pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3 > 0 ? bl : br).push(a, b, c);
      }
      for (const [arr, grp] of [[bl, L], [br, R]]) {
        if (!arr.length) continue;
        const ng = new THREE.BufferGeometry(); for (const [n, att] of Object.entries(g.attributes)) ng.setAttribute(n, att);
        ng.setIndex(arr); { const bb = new THREE.Box3(), v = new THREE.Vector3(); for (const ix of arr) { v.fromBufferAttribute(pos, ix); bb.expandByPoint(v); } ng.boundingBox = bb; ng.boundingSphere = bb.getBoundingSphere(new THREE.Sphere()); }
        grp.add(new THREE.Mesh(ng, m.material));
      }
      m.parent.remove(m);
    }
    susp.add(L, R);
  }
}

// ------------------------------------------------------------------ instances
/** Clone indépendant (matériaux clonés) pour une vue donnée. */
export function createInstance() {
  if (!base) return null;
  const root = base.scene.clone(true);
  const compMeshes = new Map(), wheelPivots = {};
  root.traverse((o) => {
    if (o.isMesh) {
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      o.userData.baseEmissive = (o.material.emissive || new THREE.Color(0)).clone();
      o.userData.baseOpacity = o.material.opacity;
      const c = o.userData.comp;
      if (c) { if (!compMeshes.has(c)) compMeshes.set(c, []); compMeshes.get(c).push(o); }
    }
    if (o.userData && o.userData.wheelKey) wheelPivots[o.userData.wheelKey] = o;
  });
  // marqueurs des composants sans maillage dédié (position indicative)
  const markers = new Map();
  for (const c of components()) {
    if (!c.indicative3d) continue;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 14), new THREE.MeshStandardMaterial({ color: 0x7b8aa3, emissive: 0x7b8aa3, emissiveIntensity: 0.6, transparent: true, opacity: 0.9 }));
    m.position.fromArray(c.anchor || [0, 1, 0]); m.name = `marker:${c.id}`; m.userData.comp = c.id; m.userData.marker = true;
    root.add(m); markers.set(c.id, m); compMeshes.set(c.id, [m]);
  }
  return { root, compMeshes, wheelPivots, markers, box: base.box.clone() };
}

/** Coloration par état. statuses : Map/obj compId → code d'état ; options : highlight, ghost (autres pièces translucides). */
export function applyStatus(inst, statuses, { highlight = null, ghostOthers = false, intensity = 0.55, impact = null } = {}) {
  const get = (id) => (statuses instanceof Map ? statuses.get(id) : statuses[id]);
  inst.root.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.userData.baseEmissive) { const m0 = Array.isArray(o.material) ? o.material[0] : o.material; o.userData.baseEmissive = m0.emissive ? m0.emissive.clone() : new THREE.Color(0); o.userData.baseOpacity = m0.opacity; }
    const id = o.userData.comp, mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m.emissive) continue;
      let col = null, k = 0;
      if (impact && id && impact[id] !== undefined) { const v = impact[id]; col = new THREE.Color().setHSL(0.33 * (1 - v), 0.9, 0.5); k = 0.25 + 0.6 * v; }
      else if (id && get(id)) { col = new THREE.Color(STATUS[get(id)] ? STATUS[get(id)].color : '#94A3B8'); k = get(id) === 'ok' ? intensity * 0.12 : get(id) === 'nodata' ? intensity * 0.15 : intensity; }
      if (highlight && id === highlight) { col = col || new THREE.Color('#2563EB'); k = Math.max(k, 0.9); }
      if (col) { m.emissive.copy(col); m.emissiveIntensity = k; } else { m.emissive.copy(o.userData.baseEmissive); m.emissiveIntensity = 1; }
      const ghost = ghostOthers && highlight && id !== highlight;
      m.transparent = ghost || o.userData.baseOpacity < 1 || !!o.userData.marker; m.opacity = ghost ? 0.12 : o.userData.baseOpacity ?? 1;
      m.depthWrite = !ghost;
    }
  });
}
/** Boîte englobante (monde) des maillages d'un composant. */
export function compBox(inst, id) {
  const ms = inst.compMeshes.get(id) || []; const b = new THREE.Box3();
  ms.forEach((m) => b.expandByObject(m));
  return b.isEmpty() ? null : b;
}

// ------------------------------------------------------------------ modèle procédural de secours
function buildProcedural() {
  const root = new THREE.Group(); root.name = 'procedural_rover';
  const M = (c, metal = 0.3) => new THREE.MeshStandardMaterial({ color: c, metalness: metal, roughness: 0.6 });
  const add = (name, geo, mat, pos, rot) => { const m = new THREE.Mesh(geo, mat); m.name = name; m.position.fromArray(pos); if (rot) m.rotation.set(...rot); root.add(m); return m; };
  add('Body', new THREE.BoxGeometry(1.3, 0.45, 2.0), M(0xd8d8d8), [0, 1.15, 0]);
  add('rtg', new THREE.CylinderGeometry(0.22, 0.22, 0.7, 24), M(0x444444, 0.6), [0, 1.2, -1.2], [Math.PI / 2.6, 0, 0]);
  add('antenna_hg', new THREE.CylinderGeometry(0.2, 0.2, 0.04, 28), M(0xbbbbbb), [0.42, 1.48, -0.4], [Math.PI / 2, 0, 0]);
  add('antenna_lg', new THREE.CylinderGeometry(0.03, 0.03, 0.3, 10), M(0x999999), [0.5, 1.55, -0.9]);
  add('antenna_uhf', new THREE.CylinderGeometry(0.05, 0.05, 0.25, 12), M(0x999999), [-0.5, 1.5, -1.05]);
  add('base', new THREE.CylinderGeometry(0.05, 0.05, 0.75, 12), M(0xcccccc), [-0.55, 1.75, 0.72]);
  add('head', new THREE.BoxGeometry(0.42, 0.2, 0.18), M(0x888888, 0.5), [-0.55, 2.15, 0.72]);
  add('hazcams_front', new THREE.BoxGeometry(0.5, 0.08, 0.08), M(0x222222), [0, 0.75, 1.02]);
  add('hazcams_rear', new THREE.BoxGeometry(0.5, 0.08, 0.08), M(0x222222), [0, 0.8, -1.05]);
  const arm = add('arm.003', new THREE.CylinderGeometry(0.05, 0.05, 1.0, 12), M(0xaaaaaa), [0.15, 0.95, 1.25], [0, 0, Math.PI / 2]);
  add('arm.002', new THREE.CylinderGeometry(0.04, 0.04, 0.7, 12), M(0xaaaaaa), [0.55, 0.7, 1.35], [0.4, 0, 0]);
  add('turret_obj', new THREE.BoxGeometry(0.3, 0.3, 0.3), M(0x777777, 0.5), [0.55, 0.42, 1.5]);
  add('PIXL', new THREE.BoxGeometry(0.12, 0.12, 0.12), M(0x333333), [0.72, 0.42, 1.55]);
  arm.userData.procedural = true;
  const susp = new THREE.Group(); susp.name = 'suspension'; root.add(susp);
  for (const side of ['L', 'R']) { const s = side === 'L' ? 1 : -1; const g = new THREE.Group(); g.name = `suspension#${side}`;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 2.3), M(0xbbbbbb)); bar.position.set(0.85 * s, 0.7, 0); bar.rotation.x = 0.05; g.add(bar); susp.add(g); }
  const wheels = new THREE.Group(); wheels.name = 'Wheels_objs'; root.add(wheels);
  const zPos = { front: 1.0, mid: -0.1, rear: -1.2 };
  for (const k of WHEEL_KEYS) {
    const [side, band] = k.split('_'); const s = side === 'L' ? 1 : -1;
    const p = new THREE.Group(); p.name = `Wheels_objs#${k}`; p.position.set(1.0 * s, 0.26, zPos[band]); p.userData.wheelKey = k; p.userData.radius = 0.26;
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.24, 28), M(0x9a9a9a, 0.7)); tire.rotation.z = Math.PI / 2; tire.name = `Wheels_objs#${k}:part`; p.add(tire);
    const hubG = new THREE.Group(); hubG.name = `Wheels_objs#${k}:hub`;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.27, 16), M(0x553322, 0.5)); hub.rotation.z = Math.PI / 2; hubG.add(hub); p.add(hubG);
    wheels.add(p);
  }
  return root;
}
