"""API REST (bibliothèque standard : http.server, aucune dépendance web) + service des fichiers de l'application.

Lecture
  GET  /api/health                         état du service, version du schéma, tâches en cours
  GET  /api/equipment                      liste des équipements (provenance, unité de temps, analogue rover)
  GET  /api/data/audit                     synthèse de la base (effectifs, valeurs manquantes, drapeaux qualité)
  GET  /api/ia/<module>?equipment=&t_from=&t_to=&limit=
                                           module ∈ anomalies | diagnostic | fiabilite | rul | maintenabilite | disponibilite | securite
  GET  /api/models[?module=]               registre des modèles + métriques
  GET  /api/comparison                     comparaison des algorithmes par tâche
  GET  /api/recommendations[?equipment=]   recommandations (traçables)
  GET  /api/export/<module>.csv            export CSV de l'historique du module
  GET  /api/jobs                           état des entraînements en arrière-plan
Écriture (JSON)
  POST /api/models/<module>/train          lance l'entraînement (arrière-plan) → 202
  POST /api/recommendations/<id>/validate  {"decision": "validee|rejetee", "actor": "...", "comment": "..."}
  PUT  /api/fmea/<id>                      {"G":..,"O":..,"D":..,"actor":"..."}  (NPR recalculé par la base)
  POST /api/fta/<event_id>/probability     {"probability": 0.01 | null, "source": "...", "actor": "..."}
  POST /api/maintenance/import             CSV (text/csv) → maintenance_history (provenance obligatoire)
Toute erreur renvoie {"error": message} avec un code HTTP explicite (400, 404, 409, 500).
"""
from __future__ import annotations

import csv
import io
import json
import mimetypes
import os
import re
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import db, views
from .config import APP_ROOT
from .services import jobs, recommendations, safety

MODULES = list(views.MODULE_LABEL)
CON = None


class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


def _csv(rows):
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()), delimiter=";")
        w.writeheader()
        w.writerows(rows)
    return buf.getvalue().encode("utf-8-sig")


class Handler(BaseHTTPRequestHandler):
    server_version = "MRH/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        data = body if isinstance(body, bytes) else db.j(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 5_000_000:
            raise ApiError(413, "corps de requête trop volumineux (> 5 Mo)")
        raw = self.rfile.read(n) if n else b""
        if (self.headers.get("Content-Type") or "").startswith("application/json"):
            try:
                return json.loads(raw or b"{}")
            except ValueError:
                raise ApiError(400, "JSON invalide")
        return raw.decode("utf-8-sig")

    def _dispatch(self, method):
        u = urlparse(self.path)
        path, params = u.path, {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if path.startswith("/api/"):
                # connexion SQLite partagée : les requêtes API concurrentes sont sérialisées
                with db._lock:
                    res = self._api(method, path, params)
                return self._send(*res)
            if method != "GET":
                raise ApiError(405, "méthode non autorisée")
            return self._static(path)
        except ApiError as e:
            self._send(e.code, {"error": str(e)})
        except (ValueError, KeyError) as e:
            self._send(400, {"error": f"requête invalide : {e}"})
        except LookupError as e:
            self._send(404, {"error": str(e)})
        except Exception as e:  # erreur interne : journalisée, message générique côté client
            db.log(CON, "api_error", {"path": path, "error": repr(e), "trace": traceback.format_exc()[-1500:]})
            self._send(500, {"error": "erreur interne (consignée dans audit_log)"})

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    # ------------------------------------------------------------------ routes API
    def _api(self, method, path, params):
        con = CON
        if method == "GET":
            if path == "/api/health":
                mig = [r[0] for r in con.execute("SELECT name FROM schema_migrations ORDER BY name")]
                return 200, {"status": "ok", "migrations": mig, "jobs": jobs.status(), "now": db.now()}
            if path == "/api/equipment":
                return 200, views.equipment(con)
            if path == "/api/data/audit":
                return 200, views.audit_summary(con)
            m = re.fullmatch(r"/api/ia/([a-z]+)", path)
            if m:
                if m.group(1) not in MODULES:
                    raise LookupError(f"module inconnu : {m.group(1)}")
                return 200, views.module(con, m.group(1), params)
            if path == "/api/models":
                return 200, views.models(con, params.get("module"))
            if path == "/api/comparison":
                return 200, views.comparison(con)
            if path == "/api/recommendations":
                return 200, views.recommendations(con, params)
            if path == "/api/jobs":
                return 200, jobs.status()
            m = re.fullmatch(r"/api/export/([a-z]+)\.csv", path)
            if m:
                table = {"anomalies": "anomaly_history", "diagnostic": "diagnosis_results", "fiabilite": "reliability_results", "rul": "rul_predictions",
                         "maintenabilite": "availability_results", "disponibilite": "availability_results", "securite": "fmea", "recommandations": "recommendations",
                         "modeles": "model_registry"}.get(m.group(1))
                if not table:
                    raise LookupError("export inconnu")
                rows = db.rows(con, f"SELECT * FROM {table}")
                return 200, _csv(rows), "text/csv; charset=utf-8", {"Content-Disposition": f'attachment; filename="mrh_{m.group(1)}.csv"'}
            raise LookupError("route inconnue")
        body = self._body()
        m = re.fullmatch(r"/api/models/([a-z]+)/train", path)
        if m and method == "POST":
            if m.group(1) not in jobs.SERVICE:
                raise LookupError("module inconnu")
            return 202, jobs.start(m.group(1), lambda: db.connect())
        m = re.fullmatch(r"/api/recommendations/(\d+)/validate", path)
        if m and method == "POST":
            recommendations.validate(con, int(m.group(1)), body.get("decision"), body.get("actor", ""), body.get("comment"))
            return 200, {"ok": True}
        m = re.fullmatch(r"/api/fmea/([A-Za-z0-9_-]+)", path)
        if m and method == "PUT":
            vals = {k: int(body[k]) for k in ("G", "O", "D") if k in body}
            if not vals or any(not 1 <= v <= 10 for v in vals.values()):
                raise ApiError(400, "G, O, D entiers entre 1 et 10")
            if not (body.get("actor") or "").strip():
                raise ApiError(400, "auteur de la modification obligatoire")
            with db._lock:
                cur = con.execute(f"UPDATE fmea SET {', '.join(f'{k}=?' for k in vals)}, updated_at=?, updated_by=? WHERE fmea_id=?",
                                  (*vals.values(), db.now(), body["actor"].strip(), m.group(1)))
                con.commit()
            if cur.rowcount == 0:
                raise LookupError("mode de défaillance introuvable")
            db.log(con, "fmea_update", {"id": m.group(1), **vals}, body["actor"])
            return 200, db.rows(con, "SELECT * FROM fmea WHERE fmea_id=?", (m.group(1),))[0]
        m = re.fullmatch(r"/api/fta/([A-Za-z0-9_-]+)/probability", path)
        if m and method == "POST":
            p = body.get("probability")
            if not (body.get("source") or "").strip() and p is not None:
                raise ApiError(400, "source de la probabilité obligatoire (traçabilité)")
            safety.set_probability(con, m.group(1), None if p is None else float(p), body.get("source"), body.get("actor") or "analyste")
            return 200, safety.evaluate_tree(safety.tree(con))
        if path == "/api/maintenance/import" and method == "POST":
            return 200, import_maintenance(con, body if isinstance(body, str) else "")
        raise LookupError("route inconnue")

    # ------------------------------------------------------------------ fichiers statiques (application web)
    def _static(self, path):
        rel = path.lstrip("/") or "index.html"
        full = os.path.realpath(os.path.join(APP_ROOT, rel))
        if not full.startswith(os.path.realpath(APP_ROOT) + os.sep) or "/backend/" in full.replace(os.sep, "/") or not os.path.isfile(full):
            return self._send(404, {"error": "introuvable"})
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)


REQUIRED = ["equipment_id", "type", "t_start", "t_end", "provenance"]


def import_maintenance(con, text: str) -> dict:
    """Import d'historique de maintenance réel. Provenance obligatoire ; lignes invalides rejetées (jamais corrigées)."""
    rd = csv.DictReader(io.StringIO(text))
    if not rd.fieldnames or any(c not in rd.fieldnames for c in REQUIRED):
        raise ApiError(400, f"colonnes obligatoires : {', '.join(REQUIRED)}")
    known = {r[0] for r in con.execute("SELECT equipment_id FROM equipment")}
    ok, rejected = [], []
    for i, r in enumerate(rd, start=2):
        try:
            if r["equipment_id"] not in known:
                raise ValueError("équipement inconnu")
            if r["type"] not in ("panne", "planifiee", "preventive", "corrective"):
                raise ValueError("type invalide")
            if r["provenance"] not in ("mission", "experimental", "simulated", "substituted"):
                raise ValueError("provenance invalide")
            ts, te = float(r["t_start"]), (float(r["t_end"]) if r.get("t_end") else None)
            if te is not None and te < ts:
                raise ValueError("t_end < t_start")
            num = lambda k: int(r[k]) if r.get(k) not in (None, "") else None
            ok.append({"equipment_id": r["equipment_id"], "type": r["type"], "t_start": ts, "t_end": te, "unit": r.get("unit") or "h",
                       "failure_type": r.get("failure_type"), "severity": num("severity"), "complexity": num("complexity"),
                       "spare_parts_available": num("spare_parts_available"), "provenance": r["provenance"], "source": "import API"})
        except (ValueError, KeyError) as e:
            rejected.append({"line": i, "error": str(e)})
    db.insert_many(con, "maintenance_history", ok)
    con.commit()
    db.log(con, "maintenance_import", {"inserted": len(ok), "rejected": len(rejected)})
    return {"inserted": len(ok), "rejected": rejected}


def serve(port=8765, host="127.0.0.1"):
    global CON
    CON = db.connect()
    db.migrate(CON)
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"MarsRover Health — API et application : http://{host}:{port}/  (Ctrl+C pour arrêter)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
