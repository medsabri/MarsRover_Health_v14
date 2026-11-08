// =============================================================================
// analysis.js — moteur d'analyse : états des composants, alertes, métriques, RUL, substitution.
// Chaque résultat porte sa provenance et la méthode/règle qui le justifie (traçabilité §13).
// =============================================================================
import { state, on } from './store.js';
import { ds, components, component, lifetimes, registry } from './data.js';
import { detectVariable, evaluate, iforestDetect, segments } from '../ml/anomaly.js';
import { groupTrajectories, rulBenchmark } from '../ml/rul.js';
import { substitutionPlan } from '../ml/substitution.js';
import { fmdsFromEvents, NOT_COMPUTABLE } from '../ml/fmds.js';
import { linreg, mean } from '../ml/stats.js';
import { SEVERITY } from './dom.js';

export const TRAIN_END_H = 800;          // fenêtre d'apprentissage « normale » (méta-données du dataset)
export const WINDOW_H = 48;              // fenêtre d'évaluation de l'état courant
const TEL = 'rover_telemetry_sim';
let cache = new Map();
export function invalidate() { cache = new Map(); }
on('change', (k) => { if (['overrides', 'settings', 'terrainImpact', 'fmecaOverrides'].includes(k)) invalidate(); });
on('datasets', invalidate);
const memo = (k, fn) => { if (!cache.has(k)) cache.set(k, fn()); return cache.get(k); };

// ------------------------------------------------------------------ télémétrie
export function tel() {
  return memo('tel', () => {
    const d = ds(TEL); if (!d) return null;
    const R = d.rows;
    const g = (c) => R.map((r) => (r[c] === null || r[c] === '' || r[c] === undefined ? NaN : +r[c]));
    const t = g('time_h');
    return { rows: R, t, g, op: R.map((r) => r.op_mode), terrain: R.map((r) => r.terrain),
      ctx: R.map((r) => r.op_mode + '|' + r.terrain), train: t.map((x) => x < TRAIN_END_H), amb: g('ambient_temp_C'), tmax: t[t.length - 1], meta: d.meta };
  });
}
export const cursor = () => (state.cursorTime ?? (tel() ? tel().tmax : 0));
export const LABEL_OF = { motor3_current_A: 'label_motor3_drift', arm_current_A: 'label_arm_overload', bat_voltage_V: 'label_bat_voltage_drop', avionics_temp_C: 'label_thermal_heater_stuck', heater_power_W: 'label_thermal_heater_stuck', link_margin_dB: 'label_comm_unplanned_loss', hazcam_temp_C: 'label_hazcam_stuck' };
export const isTemp = (v) => /temp/i.test(v);
export const isCurrent = (v) => /current/i.test(v);

/** Détection pour une variable de télémétrie, paramétrée par les seuils du composant. */
export function detect(variable, compId) {
  const comp = compId ? component(compId) : components().find((c) => c.thresholds && c.thresholds[variable]);
  const th = comp && comp.thresholds ? comp.thresholds[variable] : null;
  return memo(`det:${variable}:${JSON.stringify(th)}`, () => {
    const T = tel(); if (!T) return null;
    const v = T.g(variable);
    const r = detectVariable(v, { t: T.t, trainMask: T.train, context: T.ctx, coarse: T.op, reference: isTemp(variable) && variable !== 'avionics_temp_C' ? T.amb : null, threshold: th, checkStuck: /hazcam|temp_C/.test(variable) && !/motor|avionics/.test(variable) });
    r.values = v; r.variable = variable; r.threshold = th;
    return r;
  });
}
export function iforestMotors() {
  return memo('ifo', () => {
    const T = tel(); if (!T) return null;
    const cols = [1, 2, 3, 4, 5, 6].map((i) => T.g(`motor${i}_current_A`));
    // caractéristique supplémentaire : écart du moteur i à la médiane des 6 moteurs (cohérence inter-roues)
    const med = T.t.map((_, k) => { const a = cols.map((c) => c[k]).sort((x, y) => x - y); return (a[2] + a[3]) / 2; });
    const dev = cols.map((c) => c.map((x, k) => x - med[k]));
    const r = iforestDetect(dev, T.train.map((m, k) => m && T.op[k] === 'drive'), { seed: 7, contamination: 0.005 });
    // n'évaluer qu'en conduite
    r.flag = r.flag.map((f, k) => (T.op[k] === 'drive' ? f : 0));
    r.dev = dev;
    return r;
  });
}

// ------------------------------------------------------------------ usage consommé
export function usageAt(comp, tq = cursor()) {
  const T = tel(); const u = comp.usage || {}; let val = null;
  if (!T) return { value: null, unit: u.unit };
  const k = T.t.findIndex((x) => x > tq); const n = k < 0 ? T.t.length : k;
  const dt = 2;
  switch (u.variable) {
    case 'odometry_km': val = T.g('odometry_km')[n - 1]; break;
    case 'arm_cycles': val = T.g('arm_cycles')[n - 1]; break;
    case 'time_h': val = T.t[n - 1]; break;
    case '__drive_hours': val = T.op.slice(0, n).filter((o) => o === 'drive').length * dt; break;
    case '__arm_hours': val = T.op.slice(0, n).filter((o) => o === 'arm').length * dt; break;
    case '__mission_years': val = T.t[n - 1] / 8766; break;
    case '__abrasion_ops': { // règle de démonstration : 1 opération d'abrasion par session « bras » de 2 sols
      const sess = segments(T.op.slice(0, n).map((o) => (o === 'arm' ? 1 : 0)), T.t).length; val = Math.floor(sess / 2); break; }
    case '__battery_cycles': { const b = ds('battery_sim'); val = b ? Math.max(...b.rows.filter((r) => r.pack_id === 'ROVER_PACK').map((r) => r.cycle)) : null; break; }
    default: val = null;
  }
  // dommage équivalent ajouté par la dernière simulation de terrain (loi charge-vie cubique), si appliquée
  let extra = 0;
  const ti = state.terrainImpact;
  if (ti && ti.applied && ti.equivalentUsage && ti.equivalentUsage[comp.id]) extra = ti.equivalentUsage[comp.id];
  return { value: val, extra, total: val === null ? null : val + extra, unit: u.unit, variable: u.variable, source: u.variable && u.variable.startsWith('__') ? 'dérivé de la télémétrie simulée' : 'télémétrie simulée' };
}
export function usagePerSol(comp) {
  const T = tel(); if (!T) return null;
  const u1 = usageAt(comp, T.tmax).value, u0 = usageAt(comp, 0).value;
  const sols = T.tmax / 24.66; return u1 !== null && u0 !== null ? (u1 - u0) / sols : null;
}

// ------------------------------------------------------------------ RUL (datasets avec fin de vie définie)
export function rulBattery() {
  return memo('rulBat', () => {
    const d = ds('battery_sim'); if (!d) return null;
    const comp = component('battery'); const thr = comp.eol ? comp.eol.threshold : null;
    if (!thr) return { available: false, reason: 'Aucun seuil de fin de vie défini.' };
    const trajs = groupTrajectories(d.rows, { idCol: 'pack_id', tCol: 'cycle', yCol: 'capacity_Ah' });
    const split = d.meta.split;
    const b = rulBenchmark(trajs.filter((u) => u.id !== 'ROVER_PACK'), split, { threshold: thr, direction: 'down', ref: 40, kind: 'power', unit: 'cycles' });
    const rp = trajs.find((u) => u.id === 'ROVER_PACK');
    const pred = b.models[b.chosen].predict(rp.t, rp.y);
    return { ...b, current: pred, trajectory: rp, trajs, soh: rp.y[rp.y.length - 1] / 40, provenance: 'simulated' };
  });
}
export function rulVibration() {
  return memo('rulVib', () => {
    const d = ds('vib_bearings_sim'); if (!d) return null;
    const trajs = groupTrajectories(d.rows, { idCol: 'ID_Roulement', tCol: 'Cycle_Heure', yCol: 'Vibration_RMS' });
    const b = rulBenchmark(trajs, d.meta.split, { threshold: d.meta.events.eol_threshold.value, unit: 'h', kind: 'exp' });
    return { ...b, trajs, provenance: 'simulated' };
  });
}

// ------------------------------------------------------------------ substitution (composants non paramétriques)
export function substitution(compId, opts = {}) {
  const comp = component(compId);
  const key = `sub:${compId}:${JSON.stringify(opts)}:${JSON.stringify(comp.design_life)}:${state.settings.lifeInterpretation}:${state.settings.Rstar}:${state.terrainImpact && state.terrainImpact.applied ? state.terrainImpact.ts : ''}`;
  return memo(key, () => {
    if (!comp.substitution) return { ok: false, reason: 'Aucune source de substitution pertinente n\'est disponible pour ce composant.' };
    const shapeId = opts.shapeSource || comp.substitution.sources.find((s) => s === 'bearings_exp') || comp.substitution.sources[0];
    const lt = lifetimes(shapeId);
    if (!lt) return { ok: false, reason: `Source « ${shapeId} » non chargée.` };
    const vib = ds('vib_bearings_sim');
    const trajs = vib ? groupTrajectories(vib.rows, { idCol: 'ID_Roulement', tCol: 'Cycle_Heure', yCol: 'Vibration_RMS' }).filter((u) => vib.meta.split.train.includes(u.id)) : [];
    const u = usageAt(comp);
    const plan = substitutionPlan(comp, {
      lifetimes: { times: lt.times, events: lt.events, name: lt.name, provenance: lt.prov, unit: lt.unit },
      trajectories: trajs.length ? { trajs, threshold: 3.5, name: vib.meta.name + ' (unités d\'apprentissage uniquement)' } : null,
    }, { interpretation: opts.interpretation || state.settings.lifeInterpretation, Rstar: opts.Rstar || state.settings.Rstar, usageNow: u.total || 0, usagePerSol: usagePerSol(comp), lifeOverride: opts.lifeOverride });
    plan.shapeSource = shapeId;
    return plan;
  });
}

// ------------------------------------------------------------------ état d'un composant
export function componentState(compId, tq = cursor()) {
  const comp = component(compId);
  return memo(`st:${compId}:${tq}`, () => {
    const res = { id: compId, comp, status: 'nodata', health: null, confidence: 0, provenance: comp.dataset ? comp.dataset.provenance : null, reasons: [], lastValues: [], trend: [], regime: comp.dataset && comp.dataset.parametric ? 'paramétrique' : comp.substitution ? 'non paramétrique (substitution)' : 'aucune donnée', rul: null };
    const T = tel();
    const vars = (comp.dataset && comp.dataset.id === TEL ? comp.dataset.variables : comp.dataset && comp.dataset.telemetry) || [];
    let worst = 'ok', anyData = false, scores = [];
    if (T && vars.length) {
      const k1 = T.t.findIndex((x) => x > tq); const i1 = (k1 < 0 ? T.t.length : k1) - 1;
      const i0 = Math.max(0, T.t.findIndex((x) => x >= tq - WINDOW_H));
      for (const v of vars) {
        const d = detect(v, compId); if (!d) continue;
        const win = []; for (let i = i0; i <= i1; i++) win.push(i);
        const finite = win.filter((i) => Number.isFinite(d.values[i]));
        if (!finite.length) { res.reasons.push(`${v} : aucune mesure dans la fenêtre (${WINDOW_H} h)${v === 'link_margin_dB' ? ' — coupure de liaison PROGRAMMÉE (hors passage orbiteur), non comptée comme panne' : ''}`); continue; }
        anyData = true;
        const last = finite[finite.length - 1];
        res.lastValues.push({ variable: v, value: d.values[last], t: T.t[last], unit: (d.threshold && d.threshold.unit) || '' });
        // tendance sur 200 h (pente) dans le contexte dominant
        const tw = []; const yw = [];
        for (let i = Math.max(0, i1 - 100); i <= i1; i++) if (Number.isFinite(d.values[i]) && (T.op[i] === T.op[last] || !isCurrent(v))) { tw.push(T.t[i]); yw.push(d.values[i]); }
        const lr = linreg(tw, yw);
        res.trend.push({ variable: v, slopePer100h: lr ? lr.b * 100 : null });
        const fl = finite.filter((i) => d.flag[i]);
        const sc = finite.map((i) => d.score[i]).filter((x) => x !== null); scores.push(...sc);
        let st = 'ok';
        if (finite.some((i) => d.stuck[i])) { st = 'sensor'; res.reasons.push(`${v} : valeur figée détectée (capteur suspect)`); }
        else if (finite.some((i) => d.th[i] === 2)) { st = isTemp(v) ? 'overtemp' : isCurrent(v) ? 'overload' : 'fault'; res.reasons.push(`${v} : seuil de défaut dépassé (${fmtTh(d.threshold)})`); }
        else if (fl.length) {
          const thw = finite.some((i) => d.th[i] === 1);
          st = thw && isTemp(v) ? 'overtemp' : 'warn';
          res.reasons.push(`${v} : ${d.rule[fl[fl.length - 1]]}`);
        }
        if (SEVERITY[st] > SEVERITY[worst]) worst = st;
      }
    }
    if (compId === 'battery') {
      const rb = rulBattery();
      if (rb && rb.current) {
        anyData = true; res.rul = { ...rb.current, provenance: 'simulated' };
        res.soh = rb.soh;
        if (rb.soh <= 0.8) { worst = 'fault'; res.reasons.push(`SOH = ${(rb.soh * 100).toFixed(1)} % ≤ 80 % (fin de vie)`); }
        else if (rb.soh <= 0.85 && SEVERITY.warn > SEVERITY[worst]) { worst = 'warn'; res.reasons.push(`SOH = ${(rb.soh * 100).toFixed(1)} % : proche du seuil de fin de vie (80 %)`); }
      }
    }
    if (comp.dataset && comp.dataset.parametric && anyData) {
      res.status = worst; res.provenance = comp.dataset.provenance;
      res.health = Math.max(0, Math.min(1, 1 - (scores.length ? Math.max(...scores.slice(-12)) : 0) * 0.9 - (worst === 'ok' ? 0 : SEVERITY[worst] * 0.12)));
      res.confidence = 0.6; // données SIMULÉES : confiance plafonnée
      if (!res.rul) res.rulNote = comp.eol ? null : 'RUL masquée : aucune fin de vie définie pour ce composant (seuils de démonstration uniquement).';
    } else if (comp.substitution) {
      const p = substitution(compId);
      if (p.ok) {
        res.provenance = 'substituted';
        res.status = p.state.verdict === 'Bon état' ? 'ok' : p.state.verdict === 'À surveiller' ? 'warn' : 'fault';
        res.health = p.state.R; res.confidence = p.state.confidence; res.subst = p;
        res.reasons.push(`Estimation par substitution : R(usage) = ${(p.state.R * 100).toFixed(1)} %, ${p.state.consumedPctOfTPM.toFixed(0)} % de l'âge d'intervention (R* = ${p.params.Rstar})`);
        res.rulNote = 'RUL non affichée : aucune fin de vie mesurée sur ce composant (fiabilité estimée par substitution à la place).';
      } else { res.status = 'nodata'; res.reasons.push(p.reason); }
      // indicateur contextuel (proxy) : courant moteur associé
      if (comp.substitution.proxy_indicator) {
        const d = detect(comp.substitution.proxy_indicator);
        if (d && T) {
          const k1 = T.t.findIndex((x) => x > tq); const i1 = (k1 < 0 ? T.t.length : k1) - 1;
          const recent = []; for (let i = Math.max(0, i1 - 24); i <= i1; i++) if (d.flag[i]) recent.push(i);
          if (recent.length) { res.reasons.push(`Indicateur contextuel ${comp.substitution.proxy_indicator} en alerte (effort de déplacement anormal à vérifier)`); if (res.status === 'ok') res.status = 'warn'; }
        }
      }
    } else { res.status = 'nodata'; res.reasons.push('Aucun dataset ni source de substitution : données insuffisantes.'); }
    // impact de la simulation de terrain appliqué au tableau de bord
    const ti = state.terrainImpact;
    if (ti && ti.applied && ti.status && ti.status[compId]) {
      const s = ti.status[compId];
      if (SEVERITY[s.status] > SEVERITY[res.status]) { res.status = s.status; res.reasons.push(`Simulation de terrain (SIMULÉ) : ${s.reason}`); }
    }
    return res;
  });
}
function fmtTh(th) { if (!th) return ''; return Object.entries(th).filter(([k]) => /warn|fault/.test(k)).map(([k, v]) => `${k} = ${v} ${th.unit || ''}`).join(', ') + (th.source ? ` — ${th.source}` : ''); }

export function allStates(tq = cursor()) { return components().map((c) => componentState(c.id, tq)); }
export function globalHealth(tq = cursor()) {
  const S = allStates(tq);
  const w = { high: 3, medium: 2, low: 1 };
  const known = S.filter((s) => s.health !== null);
  const hs = known.length ? known.reduce((a, s) => a + s.health * (w[s.comp.criticality] || 1), 0) / known.reduce((a, s) => a + (w[s.comp.criticality] || 1), 0) : null;
  const worst = S.reduce((m, s) => (SEVERITY[s.status] > SEVERITY[m] ? s.status : m), 'ok');
  return { health: hs, worst, counts: S.reduce((a, s) => ((a[s.status] = (a[s.status] || 0) + 1), a), {}), critical: S.filter((s) => SEVERITY[s.status] >= 3), states: S };
}

// ------------------------------------------------------------------ alertes
export function alerts(tq = cursor()) {
  return memo(`alerts:${tq}`, () => {
    const T = tel(); if (!T) return [];
    const out = [];
    for (const comp of components()) {
      const vars = comp.dataset && comp.dataset.id === TEL ? comp.dataset.variables : (comp.dataset && comp.dataset.telemetry) || [];
      for (const v of vars) {
        const d = detect(v, comp.id); if (!d) continue;
        const fl = d.flag.map((f, i) => (T.t[i] <= tq && T.t[i] >= TRAIN_END_H ? f : 0));
        for (const s of segments(fl, T.t)) {
          let worst = s.i0, zmax = 0;
          for (let i = s.i0; i <= s.i1; i++) if (d.z[i] !== null && Math.abs(d.z[i]) > zmax) { zmax = Math.abs(d.z[i]); worst = i; }
          const thL = d.th[worst];
          const sev = d.stuck[worst] ? 'sensor' : thL === 2 ? (isTemp(v) ? 'overtemp' : isCurrent(v) ? 'overload' : 'fault') : 'warn';
          const ref = d.ref[T.ctx[worst]] || d.ref[T.op[worst]];
          out.push({ id: `${v}@${s.t0}`, component: comp.id, componentName: comp.name, variable: v, start: s.t0, end: s.t1, sol: T.rows[s.i0].sol, value: d.values[worst], z: d.z[worst], severity: sev,
            rule: d.rule[worst] || d.rule[s.i0], model: d.stuck[worst] ? 'Détecteur de valeur figée' : thL ? 'Seuil physique' : 'z-score robuste contextuel (médiane/MAD, apprentissage 0–800 h)',
            factors: [`mode : ${T.op[worst]}`, `terrain : ${T.terrain[worst]}`, ref ? `référence contexte : médiane ${ref.med.toFixed(3)}, MAD ${ref.mad.toFixed(3)}` : 'référence globale', `durée ${s.t1 - s.t0 + 2} h`],
            provenance: 'simulated', dataset: TEL });
        }
      }
    }
    // modèle multivarié : Isolation Forest sur la cohérence inter-roues
    const ifo = iforestMotors();
    if (ifo) {
      const fl = ifo.flag.map((f, i) => (T.t[i] <= tq && T.t[i] >= TRAIN_END_H ? f : 0));
      for (const s of segments(fl, T.t)) {
        let best = 0, wi = 0;
        for (let m = 0; m < 6; m++) { const a = Math.abs(ifo.dev[m][s.i0]); if (a > best) { best = a; wi = m; } }
        out.push({ id: `iforest@${s.t0}`, component: `motor_${wi + 1}`, componentName: component(`motor_${wi + 1}`).name, variable: `motor${wi + 1}_current_A (écart à la médiane des 6 moteurs)`, start: s.t0, end: s.t1, sol: T.rows[s.i0].sol, value: ifo.dev[wi][s.i0], z: null, severity: 'warn',
          rule: `Score Isolation Forest ${ifo.score[s.i0].toFixed(3)} > seuil ${ifo.threshold.toFixed(3)} (quantile 99,5 % de l'apprentissage)`, model: 'Isolation Forest (100 arbres, graine 7)',
          factors: [`facteur contributif principal : moteur ${wi + 1} (écart ${ifo.dev[wi][s.i0].toFixed(3)} A)`, `terrain : ${T.terrain[s.i0]}`], provenance: 'simulated', dataset: TEL });
      }
    }
    return out.sort((a, b) => b.start - a.start);
  });
}
/** Métriques de détection (possibles uniquement parce que la vérité terrain des données SIMULÉES est connue). */
export function detectionMetrics() {
  return memo('metrics', () => {
    const T = tel(); if (!T) return [];
    const rows = [];
    for (const [v, lab] of Object.entries(LABEL_OF)) {
      const d = detect(v); if (!d) continue;
      const truth = T.rows.map((r) => +r[lab]);
      const e = evaluate(d.flag, truth, T.t, { evalMask: T.t.map((x) => x >= TRAIN_END_H) });
      rows.push({ variable: v, label: lab, method: 'Seuils + z robuste contextuel + figé + persistance', ...e });
    }
    const ifo = iforestMotors();
    if (ifo) { const e = evaluate(ifo.flag, T.rows.map((r) => +r.label_motor3_drift), T.t, { evalMask: T.t.map((x) => x >= TRAIN_END_H) }); rows.push({ variable: 'motor1..6 (écarts)', label: 'label_motor3_drift', method: 'Isolation Forest multivariée', ...e }); }
    return rows;
  });
}

// ------------------------------------------------------------------ FMDS événements
export function eventsDataset() {
  for (const d of registry.values()) if (d.imported && d.mapping && d.mapping.role === 'events') return { id: d.id, rows: d.rows, prov: d.meta.provenance, imported: true };
  if (ds('rover_events_sim')) return { id: 'rover_events_sim', rows: ds('rover_events_sim').rows, prov: 'simulated' };
  return null;
}
export function fmdsFor(compId) {
  const ev = eventsDataset();
  const comp = component(compId);
  if (!ev || ((!comp.dataset || !comp.dataset.events) && !(ev.imported && ev.rows.some((r) => r.component_id === compId)))) return { computable: false, reason: `MTBF / MTTR / disponibilité ${NOT_COMPUTABLE} : aucun historique de pannes ni de remises en service pour ce composant.` };
  const r = fmdsFromEvents(ev.rows, { componentId: compId, window: tel() ? tel().tmax : null });
  return { ...r, provenance: ev.prov, dataset: ev.id };
}
export { NOT_COMPUTABLE };
export function meanOf(a) { return mean(a); }
