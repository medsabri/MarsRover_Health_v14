"""MODULE 6 — Disponibilité : calculs FMDS (historique) et prévision (régression).

Définitions (fenêtre d'observation W, journal maintenance_history) :
  temps d'arrêt sur panne        D_p = Σ (t_end − t_start) des pannes
  temps d'arrêt planifié         D_s = Σ (t_end − t_start) des arrêts planifiés / préventifs
  temps de fonctionnement        U   = W − D_p − D_s
  MTBF = U / nombre de défaillances           MTTR = D_p / nombre de réparations terminées
  Ai   = MTBF / (MTBF + MTTR)                 (intrinsèque : arrêts sur panne seulement)
  Ao   = U / (U + D_p + D_s)                  (opérationnelle : tous les arrêts)
Évolution : MTBF et MTTR cumulés après chaque défaillance ; disponibilité par période de 500 h.

Prévision : régression (linéaire, Random Forest, XGBoost) de la disponibilité de la période suivante à partir de
MTBF, MTTR, fréquence des pannes, temps d'arrêt, RUL et conditions d'utilisation de la période courante.
Statut « En attente de données » tant qu'il n'existe pas au moins MIN_PERIODS_AVAIL_MODEL périodes × équipement
avec arrêts renseignés. Les valeurs calculées (historiques) et prédites sont stockées séparément (colonne nature).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import db
from ..config import MIN_PERIODS_AVAIL_MODEL, PROV_SIMULATED
from ..ml.common import save_payload
from . import registry as reg

WINDOW_H = 2998.0  # durée de la télémétrie rover simulée (rover_telemetry_sim.csv, 0–2998 h)
PERIOD_H = 500.0
NEEDED = ("journal d'exploitation et de maintenance sur plusieurs périodes : pour chaque équipement et chaque période (ex. mois), "
          "temps de fonctionnement, nombre de pannes, durées d'arrêt (panne / planifié), conditions d'utilisation et RUL estimée ; "
          f"au moins {MIN_PERIODS_AVAIL_MODEL} périodes × équipement, dont la disponibilité de la période suivante est connue.")


def indicators(ev: pd.DataFrame, W: float) -> dict:
    f = ev[ev.type.isin(["panne", "corrective"])]
    s = ev[ev.type.isin(["planifiee", "preventive"])]
    dur = lambda d: float((d.t_end - d.t_start).clip(lower=0).sum())
    Dp, Ds = dur(f[f.t_end.notna()]), dur(s[s.t_end.notna()])
    U = W - Dp - Ds
    r = len(f)
    nr = int(f.t_end.notna().sum())
    mtbf = U / r if r else None
    mttr = Dp / nr if nr else None
    ai = mtbf / (mtbf + mttr) if (mtbf is not None and mttr is not None) else None
    ao = U / (U + Dp + Ds) if W > 0 else None
    return {"W_h": W, "uptime_h": U, "downtime_failure_h": Dp, "downtime_planned_h": Ds, "failures": r, "MTBF_h": mtbf, "MTTR_h": mttr, "Ai": ai, "Ao": ao,
            "failure_rate_per_h": r / U if U > 0 else None}


def train(con) -> dict:
    mh = pd.DataFrame(db.rows(con, "SELECT * FROM maintenance_history"))
    con.execute("DELETE FROM availability_results WHERE quantity IN ('MTBF','Ai','Ao','downtime','A_pred')")
    now = db.now()
    out, rows = [], []
    for eid, g in mh.groupby("equipment_id"):
        ind = indicators(g, WINDOW_H)
        # évolution : MTBF / MTTR cumulés après chaque panne
        f = g[g.type == "panne"].sort_values("t_start")
        evo = []
        for k in range(1, len(f) + 1):
            sub = pd.concat([f.iloc[:k], g[(g.type != "panne") & (g.t_end <= f.iloc[k - 1].t_end)]])
            i = indicators(sub, float(f.iloc[k - 1].t_end))
            evo.append({"t": float(f.iloc[k - 1].t_end), "MTBF_h": i["MTBF_h"], "MTTR_h": i["MTTR_h"]})
        per = []
        for p0 in np.arange(0, WINDOW_H, PERIOD_H):
            p1 = min(p0 + PERIOD_H, WINDOW_H)
            cl = g.assign(t_start=g.t_start.clip(p0, p1), t_end=g.t_end.clip(p0, p1))
            cl = cl[cl.t_end > cl.t_start]
            i = indicators(cl, p1 - p0)
            per.append({"period": f"{int(p0)}–{int(p1)} h", "Ao": i["Ao"], "downtime_h": i["downtime_failure_h"] + i["downtime_planned_h"], "failures": i["failures"]})
        prov = ",".join(sorted(set(g.provenance)))
        out.append({"equipment_id": eid, **ind, "evolution": evo, "periods": per, "provenance": prov})
        for q, v, u in (("MTBF", ind["MTBF_h"], "h"), ("Ai", ind["Ai"], "—"), ("Ao", ind["Ao"], "—"), ("downtime", ind["downtime_failure_h"] + ind["downtime_planned_h"], "h")):
            if v is not None:
                rows.append({"equipment_id": eid, "computed_at": now, "algorithm": "formule_FMDS", "model_version": "formule", "quantity": q, "nature": "historique",
                             "period": f"0–{int(WINDOW_H)} h", "value": float(v), "unit": u, "status": "calcule",
                             "validation": db.j({"fenetre_h": WINDOW_H, "pannes": ind["failures"]}), "provenance": prov})
    db.insert_many(con, "availability_results", rows)
    n_periods = sum(len(o["periods"]) for o in out)
    reason = (f"Historique disponible : {len(out)} équipement(s) × {int(WINDOW_H // PERIOD_H) + 1} périodes = {n_periods} périodes, issues d'un journal SIMULÉ "
              f"de {int(mh.type.eq('panne').sum())} pannes. Minimum requis : {MIN_PERIODS_AVAIL_MODEL} périodes réelles avec la disponibilité de la période suivante. "
              "Aucune prévision n'est produite.")
    models = {}
    for a in ("regression_lineaire", "random_forest", "xgboost"):
        mid = reg.placeholder(con, "disponibilite", a, reason, NEEDED, target="disponibilité opérationnelle de la période suivante", unit="—")
        models[a] = {"model_id": mid, "status": "attente_donnees"}
    con.commit()
    payload = {"equipment": out, "window_h": WINDOW_H, "period_h": PERIOD_H, "models": models, "needed": NEEDED, "reason": reason,
               "provenance_note": "Journal d'événements SIMULÉ (rover_events_sim.csv) : indicateurs de démonstration, non représentatifs d'une mission réelle.",
               "formulas": {"MTBF": "U / r", "MTTR": "D_p / r_terminées", "Ai": "MTBF / (MTBF + MTTR)", "Ao": "U / (U + D_p + D_s)"}}
    save_payload(con, "disponibilite", payload)
    return {o["equipment_id"]: {k: (round(o[k], 4) if isinstance(o[k], float) else o[k]) for k in ("MTBF_h", "MTTR_h", "Ai", "Ao")} for o in out}
