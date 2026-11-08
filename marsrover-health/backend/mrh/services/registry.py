"""Registre des modèles : versionnement, statut, artefacts, évaluations, garde-fous de prédiction.

Statuts : non_entraine → attente_donnees | entrainement → entraine → valide | erreur.
Un modèle n'est « valide » que s'il satisfait la règle de validation propre à sa tâche
(ex. RUL : RMSE test < RMSE d'un prédicteur constant ; classification : F1 macro > classe majoritaire).
Les prédictions sont REFUSÉES pour un modèle non entraîné ou en erreur (exception NotTrained).
"""
from __future__ import annotations

import hashlib
import os

import joblib

from .. import db
from ..config import MODELS

STATUS_LABEL = {"non_entraine": "Non entraîné", "attente_donnees": "En attente de données", "entrainement": "En cours d'entraînement",
                "entraine": "Entraîné", "valide": "Validé", "erreur": "Erreur"}


class NotTrained(RuntimeError):
    pass


class InsufficientData(RuntimeError):
    pass


def data_hash(*arrays) -> str:
    h = hashlib.sha256()
    for a in arrays:
        h.update(memoryview(a.tobytes() if hasattr(a, "tobytes") else str(a).encode()))
    return h.hexdigest()[:16]


def next_version(con, module: str, algorithm: str) -> int:
    r = con.execute("SELECT MAX(version) FROM model_registry WHERE module=? AND algorithm=?", (module, algorithm)).fetchone()[0]
    return (r or 0) + 1


def create(con, module: str, algorithm: str, **kw) -> str:
    v = next_version(con, module, algorithm)
    mid = f"{module}:{algorithm}:v{v}"
    row = {"model_id": mid, "module": module, "algorithm": algorithm, "version": v, "status": kw.pop("status", "entrainement"), "created_at": db.now()}
    for k in ("dataset", "provenance", "target", "unit", "validation_rule", "message"):
        row[k] = kw.get(k)
    for k in ("hyperparams", "features", "split"):
        row[k] = db.j(kw.get(k)) if kw.get(k) is not None else None
    db.insert_many(con, "model_registry", [row])
    con.commit()
    return mid


def update(con, mid: str, **kw):
    if not kw:
        return
    sets, vals = [], []
    for k, v in kw.items():
        sets.append(f"{k}=?")
        vals.append(db.j(v) if isinstance(v, (dict, list)) else v)
    with db._lock:
        con.execute(f"UPDATE model_registry SET {','.join(sets)} WHERE model_id=?", (*vals, mid))
        con.commit()


def save_artifact(mid: str, obj) -> str:
    os.makedirs(MODELS, exist_ok=True)
    path = os.path.join(MODELS, mid.replace(":", "__") + ".joblib")
    joblib.dump(obj, path, compress=3)
    return os.path.relpath(path, os.path.dirname(MODELS))


def load_artifact(con, mid: str):
    r = con.execute("SELECT status, artifact FROM model_registry WHERE model_id=?", (mid,)).fetchone()
    if r is None or r["status"] not in ("entraine", "valide") or not r["artifact"]:
        raise NotTrained(f"Modèle {mid} non entraîné (statut : {STATUS_LABEL.get(r['status'], 'inconnu') if r else 'absent'}) — aucune prédiction produite.")
    return joblib.load(os.path.join(os.path.dirname(MODELS), r["artifact"]))


def active(con, module: str, algorithm: str):
    r = con.execute("SELECT * FROM model_registry WHERE module=? AND algorithm=? AND is_active=1", (module, algorithm)).fetchone()
    return dict(r) if r else None


def activate(con, mid: str):
    r = con.execute("SELECT module, algorithm FROM model_registry WHERE model_id=?", (mid,)).fetchone()
    with db._lock:
        con.execute("UPDATE model_registry SET is_active=0 WHERE module=? AND algorithm=?", (r["module"], r["algorithm"]))
        con.execute("UPDATE model_registry SET is_active=1 WHERE model_id=?", (mid,))
        con.commit()


def evaluate(con, mid: str, split: str, metrics: dict):
    rows = [{"model_id": mid, "split": split, "metric": k, "value": None if v is None else float(v), "computed_at": db.now()} for k, v in metrics.items()]
    db.insert_many(con, "model_evaluation", rows)
    con.commit()


def placeholder(con, module: str, algorithm: str, reason: str, needed: str, **kw) -> str:
    """Modèle déclaré mais non entraînable faute de données : statut « attente_donnees », aucune métrique."""
    existing = con.execute("SELECT model_id FROM model_registry WHERE module=? AND algorithm=? AND status='attente_donnees'", (module, algorithm)).fetchone()
    if existing:
        update(con, existing[0], message=f"{reason} Données nécessaires : {needed}")
        return existing[0]
    mid = create(con, module, algorithm, status="attente_donnees", message=f"{reason} Données nécessaires : {needed}", **kw)
    activate(con, mid)
    return mid


def finish(con, mid: str, *, valid: bool, artifact_obj=None, **kw):
    if artifact_obj is not None:
        kw["artifact"] = save_artifact(mid, artifact_obj)
    update(con, mid, status="valide" if valid else "entraine", **kw)
    activate(con, mid)


def fail(con, mid: str, err: Exception):
    update(con, mid, status="erreur", message=f"{type(err).__name__}: {err}")


def recover_stale(con) -> int:
    """Détection des entraînements interrompus : un modèle resté « entrainement » sans tâche active passe en « erreur »."""
    from . import jobs
    live = jobs.running_models()
    stale = [r[0] for r in con.execute("SELECT model_id FROM model_registry WHERE status='entrainement'") if r[0] not in live]
    for mid in stale:
        update(con, mid, status="erreur", message="Entraînement interrompu (processus arrêté avant la fin) — relancer l'entraînement.")
    return len(stale)
