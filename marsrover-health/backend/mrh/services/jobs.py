"""Tâches d'entraînement en arrière-plan (une à la fois par module) — le tableau de bord ne déclenche jamais d'entraînement implicite."""
from __future__ import annotations

import importlib
import threading
import traceback

from .. import db

_jobs: dict[str, dict] = {}
_lock = threading.Lock()
SERVICE = {"anomalies": "anomaly", "diagnostic": "diagnosis", "fiabilite": "reliability", "rul": "rul", "maintenabilite": "maintainability",
           "disponibilite": "availability", "securite": "safety", "references": "reference", "defauts": "faults"}


def running_models() -> set:
    return set()  # les identifiants de modèles sont créés dans le service ; un module en cours protège tous ses modèles


def running_modules() -> list[str]:
    with _lock:
        return [m for m, j in _jobs.items() if j["state"] == "en_cours"]


def run_module(con, module: str) -> dict:
    """Exécution synchrone avec capture d'erreur : en cas d'échec, les modèles du module restés « entrainement » passent en « erreur »."""
    svc = importlib.import_module(f"mrh.services.{SERVICE[module]}")
    try:
        res = svc.train(con)
        db.log(con, "train", {"module": module, "result": res})
        return {"ok": True, "result": res}
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        with db._lock:
            con.execute("UPDATE model_registry SET status='erreur', message=? WHERE module=? AND status='entrainement'", (msg, module))
            con.commit()
        db.log(con, "train_error", {"module": module, "error": msg, "trace": traceback.format_exc()[-2000:]})
        return {"ok": False, "error": msg}


def start(module: str, con_factory) -> dict:
    if module not in SERVICE:
        raise KeyError(module)
    with _lock:
        if _jobs.get(module, {}).get("state") == "en_cours":
            return {"module": module, "state": "en_cours", "message": "entraînement déjà en cours"}
        _jobs[module] = {"state": "en_cours", "started_at": db.now()}

    def work():
        con = con_factory()
        res = run_module(con, module)
        if res["ok"]:
            from . import recommendations
            recommendations.generate(con)
        with _lock:
            _jobs[module] = {"state": "termine" if res["ok"] else "erreur", "finished_at": db.now(), **res}

    threading.Thread(target=work, daemon=True).start()
    return {"module": module, "state": "en_cours"}


def status() -> dict:
    with _lock:
        return {k: {kk: vv for kk, vv in v.items() if kk != "result"} for k, v in _jobs.items()}
