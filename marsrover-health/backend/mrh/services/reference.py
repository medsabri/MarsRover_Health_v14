"""Jeux de référence FEMTO (roulements PRONOSTIA) et HIRF (batteries de l'avion électrique Edge 540).

Lecture depuis la base (sensor_data, failure_history, equipment) et les fichiers traités ; aucune valeur inventée.

FEMTO / PRONOSTIA — 17 roulements menés jusqu'à défaillance (6 d'apprentissage, 11 du jeu de test complet),
3 conditions (1 800 tr/min-4 000 N ; 1 650-4 200 ; 1 500-5 000). Instantanés de 0,1 s toutes les 10 s.
  * exploration : trajectoires RMS / kurtosis, distributions, corrélations ;
  * fiabilité : Weibull MLE sur les 17 durées de vie (toutes observées), Kaplan–Meier, médianes par condition ;
  * anomalies : Isolation Forest par roulement (référence = 20 premiers % de sa vie, seuil = quantile 99 % des 20–30 %),
    alarme = 6 instantanés consécutifs (1 min) ; comparé à la règle « RMS > 3 × référence » ;
  * RUL (h) : XGBoost et Random Forest appris sur les 6 roulements d'apprentissage, évalués sur les 11 roulements de test
    (jamais vus) ; référence statistique = durée de vie résiduelle moyenne conditionnelle de la loi de Weibull
    ajustée sur l'apprentissage, MRL(t) = ∫ₜ^∞ R(u) du / R(t).
HIRF — 53 essais (200 Hz) de 4 packs de batteries ; pas de fin de vie observée.
  * exploration : séries temporelles, distributions, corrélations, contrôle qualité (valeurs hors plage, pics) ;
  * dégradation : tendance de la résistance interne apparente R (régression V = E₀ − R·I − k·Ah) au fil des essais ;
  * anomalies : Isolation Forest sur les caractéristiques par essai ;
  * moniteur BHM embarqué : stabilité de la prédiction de fin de décharge (EOD) — sa justesse n'est PAS calculable,
    aucune décharge n'ayant été menée jusqu'au seuil de fin de décharge.
"""
from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd
from scipy import integrate, stats
from sklearn.ensemble import IsolationForest, RandomForestRegressor
from sklearn.preprocessing import StandardScaler
from xgboost import XGBRegressor

from .. import db
from ..config import PROCESSED, PROV_EXPERIMENTAL, SEED
from ..ml import weibull as W
from ..ml.common import Timer, downsample, reg_metrics, save_payload
from . import registry as reg

FEATS = ["h_rms", "v_rms", "h_kurt", "v_kurt", "h_peak", "v_peak", "h_crest", "v_crest", "h_band_0_1k", "h_band_6_12k", "v_band_0_1k", "v_band_6_12k"]
PACKS = ["LLF20", "ULA20", "LRF40", "URA40"]


def _femto(con) -> pd.DataFrame:
    long = pd.read_sql_query("SELECT equipment_id, t, variable, value FROM sensor_data WHERE equipment_id LIKE 'FEMTO-%'", con)
    w = long.pivot_table(index=["equipment_id", "t"], columns="variable", values="value").reset_index()
    meta = {r["equipment_id"]: json.loads(r["meta"]) for r in db.rows(con, "SELECT equipment_id, meta FROM equipment WHERE equipment_id LIKE 'FEMTO-%'")}
    for k in ("split", "condition", "life_s"):
        w[k] = w.equipment_id.map(lambda e: meta[e][k])
    w["rul_h"] = (w.life_s - w.t) / 3600
    w["life_frac"] = w.t / w.life_s
    return w.sort_values(["equipment_id", "t"]).reset_index(drop=True)


def _rul_features(F: pd.DataFrame) -> tuple[pd.DataFrame, list]:
    """Caractéristiques causales : moyenne glissante (30 instantanés = 5 min) normalisée par la référence du roulement
    (médiane des 30 premiers instantanés, connue dès la mise en service) + temps écoulé + condition."""
    out = []
    for e, g in F.groupby("equipment_id"):
        g = g.copy()
        base = g[FEATS].iloc[:30].median()
        sm = g[FEATS].rolling(30, min_periods=1).mean()
        for c in FEATS:
            g[f"n_{c}"] = sm[c] / base[c] if base[c] else sm[c]
        g["n_h_rms_max"] = (g.h_rms / base.h_rms).cummax()
        g["slope_h_rms"] = sm.h_rms.diff(30) / base.h_rms
        out.append(g)
    X = pd.concat(out, ignore_index=True)
    cols = [f"n_{c}" for c in FEATS] + ["n_h_rms_max", "slope_h_rms", "t", "condition"]
    X[cols] = X[cols].fillna(0)
    return X, cols


def _mrl(beta, eta, t):
    """Durée de vie résiduelle moyenne conditionnelle de Weibull."""
    R = lambda u: np.exp(-(u / eta) ** beta)
    out = []
    for x in np.atleast_1d(t):
        r = R(x)
        out.append(integrate.quad(R, x, np.inf, limit=200)[0] / r if r > 1e-12 else 0.0)
    return np.array(out)


def train(con) -> dict:
    payload, summary = {}, {}
    # ================================================================= FEMTO
    F = _femto(con)
    if len(F):
        bear = []
        for e, g in F.groupby("equipment_id"):
            b0 = g.h_rms.iloc[:30].median()
            bear.append({"equipment_id": e, "bearing": e[6:], "split": g.split.iloc[0], "condition": int(g.condition.iloc[0]), "life_h": float(g.life_s.iloc[0] / 3600),
                         "snapshots": int(len(g)), "h_rms_ref": float(b0), "h_rms_end": float(g.h_rms.iloc[-10:].median()), "ratio_h_rms": float(g.h_rms.iloc[-10:].median() / b0),
                         "h_kurt_max": float(g.h_kurt.max()), "peak_end_g": float(max(g.h_peak.iloc[-1], g.v_peak.iloc[-1]))})
        B = pd.DataFrame(bear)
        traj = {}
        for e, g in F.groupby("equipment_id"):
            idx = np.linspace(0, len(g) - 1, min(160, len(g))).astype(int)
            traj[e[6:]] = {"frac": g.life_frac.iloc[idx].round(4).tolist(), "t_h": (g.t.iloc[idx] / 3600).round(4).tolist(), "h_rms": g.h_rms.iloc[idx].round(4).tolist(),
                           "v_rms": g.v_rms.iloc[idx].round(4).tolist(), "h_kurt": g.h_kurt.iloc[idx].round(3).tolist()}
        # distributions (histogrammes log RMS par moitié de vie) et corrélations
        edges = np.linspace(np.log10(F.h_rms.min()), np.log10(F.h_rms.max()), 41)
        hist = {lab: np.histogram(np.log10(F.h_rms[m]), bins=edges)[0].tolist() for lab, m in (("0–50 % de la vie", F.life_frac < .5), ("50–90 %", (F.life_frac >= .5) & (F.life_frac < .9)), ("90–100 %", F.life_frac >= .9))}
        corr = F[FEATS + ["life_frac"]].corr(method="spearman").round(3)
        # ---- fiabilité : Weibull sur 17 durées de vie (h)
        life = B.life_h.to_numpy()
        mid = reg.create(con, "fiabilite", "weibull_femto", dataset="femto_pronostia", provenance=PROV_EXPERIMENTAL, target="durée de vie", unit="h",
                         hyperparams={"estimation": "MLE", "censure": "aucune (17 essais jusqu'à défaillance)"}, split={"n": int(len(life))}, validation_rule="≥ 2 défaillances, IC fini")
        fw = W.fit(life, np.ones_like(life))
        grid = np.linspace(0.05, 10, 120)
        lo, hi = W.R_ci(grid, fw)
        reg.finish(con, mid, valid=bool(np.isfinite(fw["beta_ci"][1])), artifact_obj=fw, n_train=len(life))
        km = W.kaplan_meier(life, np.ones_like(life))
        ks = stats.kstest(life, "weibull_min", args=(fw["beta"], 0, fw["eta"]))
        by_cond = B.groupby("condition").life_h.agg(["count", "median", "mean", "min", "max"]).reset_index()
        kw = stats.kruskal(*[g.life_h.to_numpy() for _, g in B.groupby("condition")])
        rel = {"beta": fw["beta"], "eta": fw["eta"], "beta_ci": fw["beta_ci"], "eta_ci": fw["eta_ci"], "mttf": fw["mttf"], "b10": fw["eta"] * (-np.log(0.9)) ** (1 / fw["beta"]),
               "ks_p": float(ks.pvalue), "grid": grid.round(3).tolist(), "R": W.R(grid, fw["beta"], fw["eta"]).round(4).tolist(), "R_lo": lo.round(4).tolist(), "R_hi": hi.round(4).tolist(),
               "km": km, "by_condition": by_cond.round(3).to_dict("records"), "kruskal_p": float(kw.pvalue), "model_id": mid}
        # ---- anomalies : Isolation Forest par roulement vs règle RMS > 3 × référence
        mid_if = reg.create(con, "anomalies", "isolation_forest_femto", dataset="femto_pronostia", provenance=PROV_EXPERIMENTAL, target="score d'anomalie", unit="—",
                            hyperparams={"n_estimators": 200, "référence": "20 premiers % de la vie", "persistance": "6 instantanés (1 min)"}, features=FEATS,
                            split={"par roulement": "apprentissage 0–20 %, seuil 20–30 %, détection 30–100 %"},
                            validation_rule="non validable (pas d'instant de défaut de référence) : on rapporte l'avance avant défaillance")
        det, series = [], {}
        for e, g in F.groupby("equipment_id"):
            g = g.reset_index(drop=True)
            n = len(g)
            a, b = max(20, int(.2 * n)), max(30, int(.3 * n))
            X = g[FEATS].rolling(6, min_periods=1).mean().to_numpy()
            sc = StandardScaler().fit(X[:a])
            m = IsolationForest(n_estimators=200, random_state=SEED).fit(sc.transform(X[:a]))
            s = -m.score_samples(sc.transform(X))
            thr = float(np.quantile(s[a:b], .99))

            def first_alarm(flags, k=6, start=b):
                run = 0
                for i in range(start, len(flags)):
                    run = run + 1 if flags[i] else 0
                    if run >= k:
                        return i - k + 1
                return None
            fi = first_alarm(s > thr)
            base = g.h_rms.iloc[:a].median()
            fr = first_alarm((g.h_rms.rolling(6, min_periods=1).median() > 3 * base).to_numpy())
            life_h = g.life_s.iloc[0] / 3600
            det.append({"bearing": e[6:], "condition": int(g.condition.iloc[0]), "life_h": life_h,
                        "if_alarm_h": g.t[fi] / 3600 if fi is not None else None, "if_lead_h": life_h - g.t[fi] / 3600 if fi is not None else None,
                        "if_alarm_frac": float(g.life_frac[fi]) if fi is not None else None,
                        "rule_alarm_h": g.t[fr] / 3600 if fr is not None else None, "rule_lead_h": life_h - g.t[fr] / 3600 if fr is not None else None,
                        "rule_alarm_frac": float(g.life_frac[fr]) if fr is not None else None, "if_threshold": thr})
            idx = np.linspace(0, n - 1, min(200, n)).astype(int)
            series[e[6:]] = {"t_h": (g.t[idx] / 3600).round(4).tolist(), "score": s[idx].round(4).tolist(), "thr": thr}
        D = pd.DataFrame(det)
        reg.finish(con, mid_if, valid=False, n_train=int(len(F)), message="Entraîné par roulement ; performance non validable faute d'instant de défaut de référence.")
        reg.evaluate(con, mid_if, "test", {"detected_bearings": float(D.if_alarm_h.notna().sum()), "median_lead_h": float(D.if_lead_h.median()),
                                            "median_alarm_frac": float(D.if_alarm_frac.median())})
        # ---- RUL : apprentissage (6) → test complet (11)
        X, cols = _rul_features(F)
        tr, te = X[X.split == "learning"], X[X.split != "learning"]
        ytr, yte = tr.rul_h.to_numpy(), te.rul_h.to_numpy()
        fw_tr = W.fit(B[B.split == "learning"].life_h.to_numpy(), np.ones((B.split == "learning").sum()))
        grid_t = np.linspace(0, te.t.max() / 3600, 400)
        mrl_tab = _mrl(fw_tr["beta"], fw_tr["eta"], grid_t)
        p_base = np.interp(te.t / 3600, grid_t, mrl_tab)
        comp, preds = {}, {"weibull_mrl": p_base}
        mid_b = reg.create(con, "rul", "weibull_mrl_femto", dataset="femto_pronostia", provenance=PROV_EXPERIMENTAL, target="RUL", unit="h",
                           hyperparams={"méthode": "durée de vie résiduelle moyenne conditionnelle Weibull", "beta": round(fw_tr["beta"], 3), "eta_h": round(fw_tr["eta"], 3)},
                           split={"train": "6 durées de vie d'apprentissage", "test": "11 roulements de test"}, validation_rule="référence statistique (sans capteur)")
        comp["weibull_mrl"] = {"model_id": mid_b, **reg_metrics(yte, p_base), "status": "valide",
                               "note": f"MRL Weibull (β = {fw_tr['beta']:.2f}, η = {fw_tr['eta']:.2f} h) appris sur les 6 durées d'apprentissage"}
        algos = {"xgboost": (lambda: XGBRegressor(n_estimators=400, max_depth=3, learning_rate=0.03, subsample=0.8, colsample_bytree=0.8, min_child_weight=20, random_state=SEED, n_jobs=2),
                             {"n_estimators": 400, "max_depth": 3, "learning_rate": 0.03, "min_child_weight": 20}),
                 "random_forest": (lambda: RandomForestRegressor(n_estimators=300, min_samples_leaf=50, max_features=0.5, random_state=SEED, n_jobs=2),
                                   {"n_estimators": 300, "min_samples_leaf": 50, "max_features": 0.5})}
        for name, (make, hp) in algos.items():
            mid_r = reg.create(con, "rul", f"{name}_femto", dataset="femto_pronostia", provenance=PROV_EXPERIMENTAL, target="RUL", unit="h", hyperparams=hp, features=cols,
                               split={"train": "6 roulements d'apprentissage", "test": "11 roulements du jeu de test complet (jamais vus)"},
                               validation_rule="MAE test < MAE de la référence Weibull MRL")
            try:
                # validation croisée « un roulement exclu » sur l'apprentissage (stabilité)
                cv = []
                for b in tr.equipment_id.unique():
                    mm = make().fit(tr[tr.equipment_id != b][cols], ytr[tr.equipment_id.to_numpy() != b])
                    cv.append(reg_metrics(ytr[tr.equipment_id.to_numpy() == b], mm.predict(tr[tr.equipment_id == b][cols]))["MAE"])
                with Timer() as tt:
                    m = make().fit(tr[cols], ytr)
                with Timer() as tp:
                    p = np.clip(m.predict(te[cols]), 0, None)
                met = reg_metrics(yte, p)
                met.update(cv_mae_mean=float(np.mean(cv)), cv_mae_std=float(np.std(cv)), train_time_s=tt.s, predict_time_ms_per_obs=1000 * tp.s / len(te))
                for q in (0.5, 0.75, 0.9):
                    sel = (te.life_frac - q).abs() < 0.02
                    met[f"MAE_{int(q * 100)}pct"] = float(np.mean(np.abs(p[sel.to_numpy()] - yte[sel.to_numpy()])))
                reg.evaluate(con, mid_r, "test", {k: v for k, v in met.items() if isinstance(v, (int, float))})
                valid = met["MAE"] < comp["weibull_mrl"]["MAE"]
                reg.finish(con, mid_r, valid=valid, artifact_obj={"model": m, "features": cols}, n_train=len(tr), n_test=len(te), train_time_s=tt.s,
                           predict_time_ms=met["predict_time_ms_per_obs"], message=None if valid else "Non meilleur que la référence Weibull MRL : non validé.")
                comp[name] = {"model_id": mid_r, **met, "status": "valide" if valid else "entraine"}
                preds[name] = p
                if name == "xgboost":
                    imp = sorted(zip(cols, m.feature_importances_.tolist()), key=lambda r: -r[1])[:10]
            except Exception as ex:
                reg.fail(con, mid_r, ex)
                comp[name] = {"model_id": mid_r, "status": "erreur", "message": str(ex)}
        for q in (0.5, 0.75, 0.9):
            sel = ((te.life_frac - q).abs() < 0.02).to_numpy()
            comp["weibull_mrl"][f"MAE_{int(q * 100)}pct"] = float(np.mean(np.abs(p_base[sel] - yte[sel])))
        reg.evaluate(con, mid_b, "test", {k: v for k, v in comp["weibull_mrl"].items() if isinstance(v, (int, float))})
        reg.finish(con, mid_b, valid=True, artifact_obj=fw_tr, n_train=6, n_test=len(te), message="Référence statistique : utilise uniquement le temps écoulé.")
        rtraj = {}
        te2 = te.assign(**{k: v for k, v in preds.items()})
        for e, g in te2.groupby("equipment_id"):
            idx = np.linspace(0, len(g) - 1, min(140, len(g))).astype(int)
            rtraj[e[6:]] = {"t_h": (g.t.iloc[idx] / 3600).round(3).tolist(), "true": g.rul_h.iloc[idx].round(3).tolist(),
                            **{k: np.round(g[k].iloc[idx], 3).tolist() for k in preds}}
        best = min((k for k in comp if "MAE" in comp[k]), key=lambda k: comp[k]["MAE"])
        payload["femto"] = {"bearings": B.round(4).to_dict("records"), "trajectories": traj, "hist": {"edges_log10": edges.round(3).tolist(), "counts": hist},
                            "corr": {"cols": corr.columns.tolist(), "m": corr.to_numpy().tolist()}, "reliability": rel, "detection": D.round(3).to_dict("records"),
                            "det_series": series, "rul": {"comparison": comp, "trajectories": rtraj, "best": best, "importance": imp if "xgboost" in preds else []},
                            "n_snapshots": int(len(F)), "conditions": {1: "1 800 tr/min · 4 000 N", 2: "1 650 tr/min · 4 200 N", 3: "1 500 tr/min · 5 000 N"}}
        summary["femto"] = {"weibull": (round(fw["beta"], 3), round(fw["eta"], 3)), "rul": {k: round(v.get("MAE", np.nan), 3) for k, v in comp.items()},
                            "if_detected": int(D.if_alarm_h.notna().sum())}

    # ================================================================= HIRF
    hp = os.path.join(PROCESSED, "hirf_runs.csv")
    if os.path.exists(hp):
        R = pd.read_csv(hp).sort_values("run").reset_index(drop=True)
        R["ordre"] = np.arange(1, len(R) + 1)
        trend = []
        for p in PACKS:
            y = R[f"{p}_R_ohm"]
            ok = y.notna()
            rho, pv = stats.spearmanr(R.ordre[ok], y[ok])
            lr = stats.linregress(R.ordre[ok], y[ok])
            trend.append({"pack": p, "R_median_ohm": float(y.median()), "R_first10": float(y[ok].iloc[:10].median()), "R_last10": float(y[ok].iloc[-10:].median()),
                          "spearman_rho": float(rho), "p_value": float(pv), "slope_mohm_per_run": float(lr.slope * 1000), "slope_ci95_mohm": float(1.96 * lr.stderr * 1000)})
        Tn = pd.DataFrame(trend)
        feat = [f"{p}_{q}" for p in PACKS for q in ("R_ohm", "Ah", "T_rise", "V_end", "dVdAh")]
        Xr = R[feat].copy()
        nan_rows = Xr.isna().any(axis=1)
        Xf = Xr.fillna(Xr.median())
        sc = StandardScaler().fit(Xf)
        Z = sc.transform(Xf)
        mid_h = reg.create(con, "anomalies", "isolation_forest_hirf", dataset="hirf_edge540", provenance=PROV_EXPERIMENTAL, target="essai atypique", unit="—",
                           hyperparams={"n_estimators": 300, "contamination": 0.1}, features=feat, split={"n_essais": int(len(R))},
                           validation_rule="non validable (pas d'étiquette d'essai anormal)")
        m = IsolationForest(n_estimators=300, contamination=0.1, random_state=SEED).fit(Z)
        sc_run = -m.score_samples(Z)
        flag = m.predict(Z) == -1
        reg.finish(con, mid_h, valid=False, n_train=int(len(R)), message="Détection non supervisée d'essais atypiques ; aucune vérité terrain.")
        an = []
        for i in np.where(flag)[0]:
            top = pd.Series(np.abs(Z[i]), index=feat).sort_values(ascending=False).head(3)
            an.append({"run": int(R.run[i]), "set": R.set[i], "score": float(sc_run[i]), "variables": [{"var": k, "z": round(float(Z[i][feat.index(k)]), 2)} for k in top.index],
                       "spikes": int(R.spikes_V_T[i])})
        corr = R[feat + ["spikes_V_T", "duration_s", "active_s"]].corr(method="spearman").round(3)
        # séries d'un essai représentatif (dernier essai avec BHM et sans valeur invalide)
        S = pd.read_csv(os.path.join(PROCESSED, "hirf_series_10s.csv"))
        inv_cols = [c for c in R.columns if c.startswith("invalid_pct")]
        clean = R[(R[inv_cols].fillna(0).sum(axis=1) == 0) & R.has_bhm]
        rep_run = int(clean.run.iloc[-1]) if len(clean) else int(R.run.iloc[-1])
        sr = S[S.run == rep_run]
        cols_s = [c for c in sr.columns if c not in ("run",)]
        series = {c: sr[c].round(3).where(sr[c].notna(), None).tolist() for c in cols_s}
        bh = None
        bp = os.path.join(PROCESSED, "hirf_bhm_10s.csv")
        stab = []
        if os.path.exists(bp):
            BH = pd.read_csv(bp)
            b = BH[BH.run == rep_run]
            bh = {c: b[c].round(3).tolist() for c in ["t_s"] + [f"{p}_{q}" for p in ("LLF", "ULA", "LRF", "URA") for q in ("SOC_med", "RUL_med", "RUL_p05", "RUL_p95", "EOD_med")]}
            for run, g in BH.groupby("run"):
                for p in ("LLF", "ULA", "LRF", "URA"):
                    eod = g[f"{p}_EOD_med"]
                    act = g[g[f"{p}_RUL_med"] > 0]
                    if len(act) > 10:
                        stab.append({"run": int(run), "pack": p, "eod_iqr_s": float(act[f"{p}_EOD_med"].quantile(.75) - act[f"{p}_EOD_med"].quantile(.25)),
                                     "soc_end": float(g[f"{p}_SOC_med"].iloc[-1]), "rul_end_s": float(g[f"{p}_RUL_med"].iloc[-1])})
        ST = pd.DataFrame(stab)
        payload["hirf"] = {
            "runs": R.round(4).where(R.notna(), None).to_dict("records"), "trend": Tn.round(5).to_dict("records"), "anomalies": an, "anomaly_scores": [{"run": int(r), "score": float(s), "flag": bool(f)} for r, s, f in zip(R.run, sc_run, flag)],
            "corr": {"cols": corr.columns.tolist(), "m": corr.to_numpy().tolist()}, "rep_run": rep_run, "series": series, "bhm": bh,
            "bhm_stability": ST.groupby("pack").agg(eod_iqr_median_s=("eod_iqr_s", "median"), soc_end_median=("soc_end", "median"), rul_end_median_s=("rul_end_s", "median")).reset_index().round(2).to_dict("records") if len(ST) else [],
            "qc": {"runs_with_invalid": int((R[inv_cols].fillna(0).sum(axis=1) > 0).sum()), "temp_all_invalid_runs": R.run[(R[[c for c in inv_cols if c.endswith("T")]].fillna(0) >= 99).any(axis=1)].astype(int).tolist(),
                   "spikes_total": int(R.spikes_V_T.sum()), "nan_rows_features": int(nan_rows.sum())},
            "model_id": mid_h}
        summary["hirf"] = {"trend": Tn[["pack", "spearman_rho", "p_value"]].round(4).to_dict("records"), "anomalous_runs": [a["run"] for a in an]}
    con.commit()
    save_payload(con, "references", payload)
    return summary
