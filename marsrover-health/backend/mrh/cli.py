"""Interface en ligne de commande.

  python -m mrh.cli init                 migrations + chargement des données traitées
  python -m mrh.cli ingest --raw-dir D   (ré)extraction depuis les archives brutes décompressées
  python -m mrh.cli train [module…]      entraînement/validation (anomalies diagnostic fiabilite rul maintenabilite disponibilite securite)
  python -m mrh.cli recommend            génération des recommandations
  python -m mrh.cli export               instantané JSON pour le frontend hors ligne (data/ml_snapshot.js)
  python -m mrh.cli serve [--port 8765]  API REST + fichiers statiques de l'application
  python -m mrh.cli all                  init + train + recommend + export
"""
from __future__ import annotations

import argparse
import json
import time

from . import db

MODULES = ["anomalies", "diagnostic", "fiabilite", "rul", "maintenabilite", "disponibilite", "securite", "references", "defauts"]
SERVICE = {"anomalies": "anomaly", "diagnostic": "diagnosis", "fiabilite": "reliability", "rul": "rul", "maintenabilite": "maintainability",
           "disponibilite": "availability", "securite": "safety", "references": "reference", "defauts": "faults"}


def train(con, mods):
    from .services import jobs
    out = {}
    for m in mods:
        t0 = time.time()
        out[m] = jobs.run_module(con, m)
        print(f"[{m}] {time.time() - t0:.1f} s →", json.dumps(out[m], ensure_ascii=False, default=str)[:600])
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog="mrh")
    ap.add_argument("cmd")
    ap.add_argument("mods", nargs="*")
    ap.add_argument("--raw-dir")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args(argv)
    con = db.connect()
    db.migrate(con)
    from .services import registry
    registry.recover_stale(con)
    if a.cmd == "ingest":
        from .ingest import ingest_all
        print(ingest_all(a.raw_dir))
    if a.cmd in ("init", "all"):
        from .load import load_all
        print(load_all(con))
    if a.cmd in ("train", "all"):
        train(con, a.mods or MODULES)
    if a.cmd in ("recommend", "all"):
        from .services import recommendations
        print("recommandations :", recommendations.generate(con))
    if a.cmd in ("export", "all"):
        from .snapshot import export
        print("instantané :", export(con))
    if a.cmd == "serve":
        from .api import serve
        serve(a.port)


if __name__ == "__main__":
    main()
