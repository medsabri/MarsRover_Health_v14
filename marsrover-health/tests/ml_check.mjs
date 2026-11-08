// Vérification numérique de la bibliothèque ML (exécuter : node tests/ml_check.mjs)
import fs from 'fs';
import Papa from 'papaparse';
import { kaplanMeier, nelsonAalen, weibullMLE, exponentialMLE, lognormalMLE, kernelHazard, compareModels } from '../src/ml/survival.js';
import { fmdsFromEvents } from '../src/ml/fmds.js';
import { groupTrajectories, ExpDegradationModel, linearBaselineRUL, evaluateRUL } from '../src/ml/rul.js';
import { detectVariable, evaluate, iforestDetect } from '../src/ml/anomaly.js';
import { substitutionPlan } from '../src/ml/substitution.js';
const rd = (f) => Papa.parse(fs.readFileSync('data/datasets/' + f, 'utf8'), { header: true, dynamicTyping: true, skipEmptyLines: true }).data;
const out = {};
for (const [f, tc] of [['bearings_datareal_exp.csv', 'T_obs_Mcycles'], ['reliability_500_sim.csv', 'T_obs_h'], ['fire_detectors_demo.csv', 'T_obs_mois']]) {
  const d = rd(f); const T = d.map(r => r[tc]), E = d.map(r => r.event_1_panne_0_censure);
  const km = kaplanMeier(T, E); const w = weibullMLE(T, E); const na = nelsonAalen(T, E);
  out[f] = { km_t: km.t.slice(0, 6), km_S: km.S.slice(0, 6), km_lo: km.lo.slice(0, 6), km_hi: km.hi.slice(0, 6), median: km.median,
    na_H_last: na.H[na.H.length - 1], weib: [w.beta, w.eta, w.ci && w.ci.beta, w.ci && w.ci.eta], expo: exponentialMLE(T, E).lambda, logn: (({mu,sigma})=>[mu,sigma])(lognormalMLE(T,E)),
    cmp: compareModels(T, E).rows.map(r=>r.model+':'+r.aic.toFixed(2)) };
}
// FMDS événements
const ev = rd('rover_events_sim.csv');
out.fmds_computer = fmdsFromEvents(ev, { componentId: 'computer', window: 3000 });
out.fmds_none = fmdsFromEvents([], {});
// RUL vibration : split par unité
const vib = rd('degradation_vibration.csv');
const trajs = groupTrajectories(vib, { idCol: 'ID_Roulement', tCol: 'Cycle_Heure', yCol: 'Vibration_RMS' });
const train = trajs.filter(t => ['R-001','R-002','R-003','R-004','R-005','R-006'].includes(t.id));
const test = trajs.filter(t => ['R-009','R-010'].includes(t.id));
const m = new ExpDegradationModel({ threshold: 3.5, unit: 'h' }).fit(train);
const ev2 = evaluateRUL(m, test, { baseline: (t, y) => linearBaselineRUL(t, y, { threshold: 3.5 }) });
out.rul = { prior: m.prior.mean, phi: m.phi, mae: ev2.mae, rmse: ev2.rmse, cov: ev2.coverage, maeBase: ev2.maeBase, rows: ev2.rows.map(r => [r.unit, r.fraction, r.truth, Math.round(r.pred), Math.round(r.lo), Math.round(r.hi), Math.round(r.base)]) };
// Batterie
const bat = rd('battery_packs_sim.csv');
const bt = groupTrajectories(bat, { idCol: 'pack_id', tCol: 'cycle', yCol: 'capacity_Ah' });
const bm = new ExpDegradationModel({ threshold: 32, direction: 'down', ref: 40, kind: 'power', unit: 'cycles' }).fit(bt.filter(t => ['P01','P02','P03','P04'].includes(t.id)));
const be = evaluateRUL(bm, bt.filter(t => ['P06','P07'].includes(t.id)));
const rp = bt.find(t => t.id === 'ROVER_PACK'); const pr = bm.predict(rp.t, rp.y);
out.battery = { mae: be.mae, cov: be.coverage, rows: be.rows.map(r => [r.unit, r.fraction, r.truth, Math.round(r.pred), Math.round(r.lo), Math.round(r.hi)]), rover: [pr.value, pr.ci] };
// Anomalies télémétrie
const tel = rd('rover_telemetry_sim.csv'); const t = tel.map(r => r.time_h); const train2 = t.map(x => x < 800);
const ctx = tel.map(r => r.op_mode + '|' + r.terrain), coarse = tel.map(r => r.op_mode), amb = tel.map(r => r.ambient_temp_C);
const cases = [['motor3_current_A', 'label_motor3_drift', { warn: 1.1, fault: 1.5 }, false], ['arm_current_A', 'label_arm_overload', { warn: 2.0, fault: 2.6 }, false], ['bat_voltage_V', 'label_bat_voltage_drop', { warn_low: 27, fault_low: 25 }, false], ['avionics_temp_C', 'label_thermal_heater_stuck', { warn: 28, fault: 32 }, false], ['link_margin_dB', 'label_comm_unplanned_loss', { warn_low: 2, fault_low: 0 }, false], ['hazcam_temp_C', 'label_hazcam_stuck', {}, true]];
out.anom = {};
for (const [v, l, th, st] of cases) {
  const vals = tel.map(r => (r[v] === null || r[v] === '' ? NaN : r[v]));
  const d = detectVariable(vals, { t, trainMask: train2, context: ctx, coarse, reference: /temp/.test(v) ? amb : null, threshold: th, checkStuck: st });
  const e = evaluate(d.flag, tel.map(r => r[l]), t, { evalMask: t.map(x => x >= 800) });
  out.anom[v] = { P: e.precision, R: e.recall, ev: `${e.eventsDetected}/${e.events.length}`, delay: e.meanDelay, FA: e.falseAlarms };
}
const cols = ['motor1_current_A','motor2_current_A','motor3_current_A','motor4_current_A','motor5_current_A','motor6_current_A'].map(c => tel.map(r => r[c]));
const ifo = iforestDetect(cols, train2, { seed: 7 });
out.iforest = evaluate(ifo.flag, tel.map(r => r.label_motor3_drift), t, { evalMask: t.map(x => x >= 800) });
delete out.iforest.events; delete out.iforest.falseAlarmList;
// Substitution
const lz = rd('bearings_datareal_exp.csv');
const sp = substitutionPlan({ design_life: { value: 40, unit: 'km' } }, { lifetimes: { times: lz.map(r => r.T_obs_Mcycles), events: lz.map(r => r.event_1_panne_0_censure), name: 'bearings', provenance: 'experimental', unit: 'Mcycles' }, trajectories: { trajs: train, threshold: 3.5, name: 'vib' } }, { usageNow: 10.8, usagePerSol: 0.09 });
out.subst = { ok: sp.ok, params: sp.params, tpl: sp.template, tPM: sp.plan.tPM, verdict: sp.state.verdict, conf: sp.state.confidence, sens: sp.sensitivity.map(s => [s.name, s.lo.toFixed(1), s.hi.toFixed(1)]) };
const kh = kernelHazard(rd('reliability_500_sim.csv').map(r=>r.T_obs_h), rd('reliability_500_sim.csv').map(r=>r.event_1_panne_0_censure), { bandwidth: 60 });
out.kh = [kh.h[5], kh.h[60], kh.h[110]];
fs.writeFileSync('tests/ml_check_out.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, (k, v) => typeof v === 'number' ? +v.toPrecision(5) : v, 1).slice(0, 6000));
