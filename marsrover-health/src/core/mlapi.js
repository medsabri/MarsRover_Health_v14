// =============================================================================
// mlapi.js — accès aux résultats du backend FMDS / ML.
//  * mode « api »      : application servie par le backend (python -m mrh.cli serve) → résultats en direct ;
//  * mode « snapshot » : ouverture hors ligne (file://) → instantané exporté data/ml_snapshot.js (lecture seule).
// Aucun calcul analytique n'est fait ici : seulement lecture, filtrage d'affichage et appels d'action.
// =============================================================================
let mode = null, snap = null;

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(`${src} introuvable`)); document.head.append(s); });
}
async function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('délai dépassé')), ms))]); }

export async function init() {
  if (mode) return mode;
  if (location.protocol.startsWith('http')) {
    try { const r = await withTimeout(fetch('api/health', { cache: 'no-store' }), 2000); if (r.ok) { mode = 'api'; return mode; } } catch { /* backend absent → instantané */ }
  }
  if (!window.MRH_ML_SNAPSHOT) await loadScript('data/ml_snapshot.js');
  snap = window.MRH_ML_SNAPSHOT; mode = 'snapshot';
  return mode;
}
export const getMode = () => mode;
export const snapshotDate = () => (snap ? snap.generated_at : null);
export const canWrite = () => mode === 'api';

async function api(path, opts = {}) {
  const r = await fetch(path.replace(/^\//, ''), { cache: 'no-store', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
  return body;
}
const inRange = (v, a, b) => (a === '' || a == null || v >= +a) && (b === '' || b == null || v <= +b);

/** Filtre d'affichage identique à celui de l'API (équipement exact ou préfixe « …- », période). */
function filterRows(rows, { equipment, t_from, t_to } = {}, tkey = 't') {
  return (rows || []).filter((r) => (!equipment || (equipment.endsWith('-') ? r.equipment_id.startsWith(equipment) : r.equipment_id === equipment)) && inRange(r[tkey], t_from, t_to));
}

export async function module(name, params = {}) {
  if (mode === 'api') return api(`/api/ia/${name}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null))}`);
  const m = structuredClone(snap.modules[name]);
  if (m.history) m.history = filterRows(m.history, params, name === 'anomalies' ? 't_end' : 't');
  if (m.results && params.equipment) m.results = filterRows(m.results, { equipment: params.equipment });
  return m;
}
export async function models() { return mode === 'api' ? api('/api/models') : snap.models; }
export async function comparison() { return mode === 'api' ? api('/api/comparison') : snap.comparison; }
export async function recommendations() { return mode === 'api' ? api('/api/recommendations') : snap.recommendations; }
export async function audit() { return mode === 'api' ? api('/api/data/audit') : snap.audit; }
export async function equipment() { return mode === 'api' ? api('/api/equipment') : snap.equipment; }

// ---------------------------------------------------------------- actions (backend requis)
function needApi() { if (mode !== 'api') throw new Error('Action indisponible hors ligne : lancez le backend (python -m mrh.cli serve) et ouvrez http://127.0.0.1:8765/.'); }
export async function train(moduleName) { needApi(); return api(`/api/models/${moduleName}/train`, { method: 'POST', body: '{}' }); }
export async function jobs() { needApi(); return api('/api/jobs'); }
export async function validateReco(id, decision, actor, comment) { needApi(); return api(`/api/recommendations/${id}/validate`, { method: 'POST', body: JSON.stringify({ decision, actor, comment }) }); }
export async function updateFmea(id, vals, actor) { needApi(); return api(`/api/fmea/${id}`, { method: 'PUT', body: JSON.stringify({ ...vals, actor }) }); }
export async function setFtaProbability(id, probability, source, actor) { needApi(); return api(`/api/fta/${id}/probability`, { method: 'POST', body: JSON.stringify({ probability, source, actor }) }); }
export { filterRows };
