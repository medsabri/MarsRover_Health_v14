// Vignettes 3D des composants (rendu hors écran, mises en cache).
import * as THREE from 'three';
import { loadDefaultModel, createInstance, applyStatus, compBox } from './rover.js';
import { on } from '../core/store.js';
const cache = new Map();
on('model', () => cache.clear());
export async function thumbnails(ids, statuses) {
  await loadDefaultModel();
  const need = ids.filter((id) => !cache.has(id));
  if (need.length) {
    const W = 320, H = 180;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setSize(W, H); r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x5a3a28, 1.2)); const d = new THREE.DirectionalLight(0xffffff, 2); d.position.set(4, 8, 5); scene.add(d);
    const inst = createInstance(); scene.add(inst.root);
    const cam = new THREE.PerspectiveCamera(35, W / H, 0.01, 100);
    for (const id of need) {
      applyStatus(inst, statuses, { highlight: id, ghostOthers: true });
      const b = compBox(inst, id) || inst.box;
      const c = b.getCenter(new THREE.Vector3()), rad = Math.max(0.15, b.getBoundingSphere(new THREE.Sphere()).radius);
      cam.position.copy(c).add(new THREE.Vector3(1.4, 0.9, 1.6).normalize().multiplyScalar(rad / Math.sin((35 * Math.PI) / 360) * 1.1));
      cam.lookAt(c); r.render(scene, cam);
      cache.set(id, r.domElement.toDataURL('image/png'));
    }
    r.dispose(); r.forceContextLoss();
  }
  return Object.fromEntries(ids.map((id) => [id, cache.get(id)]));
}
