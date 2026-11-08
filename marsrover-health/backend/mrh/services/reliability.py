"""MODULE 3 — Fiabilité : loi de Weibull (MLE avec censure) et Random Survival Forest.

Partie A — Weibull 2 paramètres (cf. ml/weibull.py), données de durée de vie avec censure à droite :
  * C-MAPSS FD001 : 100 trajectoires jusqu'à défaillance (event = 1) + 100 trajectoires de test interrompues
    (event = 0, censure à la dernière observation — la RUL NASA n'est PAS utilisée ici) ;
  * cellules Li-ion NASA (EXPÉRIMENTAL) : durée en nombre de décharges jusqu'à C < 1,4 Ah, censure sinon.
    Effectif très faible → IC larges, résultat indicatif ; transfert vers la batterie rover = substitution non validée.
Partie B — S(t | X) : Random Survival Forest (Ishwaran et al. 2008) vs Weibull, sur C-MAPSS FD001–FD004
  (1 416 unités, ≈ 50 % censurées). Covariables connues dès la mise en service : moyennes des 15 premiers cycles
  (14 capteurs + 3 réglages), nombre de régimes et de modes de défaillance du sous-ensemble.
  Découpage aléatoire par unité 70 / 30 (graine fixe). Comparaison sur le test :
    - C-index de Harrell (concordance des risques prédits, censure prise en compte) ;
    - Brier score intégré (IBS) pondéré IPCW (Graf et al. 1999) sur la grille des quantiles 10–80 % des temps.
  Le Weibull sans covariable prédit la même courbe pour toutes les unités : C-index = 0,5 par construction.
  Un Weibull AFT (avec les mêmes covariables) est ajouté comme référence paramétrique équitable.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
from lifelines import WeibullAFTFitter
from sksurv.ensemble import RandomSurvivalForest
from sksurv.metrics import concordance_index_censored, integrated_brier_score
from sksurv.util import Surv

from .. import db
from ..config import CMAPSS_SENSORS, PROV_EXPERIMENTAL, PROV_SIMULATED, PROV_SUBSTITUTED, SEED
from ..ml import weibull as W
from ..ml.common import Timer, save_payload
from . import registry as reg

HORIZONS = [100, 150, 200, 250, 300]


def _lifetimes(con, like):
    return pd.DataFrame(db.rows(con, f"SELECT f.equipment_id, f.t_event AS t, f.event FROM failure_history f WHERE f.equipment_id LIKE '{like}'"))


def _weibull_block(t, d, unit, grid_max):
    f = W.fit(t, d)
    if not f["ok"]:
        return {"ok": False, "reason": f["reason"]}
    grid = np.linspace(1, grid_max, 120)
    lo, hi = W.R_ci(grid, f)
    km = W.kaplan_meier(t, d)
    return {**{k: f[k] for k in ("ok", "beta", "eta", "beta_ci", "eta_ci", "mttf", "n", "failures", "censored", "aic", "loglik")}, "unit": unit,
            "curve": {"t": np.round(grid, 2).tolist(), "R": np.round(W.R(grid, f["beta"], f["eta"]), 5).tolist(), "R_lo": np.round(lo, 5).tolist(),
                      "R_hi": np.round(hi, 5).tolist(), "F": np.round(W.F(grid, f["beta"], f["eta"]), 5).tolist(),
                      "h": np.round(W.hazard(grid, f["beta"], f["eta"]), 7).tolist()},
            "km": km, "_fit": f}


def train(con) -> dict:
    con.execute("DELETE FROM reliability_results")
    now = db.now()
    res_rows = []

    def store(eid, algo, mid, q, value, unit, t=None, ci=(None, None), prov=PROV_SIMULATED, val=None):
        res_rows.append({"equipment_id": eid, "computed_at": now, "algorithm": algo, "model_version": mid, "quantity": q, "t": t, "value": value, "unit": unit,
                         "ci_low": ci[0], "ci_high": ci[1], "status": "calcule", "validation": db.j(val or {}), "provenance": prov})

    # ---------------- Partie A : Weibull C-MAPSS FD001
    lt = _lifetimes(con, "CMAPSS-FD001-%")
    mid = reg.create(con, "fiabilite", "weibull", dataset="cmapss_fd001", provenance=PROV_SIMULATED, target="durée de vie", unit="cycle",
                     hyperparams={"estimation": "MLE censure à droite", "IC": "Fisher observée, 90 %"}, split={"n": len(lt)},
                     validation_rule="≥ 2 défaillances ; convergence ; IC fini")
    with Timer() as tt:
        wb = _weibull_block(lt.t.to_numpy(), lt.event.to_numpy(), "cycle", 400)
    if wb["ok"]:
        f = wb.pop("_fit")
        reg.finish(con, mid, valid=bool(np.isfinite(f["beta_ci"][1])), artifact_obj=f, n_train=len(lt), train_time_s=tt.s)
        store("POP:CMAPSS-FD001", "weibull", mid, "beta", f["beta"], "—", ci=f["beta_ci"])
        store("POP:CMAPSS-FD001", "weibull", mid, "eta", f["eta"], "cycle", ci=f["eta_ci"])
        store("POP:CMAPSS-FD001", "weibull", mid, "MTTF", f["mttf"], "cycle")
        lo, hi = W.R_ci(np.array(HORIZONS, float), f)
        wb["horizons"] = []
        for k, h in enumerate(HORIZONS):
            r = float(W.R(h, f["beta"], f["eta"]))
            store("POP:CMAPSS-FD001", "weibull", mid, "R(t)", r, "probabilité", t=h, ci=(float(lo[k]), float(hi[k])))
            wb["horizons"].append({"t": h, "R": r, "F": 1 - r, "h": float(W.hazard(h, f["beta"], f["eta"])), "R_lo": float(lo[k]), "R_hi": float(hi[k])})
    else:
        reg.update(con, mid, status="attente_donnees", message=wb["reason"])

    # ---------------- Partie A bis : Weibull batteries Li-ion (expérimental, effectif faible)
    bt = _lifetimes(con, "BAT-%")
    mid_b = reg.create(con, "fiabilite", "weibull_batterie", dataset="battery_nasa_pcoe", provenance=PROV_EXPERIMENTAL, target="durée de vie", unit="décharge",
                       hyperparams={"critère": "C < 1,4 Ah (médiane glissante 3)"}, split={"n": len(bt)}, validation_rule="≥ 2 défaillances")
    wbb = _weibull_block(bt.t.to_numpy(), bt.event.to_numpy(), "décharge", 250) if len(bt) else {"ok": False, "reason": "aucune cellule retenue"}
    if wbb["ok"]:
        f = wbb.pop("_fit")
        reg.finish(con, mid_b, valid=False, artifact_obj=f, n_train=len(bt),
                   message=f"Ajusté sur {f['failures']} défaillance(s) / {f['n']} cellules : IC larges, résultat indicatif (non validé).")
        for q, v, u, ci in (("beta", f["beta"], "—", f["beta_ci"]), ("eta", f["eta"], "décharge", f["eta_ci"])):
            store("POP:BAT", "weibull", mid_b, q, v, u, ci=ci, prov=PROV_EXPERIMENTAL)
            store("ROVER-battery", "weibull", mid_b, q, v, u, ci=ci, prov=PROV_SUBSTITUTED, val={"transfert": "non validé"})
        wbb["cells"] = bt.to_dict("records")
    else:
        reg.update(con, mid_b, status="attente_donnees", message=wbb["reason"])

    # ---------------- Partie B : RSF vs Weibull (sans / avec covariables) — C-MAPSS FD001..FD004
    op = pd.DataFrame(db.rows(con, """SELECT o.equipment_id, o.conditions, f.t_event AS t, f.event FROM operating_history o
                                       JOIN failure_history f ON f.equipment_id = o.equipment_id WHERE o.equipment_id LIKE 'CMAPSS-%'"""))
    cov = pd.json_normalize(op.conditions.map(json.loads))
    X = pd.concat([cov[[f"early_means.{c}" for c in ["op1", "op2", "op3"] + CMAPSS_SENSORS]].set_axis(["op1", "op2", "op3"] + CMAPSS_SENSORS, axis=1),
                   cov[["n_conditions", "n_fault_modes"]]], axis=1)
    t, e = op.t.to_numpy(float), op.event.to_numpy(bool)
    rng = np.random.default_rng(SEED)
    idx = rng.permutation(len(op))
    ntr = int(0.7 * len(op))
    tr, te = idx[:ntr], idx[ntr:]
    y_tr, y_te = Surv.from_arrays(e[tr], t[tr]), Surv.from_arrays(e[te], t[te])
    grid = np.quantile(t[te][e[te]], np.linspace(0.1, 0.8, 30))
    grid = grid[(grid > t[tr].min()) & (grid < t[tr].max())]
    surv_models, comp = {}, {}

    # Weibull sans covariable
    mid_w = reg.create(con, "fiabilite", "weibull_population", dataset="cmapss_fd001-fd004", provenance=PROV_SIMULATED, target="S(t)", unit="cycle",
                       split={"train": int(len(tr)), "test": int(len(te)), "censure_test": float(1 - e[te].mean())}, validation_rule="IBS < IBS de Kaplan–Meier + 0,01")
    with Timer() as tt:
        fw = W.fit(t[tr], e[tr].astype(float))
    S_w = np.tile(W.R(grid, fw["beta"], fw["eta"]), (len(te), 1))
    # Weibull AFT (lifelines)
    mid_a = reg.create(con, "fiabilite", "weibull_aft", dataset="cmapss_fd001-fd004", provenance=PROV_SIMULATED, target="S(t|X)", unit="cycle",
                       hyperparams={"penalizer": 0.01}, features=list(X.columns), split={"train": int(len(tr)), "test": int(len(te))},
                       validation_rule="C-index test > 0,5")
    Xs = (X - X.iloc[tr].mean()) / X.iloc[tr].std().replace(0, 1)
    with Timer() as tta:
        aft = WeibullAFTFitter(penalizer=0.01).fit(pd.concat([Xs.iloc[tr].reset_index(drop=True), pd.DataFrame({"T": t[tr], "E": e[tr]})], axis=1), "T", "E")
    S_a = aft.predict_survival_function(Xs.iloc[te], times=grid).T.to_numpy()
    # RSF
    mid_r = reg.create(con, "fiabilite", "random_survival_forest", dataset="cmapss_fd001-fd004", provenance=PROV_SIMULATED, target="S(t|X)", unit="cycle",
                       hyperparams={"n_estimators": 300, "min_samples_leaf": 10, "max_features": "sqrt"}, features=list(X.columns),
                       split={"train": int(len(tr)), "test": int(len(te))}, validation_rule="C-index test > 0,5 et IBS < IBS Weibull")
    with Timer() as ttr:
        rsf = RandomSurvivalForest(n_estimators=300, min_samples_leaf=10, max_features="sqrt", random_state=SEED, n_jobs=2).fit(X.iloc[tr], y_tr)
    with Timer() as tpr:
        sf = rsf.predict_survival_function(X.iloc[te])
    S_r = np.vstack([fn(grid) for fn in sf])
    # Kaplan–Meier (référence non informative)
    km = W.kaplan_meier(t[tr], e[tr])
    km_t = np.array([k[0] for k in km]); km_s = np.array([k[1] for k in km])
    S_km = np.tile([km_s[km_t <= g][-1] if np.any(km_t <= g) else 1.0 for g in grid], (len(te), 1))
    # IPCW : les temps de test doivent rester sous le plus grand temps d'apprentissage (estimateur de censure défini)
    okm = t[te] < t[tr].max()
    y_te_b = Surv.from_arrays(e[te][okm], t[te][okm])
    ibs = lambda S: float(integrated_brier_score(y_tr, y_te_b, S[okm], grid))
    ibs_km = ibs(S_km)

    def cidx(risk):
        return float(concordance_index_censored(e[te], t[te], risk)[0])

    risks = {
        "weibull_population": np.zeros(len(te)),
        "weibull_aft": -aft.predict_median(Xs.iloc[te]).to_numpy().ravel(),
        "random_survival_forest": rsf.predict(X.iloc[te]),
    }
    for name, mid_x, S, ttime in (("weibull_population", mid_w, S_w, tt.s), ("weibull_aft", mid_a, S_a, tta.s), ("random_survival_forest", mid_r, S_r, ttr.s)):
        m = {"c_index": cidx(risks[name]) if name != "weibull_population" else 0.5, "ibs": ibs(S), "ibs_km": ibs_km, "n_test_ibs": int(okm.sum()),
             "train_time_s": ttime, "n_train": int(len(tr)), "n_test": int(len(te)), "censure_test": float(1 - e[te].mean())}
        comp[name] = m
        reg.evaluate(con, mid_x, "test", {k: v for k, v in m.items() if isinstance(v, (int, float))})
    comp["random_survival_forest"]["predict_time_ms_per_obs"] = 1000 * tpr.s / len(te)
    reg.finish(con, mid_w, valid=comp["weibull_population"]["ibs"] < ibs_km + 0.01, artifact_obj=fw, n_train=len(tr), n_test=len(te), train_time_s=tt.s)
    reg.finish(con, mid_a, valid=comp["weibull_aft"]["c_index"] > 0.5, artifact_obj={"model": aft, "mean": X.iloc[tr].mean(), "std": X.iloc[tr].std()},
               n_train=len(tr), n_test=len(te), train_time_s=tta.s)
    rsf_valid = comp["random_survival_forest"]["c_index"] > 0.5 and comp["random_survival_forest"]["ibs"] < comp["weibull_population"]["ibs"]
    reg.finish(con, mid_r, valid=rsf_valid, artifact_obj={"model": rsf, "features": list(X.columns)}, n_train=len(tr), n_test=len(te), train_time_s=ttr.s,
               predict_time_ms=comp["random_survival_forest"]["predict_time_ms_per_obs"])
    for name, mid_x in (("weibull_population", mid_w), ("weibull_aft", mid_a), ("random_survival_forest", mid_r)):
        for q in ("c_index", "ibs"):
            store("POP:CMAPSS", name, mid_x, q, comp[name][q], "—", val={"n_test": int(len(te))})
    # courbes S(t|X) de quelques unités de test (illustration)
    ex_ids = op.equipment_id.iloc[te].to_numpy()
    pick = [i for i in range(len(te))][:: max(1, len(te) // 6)][:6]
    examples = [{"equipment_id": ex_ids[i], "t_obs": float(t[te][i]), "event": bool(e[te][i]), "rsf": np.round(S_r[i], 4).tolist(),
                 "aft": np.round(S_a[i], 4).tolist()} for i in pick]
    # importance par permutation de la RSF (C-index)
    from sklearn.inspection import permutation_importance
    pi = permutation_importance(rsf, X.iloc[te], y_te, n_repeats=8, random_state=SEED, n_jobs=1)
    imp = sorted([{"feature": c, "perm_mean": float(pi.importances_mean[k]), "perm_std": float(pi.importances_std[k])} for k, c in enumerate(X.columns)],
                 key=lambda r: -r["perm_mean"])[:10]
    db.insert_many(con, "reliability_results", res_rows)
    con.commit()
    payload = {"weibull_cmapss": wb, "weibull_battery": wbb, "survival": {"comparison": comp, "grid": np.round(grid, 1).tolist(),
               "weibull_curve": np.round(W.R(grid, fw["beta"], fw["eta"]), 4).tolist(), "examples": examples, "importance": imp,
               "km": [[float(a), float(b)] for a, b in km], "note": "Weibull population : même S(t) pour toutes les unités → C-index = 0,5 par construction."}}
    save_payload(con, "fiabilite", payload)
    return {"weibull_fd001": {k: wb.get(k) for k in ("beta", "eta", "mttf")}, "weibull_battery": {k: wbb.get(k) for k in ("beta", "eta", "failures", "n")},
            "survival": {k: {kk: round(v[kk], 4) for kk in ("c_index", "ibs")} for k, v in comp.items()}, "ibs_km": ibs_km}
