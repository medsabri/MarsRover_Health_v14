"""Moteur de recommandations de maintenance (règles explicites, traçables, validables).

Chaque recommandation référence les résultats analytiques qui la justifient (table, identifiant, valeur) et reste
« à valider » jusqu'à décision d'un technicien / responsable (POST /api/recommendations/<id>/validate).
Une recommandation n'est jamais une commande : aucune action n'est déclenchée automatiquement.

Règles :
  R1  anomalie persistante détectée            → alerte à vérifier (priorité = priorité de l'épisode)
  R2  diagnostic usure critique / défaut       → inspection et remplacement de l'outil (conf. ≥ 0,6)
  R3  RUL ≤ seuil critique (30) / alerte (60)  → intervention préventive planifiée (haute / moyenne)
  R4  risque élevé (classifieur sécurité)      → inspection prioritaire
  R5  NPR AMDEC ≥ 150 / ≥ 100                  → priorisation de l'analyse de risque (haute / moyenne)
  R6  MTTR prédit élevé                        → anticiper les ressources (INACTIVE tant que le modèle MTTR est en attente de données)
"""
from __future__ import annotations

import json

from .. import db
from . import registry as reg
from .rul import THRESHOLDS

RULES = {
    "R1": "Anomalie persistante détectée", "R2": "Diagnostic d'usure critique ou de défaut mécanique", "R3": "RUL inférieure au seuil configuré",
    "R4": "Risque de défaillance élevé (classifieur de sécurité)", "R5": "Criticité AMDEC élevée", "R6": "MTTR prédit élevé",
}


def generate(con, thresholds=THRESHOLDS) -> dict:
    with db._lock:
        con.execute("DELETE FROM recommendations WHERE status='a_valider'")
        con.commit()
    decided = {(r["equipment_id"], r["rule_id"]) for r in db.rows(con, "SELECT equipment_id, rule_id FROM recommendations")}
    now, out = db.now(), []

    def add(eid, rule, reason, evidence, prio, action):
        if (eid, rule) in decided:
            return
        out.append({"equipment_id": eid, "generated_at": now, "rule_id": rule, "reason": reason, "evidence": db.j(evidence), "priority": prio, "action": action,
                    "status": "a_valider", "validated_by": None, "validated_at": None, "comment": None})

    # R1 — dernier épisode par équipement (test NASA et IGBT ; les unités de validation servent à l'évaluation)
    for r in db.rows(con, """SELECT a.* FROM anomaly_history a JOIN (SELECT equipment_id, MAX(t_end) m FROM anomaly_history GROUP BY equipment_id) b
                             ON a.equipment_id=b.equipment_id AND a.t_end=b.m WHERE a.equipment_id LIKE '%-TE-%' OR a.equipment_id LIKE 'IGBT%'"""):
        sens = ", ".join(s["sensor"] for s in json.loads(r["sensors"] or "[]"))
        add(r["equipment_id"], "R1", f"Épisode d'anomalie {r['t_start']:.0f}–{r['t_end']:.0f} {r['unit']} (score max {r['value']:.3f} > seuil {r['threshold']:.3f}) ; capteurs : {sens}",
            [{"table": "anomaly_history", "id": r["id"], "value": r["value"], "algorithm": r["algorithm"], "model": r["model_version"]}], r["priority"],
            "Vérifier les capteurs concernés et confirmer l'état par diagnostic avant toute conclusion de panne.")
    # R2 — dernière passe de chaque outil
    for r in db.rows(con, """SELECT d.* FROM diagnosis_results d JOIN (SELECT equipment_id, MAX(t) m FROM diagnosis_results GROUP BY equipment_id) b
                             ON d.equipment_id=b.equipment_id AND d.t=b.m"""):
        if r["value"] != "normal" and r["confidence"] >= 0.6:
            add(r["equipment_id"], "R2", f"Classe prédite « {r['value']} » (confiance {r['confidence']:.2f}) à t = {r['t']:.0f} min",
                [{"table": "diagnosis_results", "id": r["id"], "value": r["value"], "confidence": r["confidence"], "model": r["model_version"]}],
                "haute" if r["value"] == "defaut_mecanique" else "moyenne", "Inspecter l'arête de coupe (mesure VB) et remplacer l'outil si VB ≥ 0,3 mm.")
    # R3 — RUL au dernier cycle observé, meilleur modèle
    best = None
    p = con.execute("SELECT payload FROM module_payload WHERE module='rul'").fetchone()
    if p:
        best = json.loads(p[0]).get("best")
    if best:
        for r in db.rows(con, """SELECT r.* FROM rul_predictions r JOIN (SELECT equipment_id, MAX(t) m FROM rul_predictions WHERE algorithm=? GROUP BY equipment_id) b
                                 ON r.equipment_id=b.equipment_id AND r.t=b.m WHERE r.algorithm=?""", (best, best)):
            if r["value"] <= thresholds["alerte"]:
                crit = r["value"] <= thresholds["critique"]
                add(r["equipment_id"], "R3", f"RUL estimée {r['value']:.0f} cycles ({best}) ≤ seuil {'critique' if crit else 'd’alerte'} "
                    f"{thresholds['critique' if crit else 'alerte']} cycles", [{"table": "rul_predictions", "id": r["id"], "value": r["value"], "unit": r["unit"], "model": r["model_version"]}],
                    "haute" if crit else "moyenne", "Planifier une intervention préventive avant l'échéance estimée (marge selon l'incertitude du modèle).")
    # R4 — risque élevé
    p = con.execute("SELECT payload FROM module_payload WHERE module='securite'").fetchone()
    if p:
        sp = json.loads(p[0])
        for a in sp["ml"]["alerts"]:
            add(a["equipment_id"], "R4", f"Probabilité de situation à risque {a['p_risk']:.2f} au cycle {a['cycle']}",
                [{"table": "module_payload:securite", "id": a["equipment_id"], "value": a["p_risk"], "model": sp["ml"]["comparison"].get("xgboost", {}).get("model_id")}],
                "haute", "Inspection prioritaire ; ne se substitue pas aux protections et arrêts d'urgence.")
    # R5 — AMDEC
    for r in db.rows(con, "SELECT * FROM fmea WHERE NPR >= 100 ORDER BY NPR DESC"):
        add(r["equipment_id"], "R5", f"{r['fmea_id']} « {r['mode']} » : NPR = {r['NPR']} (G {r['G']} × O {r['O']} × D {r['D']})",
            [{"table": "fmea", "id": r["fmea_id"], "value": r["NPR"]}], "haute" if r["NPR"] >= 150 else "moyenne",
            f"Prioriser l'analyse du risque ; mesure existante : {r['mitigation'] or '—'}.")
    # R6 — MTTR prévisionnel
    mt = reg.active(con, "maintenabilite", "xgboost")
    r6 = "inactive : modèle MTTR en attente de données" if not mt or mt["status"] not in ("entraine", "valide") else "active"
    db.insert_many(con, "recommendations", out)
    con.commit()
    db.log(con, "recommendations_generate", {"n": len(out), "R6": r6})
    return {"generated": len(out), "R6": r6}


def validate(con, rec_id: int, decision: str, actor: str, comment: str | None = None):
    if decision not in ("validee", "rejetee"):
        raise ValueError("décision attendue : validee | rejetee")
    if not actor or not actor.strip():
        raise ValueError("le nom du validateur est obligatoire (traçabilité)")
    with db._lock:
        cur = con.execute("UPDATE recommendations SET status=?, validated_by=?, validated_at=?, comment=? WHERE id=? AND status='a_valider'",
                          (decision, actor.strip(), db.now(), comment, rec_id))
        con.commit()
    if cur.rowcount == 0:
        raise LookupError("recommandation introuvable ou déjà traitée")
    db.log(con, "recommendation_" + decision, {"id": rec_id, "comment": comment}, actor)
