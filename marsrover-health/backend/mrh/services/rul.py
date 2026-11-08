"""MODULE 4 — Pronostic RUL : XGBoost Regression vs LSTM (C-MAPSS FD001, simulation NASA).

Cible : RUL linéaire par morceaux plafonnée à 125 cycles (Heimes 2008) — la dégradation n'est pas observable
en début de vie ; une RUL supervisée n'est produite QUE parce que les trajectoires d'apprentissage vont jusqu'à
la défaillance (cible fiable). Normalisation min–max ajustée sur les seules unités d'apprentissage.
Découpage : 80 unités d'apprentissage / 20 unités de validation (arrêt précoce, aucune fuite inter-unité) ;
test = 100 unités NASA, évaluées au DERNIER cycle observé contre la RUL réelle fournie (RUL_FD001.txt).
  * XGBoost : caractéristiques sur fenêtre glissante de 30 cycles (dernière valeur, moyenne, écart-type, pente)
    des 14 capteurs + cycle courant ;
  * LSTM : séquences brutes normalisées de 30 cycles × 14 capteurs (ml/lstm.py, NumPy, BPTT).
Métriques : MAE, RMSE, R², score asymétrique PHM08 ; référence « prédicteur constant » (moyenne de la cible).
État de santé : HI = RUL / 125 ; seuils d'alerte configurables (défaut : critique ≤ 30, alerte ≤ 60 cycles).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

from .. import db
from ..config import CMAPSS_SENSORS, PROV_SIMULATED, RUL_CAP, SEED
from ..ml.common import Timer, capped, cmapss_fd001, downsample, reg_metrics, save_payload, unit_split
from ..ml.lstm import LSTMRegressor
from . import registry as reg

WIN = 30
THRESHOLDS = {"critique": 30, "alerte": 60}


def health_state(rul, thr=THRESHOLDS):
    return "critique" if rul <= thr["critique"] else ("alerte" if rul <= thr["alerte"] else "sain")


def windows(df, lo, hi):
    """Séquences (n, WIN, 14) se terminant à chaque cycle ≥ WIN, et tableau de caractéristiques XGBoost."""
    seqs, feats, keys = [], [], []
    tt = np.arange(WIN, dtype=float)
    tt -= tt.mean()
    for u, g in df.groupby("equipment_id"):
        A = (g[CMAPSS_SENSORS].to_numpy() - lo) / (hi - lo)
        cyc, rul = g.cycle.to_numpy(), g.rul.to_numpy()
        for k in range(WIN - 1, len(g)):
            w = A[k - WIN + 1:k + 1]
            seqs.append(w)
            slope = (tt @ (w - w.mean(0))) / (tt @ tt)
            feats.append(np.concatenate([w[-1], w.mean(0), w.std(0), slope, [cyc[k] / 100.0]]))
            keys.append((u, int(cyc[k]), float(rul[k]), int(g.last_cycle.iloc[0])))
    return np.asarray(seqs, np.float64), np.asarray(feats), pd.DataFrame(keys, columns=["equipment_id", "cycle", "rul", "last_cycle"])


def train(con) -> dict:
    df = cmapss_fd001(con)
    tr_all = df[df.split == "train"]
    fit_u, val_u = unit_split(tr_all.equipment_id.unique())
    lo = tr_all[tr_all.equipment_id.isin(fit_u)][CMAPSS_SENSORS].min().to_numpy()
    hi = tr_all[tr_all.equipment_id.isin(fit_u)][CMAPSS_SENSORS].max().to_numpy()
    hi = np.where(hi > lo, hi, lo + 1)
    S_tr, F_tr, K_tr = windows(tr_all[tr_all.equipment_id.isin(fit_u)], lo, hi)
    S_va, F_va, K_va = windows(tr_all[tr_all.equipment_id.isin(val_u)], lo, hi)
    S_te, F_te, K_te = windows(df[df.split == "test"], lo, hi)
    y_tr, y_va = capped(K_tr.rul.to_numpy()), capped(K_va.rul.to_numpy())
    last = K_te.cycle == K_te.last_cycle  # évaluation officielle : dernier cycle observé
    y_last = K_te.rul[last].to_numpy()
    base = reg_metrics(y_last, np.full(last.sum(), y_tr.mean()))
    comp, preds = {}, {}
    common = dict(dataset="cmapss_fd001", provenance=PROV_SIMULATED, target=f"RUL plafonnée à {RUL_CAP}", unit="cycle",
                  split={"train": f"{len(fit_u)} unités / {len(K_tr)} fenêtres", "validation": f"{len(val_u)} unités", "test": "100 unités NASA (dernier cycle)"},
                  validation_rule="RMSE test < RMSE du prédicteur constant")
    # ---------------- XGBoost
    mid = reg.create(con, "rul", "xgboost", hyperparams={"n_estimators": "≤ 2000 (arrêt précoce 50)", "max_depth": 4, "learning_rate": 0.03,
                                                        "subsample": 0.8, "colsample_bytree": 0.8, "fenêtre": WIN}, features=["last", "mean", "std", "slope"] , **common)
    try:
        with Timer() as tt:
            xgb = XGBRegressor(n_estimators=2000, max_depth=4, learning_rate=0.03, subsample=0.8, colsample_bytree=0.8, min_child_weight=5,
                               early_stopping_rounds=50, eval_metric="rmse", random_state=SEED, n_jobs=2)
            xgb.fit(F_tr, y_tr, eval_set=[(F_va, y_va)], verbose=False)
        with Timer() as tp:
            p_all = np.clip(xgb.predict(F_te), 0, None)
        m = reg_metrics(y_last, p_all[last.to_numpy()])
        m["val_RMSE"] = float(np.sqrt(np.mean((xgb.predict(F_va) - y_va) ** 2)))
        m["train_time_s"], m["predict_time_ms_per_obs"], m["best_iteration"] = tt.s, 1000 * tp.s / len(F_te), int(xgb.best_iteration)
        reg.evaluate(con, mid, "test", {k: v for k, v in m.items() if isinstance(v, (int, float))})
        valid = m["RMSE"] < base["RMSE"]
        reg.finish(con, mid, valid=valid, artifact_obj={"model": xgb, "lo": lo, "hi": hi}, n_train=len(F_tr), n_val=len(F_va), n_test=int(last.sum()),
                   train_time_s=tt.s, predict_time_ms=m["predict_time_ms_per_obs"], data_hash=reg.data_hash(F_tr))
        comp["xgboost"] = {"model_id": mid, **m, "status": "valide" if valid else "entraine"}
        preds["xgboost"] = (mid, p_all)
        gain = sorted(zip([f"{a}:{s}" for a in ("dernier", "moyenne", "écart-type", "pente") for s in CMAPSS_SENSORS] + ["cycle"], xgb.feature_importances_.tolist()),
                      key=lambda r: -r[1])[:12]
    except Exception as e:
        reg.fail(con, mid, e)
        comp["xgboost"] = {"model_id": mid, "status": "erreur", "message": str(e)}
        gain = []
    # ---------------- LSTM
    mid = reg.create(con, "rul", "lstm", hyperparams={"hidden": 32, "dense": 16, "lr": 3e-3, "batch": 256, "epochs_max": 60, "patience": 8, "fenêtre": WIN},
                     features=CMAPSS_SENSORS, **common)
    try:
        with Timer() as tt:
            lstm = LSTMRegressor(len(CMAPSS_SENSORS), hidden=32, dense=16, lr=3e-3, seed=SEED % 1000)
            lstm.fit(S_tr, y_tr / RUL_CAP, S_va, y_va / RUL_CAP, epochs=60, batch=256, patience=8, seed=SEED % 1000)
        with Timer() as tp:
            p_all = np.clip(lstm.predict(S_te) * RUL_CAP, 0, None)
        m = reg_metrics(y_last, p_all[last.to_numpy()])
        m["val_RMSE"] = float(np.sqrt(lstm.best_val_mse)) * RUL_CAP
        m["train_time_s"], m["predict_time_ms_per_obs"], m["epochs"] = tt.s, 1000 * tp.s / len(S_te), len(lstm.history)
        reg.evaluate(con, mid, "test", {k: v for k, v in m.items() if isinstance(v, (int, float))})
        valid = m["RMSE"] < base["RMSE"]
        reg.finish(con, mid, valid=valid, artifact_obj={"state": lstm.state(), "lo": lo, "hi": hi}, n_train=len(S_tr), n_val=len(S_va), n_test=int(last.sum()),
                   train_time_s=tt.s, predict_time_ms=m["predict_time_ms_per_obs"], data_hash=reg.data_hash(S_tr[:, -1, :]))
        comp["lstm"] = {"model_id": mid, **m, "status": "valide" if valid else "entraine", "history": lstm.history}
        preds["lstm"] = (mid, p_all)
    except Exception as e:
        reg.fail(con, mid, e)
        comp["lstm"] = {"model_id": mid, "status": "erreur", "message": str(e)}

    # ---------------- persistance des prédictions (toutes les fenêtres de test) + charge utile
    con.execute("DELETE FROM rul_predictions")
    now = db.now()
    rows = []
    for algo, (mid, p) in preds.items():
        for k, r in enumerate(K_te.itertuples(index=False)):
            rows.append({"equipment_id": r.equipment_id, "computed_at": now, "algorithm": algo, "model_version": mid, "t": float(r.cycle), "value": float(p[k]),
                         "unit": "cycle", "true_value": float(r.rul), "health_index": float(min(p[k], RUL_CAP) / RUL_CAP),
                         "status": health_state(p[k]), "validation": db.j({"jeu": "test NASA", "dernier_cycle": bool(r.cycle == r.last_cycle)}),
                         "provenance": PROV_SIMULATED})
    db.insert_many(con, "rul_predictions", rows)
    con.commit()
    best = min((a for a in comp if "RMSE" in comp[a]), key=lambda a: comp[a]["RMSE"])
    units = []
    for u, g in K_te.assign(**{a: preds[a][1] for a in preds}).groupby("equipment_id"):
        lr = g.iloc[-1]
        units.append({"equipment_id": u, "last_cycle": int(lr.cycle), "true_rul": float(lr.rul), **{a: round(float(lr[a]), 1) for a in preds},
                      "state": health_state(lr[best])})
    traj = {}
    for u in sorted(K_te.equipment_id.unique())[:100]:
        g = K_te.assign(**{a: preds[a][1] for a in preds})[K_te.equipment_id == u]
        traj[u] = {"cycle": downsample(g.cycle.tolist(), 120), "true": downsample(np.minimum(g.rul, 200).round(1).tolist(), 120),
                   **{a: downsample(np.round(g[a], 1).tolist(), 120) for a in preds}}
    payload = {"comparison": {k: {kk: vv for kk, vv in v.items() if kk != "history"} for k, v in comp.items()},
               "lstm_history": comp.get("lstm", {}).get("history", []), "baseline_constant": base, "best": best, "thresholds": THRESHOLDS,
               "units": units, "trajectories": traj, "xgb_importance": gain, "cap": RUL_CAP, "window": WIN,
               "note": "RUL réelle au dernier cycle = vérité NASA (non plafonnée) ; la cible d'apprentissage est plafonnée à 125 cycles."}
    save_payload(con, "rul", payload)
    return {k: {kk: (round(v[kk], 3) if isinstance(v.get(kk), float) else v.get(kk)) for kk in ("MAE", "RMSE", "R2", "score_PHM08", "status")} for k, v in comp.items()} | {"baseline_RMSE": base["RMSE"]}
