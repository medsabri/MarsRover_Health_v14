// =============================================================================
// fmds.js — indicateurs MTBF / MTTR / Disponibilité à partir d'un JOURNAL D'ÉVÉNEMENTS.
// Règle du cahier des charges (§8) : sans historique d'événements identifiables,
// l'indicateur est déclaré « non calculable avec les données retenues ».
// Définitions opérationnelles retenues (affichées dans l'interface) :
//   - panne     : indisponibilité NON planifiée (type = « panne »)
//   - planifiee : indisponibilité programmée, EXCLUE du temps requis
//   - Temps requis  TR = fenêtre d'observation − indisponibilités planifiées
//   - Temps de bon fonctionnement TBF = TR − Σ durées de panne
//   - MTBF = TBF / nombre de pannes        (système réparable / remis en service)
//   - MTTR = moyenne des durées de panne   (ici : durée de remise en service, pas réparation physique)
//   - Disponibilité intrinsèque Ai = TBF / TR = MTBF / (MTBF + MTTR)   (arrêts planifiés exclus)
//   - Disponibilité opérationnelle Ao = TBF / W                         (tous les arrêts comptés)
//   (correctif d'audit : l'ancienne « disponibilité opérationnelle » TBF / TR était en réalité Ai)
// IC du MTBF : loi du χ² (essai tronqué en temps, hypothèse de taux constant).
// =============================================================================
import { chi2inv, mean } from './stats.js';
import { lognormalMLE } from './survival.js';

export const NOT_COMPUTABLE = 'non calculable avec les données retenues';

export function fmdsFromEvents(events, { componentId = null, window = null, alpha = 0.1 } = {}) {
  if (!events || !events.length) return { computable: false, reason: 'Aucun journal d\'événements chargé.' };
  const ev = events.filter((e) => !componentId || e.component_id === componentId);
  if (!ev.length) return { computable: false, reason: `Aucun événement pour « ${componentId} » dans le journal.` };
  const W = window || Math.max(...events.map((e) => +e.end_h));
  const fails = ev.filter((e) => e.type === 'panne');
  const planned = ev.filter((e) => e.type === 'planifiee');
  const dur = (e) => Math.max(0, +e.end_h - +e.start_h);
  const TR = W - planned.reduce((s, e) => s + dur(e), 0);
  const down = fails.reduce((s, e) => s + dur(e), 0);
  const TBF = TR - down;
  const r = fails.length;
  const out = { computable: true, window: W, TR, TBF, down, nFailures: r, nPlanned: planned.length, alpha };
  if (r === 0) {
    out.mtbf = null; out.mtbfNote = `Aucune panne sur ${W} h : MTBF ${NOT_COMPUTABLE} (borne inférieure seulement).`;
    out.mtbfLower = 2 * TBF / chi2inv(1 - alpha, 2);
  } else {
    out.mtbf = TBF / r;
    out.mtbfCI = [2 * TBF / chi2inv(1 - alpha / 2, 2 * r + 2), 2 * TBF / chi2inv(alpha / 2, 2 * r)];
  }
  if (r >= 1) {
    const d = fails.map(dur);
    out.mttr = mean(d);
    out.repairTimes = d;
    if (r >= 3) { const ln = lognormalMLE(d, d.map(() => 1)); if (ln.ok) out.mttrLognormal = ln; }
  } else { out.mttr = null; out.mttrNote = `MTTR ${NOT_COMPUTABLE} (aucune remise en service observée).`; }
  out.availability = TR > 0 ? TBF / TR : null; // Ai
  out.availabilityAo = W > 0 ? TBF / W : null;
  out.failureRate = out.mtbf ? 1 / out.mtbf : null;
  return out;
}
