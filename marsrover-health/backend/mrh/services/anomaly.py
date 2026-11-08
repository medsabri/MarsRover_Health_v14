"""MODULE 1 — Détection d'anomalies : Isolation Forest (principal) vs One-Class SVM vs Autoencodeur.

Cas A — C-MAPSS FD001 (simulation NASA, 14 capteurs informatifs), vérité terrain disponible :
  * apprentissage NON supervisé sur le fonctionnement normal = 50 premiers cycles des unités d'apprentissage
    (hypothèse d'exploitation : un équipement neuf est sain ; aucune étiquette d'anomalie utilisée) ;
  * normalisation z-score ajustée sur ces seules données ; moyenne glissante causale (5 cycles) ;
  * seuil = quantile 99 % des scores sur le normal des unités de VALIDATION (taux de fausses alertes visé 1 %) ;
  * évaluation sur le jeu de TEST NASA : normal ⇔ RUL réelle > 125 cycles, anormal ⇔ RUL ≤ 30 cycles,
    observations intermédiaires (dégradation naissante, étiquette ambiguë) exclues des métriques.
Cas B — IGBT (essai réel de vieillissement, sans vérité terrain) : Isolation Forest appris sur les 20 premiers %
  de l'essai, seuil sur les 10 % suivants ; AUCUNE métrique de performance n'est produite (pas de référence).

Règle de priorité (proposée, à valider par l'exploitant) :
  haute   : épisode ≥ 5 observations consécutives ET ≥ 3 capteurs |z| > 3
  moyenne : épisode ≥ 3 observations consécutives (persistance)
  basse   : dépassement isolé (non enregistré comme épisode)
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.svm import OneClassSVM

from .. import db
from ..config import ANOMALY_PERSIST, CMAPSS_SENSOR_INFO, CMAPSS_SENSORS, PROV_EXPERIMENTAL, PROV_SIMULATED, RISK_RUL, RUL_CAP, SEED
from ..ml.common import Timer, cmapss_fd001, det_metrics, downsample, rolling_mean, save_payload, unit_split
from . import registry as reg

NORMAL_CYCLES = 50


class AE:
    """Autoencodeur dense 14-8-4-8-14 (tanh) ; score = erreur quadratique moyenne de reconstruction."""

    def __init__(self, seed=SEED):
        self.m = MLPRegressor(hidden_layer_sizes=(8, 4, 8), activation="tanh", alpha=1e-4, max_iter=600, early_stopping=True,
                              validation_fraction=0.15, n_iter_no_change=20, random_state=seed)

    def fit(self, X):
        self.m.fit(X, X)
        return self

    def score(self, X):
        return np.mean((self.m.predict(X) - X) ** 2, axis=1)


def _scores(name, model, X):
    if name == "isolation_forest":
        return -model.score_samples(X)
    if name == "one_class_svm":
        return -model.decision_function(X)
    return model.score(X)


def episodes(flags, min_len=ANOMALY_PERSIST):
    """Intervalles [i, j] d'au moins min_len dépassements consécutifs."""
    out, i, n = [], 0, len(flags)
    while i < n:
        if flags[i]:
            j = i
            while j + 1 < n and flags[j + 1]:
                j += 1
            if j - i + 1 >= min_len:
                out.append((i, j))
            i = j + 1
        else:
            i += 1
    return out


def priority(length, n_sensors_hi):
    return "haute" if length >= 5 and n_sensors_hi >= 3 else "moyenne"


def train(con) -> dict:
    df = rolling_mean(cmapss_fd001(con), CMAPSS_SENSORS)
    tr_units = df[df.split == "train"].equipment_id.unique()
    fit_u, val_u = unit_split(tr_units)
    normal_fit = df[df.equipment_id.isin(fit_u) & (df.cycle <= NORMAL_CYCLES)]
    normal_val = df[df.equipment_id.isin(val_u) & (df.cycle <= NORMAL_CYCLES)]
    scaler = StandardScaler().fit(normal_fit[CMAPSS_SENSORS])
    Z = lambda d: scaler.transform(d[CMAPSS_SENSORS])
    test = df[df.split == "test"].copy()
    test["label"] = np.where(test.rul <= RISK_RUL, 1, np.where(test.rul > RUL_CAP, 0, -1))
    ev = test[test.label >= 0]
    val_all = df[df.equipment_id.isin(val_u)].copy()
    rng = np.random.default_rng(SEED)
    Xfit = Z(normal_fit)
    Xsvm = Xfit[rng.choice(len(Xfit), size=min(3000, len(Xfit)), replace=False)]
    algos = {
        "isolation_forest": (lambda: IsolationForest(n_estimators=200, max_samples=256, contamination="auto", random_state=SEED).fit(Xfit),
                             {"n_estimators": 200, "max_samples": 256}),
        "one_class_svm": (lambda: OneClassSVM(kernel="rbf", nu=0.01, gamma="scale").fit(Xsvm), {"kernel": "rbf", "nu": 0.01, "gamma": "scale", "n_fit": len(Xsvm)}),
        "autoencoder": (lambda: AE().fit(Xfit), {"layers": [14, 8, 4, 8, 14], "activation": "tanh"}),
    }
    comp, models = {}, {}
    for name, (make, hp) in algos.items():
        mid = reg.create(con, "anomalies", name, dataset="cmapss_fd001", provenance=PROV_SIMULATED, target="score d'anomalie", unit="—",
                         hyperparams=hp, features=CMAPSS_SENSORS,
                         split={"fit": f"{len(fit_u)} unités (cycles ≤ {NORMAL_CYCLES})", "validation": f"{len(val_u)} unités", "test": "100 unités NASA"},
                         validation_rule="AUC-ROC test > 0,5 et F1 test > 0")
        try:
            with Timer() as tt:
                model = make()
            thr = float(np.quantile(_scores(name, model, Z(normal_val)), 0.99))
            with Timer() as tp:
                s_ev = _scores(name, model, Z(ev))
            m = det_metrics(ev.label.to_numpy(), (s_ev > thr).astype(int), s_ev)
            # avance de détection sur les unités de validation (trajectoires complètes jusqu'à la défaillance)
            sv = _scores(name, model, Z(val_all))
            leads = []
            for u, g in val_all.assign(s=sv).groupby("equipment_id"):
                ep = episodes((g.s.to_numpy() > thr).tolist())
                if ep:
                    leads.append(float(g.rul.iloc[ep[0][0]]))
            m["lead_median_cycles"] = float(np.median(leads)) if leads else None
            m["detected_units_val"] = f"{len(leads)}/{len(val_u)}"
            m["threshold"] = thr
            m["train_time_s"], m["predict_time_ms_per_obs"] = tt.s, 1000 * tp.s / len(ev)
            reg.evaluate(con, mid, "test", {k: v for k, v in m.items() if isinstance(v, (int, float)) or v is None})
            valid = (m["auc_roc"] or 0) > 0.5 and m["f1"] > 0
            reg.finish(con, mid, valid=valid, artifact_obj={"model": model, "scaler": scaler, "threshold": thr},
                       n_train=len(Xfit), n_val=len(normal_val), n_test=len(ev), train_time_s=tt.s, predict_time_ms=m["predict_time_ms_per_obs"],
                       data_hash=reg.data_hash(Xfit))
            comp[name] = {"model_id": mid, **m, "status": "valide" if valid else "entraine"}
            models[name] = (model, thr)
        except Exception as e:  # erreur d'entraînement : statut « erreur », aucune métrique inventée
            reg.fail(con, mid, e)
            comp[name] = {"model_id": mid, "status": "erreur", "message": str(e)}

    # --------- historique d'anomalies (modèle principal) sur test + validation, capteurs contributifs
    con.execute("DELETE FROM anomaly_history")
    model, thr = models["isolation_forest"]
    mid = reg.active(con, "anomalies", "isolation_forest")["model_id"]
    hist, series = [], {}
    pool = pd.concat([test, val_all])
    pool = pool.assign(s=_scores("isolation_forest", model, Z(pool)))
    zf = pd.DataFrame(Z(pool), columns=CMAPSS_SENSORS, index=pool.index)
    now = db.now()
    for u, g in pool.groupby("equipment_id"):
        sc = g.s.to_numpy()
        flags = sc > thr
        series[u] = {"cycle": g.cycle.astype(int).tolist(), "score": np.round(sc, 4).tolist(), "rul": g.rul.astype(int).tolist()}
        for i, j in episodes(flags.tolist()):
            seg = zf.loc[g.index[i:j + 1]]
            mz = seg.abs().mean().sort_values(ascending=False)
            top = [{"sensor": s, "label": CMAPSS_SENSOR_INFO[s][0], "unit": CMAPSS_SENSOR_INFO[s][1], "z": round(float(seg[s].mean()), 2)} for s in mz.index[:3]]
            hist.append({"equipment_id": u, "computed_at": now, "algorithm": "isolation_forest", "model_version": mid, "t_start": float(g.cycle.iloc[i]),
                         "t_end": float(g.cycle.iloc[j]), "unit": "cycle", "value": float(sc[i:j + 1].max()), "threshold": thr, "sensors": db.j(top),
                         "priority": priority(j - i + 1, int((mz > 3).sum())), "status": "a_verifier",
                         "validation": db.j({"rul_reelle_debut": int(g.rul.iloc[i]), "jeu": "test NASA" if "-TE-" in u else "validation"}), "provenance": PROV_SIMULATED})
    db.insert_many(con, "anomaly_history", hist)

    # --------- IGBT : sans vérité terrain
    igbt = _igbt(con)
    con.commit()
    payload = {
        "cmapss": {"comparison": comp, "threshold_rule": "quantile 99 % des scores du normal de validation", "normal_def": f"cycles ≤ {NORMAL_CYCLES} des unités d'apprentissage",
                   "eval_def": f"test NASA : normal RUL > {RUL_CAP}, anormal RUL ≤ {RISK_RUL}, intermédiaire exclu",
                   "series": {u: {k: downsample(v, 220) for k, v in s.items()} for u, s in list(series.items())}, "threshold": thr,
                   "sensors": {s: {"label": CMAPSS_SENSOR_INFO[s][0], "unit": CMAPSS_SENSOR_INFO[s][1]} for s in CMAPSS_SENSORS}},
        "igbt": igbt,
    }
    save_payload(con, "anomalies", payload)
    return {k: {kk: v.get(kk) for kk in ("auc_roc", "f1", "precision", "recall", "status")} for k, v in comp.items()}


def _igbt(con):
    q = "SELECT t, variable, value FROM sensor_data WHERE equipment_id='IGBT-DC-01'"
    w = pd.read_sql_query(q, con).pivot_table(index="t", columns="variable", values="value").reset_index().sort_values("t")
    feats = ["collector_voltage_V", "collector_current_A", "gate_voltage_V", "gate_current_A", "package_temp_C"]
    # phase de mise en température (≤ 120 s) exclue : régime transitoire, non représentatif du fonctionnement établi ;
    # moyenne glissante causale sur 6 fenêtres (1 min) pour réduire le bruit de mesure
    w = w[w.t > 120].reset_index(drop=True)
    w[feats] = w[feats].rolling(6, min_periods=1).mean()
    T = w.t.max()
    fit_m, val_m = w.t < 0.2 * T, (w.t >= 0.2 * T) & (w.t < 0.3 * T)  # T : fin de l'essai
    sc = StandardScaler().fit(w.loc[fit_m, feats])
    mid = reg.create(con, "anomalies", "isolation_forest_igbt", dataset="igbt_nasa_pcoe", provenance=PROV_EXPERIMENTAL, target="score d'anomalie", unit="—",
                     hyperparams={"n_estimators": 200}, features=feats, split={"fit": "0–20 % de l'essai", "seuil": "20–30 %", "test": "aucune vérité terrain"},
                     validation_rule="non validable : aucune référence d'anomalie (métriques non calculables)")
    with Timer() as tt:
        m = IsolationForest(n_estimators=200, random_state=SEED).fit(sc.transform(w.loc[fit_m, feats]))
    s = -m.score_samples(sc.transform(w[feats]))
    thr = float(np.quantile(s[val_m.to_numpy()], 0.99))
    flags = s > thr
    eps = episodes(flags.tolist())
    z = pd.DataFrame(sc.transform(w[feats]), columns=feats)
    now = db.now()
    hist = []
    for i, j in eps:
        mz = z.iloc[i:j + 1].abs().mean().sort_values(ascending=False)
        top = [{"sensor": f, "label": f, "unit": f.rsplit("_", 1)[-1], "z": round(float(z.iloc[i:j + 1][f].mean()), 2)} for f in mz.index[:3]]
        hist.append({"equipment_id": "IGBT-DC-01", "computed_at": now, "algorithm": "isolation_forest", "model_version": mid, "t_start": float(w.t.iloc[i]),
                     "t_end": float(w.t.iloc[j]), "unit": "s", "value": float(s[i:j + 1].max()), "threshold": thr, "sensors": db.j(top),
                     "priority": priority(j - i + 1, int((mz > 3).sum())), "status": "a_verifier", "validation": db.j({"verite_terrain": None}),
                     "provenance": PROV_EXPERIMENTAL})
    db.insert_many(con, "anomaly_history", hist)
    reg.finish(con, mid, valid=False, artifact_obj={"model": m, "scaler": sc, "threshold": thr}, n_train=int(fit_m.sum()), n_val=int(val_m.sum()), n_test=0,
               train_time_s=tt.s, message="Entraîné ; performance NON évaluable (pas de vérité terrain).")
    first = float(w.t.iloc[eps[0][0]]) if eps else None
    return {"model_id": mid, "threshold": thr, "t": w.t.astype(int).tolist(), "score": np.round(s, 4).tolist(),
            "signals": {f: np.round(w[f].to_numpy(), 4).tolist() for f in ("collector_voltage_V", "collector_current_A", "package_temp_C")},
            "episodes": len(eps), "first_episode_s": first, "preprocessing": "mise en température (≤ 120 s) exclue ; moyenne glissante causale 1 min", "duration_s": float(T), "metrics": None,
            "note": "Aucune métrique (précision, rappel, AUC) : l'essai ne fournit pas d'instants d'anomalie de référence."}
