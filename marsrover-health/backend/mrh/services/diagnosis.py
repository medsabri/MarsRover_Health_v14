"""MODULE 2 — Diagnostic des défaillances : XGBoost (principal) vs Random Forest vs SVM.

Données : essais de fraisage NASA / UC Berkeley (mesures réelles). 146 passes avec usure en dépouille VB mesurée.
Classes (ISO 3685:1993, critère de durée de vie outil) :
  normal            VB < 0,3 mm
  usure_critique    0,3 ≤ VB < 0,6 mm   (fin de vie atteinte)
  defaut_mecanique  VB ≥ 0,6 mm         (usure sévère)
Variables : 36 caractéristiques (moyenne, écart-type, RMS, crête-à-crête, kurtosis, facteur de crête) des 6 signaux
(courant broche AC/DC, vibrations table/broche, émission acoustique table/broche) + conditions de coupe + temps de coupe.

Normalisation par outil : chaque caractéristique est aussi exprimée en écart à la PREMIÈRE passe du même outil
(référence connue dès la mise en service ; supprime les décalages dus aux conditions de coupe et au matériau).

Validation SANS fuite : les passes d'un même outil (« case ») sont corrélées → découpage par outil.
  * évaluation « hors outil » : validation croisée leave-one-tool-out (16 plis) ; chaque passe est prédite par un
    modèle qui n'a jamais vu son outil → prédictions hors échantillon, matrice de confusion, métriques ;
  * stabilité : F1 macro par pli (moyenne, écart-type) ; modèle final réappris sur les 16 outils.
Les passes sans VB mesurée reçoivent une prédiction (historique de diagnostic) mais n'entrent dans aucune métrique.
Les classes d'exemple « surchauffe, surpression, défaut électrique, défaut capteur, surcharge moteur » ne sont PAS
entraînables : aucun historique étiqueté de ces pannes n'est disponible (cf. payload.missing_classes).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import RandomForestClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import confusion_matrix
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from xgboost import XGBClassifier

from .. import db
from ..config import PROV_EXPERIMENTAL, SEED, VB_CLASSES
from ..ml.common import Timer, cls_metrics, save_payload
from . import registry as reg

LABELS = [c[2] for c in VB_CLASSES]
LABEL_TXT = {c[2]: c[3] for c in VB_CLASSES}


def vb_class(vb):
    for lo, hi, k, _ in VB_CLASSES:
        if lo <= vb < hi:
            return k
    return None


def load(con) -> pd.DataFrame:
    long = pd.read_sql_query("SELECT equipment_id, t, variable, value FROM sensor_data WHERE equipment_id LIKE 'MILL-%'", con)
    w = long.pivot_table(index=["equipment_id", "t"], columns="variable", values="value").reset_index()
    meta = {r["equipment_id"]: __import__("json").loads(r["meta"]) for r in db.rows(con, "SELECT equipment_id, meta FROM equipment WHERE kind='outil_fraisage'")}
    w["case"] = w.equipment_id.map(lambda e: meta[e]["case"])
    w["DOC_mm"] = w.equipment_id.map(lambda e: meta[e]["DOC_mm"])
    w["feed_mm_rev"] = w.equipment_id.map(lambda e: meta[e]["feed_mm_rev"])
    w["material_acier"] = w.equipment_id.map(lambda e: 1 if meta[e]["material"] == "acier" else 0)
    w["time_min"] = w.t
    w = w.sort_values(["case", "t"]).reset_index(drop=True)
    base = [c for c in w.columns if any(c.startswith(p) for p in ("smcAC", "smcDC", "vib_", "AE_"))]
    first = w.groupby("case")[base].transform("first")
    for c in base:
        w["d_" + c] = w[c] - first[c]
    return w


def train(con) -> dict:
    w = load(con)
    base = [c for c in w.columns if c.startswith(("smcAC", "smcDC", "vib_", "AE_"))]
    feats = base + ["d_" + c for c in base] + ["DOC_mm", "feed_mm_rev", "material_acier", "time_min"]
    # smcDC est parfois constant sur une passe (écart-type nul) → kurtosis indéfinie : variable exclue (signalée)
    excluded = [c for c in feats if w.loc[w.VB_mm.notna(), c].isna().any()]
    feats = [c for c in feats if c not in excluded]
    lab = w[w.VB_mm.notna()].copy()
    lab["y"] = lab.VB_mm.map(vb_class)
    lab = lab[lab[feats].notna().all(axis=1)].reset_index(drop=True)
    enc = {k: i for i, k in enumerate(LABELS)}
    y = lab.y.map(enc).to_numpy()
    groups = lab.case.to_numpy()
    n_tools = len(np.unique(groups))
    algos = {
        "xgboost": (lambda: XGBClassifier(n_estimators=300, max_depth=3, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8, reg_lambda=1.0,
                                          objective="multi:softprob", eval_metric="mlogloss", random_state=SEED, n_jobs=2),
                    {"n_estimators": 300, "max_depth": 3, "learning_rate": 0.05, "subsample": 0.8, "colsample_bytree": 0.8}, True),
        "random_forest": (lambda: RandomForestClassifier(n_estimators=400, min_samples_leaf=2, class_weight="balanced", random_state=SEED, n_jobs=2),
                          {"n_estimators": 400, "min_samples_leaf": 2, "class_weight": "balanced"}, False),
        "svm": (lambda: make_pipeline(StandardScaler(), CalibratedClassifierCV(SVC(kernel="rbf", C=10, gamma="scale", class_weight="balanced"), ensemble=False)),
                {"kernel": "rbf", "C": 10, "gamma": "scale", "probabilités": "calibration sigmoïde"}, False),
    }
    def weights(yy):
        return (len(yy) / (3 * np.bincount(yy, minlength=3)))[yy]
    # prédicteur de référence « classe majoritaire » évalué avec le même protocole hors outil
    maj = np.zeros_like(y)
    for a, b in GroupKFold(n_splits=n_tools).split(lab, y, groups):
        maj[b] = np.bincount(y[a]).argmax()
    majority = cls_metrics(y, maj, labels=[0, 1, 2])
    comp, oof_best = {}, {}
    for name, (make, hp, use_sw) in algos.items():
        mid = reg.create(con, "diagnostic", name, dataset="milling_nasa_ucb", provenance=PROV_EXPERIMENTAL, target="classe d'usure (ISO 3685)", unit="classe",
                         hyperparams=hp, features=feats, split={"protocole": f"leave-one-tool-out ({n_tools} plis)", "n": len(lab)},
                         validation_rule="F1 macro hors outil > F1 macro du prédicteur « classe majoritaire » (même protocole)")
        try:
            P = np.zeros((len(lab), 3)); fold_f1 = []
            t_fit = t_pred = 0.0
            for a, b in GroupKFold(n_splits=n_tools).split(lab, y, groups):
                m = make()
                with Timer() as tt:
                    m.fit(lab[feats].iloc[a], y[a], **({"sample_weight": weights(y[a])} if use_sw else {}))
                with Timer() as tp:
                    P[b] = m.predict_proba(lab[feats].iloc[b])
                t_fit += tt.s; t_pred += tp.s
                fold_f1.append(cls_metrics(y[b], P[b].argmax(1), labels=[0, 1, 2])["f1_macro"])
            p = P.argmax(1)
            met = cls_metrics(y, p, labels=[0, 1, 2])
            met["f1_macro_fold_mean"], met["f1_macro_fold_std"] = float(np.mean(fold_f1)), float(np.std(fold_f1))
            met["per_class_f1"] = dict(zip(LABELS, __import__("sklearn.metrics", fromlist=["f1_score"]).f1_score(y, p, labels=[0, 1, 2], average=None, zero_division=0).round(4).tolist()))
            met["train_time_s"], met["predict_time_ms_per_obs"] = t_fit / n_tools, 1000 * t_pred / len(lab)
            cm = confusion_matrix(y, p, labels=[0, 1, 2]).tolist()
            reg.evaluate(con, mid, "test_hors_outil", {k: v for k, v in met.items() if isinstance(v, (int, float))})
            final = make()
            with Timer() as tt:
                final.fit(lab[feats], y, **({"sample_weight": weights(y)} if use_sw else {}))
            valid = met["f1_macro"] > majority["f1_macro"]
            reg.finish(con, mid, valid=valid, artifact_obj={"model": final, "features": feats, "labels": LABELS}, n_train=len(lab), n_test=len(lab),
                       train_time_s=tt.s, predict_time_ms=met["predict_time_ms_per_obs"], data_hash=reg.data_hash(lab[feats].to_numpy()))
            comp[name] = {"model_id": mid, **met, "confusion": cm, "status": "valide" if valid else "entraine"}
            oof_best[name] = (final, mid, P)
        except Exception as e:
            reg.fail(con, mid, e)
            comp[name] = {"model_id": mid, "status": "erreur", "message": str(e)}
    # modèle retenu = meilleur F1 macro hors outil (XGBoost est le candidat principal du cahier des charges,
    # mais le choix final suit uniquement le critère de validation)
    best_by_f1 = max((k for k in comp if "f1_macro" in comp[k]), key=lambda k: comp[k]["f1_macro"])
    principal = best_by_f1
    m, mid, P_oof = oof_best[principal]
    tst, yte = lab, y

    # --------- variables influentes (modèle principal) : gain XGBoost + importance par permutation sur le test

    gain = dict(zip(feats, m.feature_importances_.tolist()))
    perm = permutation_importance(m, tst[feats], yte, n_repeats=20, random_state=SEED, scoring="f1_macro")
    imp = sorted([{"feature": f, "gain": gain[f], "perm_mean": float(perm.importances_mean[i]), "perm_std": float(perm.importances_std[i])}
                  for i, f in enumerate(feats)], key=lambda r: -r["perm_mean"])[:12]

    # --------- historique de diagnostic : toutes les passes (y compris sans VB), avec vérité si mesurée
    con.execute("DELETE FROM diagnosis_results")
    allx = w[w[feats].notna().all(axis=1)]
    P = m.predict_proba(allx[feats])
    oof = {(r.equipment_id, float(r.t)): P_oof[i] for i, r in enumerate(lab.itertuples())}
    top_feats = [r["feature"] for r in imp[:3]]
    rows, now = [], db.now()
    for k, (_, r) in enumerate(allx.iterrows()):
        key = (r.equipment_id, float(r.t))
        pk = oof.get(key, P[k])  # passe étiquetée : prédiction hors outil (honnête) ; sinon modèle final
        ci = int(np.argmax(pk))
        truth = vb_class(r.VB_mm) if pd.notna(r.VB_mm) else None
        rows.append({"equipment_id": r.equipment_id, "computed_at": now, "algorithm": principal, "model_version": mid, "t": float(r.t), "unit": "min",
                     "value": LABELS[ci], "probabilities": db.j(dict(zip(LABELS, np.round(pk, 4).tolist()))), "confidence": float(pk[ci]), "true_label": truth,
                     "contributors": db.j({f: round(float(r[f]), 4) for f in top_feats}),
                     "status": "hors_outil" if key in oof else "sans_verite",
                     "validation": db.j({"VB_mm": None if pd.isna(r.VB_mm) else float(r.VB_mm)}), "provenance": PROV_EXPERIMENTAL})
    db.insert_many(con, "diagnosis_results", rows)
    con.commit()
    payload = {
        "labels": LABELS, "label_text": LABEL_TXT, "comparison": comp, "majority_baseline": majority, "importance": imp,
        "split": {"protocol": f"leave-one-tool-out ({n_tools} outils)", "n_labelled": len(lab), "n_unlabelled": int(w.VB_mm.isna().sum()),
                  "class_counts": lab.y.value_counts().to_dict()}, "principal": principal, "best_by_f1": best_by_f1, "excluded_features": excluded,
        "missing_classes": {
            "classes": ["Surchauffe", "Surpression", "Défaut électrique", "Défaut de capteur", "Surcharge moteur"],
            "needed": "Historique de pannes horodaté et étiqueté par type (≥ 30 occurrences par classe recommandées), aligné sur les mesures capteurs "
                      "(température, pression, courant, tension, vibration) au même pas de temps, avec la cause confirmée par l'intervention.",
        },
        "rule": "Une anomalie (module 1) n'est jamais convertie en panne sans ce modèle de diagnostic ou une règle technique.",
    }
    save_payload(con, "diagnostic", payload)
    return {k: {kk: v.get(kk) for kk in ("accuracy", "f1_macro", "f1_macro_fold_mean", "status")} for k, v in comp.items()}
