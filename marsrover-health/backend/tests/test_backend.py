"""Tests unitaires et fonctionnels du backend (unittest, bibliothèque standard).

Les jeux SYNTHÉTIQUES utilisés ici sont générés en mémoire, explicitement nommés « synthétique », et ne sont
JAMAIS écrits dans la base de production : les tests d'écriture travaillent sur une copie temporaire.
Lancement : cd backend && python -m unittest discover -s tests -v
"""
import json
import math
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
_tmp = tempfile.mkdtemp(prefix="mrh_test_")
_src = os.path.join(os.path.dirname(HERE), "data", "mrh.sqlite")
TEST_DB = os.path.join(_tmp, "mrh_test.sqlite")
shutil.copy(_src, TEST_DB)
os.environ["MRH_DB"] = TEST_DB  # avant tout import de mrh.config

from mrh import db  # noqa: E402
from mrh.ml import weibull as W  # noqa: E402
from mrh.ml.common import det_metrics, reg_metrics  # noqa: E402
from mrh.ml.lstm import LSTMRegressor  # noqa: E402
from mrh.services import availability, maintainability, registry, safety  # noqa: E402


class TestFormulesFMDS(unittest.TestCase):
    def test_indicateurs_exemple_connu(self):
        # 2 pannes (2 h et 4 h), 1 arrêt planifié (10 h) sur W = 1000 h
        ev = pd.DataFrame([{"type": "panne", "t_start": 100, "t_end": 102}, {"type": "panne", "t_start": 500, "t_end": 504},
                           {"type": "planifiee", "t_start": 700, "t_end": 710}])
        r = availability.indicators(ev, 1000.0)
        U = 1000 - 6 - 10
        self.assertAlmostEqual(r["uptime_h"], U)
        self.assertAlmostEqual(r["MTBF_h"], U / 2)
        self.assertAlmostEqual(r["MTTR_h"], 3.0)
        self.assertAlmostEqual(r["Ai"], (U / 2) / (U / 2 + 3))
        self.assertAlmostEqual(r["Ao"], U / 1000)
        self.assertGreater(r["Ai"], r["Ao"])  # Ai ignore les arrêts planifiés

    def test_mttr_exclut_reparations_non_terminees(self):
        ev = pd.DataFrame([{"type": "panne", "t_start": 0, "t_end": 2}, {"type": "panne", "t_start": 10, "t_end": None}])
        r = availability.indicators(ev, 100.0)
        self.assertEqual(r["failures"], 2)
        self.assertAlmostEqual(r["MTTR_h"], 2.0)  # 1 seule réparation terminée

    def test_aucune_panne_mtbf_non_calculable(self):
        r = availability.indicators(pd.DataFrame([{"type": "planifiee", "t_start": 0, "t_end": 5}]), 100.0)
        self.assertIsNone(r["MTBF_h"])
        self.assertIsNone(r["Ai"])

    def test_coherence_avec_frontend_existant(self):
        # Valeurs du calculateur rover (journal simulé) : MTBF = 597 h, MTTR = 1,4 h (identiques à src/ml/fmds.js)
        con = db.connect()
        ev = pd.DataFrame(db.rows(con, "SELECT * FROM maintenance_history WHERE equipment_id='ROVER-computer' AND source LIKE 'rover_events_sim%'"))
        r = availability.indicators(ev, 2998.0)
        self.assertAlmostEqual(r["MTBF_h"], 597.0, places=6)
        self.assertAlmostEqual(r["MTTR_h"], 1.4, places=6)


class TestWeibull(unittest.TestCase):
    def test_formules(self):
        b, e = 2.0, 100.0
        self.assertAlmostEqual(float(W.R(100, b, e)), math.exp(-1))
        self.assertAlmostEqual(float(W.F(50, b, e)), 1 - math.exp(-0.25))
        self.assertAlmostEqual(float(W.hazard(50, b, e)), (2 / 100) * 0.5)

    def test_mle_recupere_parametres_synthetique(self):
        rng = np.random.default_rng(1)  # données SYNTHÉTIQUES (β = 2,5 ; η = 1000) avec censure de type I à 1200
        t = 1000 * rng.weibull(2.5, 3000)
        d = (t < 1200).astype(float)
        t = np.minimum(t, 1200)
        f = W.fit(t, d)
        self.assertAlmostEqual(f["beta"], 2.5, delta=0.12)
        self.assertAlmostEqual(f["eta"], 1000, delta=20)
        self.assertLess(f["beta_ci"][0], 2.5)
        self.assertGreater(f["beta_ci"][1], 2.5)

    def test_accord_lifelines(self):
        from lifelines import WeibullFitter
        rng = np.random.default_rng(3)
        t = 50 * rng.weibull(1.7, 80) + 1
        d = (rng.random(80) > 0.3).astype(float)
        f = W.fit(t, d)
        wf = WeibullFitter().fit(t, d)
        self.assertAlmostEqual(f["beta"], wf.rho_, delta=1e-3)
        self.assertAlmostEqual(f["eta"], wf.lambda_, delta=1e-2)

    def test_refus_si_moins_de_deux_defaillances(self):
        self.assertFalse(W.fit([10, 20, 30], [1, 0, 0])["ok"])


class TestLSTM(unittest.TestCase):
    def test_gradient_differences_finies(self):
        rng = np.random.default_rng(0)
        X, y = rng.normal(size=(4, 5, 3)), rng.normal(size=4)
        m = LSTMRegressor(3, hidden=4, dense=3, seed=1)
        _, g = m.loss_and_grads(X, y)
        for k, v in m.p.items():
            idx = tuple(rng.integers(0, s) for s in v.shape)
            o = v[idx]
            v[idx] = o + 1e-6; lp, _ = m.loss_and_grads(X, y)
            v[idx] = o - 1e-6; lm, _ = m.loss_and_grads(X, y)
            v[idx] = o
            num = (lp - lm) / 2e-6
            self.assertLess(abs(num - g[k][idx]) / max(1e-8, abs(num) + abs(g[k][idx])), 1e-4, k)

    def test_apprend_une_tendance(self):
        rng = np.random.default_rng(2)  # tâche SYNTHÉTIQUE : prédire la pente d'une séquence bruitée
        s = rng.uniform(-1, 1, 600)
        X = (s[:, None] * np.linspace(0, 1, 10)[None, :])[:, :, None] + 0.02 * rng.normal(size=(600, 10, 1))
        m = LSTMRegressor(1, hidden=8, dense=4, lr=1e-2, seed=0).fit(X[:500], s[:500], X[500:], s[500:], epochs=40, batch=50, patience=10)
        self.assertLess(m.best_val_mse, 0.1 * np.var(s))


class TestMetriques(unittest.TestCase):
    def test_regression(self):
        m = reg_metrics([10, 20, 30], [12, 18, 30])
        self.assertAlmostEqual(m["MAE"], 4 / 3)
        self.assertAlmostEqual(m["RMSE"], math.sqrt(8 / 3))
        self.assertAlmostEqual(m["R2"], 1 - 8 / 200)

    def test_detection(self):
        m = det_metrics([0, 0, 1, 1], [0, 1, 1, 0], [0.1, 0.6, 0.9, 0.4])
        self.assertAlmostEqual(m["precision"], 0.5)
        self.assertAlmostEqual(m["recall"], 0.5)
        self.assertAlmostEqual(m["auc_roc"], 0.75)


class TestFTA(unittest.TestCase):
    def nodes(self, pa, pb, pc):
        return [{"event_id": "T", "kind": "top", "gate": "OR", "parent_id": None, "probability": None},
                {"event_id": "G", "kind": "intermediate", "gate": "AND", "parent_id": "T", "probability": None},
                {"event_id": "A", "kind": "basic", "gate": None, "parent_id": "G", "probability": pa},
                {"event_id": "B", "kind": "basic", "gate": None, "parent_id": "G", "probability": pb},
                {"event_id": "C", "kind": "basic", "gate": None, "parent_id": "T", "probability": pc}]

    def test_portes_et_ou(self):
        r = safety.evaluate_tree(self.nodes(0.1, 0.2, 0.05))
        self.assertAlmostEqual(r["top"]["p"], 1 - (1 - 0.02) * (1 - 0.05))
        self.assertEqual(r["cut_sets"], [["C"], ["A", "B"]])

    def test_probabilite_manquante_donne_borne(self):
        r = safety.evaluate_tree(self.nodes(0.1, None, 0.05))
        self.assertIsNone(r["top"]["p"])
        lo, hi = r["top"]["bound"]
        self.assertAlmostEqual(lo, 0.05)          # OU ≥ probabilité connue
        self.assertAlmostEqual(hi, 1 - 0.9 * 0.95)  # ET ≤ min des connues


class TestGardeFous(unittest.TestCase):
    def setUp(self):
        self.con = db.connect()

    def test_pas_de_prediction_si_non_entraine(self):
        mid = registry.active(self.con, "maintenabilite", "xgboost")["model_id"]
        with self.assertRaises(registry.NotTrained):
            registry.load_artifact(self.con, mid)

    def test_modeles_en_attente_sans_metrique(self):
        for r in db.rows(self.con, "SELECT model_id FROM model_registry WHERE status='attente_donnees'"):
            n = self.con.execute("SELECT COUNT(*) FROM model_evaluation WHERE model_id=?", (r["model_id"],)).fetchone()[0]
            self.assertEqual(n, 0, r["model_id"])

    def test_modeles_entraines_rechargeables_et_predictions_valides(self):
        art = registry.load_artifact(self.con, registry.active(self.con, "diagnostic", "random_forest")["model_id"])
        X = np.zeros((2, len(art["features"])))
        p = art["model"].predict_proba(X)
        np.testing.assert_allclose(p.sum(1), 1, atol=1e-6)
        iso = registry.load_artifact(self.con, registry.active(self.con, "anomalies", "isolation_forest")["model_id"])
        self.assertTrue(np.isfinite(iso["threshold"]))

    def test_pipeline_regression_mttr_synthetique(self):
        rng = np.random.default_rng(5)  # 60 réparations SYNTHÉTIQUES (test uniquement, jamais en base)
        n = 60
        df = pd.DataFrame({"equipment_id": rng.choice(["E1", "E2", "E3"], n), "failure_type": rng.choice(["meca", "elec"], n),
                           "severity": rng.integers(1, 6, n), "complexity": rng.integers(1, 6, n), "spare_parts_available": rng.integers(0, 2, n),
                           "t_start": np.sort(rng.uniform(0, 5000, n))})
        df["t_end"] = df.t_start + 1 + 2 * df.complexity + 3 * (1 - df.spare_parts_available) + rng.normal(0, 0.5, n)
        X, y, order = maintainability.prepare(df)
        res = maintainability.fit_models(X, y, order)
        self.assertEqual(set(res), {"regression_lineaire", "random_forest", "xgboost"})
        self.assertGreater(res["regression_lineaire"]["R2"], 0.8)
        self.assertEqual(res["xgboost"]["n_test"], 12)  # 20 % les plus récents


class TestJeuxReference(unittest.TestCase):
    def test_femto_17_durees_de_vie_observees(self):
        con = db.connect()
        r = con.execute("SELECT COUNT(*), SUM(event), MIN(t_event), MAX(t_event) FROM failure_history WHERE equipment_id LIKE 'FEMTO-%'").fetchone()
        self.assertEqual((r[0], r[1]), (17, 17))
        self.assertAlmostEqual(r[3] / 3600, 7.786, delta=0.01)  # Bearing1_1 : 2 803 instantanés × 10 s

    def test_hirf_53_essais_4_packs_et_resistance_coherente(self):
        con = db.connect()
        n = con.execute("SELECT COUNT(DISTINCT t) FROM sensor_data WHERE equipment_id='HIRF-LLF20' AND variable='R_ohm'").fetchone()[0]
        self.assertEqual(n, 53)
        med = {e: con.execute("SELECT AVG(value) FROM sensor_data WHERE equipment_id=? AND variable='R_ohm'", (e,)).fetchone()[0] for e in ("HIRF-LLF20", "HIRF-LRF40")}
        self.assertTrue(1.5 < med["HIRF-LRF40"] / med["HIRF-LLF20"] < 2.6)  # pack « 40 V » ≈ 2 × éléments en série

    def test_reference_rul_non_valide_si_moins_bon_que_weibull(self):
        con = db.connect()
        regs = {r["algorithm"]: r for r in db.rows(con, "SELECT * FROM model_registry WHERE module='rul' AND is_active=1")}
        ev = lambda a: con.execute("SELECT value FROM model_evaluation WHERE model_id=? AND metric='MAE'", (regs[a]["model_id"],)).fetchone()[0]
        for a in ("xgboost_femto", "random_forest_femto"):
            self.assertEqual(regs[a]["status"] == "valide", ev(a) < ev("weibull_mrl_femto"))


class TestDefauts(unittest.TestCase):
    def test_regles_detectent_les_episodes_injectes(self):
        import json as _j
        P = _j.loads(db.connect().execute("SELECT payload FROM module_payload WHERE module='defauts'").fetchone()[0])
        self.assertEqual(set(P["classes"]), {"surchauffe", "surpression", "defaut_electrique", "defaut_capteur", "surcharge_moteur"})
        for k in ("surchauffe", "defaut_electrique", "defaut_capteur"):
            self.assertEqual(P["rover_eval"][k]["rappel_episodes"], 1.0, k)
        self.assertTrue(all(e["provenance"] in ("experimental", "simulated") for e in P["events"]))

    def test_regle_valeur_figee(self):
        from mrh.services.faults import _persist, _episodes
        self.assertEqual(_persist(np.array([0, 1, 1, 1, 0, 1], bool), 3).tolist(), [False, True, True, True, False, False])
        self.assertEqual(_episodes(np.array([0, 1, 1, 0, 1], bool)), [(1, 2), (4, 4)])


class TestAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer
        from mrh import api
        api.CON = db.connect()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), api.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def call(self, path, method="GET", body=None, ctype="application/json"):
        data = None if body is None else (json.dumps(body).encode() if ctype == "application/json" else body.encode())
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": ctype})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def test_sante_et_modules(self):
        self.assertEqual(self.call("/api/health")[0], 200)
        for m in ("anomalies", "diagnostic", "fiabilite", "rul", "maintenabilite", "disponibilite", "securite"):
            code, d = self.call(f"/api/ia/{m}")
            self.assertEqual(code, 200, m)
            self.assertIsNotNone(d["computed_at"], m)

    def test_filtres(self):
        _, d = self.call("/api/ia/anomalies?equipment=IGBT-DC-01")
        self.assertTrue(all(r["equipment_id"] == "IGBT-DC-01" for r in d["history"]))
        _, d = self.call("/api/ia/diagnostic?equipment=MILL-C01&t_from=10&t_to=20")
        self.assertTrue(all(10 <= r["t"] <= 20 for r in d["history"]))

    def test_erreurs(self):
        self.assertEqual(self.call("/api/ia/inconnu")[0], 404)
        self.assertEqual(self.call("/api/fmea/FM01", "PUT", {"G": 12, "actor": "x"})[0], 400)
        self.assertEqual(self.call("/api/recommendations/1/validate", "POST", {"decision": "validee"})[0], 400)
        self.assertEqual(self.call("/backend/data/mrh.sqlite")[0], 404)

    def test_persistance_amdec_et_validation(self):
        code, r = self.call("/api/fmea/FM03", "PUT", {"G": 7, "O": 5, "D": 3, "actor": "test"})
        self.assertEqual(code, 200)
        self.assertEqual(r["NPR"], 105)  # recalculé par la base (colonne générée)
        rid = db.rows(db.connect(), "SELECT id FROM recommendations WHERE status='a_valider' LIMIT 1")[0]["id"]
        code, _ = self.call(f"/api/recommendations/{rid}/validate", "POST", {"decision": "validee", "actor": "Technicien test", "comment": "ok"})
        self.assertEqual(code, 200)
        row = db.rows(db.connect(), "SELECT * FROM recommendations WHERE id=?", (rid,))[0]
        self.assertEqual((row["status"], row["validated_by"]), ("validee", "Technicien test"))

    def test_import_maintenance_rejette_sans_provenance(self):
        csv_txt = "equipment_id,type,t_start,t_end,provenance\nROVER-computer,panne,10,12,experimental\nROVER-computer,panne,20,25,\nINCONNU,panne,1,2,experimental\n"
        code, r = self.call("/api/maintenance/import", "POST", csv_txt, "text/csv")
        self.assertEqual(code, 200)
        self.assertEqual(r["inserted"], 1)
        self.assertEqual(len(r["rejected"]), 2)


if __name__ == "__main__":
    unittest.main()
