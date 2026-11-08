"""MODULE 5 — Maintenabilité : MTTR historique (calcul) et MTTR prévisionnel (régression).

MTTR historique = Σ durées de réparation terminées / nombre de réparations terminées
  (une intervention sans date de fin n'entre pas dans le calcul ; elle est signalée).
MTTR prévisionnel = durée prédite de la PROCHAINE intervention par régression
  (linéaire, Random Forest, XGBoost) sur : type de panne, gravité, équipement, complexité, disponibilité des pièces,
  historique (durée moyenne passée de l'équipement).

Données disponibles : seul le journal d'événements SIMULÉ du rover (rover_events_sim.csv) contient des durées
d'indisponibilité ; aucun des jeux réels (C-MAPSS, Milling, Batteries, IGBT) ne contient d'intervention de
réparation. Le modèle prévisionnel reste donc « En attente de données » tant que maintenance_history ne compte pas
au moins MIN_REPAIRS_MTTR_MODEL réparations terminées avec les variables explicatives renseignées.
Le pipeline d'entraînement est opérationnel et testé (tests/test_regression_pipeline.py, données de test
synthétiques clairement identifiées, jamais écrites en base).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.model_selection import GroupKFold, KFold
from xgboost import XGBRegressor

from .. import db
from ..config import MIN_REPAIRS_MTTR_MODEL, SEED
from ..ml.common import Timer, reg_metrics, save_payload
from . import registry as reg

FEATURES = ["failure_type", "severity", "complexity", "spare_parts_available", "equipment_id", "past_mean_duration"]
NEEDED = ("table maintenance_history : ≥ 30 réparations terminées (t_start, t_end) avec type de panne, gravité (1–5), "
          "complexité (1–5), disponibilité des pièces (0/1) et équipement ; import CSV via POST /api/maintenance/import "
          "(colonnes : equipment_id,type,t_start,t_end,failure_type,severity,complexity,spare_parts_available).")


def historical(con) -> dict:
    mh = pd.DataFrame(db.rows(con, "SELECT * FROM maintenance_history"))
    if mh.empty:
        return {"computable": False, "reason": "maintenance_history vide"}
    rep = mh[mh.type.isin(["panne", "corrective"])]
    done = rep[rep.t_end.notna()].copy()
    done["duration_h"] = done.t_end - done.t_start
    per = []
    for eid, g in done.groupby("equipment_id"):
        g = g.sort_values("t_start")
        cum = (g.duration_h.cumsum() / np.arange(1, len(g) + 1)).round(4).tolist()
        per.append({"equipment_id": eid, "n_repairs": int(len(g)), "MTTR_h": float(g.duration_h.mean()), "total_h": float(g.duration_h.sum()),
                    "min_h": float(g.duration_h.min()), "max_h": float(g.duration_h.max()), "provenance": ",".join(sorted(set(g.provenance))),
                    "evolution": {"t": g.t_end.round(2).tolist(), "mttr_cum": cum}})
    return {"computable": True, "global_MTTR_h": float(done.duration_h.mean()), "n_completed": int(len(done)), "n_open": int(rep.t_end.isna().sum()),
            "per_equipment": per, "repairs": done[["equipment_id", "type", "t_start", "t_end", "duration_h", "failure_type", "provenance", "source"]].to_dict("records")}


def prepare(df: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray, np.ndarray]:
    """Variables explicatives : codage one-hot du type et de l'équipement ; durée moyenne PASSÉE de l'équipement
    (calculée uniquement sur les réparations antérieures → pas de fuite temporelle)."""
    d = df.sort_values("t_start").copy()
    d["duration_h"] = d.t_end - d.t_start
    d["past_mean_duration"] = d.groupby("equipment_id").duration_h.transform(lambda s: s.shift().expanding().mean())
    d["past_mean_duration"] = d.past_mean_duration.fillna(d.duration_h.expanding().mean().shift()).fillna(0)
    X = pd.get_dummies(d[["failure_type", "equipment_id"]].astype(str), dtype=float)
    X[["severity", "complexity", "spare_parts_available", "past_mean_duration"]] = d[["severity", "complexity", "spare_parts_available", "past_mean_duration"]].astype(float)
    return X, d.duration_h.to_numpy(float), d.t_start.to_numpy(float)


def fit_models(X: pd.DataFrame, y: np.ndarray, order: np.ndarray, n_splits: int = 5) -> dict:
    """Comparaison linéaire / RF / XGBoost avec découpage CHRONOLOGIQUE : le test = 20 % les plus récents."""
    k = int(len(y) * 0.8)
    o = np.argsort(order)
    tr, te = o[:k], o[k:]
    algos = {"regression_lineaire": lambda: LinearRegression(),
             "random_forest": lambda: RandomForestRegressor(n_estimators=300, min_samples_leaf=2, random_state=SEED),
             "xgboost": lambda: XGBRegressor(n_estimators=300, max_depth=3, learning_rate=0.05, random_state=SEED)}
    out = {}
    for name, make in algos.items():
        with Timer() as tt:
            m = make().fit(X.iloc[tr], y[tr])
        with Timer() as tp:
            p = m.predict(X.iloc[te])
        out[name] = {"model": m, **reg_metrics(y[te], p), "train_time_s": tt.s, "predict_time_ms_per_obs": 1000 * tp.s / max(1, len(te)),
                     "n_train": int(len(tr)), "n_test": int(len(te)), "pred": p.tolist(), "true": y[te].tolist()}
    return out


def train(con) -> dict:
    hist = historical(con)
    con.execute("DELETE FROM availability_results WHERE quantity IN ('MTTR','MTTR_pred')")
    now = db.now()
    rows = []
    if hist["computable"]:
        for r in hist["per_equipment"]:
            rows.append({"equipment_id": r["equipment_id"], "computed_at": now, "algorithm": "moyenne_arithmetique", "model_version": "formule",
                         "quantity": "MTTR", "nature": "historique", "period": "fenêtre complète", "value": r["MTTR_h"], "unit": "h", "status": "calcule",
                         "validation": db.j({"n_reparations": r["n_repairs"]}), "provenance": r["provenance"]})
    db.insert_many(con, "availability_results", rows)
    mh = pd.DataFrame(db.rows(con, "SELECT * FROM maintenance_history WHERE type IN ('panne','corrective') AND t_end IS NOT NULL"))
    usable = mh.dropna(subset=["severity", "complexity", "spare_parts_available", "failure_type"]) if not mh.empty else mh
    status = {}
    if len(usable) < MIN_REPAIRS_MTTR_MODEL:
        reason = (f"{len(mh)} réparation(s) terminée(s) en base, dont {len(usable)} avec les variables explicatives renseignées "
                  f"(minimum requis : {MIN_REPAIRS_MTTR_MODEL}). Aucune prédiction n'est produite.")
        for a in ("regression_lineaire", "random_forest", "xgboost"):
            mid = reg.placeholder(con, "maintenabilite", a, reason, NEEDED, target="durée de la prochaine intervention", unit="h")
            status[a] = {"model_id": mid, "status": "attente_donnees"}
        pred = None
    else:
        X, y, order = prepare(usable)
        res = fit_models(X, y, order)
        pred = {}
        base = reg_metrics(y[np.argsort(order)][int(len(y) * 0.8):], np.full(len(y) - int(len(y) * 0.8), y[np.argsort(order)][:int(len(y) * 0.8)].mean()))
        for a, r in res.items():
            mid = reg.create(con, "maintenabilite", a, dataset="maintenance_history", provenance=",".join(sorted(set(usable.provenance))),
                             target="durée d'intervention", unit="h", features=list(X.columns), split={"protocole": "chronologique 80/20"},
                             validation_rule="RMSE test < RMSE du prédicteur constant")
            metrics = {k: r[k] for k in ("MAE", "RMSE", "R2", "train_time_s", "predict_time_ms_per_obs", "n_train", "n_test")}
            reg.evaluate(con, mid, "test", metrics)
            reg.finish(con, mid, valid=r["RMSE"] < base["RMSE"], artifact_obj={"model": r["model"], "columns": list(X.columns)}, n_train=r["n_train"],
                       n_test=r["n_test"], train_time_s=r["train_time_s"])
            status[a] = {"model_id": mid, **metrics, "status": "valide" if r["RMSE"] < base["RMSE"] else "entraine"}
            pred[a] = {"true": r["true"], "pred": r["pred"]}
    con.commit()
    payload = {"historical": hist, "models": status, "predictions": pred, "needed": NEEDED, "min_repairs": MIN_REPAIRS_MTTR_MODEL,
               "definition": "MTTR historique = Σ durées de réparation terminées / nombre de réparations terminées. Contexte rover : durée de remise en service (pas de réparation physique)."}
    save_payload(con, "maintenabilite", payload)
    return {"MTTR_global_h": hist.get("global_MTTR_h"), "models": {k: v["status"] for k, v in status.items()}}
