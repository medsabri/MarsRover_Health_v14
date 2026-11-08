// =============================================================================
// store.js — état global, abonnements, persistance (localStorage + IndexedDB).
// Tout accès au stockage navigateur est protégé (mode privé, file://, quotas).
// =============================================================================
const listeners = new Map();
export const state = {
  theme: 'light',
  provFilter: new Set(['mission', 'experimental', 'simulated', 'substituted']),
  activeDataset: 'bearings_exp',
  cursorTime: null,          // instant d'analyse (h) sur la télémétrie
  overrides: {},             // modifications locales des composants (durée nominale, seuils…)
  fmecaOverrides: {},
  journal: [],               // journal des traitements (reproductibilité)
  scenarios: [],             // scénarios de perturbation sauvegardés
  matlabResults: [],         // résultats importés depuis MATLAB
  terrainImpact: null,       // dernier résultat de simulation de terrain
  perturbImpact: null,       // dernier test de perturbation
  settings: { lifeInterpretation: 'L10', Rstar: 0.95, llmModel: 'claude-sonnet-5-5', llmEndpoint: 'https://api.anthropic.com/v1/messages', mpsUrl: '' },
};
export function on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); }
export function emit(evt, payload) { (listeners.get(evt) || []).forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } }); }

const LS = 'mrh.v1.';
export function lsGet(k, def) { try { const v = localStorage.getItem(LS + k); return v === null ? def : JSON.parse(v); } catch (e) { return def; } }
export function lsSet(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch (e) { return false; } }

export function loadPersisted() {
  state.theme = lsGet('themeV2', state.theme);
  const pf = lsGet('provFilter', null); if (Array.isArray(pf)) state.provFilter = new Set(pf);
  state.activeDataset = lsGet('activeDataset', state.activeDataset);
  state.overrides = lsGet('overrides', {});
  state.fmecaOverrides = lsGet('fmecaOverrides', {});
  state.journal = lsGet('journal', []);
  state.scenarios = lsGet('scenarios', []);
  state.matlabResults = lsGet('matlabResults', []);
  state.settings = { ...state.settings, ...lsGet('settings', {}) };
  state.terrainImpact = lsGet('terrainImpact', null);
}
export function persist(key) {
  if (key === 'theme') { lsSet('themeV2', state.theme); return; }
  const v = key === 'provFilter' ? [...state.provFilter] : state[key];
  lsSet(key, v);
}
export function set(key, value, { save = true } = {}) { state[key] = value; if (save) persist(key); emit('change:' + key, value); emit('change', key); }

/** Journal des traitements : chaque calcul notable est tracé (action, paramètres, graine, version). */
export function log(action, params = {}) {
  const e = { ts: new Date().toISOString(), action, params, app: '1.0.0' };
  state.journal.unshift(e); if (state.journal.length > 400) state.journal.length = 400;
  persist('journal'); emit('journal', e);
}

// ------------------------------------------------------------------ IndexedDB (datasets importés)
const DB = 'mrh-db', STORE = 'datasets';
function idb() {
  return new Promise((res, rej) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
}
export async function idbPut(obj) { try { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(obj); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); return true; } catch (e) { return false; } }
export async function idbAll() { try { const db = await idb(); return await new Promise((res, rej) => { const tx = db.transaction(STORE, 'readonly'); const q = tx.objectStore(STORE).getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); }); } catch (e) { return []; } }
export async function idbDel(id) { try { const db = await idb(); await new Promise((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(id); tx.oncomplete = res; }); return true; } catch (e) { return false; } }
