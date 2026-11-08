"""MODULE 7 — Sécurité : AMDEC (NPR = G × O × D), arbre de défaillances (FTA) et apprentissage automatique.

AMDEC : table fmea (cotations de démonstration importées de l'application ; éditables et tracées via l'API).
FTA : portes ET / OU, événements de base indépendants (hypothèse explicite) :
    P(ET) = Π p_i           P(OU) = 1 − Π (1 − p_i)
  Si une probabilité de base manque, l'événement parent est « non calculable » ; on fournit alors la borne
  mathématiquement garantie : OU ≥ 1 − Π_connues (1 − p_i), ET ≤ min_connues p_i.
  Coupes minimales par développement descendant (MOCUS) puis absorption.
  Probabilités alimentées par les données quand elles existent : cellule Li-ion = F_Weibull(horizon) du module 3
  (substitution NASA → rover, non validée) ; autres événements : non renseignés (à saisir par l'analyste).
ML : classification des situations à risque (RUL ≤ 30 cycles) sur C-MAPSS FD001 — Random Forest et XGBoost
  (supervisés) comparés à l'Isolation Forest du module 1 (non supervisé) sur le même jeu de test.
AVERTISSEMENT : ces modèles sont une aide à la décision ; ils ne remplacent JAMAIS les fonctions de sécurité,
  les interverrouillages ni les arrêts d'urgence.
"""
from __future__ import annotations

import itertools
import math

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import confusion_matrix, roc_curve
from xgboost import XGBClassifier

from .. import db
from ..config import CMAPSS_SENSOR_INFO, CMAPSS_SENSORS, PROV_SIMULATED, PROV_SUBSTITUTED, RISK_RUL, SEED
from ..ml import weibull as W
from ..ml.common import Timer, cmapss_fd001, det_metrics, save_payload, unit_split
from . import registry as reg
from .rul import windows

DEFAULT_HORIZON = 100  # décharges (horizon de mission pour la batterie, modifiable)


# ------------------------------------------------------------------ FTA
def tree(con, tree_id="FTA-MOBILITE"):
    return db.rows(con, "SELECT * FROM fta_events WHERE tree_id=? ORDER BY rowid", (tree_id,))


def evaluate_tree(nodes: list[dict]) -> dict:
    by = {n["event_id"]: dict(n) for n in nodes}
    kids = {k: [n["event_id"] for n in nodes if n["parent_id"] == k] for k in by}

    def ev(k):
        n = by[k]
        if n["kind"] == "basic":
            p = n["probability"]
            n["p"], n["bound"] = p, None
            return p, (p, p) if p is not None else (0.0, 1.0)
        res = [ev(c) for c in kids[k]]
        ps = [r[0] for r in res]
        lo = [r[1][0] for r in res]; hi = [r[1][1] for r in res]
        if n["gate"] == "AND":
            p = math.prod(ps) if all(x is not None for x in ps) else None
            b = (math.prod(lo), math.prod(hi))
        else:
            p = 1 - math.prod(1 - x for x in ps) if all(x is not None for x in ps) else None
            b = (1 - math.prod(1 - x for x in lo), 1 - math.prod(1 - x for x in hi))
        n["p"], n["bound"] = p, None if p is not None else [b[0], b[1]]
        return p, b

    top = next(k for k, n in by.items() if n["kind"] == "top")
    ev(top)
    return {"nodes": list(by.values()), "top": by[top], "cut_sets": minimal_cut_sets(by, kids, top)}


def minimal_cut_sets(by, kids, top):
    def expand(k):
        n = by[k]
        if n["kind"] == "basic":
            return [frozenset([k])]
        sub = [expand(c) for c in kids[k]]
        if n["gate"] == "OR":
            return [s for ss in sub for s in ss]
        return [frozenset().union(*combo) for combo in itertools.product(*sub)]
    cs = set(expand(top))
    mins = [s for s in cs if not any(o < s for o in cs)]
    return sorted([sorted(s) for s in mins], key=lambda s: (len(s), s))


def set_probability(con, event_id, p, source, actor="analyste"):
    if p is not None and not (0 <= p <= 1):
        raise ValueError("probabilité hors de [0, 1]")
    with db._lock:
        con.execute("UPDATE fta_events SET probability=?, prob_source=? WHERE event_id=? AND kind='basic'", (p, source, event_id))
        con.commit()
    db.log(con, "fta_set_probability", {"event_id": event_id, "p": p, "source": source}, actor)


# ------------------------------------------------------------------ AMDEC
def fmea_payload(con):
    rows = db.rows(con, "SELECT f.*, e.name AS equipment_name FROM fmea f LEFT JOIN equipment e ON e.equipment_id=f.equipment_id ORDER BY NPR DESC")
    matrix = {}
    for r in rows:
        matrix.setdefault(f"{r['G']}-{r['O']}", []).append(r["fmea_id"])
    return {"rows": rows, "matrix": matrix, "thresholds": {"NPR_eleve": 100, "NPR_critique": 150}}


# ------------------------------------------------------------------ entraînement
def train(con) -> dict:
    # --- probabilités FTA alimentées par les données (batterie, substitution)
    wb = reg.active(con, "fiabilite", "weibull_batterie")
    fta_note = None
    if wb and wb["status"] in ("entraine", "valide"):
        f = reg.load_artifact(con, wb["model_id"])
        p = float(W.F(DEFAULT_HORIZON, f["beta"], f["eta"]))
        for e in ("B_CELL1", "B_CELL2"):
            set_probability(con, e, p, f"F_Weibull({DEFAULT_HORIZON} décharges) — cellules NASA, β={f['beta']:.2f}, η={f['eta']:.0f} ; substitution non validée", "système")
        with db._lock:
            con.execute("UPDATE fta_events SET horizon=? WHERE tree_id='FTA-MOBILITE'", (f"{DEFAULT_HORIZON} décharges",))
            con.commit()
    else:
        fta_note = "Weibull batterie indisponible : probabilités des cellules non renseignées."
    fta = evaluate_tree(tree(con))

    # --- ML : situations à risque (RUL ≤ 30)
    df = cmapss_fd001(con)
    tr_all = df[df.split == "train"]
    fit_u, val_u = unit_split(tr_all.equipment_id.unique())
    lo = tr_all[tr_all.equipment_id.isin(fit_u)][CMAPSS_SENSORS].min().to_numpy()
    hi = tr_all[tr_all.equipment_id.isin(fit_u)][CMAPSS_SENSORS].max().to_numpy()
    hi = np.where(hi > lo, hi, lo + 1)
    _, F_tr, K_tr = windows(tr_all[tr_all.equipment_id.isin(fit_u)], lo, hi)
    _, F_va, K_va = windows(tr_all[tr_all.equipment_id.isin(val_u)], lo, hi)
    _, F_te, K_te = windows(df[df.split == "test"], lo, hi)
    y_tr, y_va, y_te = (K_tr.rul <= RISK_RUL).astype(int).to_numpy(), (K_va.rul <= RISK_RUL).astype(int).to_numpy(), (K_te.rul <= RISK_RUL).astype(int).to_numpy()
    names = [f"{a}:{s}" for a in ("dernier", "moyenne", "écart-type", "pente") for s in CMAPSS_SENSORS] + ["cycle"]
    algos = {
        "random_forest": (lambda: RandomForestClassifier(n_estimators=300, min_samples_leaf=5, class_weight="balanced", random_state=SEED, n_jobs=2), {"n_estimators": 300}),
        "xgboost": (lambda: XGBClassifier(n_estimators=400, max_depth=4, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8,
                                          scale_pos_weight=float((y_tr == 0).sum() / max(1, (y_tr == 1).sum())), random_state=SEED, n_jobs=2), {"n_estimators": 400, "max_depth": 4}),
    }
    comp, imps, roc = {}, {}, {}
    for name, (make, hp) in algos.items():
        mid = reg.create(con, "securite", name, dataset="cmapss_fd001", provenance=PROV_SIMULATED, target=f"situation à risque (RUL ≤ {RISK_RUL})", unit="classe",
                         hyperparams=hp, features=names, split={"train": f"{len(fit_u)} unités", "validation": f"{len(val_u)} unités (seuil F1)", "test": "100 unités NASA"},
                         validation_rule="F1 test > F1 du classifieur « toujours à risque »")
        try:
            with Timer() as tt:
                m = make().fit(F_tr, y_tr)
            pv = m.predict_proba(F_va)[:, 1]
            grid = np.linspace(0.05, 0.95, 19)
            thr = float(grid[np.argmax([det_metrics(y_va, (pv >= g).astype(int), pv)["f1"] for g in grid])])  # seuil choisi sur la validation
            with Timer() as tp:
                pt = m.predict_proba(F_te)[:, 1]
            met = det_metrics(y_te, (pt >= thr).astype(int), pt)
            met.update(threshold=thr, train_time_s=tt.s, predict_time_ms_per_obs=1000 * tp.s / len(F_te))
            met["confusion"] = confusion_matrix(y_te, (pt >= thr).astype(int)).tolist()
            always = det_metrics(y_te, np.ones_like(y_te), np.ones(len(y_te)))
            valid = met["f1"] > always["f1"]
            reg.evaluate(con, mid, "test", {k: v for k, v in met.items() if isinstance(v, (int, float))})
            reg.finish(con, mid, valid=valid, artifact_obj={"model": m, "threshold": thr, "lo": lo, "hi": hi}, n_train=len(F_tr), n_val=len(F_va),
                       n_test=len(F_te), train_time_s=tt.s, predict_time_ms=met["predict_time_ms_per_obs"])
            comp[name] = {"model_id": mid, **met, "status": "valide" if valid else "entraine", "baseline_always_risk_f1": always["f1"]}
            fpr, tpr, _ = roc_curve(y_te, pt)
            k = np.linspace(0, len(fpr) - 1, min(60, len(fpr))).astype(int)
            roc[name] = {"fpr": np.round(fpr[k], 4).tolist(), "tpr": np.round(tpr[k], 4).tolist()}
            imps[name] = sorted(zip(names, m.feature_importances_.tolist()), key=lambda r: -r[1])[:10]
            if name == "xgboost":
                K_te = K_te.assign(p_risk=pt, thr=thr)
        except Exception as e:
            reg.fail(con, mid, e)
            comp[name] = {"model_id": mid, "status": "erreur", "message": str(e)}
    # Isolation Forest (module 1) sur le même jeu, à titre de comparaison non supervisée
    iso = reg.active(con, "anomalies", "isolation_forest")
    if iso:
        art = reg.load_artifact(con, iso["model_id"])
        from ..ml.common import rolling_mean
        te = rolling_mean(df[df.split == "test"], CMAPSS_SENSORS)
        te = te.merge(K_te[["equipment_id", "cycle"]], on=["equipment_id", "cycle"])
        s = -art["model"].score_samples(art["scaler"].transform(te[CMAPSS_SENSORS]))
        yy = (te.rul <= RISK_RUL).astype(int).to_numpy()
        comp["isolation_forest"] = {"model_id": iso["model_id"], **det_metrics(yy, (s > art["threshold"]).astype(int), s), "status": iso["status"],
                                    "note": "non supervisé, seuil du module 1 (aucune étiquette de risque utilisée)"}
        fpr, tpr, _ = roc_curve(yy, s)
        k = np.linspace(0, len(fpr) - 1, min(60, len(fpr))).astype(int)
        roc["isolation_forest"] = {"fpr": np.round(fpr[k], 4).tolist(), "tpr": np.round(tpr[k], 4).tolist()}
    last = K_te[K_te.cycle == K_te.last_cycle] if "p_risk" in K_te else K_te.iloc[:0]
    alerts = [{"equipment_id": r.equipment_id, "cycle": int(r.cycle), "p_risk": round(float(r.p_risk), 3), "true_rul": float(r.rul)} for r in last.itertuples()
              if r.p_risk >= r.thr]
    payload = {"fmea": fmea_payload(con), "fta": fta, "fta_note": fta_note, "horizon": DEFAULT_HORIZON, "ml": {"comparison": comp, "roc": roc, "importance": imps,
               "alerts": sorted(alerts, key=lambda a: -a["p_risk"]), "risk_def": f"RUL ≤ {RISK_RUL} cycles"},
               "disclaimer": "Le Machine Learning ne remplace jamais les dispositifs de sécurité fonctionnelle, les interverrouillages ni les arrêts d'urgence."}
    save_payload(con, "securite", payload)
    return {"fta_top": fta["top"]["p"], "fta_top_bound": fta["top"]["bound"], "cut_sets": len(fta["cut_sets"]),
            "ml": {k: {kk: v.get(kk) for kk in ("f1", "auc_roc", "status")} for k, v in comp.items()}, "alerts": len(alerts)}
