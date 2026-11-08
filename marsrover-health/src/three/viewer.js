// =============================================================================
// viewer.js — scène three.js réutilisable : rendu, caméra orbitale, lumières, sélection,
// étiquettes HTML projetées, compteur d'images/s (contrôle qualité ≥ 30 fps).
// =============================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { h } from '../core/dom.js';

export class Viewer {
  constructor(container, { background = null, ground = true, fpsEl = true, exposure = 1.1 } = {}) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = exposure;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', 'Vue 3D interactive du rover (glisser pour tourner, molette pour zoomer)');
    this.renderer.domElement.tabIndex = 0;
    this.scene = new THREE.Scene(); if (background) this.scene.background = new THREE.Color(background);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 500);
    this.camera.position.set(4.2, 2.6, 4.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1, 0); this.controls.enableDamping = true; this.controls.maxDistance = 40; this.controls.minDistance = 1.2;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    const hemi = new THREE.HemisphereLight(0xffffff, 0xb08a70, 1.15); this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1e0, 2.2); sun.position.set(5, 9, 4); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 30 });
    this.scene.add(sun); this.sun = sun;
    const fill = new THREE.DirectionalLight(0x9ec5ff, 0.6); fill.position.set(-6, 3, -4); this.scene.add(fill);
    if (ground) {
      const g = new THREE.Mesh(new THREE.CircleGeometry(9, 64), new THREE.MeshStandardMaterial({ color: 0xD8B59A, roughness: 1, metalness: 0 }));
      g.rotation.x = -Math.PI / 2; g.receiveShadow = true; g.name = '__ground'; this.scene.add(g);
      const grid = new THREE.PolarGridHelper(8, 16, 8, 64, 0xC9967A, 0xC9A58D); grid.position.y = 0.002; grid.material.transparent = true; grid.material.opacity = 0.5; this.scene.add(grid);
    }
    this.labels = h('div', { style: { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' } });
    container.append(this.labels);
    if (fpsEl) { this.fpsEl = h('div.fps', '— fps'); container.append(this.fpsEl); }
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    this.onPick = null; this.onHover = null; this.pickables = [];
    this._frames = 0; this._t0 = performance.now(); this.fps = 0; this.tickers = new Set(); this.labelItems = [];
    this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(container);
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
    el.addEventListener('pointerup', (e) => { if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) this._pick(e, 'pick'); down = null; });
    el.addEventListener('pointermove', (e) => this._pick(e, 'hover'));
    this.resize();
    this._loop = this._loop.bind(this); this._raf = requestAnimationFrame(this._loop);
  }
  resize() {
    const w = this.container.clientWidth || 300, hgt = this.container.clientHeight || 200;
    this.renderer.setSize(w, hgt, false); this.camera.aspect = w / hgt; this.camera.updateProjectionMatrix();
  }
  _pick(e, kind) {
    const cb = kind === 'pick' ? this.onPick : this.onHover; if (!cb) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, true);
    const hit = hits.find((x) => x.object.userData.comp && x.object.visible);
    cb(hit ? hit.object.userData.comp : null, e);
  }
  frame(box, factor = 1.4) {
    const c = box.getCenter(new THREE.Vector3()), r = box.getBoundingSphere(new THREE.Sphere()).radius;
    const fov = (this.camera.fov * Math.PI) / 180, fovH = 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect);
    const d = (r * factor) / Math.sin(Math.min(fov, fovH) / 2);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(c); this.camera.position.copy(c).add(dir.multiplyScalar(Math.max(d, 1.5)));
  }
  addLabel(el, getPos) { this.labels.append(el); const it = { el, getPos }; this.labelItems.push(it); return it; }
  clearLabels() { this.labelItems.forEach((i) => i.el.remove()); this.labelItems = []; }
  _updateLabels() {
    const w = this.container.clientWidth, hgt = this.container.clientHeight, v = new THREE.Vector3();
    const vis = [];
    for (const it of this.labelItems) {
      if (it.el.classList.contains('off')) continue;
      const p = it.getPos(); if (!p) { it.el.classList.add('hidden'); continue; }
      v.copy(p).project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) { it.el.classList.add('hidden'); continue; }
      it.el.classList.remove('hidden');
      it.x = ((v.x + 1) / 2) * w; it.y = ((1 - v.y) / 2) * hgt; it.depth = v.z;
      vis.push(it);
    }
    if (!this.avoidOverlap) { for (const it of vis) { it.el.style.left = `${it.x}px`; it.el.style.top = `${it.y}px`; } return; }
    // anti-chevauchement glouton : priorité (sélection, défaut…) puis profondeur ; essais de décalages verticaux / latéraux
    vis.sort((a, b) => (b.priority ? b.priority() : 0) - (a.priority ? a.priority() : 0) || a.depth - b.depth);
    const placed = [], pad = 3;
    const hit = (r) => placed.some((q) => r.x < q.x + q.w + pad && r.x + r.w + pad > q.x && r.y < q.y + q.h + pad && r.y + r.h + pad > q.y);
    for (const it of vis) {
      const lw = it.el.offsetWidth, lh = it.el.offsetHeight, st = lh + pad;
      const tries = [[0, 0], [0, -st], [0, st], [lw / 2 + pad, 0], [-lw / 2 - pad, 0], [0, -2 * st], [0, 2 * st], [lw / 2 + pad, -st], [-lw / 2 - pad, -st], [lw / 2 + pad, st], [-lw / 2 - pad, st]];
      let ok = null;
      for (const [dx, dy] of tries) { const r = { x: it.x + dx - lw / 2, y: it.y + dy - lh, w: lw, h: lh }; if (r.x >= 0 && r.x + lw <= w && r.y >= 0 && r.y + lh <= hgt && !hit(r)) { ok = [dx, dy, r]; break; } }
      if (!ok) { const r = { x: it.x - lw / 2, y: it.y - lh, w: lw, h: lh }; ok = [0, 0, r]; it.el.classList.add('crowded'); } else it.el.classList.remove('crowded');
      placed.push(ok[2]);
      it.el.style.left = `${it.x + ok[0]}px`; it.el.style.top = `${it.y + ok[1]}px`;
      it.el.classList.toggle('moved', ok[0] !== 0 || ok[1] !== 0);
    }
  }
  _loop(now) {
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.min(0.1, (now - (this._last || now)) / 1000); this._last = now;
    this.tickers.forEach((f) => f(dt, now));
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (this.labelItems.length) this._updateLabels();
    this._frames++;
    if (now - this._t0 > 1000) { this.fps = (this._frames * 1000) / (now - this._t0); this._frames = 0; this._t0 = now; if (this.fpsEl) this.fpsEl.textContent = `${this.fps.toFixed(0)} fps`; }
  }
  dispose() {
    cancelAnimationFrame(this._raf); this._ro.disconnect(); this.controls.dispose();
    this.scene.traverse((o) => { if (o.isMesh && o.userData.ownGeometry) o.geometry.dispose(); });
    this.renderer.dispose(); this.renderer.forceContextLoss && this.renderer.forceContextLoss();
    this.renderer.domElement.remove(); this.labels.remove(); this.fpsEl && this.fpsEl.remove();
  }
}
