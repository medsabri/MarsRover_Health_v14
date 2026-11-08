"""Instantané en lecture seule pour l'usage hors ligne (file://) : data/ml_snapshot.js.

Contient exactement les réponses de l'API (mêmes fonctions de lecture), figées à la date d'export.
Le frontend l'affiche avec la mention « Instantané exporté le … » ; les actions d'écriture (entraînement,
validation, édition AMDEC/FTA) exigent le backend.
"""
from __future__ import annotations

import os

from . import db, views
from .config import SNAPSHOT_JS


def build(con) -> dict:
    return {
        "generated_at": db.now(), "source": "snapshot",
        "modules": {m: views.module(con, m) for m in views.MODULE_LABEL},
        "models": views.models(con), "comparison": views.comparison(con), "recommendations": views.recommendations(con),
        "equipment": views.equipment(con), "audit": views.audit_summary(con),
    }


def export(con, path: str = SNAPSHOT_JS) -> dict:
    snap = build(con)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    txt = "/* Généré par backend/mrh/snapshot.py — ne pas éditer. */\nwindow.MRH_ML_SNAPSHOT = " + db.j(snap) + ";\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(txt)
    return {"path": os.path.relpath(path), "bytes": len(txt.encode("utf-8"))}
