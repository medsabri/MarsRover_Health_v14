"""Préparation commune des données (lecture en base, découpages sans fuite) et métriques."""
from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd
from sklearn import metrics as skm

from .. import db
from ..config import CMAPSS_SENSORS, RUL_CAP, SEED


# ------------------------------------------------------------------ C-MAPSS FD001 depuis la base
def cmapss_fd001(con) -> pd.DataFrame:
    """Tableau large (une ligne par unité × cycle) reconstruit depuis sensor_data, avec RUL réelle :
    - apprentissage : RUL = dernier cycle − cycle (trajectoires jusqu'à la défaillance) ;
    - test : RUL = RUL_NASA(dernier cycle) + dernier cycle − cycle (vérité fournie par la NASA)."""
    q = """SELECT s.equipment_id, s.t AS cycle, s.variable, s.value FROM sensor_data s
           WHERE s.equipment_id LIKE 'CMAPSS-FD001-%'"""
    long = pd.read_sql_query(q, con)
    wide = long.pivot_table(index=["equipment_id", "cycle"], columns="variable", values="value").reset_index()
    meta = {r["equipment_id"]: json.loads(r["meta"]) for r in db.rows(con, "SELECT equipment_id, meta FROM equipment WHERE equipment_id LIKE 'CMAPSS-FD001-%'")}
    wide["split"] = wide.equipment_id.map(lambda e: meta[e]["split"])
    last = wide.equipment_id.map(lambda e: meta[e]["last_cycle"])
    extra = wide.equipment_id.map(lambda e: meta[e].get("true_rul_at_last", 0))
    wide["rul"] = (extra + last - wide.cycle).astype(float)
    wide["last_cycle"] = last
    return wide.sort_values(["equipment_id", "cycle"]).reset_index(drop=True)


def unit_split(units, val_frac=0.2, seed=SEED):
    rng = np.random.default_rng(seed)
    u = np.array(sorted(units))
    rng.shuffle(u)
    k = int(round(len(u) * val_frac))
    return sorted(u[k:]), sorted(u[:k])


def rolling_mean(df: pd.DataFrame, cols, w=5) -> pd.DataFrame:
    """Moyenne glissante CAUSALE (fenêtre passée uniquement, par unité) : pas d'information future."""
    out = df.copy()
    out[cols] = df.groupby("equipment_id")[cols].transform(lambda s: s.rolling(w, min_periods=1).mean())
    return out


def capped(rul):
    return np.minimum(rul, RUL_CAP)


# ------------------------------------------------------------------ métriques
def reg_metrics(y, p) -> dict:
    y, p = np.asarray(y, float), np.asarray(p, float)
    d = p - y
    score = float(np.sum(np.where(d < 0, np.exp(-d / 13) - 1, np.exp(d / 10) - 1)))  # score asymétrique PHM08 (Saxena 2008)
    return {"MAE": float(np.mean(np.abs(d))), "RMSE": float(np.sqrt(np.mean(d ** 2))), "R2": float(skm.r2_score(y, p)), "score_PHM08": score, "n": int(len(y))}


def cls_metrics(y, p, labels) -> dict:
    return {
        "accuracy": float(skm.accuracy_score(y, p)),
        "precision_macro": float(skm.precision_score(y, p, labels=labels, average="macro", zero_division=0)),
        "recall_macro": float(skm.recall_score(y, p, labels=labels, average="macro", zero_division=0)),
        "f1_macro": float(skm.f1_score(y, p, labels=labels, average="macro", zero_division=0)),
        "n": int(len(y)),
    }


def det_metrics(y, flag, score) -> dict:
    y = np.asarray(y, int)
    out = {
        "precision": float(skm.precision_score(y, flag, zero_division=0)), "recall": float(skm.recall_score(y, flag, zero_division=0)),
        "f1": float(skm.f1_score(y, flag, zero_division=0)), "fpr": float(np.mean(np.asarray(flag)[y == 0])) if np.any(y == 0) else None,
        "n": int(len(y)), "n_anormal": int(y.sum()),
    }
    out["auc_roc"] = float(skm.roc_auc_score(y, score)) if 0 < y.sum() < len(y) else None
    return out


class Timer:
    def __enter__(self):
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *a):
        self.s = time.perf_counter() - self.t0


def save_payload(con, module: str, payload: dict):
    with db._lock:
        con.execute("INSERT OR REPLACE INTO module_payload (module, computed_at, payload) VALUES (?,?,?)", (module, db.now(), db.j(payload)))
        con.commit()


def downsample(xs, k=400):
    xs = list(xs)
    if len(xs) <= k:
        return xs
    step = len(xs) / k
    return [xs[int(i * step)] for i in range(k)]
