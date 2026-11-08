"""Construction des réponses de lecture (API et instantané hors ligne) — lecture seule, aucun calcul lourd.

Filtres communs : equipment (préfixe ou identifiant exact), t_from / t_to (période dans l'unité de l'équipement),
limit. Toutes les réponses portent `computed_at` (date de dernière actualisation) et la provenance.
"""
from __future__ import annotations

import json

from . import db
from .services import safety
from .services.registry import STATUS_LABEL

MODULE_LABEL = {"anomalies": "Détection des anomalies", "diagnostic": "Diagnostic des défaillances", "fiabilite": "Analyse de fiabilité",
                "rul": "Pronostic RUL", "maintenabilite": "Maintenabilité et MTTR", "disponibilite": "Disponibilité prévisionnelle",
                "securite": "Analyse de sécurité AMDEC / FTA", "references": "Jeux FEMTO et HIRF", "defauts": "Diagnostic des 5 classes de défaut"}


def payload(con, module):
    r = con.execute("SELECT computed_at, payload FROM module_payload WHERE module=?", (module,)).fetchone()
    return (json.loads(r["payload"]), r["computed_at"]) if r else (None, None)


def _filters(params, tcol="t", eq="equipment_id"):
    where, args = [], []
    e = (params.get("equipment") or "").strip()
    if e:
        where.append(f"{eq} LIKE ?")
        args.append(e if "%" in e else (e + "%" if e.endswith("-") else e))
    for k, op in (("t_from", ">="), ("t_to", "<=")):
        v = params.get(k)
        if v not in (None, ""):
            where.append(f"{tcol} {op} ?")
            args.append(float(v))
    return (" WHERE " + " AND ".join(where)) if where else "", args


def module(con, name, params=None):
    params = params or {}
    lim = min(int(params.get("limit") or 5000), 50000)
    p, at = payload(con, name)
    out = {"module": name, "label": MODULE_LABEL.get(name, name), "computed_at": at, "payload": p, "models": models(con, name)}
    if name == "anomalies":
        w, a = _filters(params, "t_end")
        out["history"] = db.rows(con, f"SELECT * FROM anomaly_history{w} ORDER BY equipment_id, t_start LIMIT {lim}", a)
    elif name == "diagnostic":
        w, a = _filters(params)
        out["history"] = db.rows(con, f"SELECT * FROM diagnosis_results{w} ORDER BY equipment_id, t LIMIT {lim}", a)
    elif name == "fiabilite":
        w, a = _filters(params, "t")
        out["results"] = db.rows(con, f"SELECT * FROM reliability_results{w} ORDER BY equipment_id, quantity, t LIMIT {lim}", a)
    elif name == "rul":
        w, a = _filters(params)
        if params.get("equipment"):
            out["predictions"] = db.rows(con, f"SELECT * FROM rul_predictions{w} ORDER BY algorithm, t LIMIT {lim}", a)
    elif name in ("maintenabilite", "disponibilite"):
        w, a = _filters(params)
        out["results"] = db.rows(con, f"SELECT * FROM availability_results{w} ORDER BY equipment_id, quantity", a)
        out["repairs"] = db.rows(con, "SELECT * FROM maintenance_history ORDER BY t_start")
    elif name == "securite":
        out["fmea"] = safety.fmea_payload(con)
        out["fta"] = safety.evaluate_tree(safety.tree(con))
    return out


def models(con, mod=None):
    q = "SELECT * FROM model_registry" + (" WHERE module=?" if mod else "") + " ORDER BY module, algorithm, version"
    regs = db.rows(con, q, (mod,) if mod else ())
    ev = {}
    for r in db.rows(con, "SELECT model_id, split, metric, value FROM model_evaluation"):
        ev.setdefault(r["model_id"], {}).setdefault(r["split"], {})[r["metric"]] = r["value"]
    for r in regs:
        r["status_label"] = STATUS_LABEL[r["status"]]
        r["metrics"] = ev.get(r["model_id"], {})
        for k in ("hyperparams", "features", "split"):
            if r.get(k):
                try:
                    r[k] = json.loads(r[k])
                except ValueError:
                    pass
    return regs


TASKS = [  # tâche, module, algorithmes comparés, métrique principale, sens (max/min), métriques affichées
    ("Détection d'anomalies (C-MAPSS FD001)", "anomalies", ["isolation_forest", "one_class_svm", "autoencoder"], "f1", "max",
     ["precision", "recall", "f1", "auc_roc", "fpr", "lead_median_cycles"]),
    ("Diagnostic d'usure (Milling, hors outil)", "diagnostic", ["random_forest", "xgboost", "svm"], "f1_macro", "max",
     ["accuracy", "precision_macro", "recall_macro", "f1_macro", "f1_macro_fold_std"]),
    ("Fiabilité S(t|X) (C-MAPSS FD001–FD004)", "fiabilite", ["weibull_population", "weibull_aft", "random_survival_forest"], "ibs", "min", ["c_index", "ibs", "ibs_km"]),
    ("Pronostic RUL (C-MAPSS FD001)", "rul", ["xgboost", "lstm"], "RMSE", "min", ["MAE", "RMSE", "R2", "score_PHM08", "val_RMSE"]),
    ("Situations à risque (C-MAPSS FD001)", "securite", ["random_forest", "xgboost"], "f1", "max", ["precision", "recall", "f1", "auc_roc"]),
    ("RUL roulements FEMTO (11 roulements de test)", "rul", ["weibull_mrl_femto", "xgboost_femto", "random_forest_femto"], "MAE", "min", ["MAE", "RMSE", "R2", "cv_mae_mean", "MAE_90pct"]),
    ("MTTR prévisionnel", "maintenabilite", ["regression_lineaire", "random_forest", "xgboost"], "RMSE", "min", ["MAE", "RMSE", "R2"]),
    ("Disponibilité prévisionnelle", "disponibilite", ["regression_lineaire", "random_forest", "xgboost"], "RMSE", "min", ["MAE", "RMSE", "R2"]),
]


def comparison(con):
    regs = {(r["module"], r["algorithm"]): r for r in models(con) if r["is_active"]}
    out = []
    for task, mod, algos, key, sense, shown in TASKS:
        rows = []
        for a in algos:
            r = regs.get((mod, a))
            if not r:
                continue
            m = next(iter(r["metrics"].values()), {}) if r["metrics"] else {}
            rows.append({"algorithm": a, "model_id": r["model_id"], "status": r["status"], "status_label": r["status_label"], "metrics": {k: m.get(k) for k in shown},
                         "key": m.get(key), "train_time_s": r["train_time_s"], "predict_time_ms": r["predict_time_ms"], "n_train": r["n_train"], "n_test": r["n_test"],
                         "message": r["message"]})
        scored = [x for x in rows if x["key"] is not None and x["status"] in ("valide", "entraine")]
        best = (max if sense == "max" else min)(scored, key=lambda x: x["key"])["algorithm"] if scored else None
        out.append({"task": task, "module": mod, "criterion": key, "sense": sense, "metrics": shown, "rows": rows, "best": best,
                    "note": None if scored else "Aucun modèle entraîné : données insuffisantes (aucune performance affichée)."})
    return out


def recommendations(con, params=None):
    params = params or {}
    w, a = _filters(params, "generated_at")
    return db.rows(con, f"SELECT * FROM recommendations{w} ORDER BY CASE priority WHEN 'haute' THEN 0 WHEN 'moyenne' THEN 1 ELSE 2 END, generated_at DESC", a)


def equipment(con):
    return db.rows(con, "SELECT equipment_id, name, kind, subsystem, dataset, provenance, time_unit, rover_analog FROM equipment ORDER BY equipment_id")


def audit_summary(con):
    q = lambda s: con.execute(s).fetchone()[0]
    return {"equipment": q("SELECT COUNT(*) FROM equipment"), "sensor_data": q("SELECT COUNT(*) FROM sensor_data"),
            "failure_history": q("SELECT COUNT(*) FROM failure_history"), "failures_observed": q("SELECT COUNT(*) FROM failure_history WHERE event=1"),
            "censored": q("SELECT COUNT(*) FROM failure_history WHERE event=0"), "maintenance_history": q("SELECT COUNT(*) FROM maintenance_history"),
            "datasets": db.rows(con, "SELECT dataset, provenance, kind, COUNT(*) n, MIN(time_unit) unit FROM equipment GROUP BY dataset ORDER BY dataset"),
            "missing_values": q("SELECT COUNT(*) FROM sensor_data WHERE value IS NULL"),
            "qc_flags": db.rows(con, "SELECT qc_flag, COUNT(*) n FROM sensor_data WHERE qc_flag <> 'ok' GROUP BY qc_flag")}
