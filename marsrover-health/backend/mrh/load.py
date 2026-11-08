"""Chargement des données traitées dans la base (equipment, sensor_data, operating_history,
failure_history, maintenance_history, fmea, fta_events).

Règles : aucune valeur imputée en base ; durées de vie inconnues = censure (event = 0), jamais une date inventée ;
chaque ligne porte sa provenance.
"""
from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

from . import db
from .config import (APP_ROOT, BATTERY_EOL_AH, BATTERY_MIN_C0, CMAPSS_SENSOR_INFO, CMAPSS_SENSORS, PROCESSED,
                     PROV_EXPERIMENTAL, PROV_SIMULATED)
from .ingest import read_cmapss, read_cmapss_rul

FD_INFO = {"FD001": (1, 1), "FD002": (6, 1), "FD003": (1, 2), "FD004": (6, 2)}  # (conditions, modes de défaillance)
EARLY = 15  # cycles initiaux utilisés comme covariables de survie (connus dès la mise en service)


def _eq(eid, name, kind, subsystem, dataset, prov, unit, analog=None, meta=None):
    return {"equipment_id": eid, "name": name, "kind": kind, "subsystem": subsystem, "dataset": dataset, "provenance": prov,
            "time_unit": unit, "rover_analog": analog, "meta": db.j(meta or {})}


def battery_lifetimes(df: pd.DataFrame) -> pd.DataFrame:
    """Durée de vie (en décharges) au critère EOL 1,4 Ah, avec censure.
    Capacité lissée par médiane glissante (3) pour ne pas déclarer une fin de vie sur une mesure isolée ;
    cellules retenues : capacité initiale (moyenne des 3 premières décharges valides) ≥ BATTERY_MIN_C0."""
    out = []
    for b, g in df[df.qc_flag == "ok"].groupby("battery"):
        g = g.sort_values("discharge_idx")
        cap = g.capacity_Ah.to_numpy()
        c0 = float(np.mean(cap[:3]))
        med = pd.Series(cap).rolling(3, center=True, min_periods=2).median().to_numpy()
        below = np.where(med < BATTERY_EOL_AH)[0]
        retained = c0 >= BATTERY_MIN_C0
        if below.size:
            t, ev = int(g.discharge_idx.iloc[below[0]]), 1
        else:
            t, ev = int(g.discharge_idx.iloc[-1]), 0
        out.append({"battery": b, "c0_Ah": c0, "t": t, "event": ev, "retained": retained, "ambient_C": float(g.ambient_C.mode().iloc[0]),
                    "n_discharges": int(len(g))})
    return pd.DataFrame(out)


def load_all(con) -> dict:
    stats = {}
    for t in ("sensor_data", "operating_history", "failure_history", "maintenance_history", "fta_events", "fmea", "equipment"):
        con.execute(f"DELETE FROM {t}")
    con.commit()
    eqs, sens, oper, fail = [], [], [], []

    # ---------------- C-MAPSS : FD001 complet (capteurs) + FD001..FD004 (durées & covariables initiales)
    for fd, (ncond, nmode) in FD_INFO.items():
        for kind in ("train", "test"):
            d = read_cmapss(kind, fd)
            rul = read_cmapss_rul(fd) if kind == "test" else None
            for u, g in d.groupby("unit"):
                eid = f"CMAPSS-{fd}-{'TR' if kind == 'train' else 'TE'}-{u:03d}"
                last = int(g.cycle.max())
                meta = {"fd": fd, "split": kind, "unit": int(u), "conditions": ncond, "fault_modes": nmode, "last_cycle": last}
                if kind == "test":
                    meta["true_rul_at_last"] = int(rul[u - 1])  # vérité NASA, utilisée UNIQUEMENT pour l'évaluation
                eqs.append(_eq(eid, f"Turboréacteur {fd} n° {u} ({'apprentissage' if kind == 'train' else 'test'})", "turbofan",
                               "Propulsion (référence)", f"cmapss_{fd.lower()}", PROV_SIMULATED, "cycle", "motor_1..6 (méthode uniquement)", meta))
                early = g[g.cycle <= EARLY]
                cov = {"op1": float(early.op1.mean()), "op2": float(early.op2.mean()), "op3": float(early.op3.mean())}
                for s in CMAPSS_SENSORS:
                    cov[s] = float(early[s].mean())
                oper.append({"equipment_id": eid, "t_start": 1, "t_end": last, "unit": "cycle", "usage_value": last, "usage_unit": "cycle",
                             "conditions": db.j({"fd": fd, "n_conditions": ncond, "n_fault_modes": nmode, "early_means": cov})})
                # train : exécution jusqu'à la défaillance (event=1) ; test : trajectoire tronquée → censure à droite (event=0)
                fail.append({"equipment_id": eid, "t_event": last, "unit": "cycle", "event": 1 if kind == "train" else 0,
                             "failure_mode": "HPC" if nmode == 1 else "HPC ou Fan (non étiqueté)",
                             "criterion": "fin de la trajectoire simulée = défaillance (marge de fonctionnement épuisée)" if kind == "train" else "trajectoire interrompue avant défaillance (censure)",
                             "provenance": PROV_SIMULATED})
                if fd == "FD001":
                    for row in g.itertuples(index=False):
                        for s in CMAPSS_SENSORS:
                            sens.append((eid, float(row.cycle), s, float(getattr(row, s)), CMAPSS_SENSOR_INFO[s][1], "ok"))
    # ---------------- Milling : un outil par « case » (essai), passes successives
    m = pd.read_csv(os.path.join(PROCESSED, "milling_runs.csv"))
    feat_cols = [c for c in m.columns if any(c.startswith(s) for s in ("smcAC", "smcDC", "vib_", "AE_"))]
    for case, g in m.groupby("case"):
        eid = f"MILL-C{case:02d}"
        meta = {"case": int(case), "DOC_mm": float(g.DOC_mm.iloc[0]), "feed_mm_rev": float(g.feed_mm_rev.iloc[0]),
                "material": "fonte" if int(g.material.iloc[0]) == 1 else "acier", "runs": int(len(g))}
        eqs.append(_eq(eid, f"Outil de fraisage — essai {case}", "outil_fraisage", "Usinage (référence)", "milling_nasa_ucb", PROV_EXPERIMENTAL,
                       "min", "rat_tool (foret / outil d'abrasion)", meta))
        for r in g.itertuples(index=False):
            t = float(r.time_min)
            sens.append((eid, t, "VB_mm", None if np.isnan(r.VB_mm) else float(r.VB_mm), "mm", r.qc_flag))
            for c in feat_cols:
                v = getattr(r, c)
                sens.append((eid, t, c, None if not np.isfinite(v) else float(v), "V" if not c.endswith(("kurt", "crest")) else "—", "ok"))
        oper.append({"equipment_id": eid, "t_start": float(g.time_min.min()), "t_end": float(g.time_min.max()), "unit": "min",
                     "usage_value": float(g.time_min.max()), "usage_unit": "min de coupe", "conditions": db.j(meta)})
    # ---------------- Batteries
    b = pd.read_csv(os.path.join(PROCESSED, "battery_discharges.csv"))
    life = battery_lifetimes(b)
    for bat, g in b.groupby("battery"):
        lf = life[life.battery == bat].iloc[0] if (life.battery == bat).any() else None
        eid = f"BAT-{bat}"
        meta = {"ambient_C": sorted(set(g.ambient_C.astype(int).tolist())), "n_discharges": int(len(g)),
                "c0_Ah": None if lf is None else round(float(lf.c0_Ah), 4), "retained_for_reliability": bool(lf is not None and lf.retained),
                "invalid_capacity_points": int((g.qc_flag != "ok").sum())}
        eqs.append(_eq(eid, f"Cellule Li-ion 18650 {bat}", "batterie_li_ion", "Énergie (référence)", "battery_nasa_pcoe", PROV_EXPERIMENTAL,
                       "décharge", "battery (substitution)", meta))
        for r in g.itertuples(index=False):
            for var, unit in (("capacity_Ah", "Ah"), ("temp_max_C", "°C"), ("v_min_V", "V"), ("duration_s", "s")):
                v = getattr(r, var)
                sens.append((eid, float(r.discharge_idx), var, None if not np.isfinite(v) else float(v), unit, r.qc_flag if var == "capacity_Ah" else "ok"))
        if lf is not None and lf.retained:
            fail.append({"equipment_id": eid, "t_event": float(lf.t), "unit": "décharge", "event": int(lf.event), "failure_mode": "perte de capacité",
                         "criterion": f"capacité (médiane glissante 3) < {BATTERY_EOL_AH} Ah ; sinon censure à la dernière décharge", "provenance": PROV_EXPERIMENTAL})
        oper.append({"equipment_id": eid, "t_start": 1, "t_end": float(g.discharge_idx.max()), "unit": "décharge", "usage_value": float(g.discharge_idx.max()),
                     "usage_unit": "décharges", "conditions": db.j(meta)})
    # ---------------- IGBT
    ig = pd.read_csv(os.path.join(PROCESSED, "igbt_dc_windows.csv"))
    eid = "IGBT-DC-01"
    eqs.append(_eq(eid, "IGBT IRG4BC30K — surcontrainte thermique (grille DC)", "igbt", "Électronique de puissance (référence)", "igbt_nasa_pcoe",
                   PROV_EXPERIMENTAL, "s", "motor_1..6 (variateur de traction, substitution)",
                   {"duration_s": float(ig.t_s.max()), "window_s": 10, "note": "heatsink_raw : grandeur brute sans unité documentée (non utilisée)"}))
    units = {"gate_voltage_V": "V", "collector_voltage_V": "V", "collector_current_A": "A", "gate_current_A": "A", "package_temp_C": "°C"}
    for r in ig.itertuples(index=False):
        for var, unit in units.items():
            sens.append((eid, float(r.t_s), var, float(getattr(r, var)), unit, "ok"))
    oper.append({"equipment_id": eid, "t_start": 0, "t_end": float(ig.t_s.max()), "unit": "s", "usage_value": float(ig.t_s.max()), "usage_unit": "s sous contrainte",
                 "conditions": db.j({"essai": "vieillissement accéléré, grille DC"})})
    # ---------------- Composants rover (application existante) + journal d'événements SIMULÉ
    comps = json.load(open(os.path.join(APP_ROOT, "data", "components.json"), encoding="utf-8"))["components"]
    for c in comps:
        eqs.append(_eq(f"ROVER-{c['id']}", c["name"], "composant_rover", c["subsystem"], "rover_app", (c.get("dataset") or {}).get("provenance") or PROV_SIMULATED,
                       "h", None, {"component_id": c["id"]}))
    ev = pd.read_csv(os.path.join(APP_ROOT, "data", "datasets", "rover_events_sim.csv"))
    maint = [{"equipment_id": f"ROVER-{r.component_id}", "type": r.type, "t_start": float(r.start_h), "t_end": float(r.end_h), "unit": "h",
              "failure_type": r.description, "severity": None, "complexity": None, "spare_parts_available": None, "provenance": PROV_SIMULATED,
              "source": f"rover_events_sim.csv#{r.event_id}"} for r in ev.itertuples(index=False)]

    db.insert_many(con, "equipment", eqs)
    with db._lock:
        con.executemany("INSERT INTO sensor_data (equipment_id, t, variable, value, unit, qc_flag) VALUES (?,?,?,?,?,?)", sens)
    db.insert_many(con, "operating_history", oper)
    db.insert_many(con, "failure_history", fail)
    db.insert_many(con, "maintenance_history", maint)
    load_fmea(con)
    load_fta(con)
    stats["reference"] = load_reference(con)
    con.commit()
    stats.update(equipment=len(eqs), sensor_data=len(sens), operating_history=len(oper), failure_history=len(fail), maintenance_history=len(maint))
    db.log(con, "load_all", stats)
    return stats


def load_fmea(con):
    f = json.load(open(os.path.join(APP_ROOT, "data", "fmeca.json"), encoding="utf-8"))
    comps = {c["id"]: c for c in json.load(open(os.path.join(APP_ROOT, "data", "components.json"), encoding="utf-8"))["components"]}
    rows = []
    for m in f["modes"]:
        c = comps.get(m["component"], {})
        rows.append({"fmea_id": m["id"], "equipment_id": f"ROVER-{m['component']}", "subsystem": c.get("subsystem"), "mode": m["mode"], "cause": m.get("cause"),
                     "effect": m.get("effect"), "detection": m.get("detection"), "G": m["G"], "O": m["O"], "D": m["D"], "mitigation": m.get("mitigation"),
                     "source": "fmeca.json — cotations de démonstration (jugement d'expert à valider)", "updated_at": db.now(), "updated_by": "import"})
    db.insert_many(con, "fmea", rows)


FTA_TREE = [  # (id, libellé, type, porte, parent, equipment_id)
    ("TOP", "Perte de la mobilité du rover", "top", "OR", None, None),
    ("G_ENERGY", "Perte de l'alimentation de la traction", "intermediate", "OR", "TOP", None),
    ("G_PACK", "Batterie hors service (≥ 1 des 2 cellules série hors critère)", "intermediate", "OR", "G_ENERGY", None),
    ("B_CELL1", "Cellule Li-ion 1 en fin de vie (capacité < 1,4 Ah)", "basic", None, "G_PACK", "ROVER-battery"),
    ("B_CELL2", "Cellule Li-ion 2 en fin de vie (capacité < 1,4 Ah)", "basic", None, "G_PACK", "ROVER-battery"),
    ("B_MMRTG", "Défaillance du générateur MMRTG", "basic", None, "G_ENERGY", "ROVER-power_mmrtg"),
    ("G_CMD", "Perte de la commande (calculateur principal ET secours)", "intermediate", "AND", "TOP", None),
    ("B_RCE_A", "Défaillance du calculateur principal", "basic", None, "G_CMD", "ROVER-computer"),
    ("B_RCE_B", "Défaillance du calculateur de secours", "basic", None, "G_CMD", "ROVER-computer"),
    ("G_DRIVE", "Perte de la chaîne de traction", "intermediate", "OR", "TOP", None),
    ("B_IGBT", "Claquage d'un IGBT du variateur (latch-up)", "basic", None, "G_DRIVE", "ROVER-motor_3"),
    ("B_GEAR", "Grippage du réducteur de roue", "basic", None, "G_DRIVE", "ROVER-motor_3"),
]


def load_fta(con):
    rows = [{"event_id": e, "tree_id": "FTA-MOBILITE", "label": l, "kind": k, "gate": g, "parent_id": p, "probability": None, "prob_source": None,
             "horizon": None, "equipment_id": q} for e, l, k, g, p, q in FTA_TREE]
    db.insert_many(con, "fta_events", rows)


# ------------------------------------------------------------------ FEMTO (PRONOSTIA) et HIRF (Edge 540)
FEMTO_VARS = ["h_rms", "v_rms", "h_kurt", "v_kurt", "h_peak", "v_peak", "h_crest", "v_crest", "h_band_0_1k", "h_band_6_12k", "v_band_0_1k", "v_band_6_12k"]


def load_reference(con) -> dict:
    import os as _os
    eqs, sens, oper, fail = [], [], [], []
    fp = _os.path.join(PROCESSED, "femto_snapshots.csv")
    if _os.path.exists(fp):
        F = pd.read_csv(fp)
        for b, g in F.groupby("bearing"):
            eid = f"FEMTO-{b}"
            life = float(g.t_s.max() + 10.0)
            meta = {"split": g.split.iloc[0], "condition": int(g.condition.iloc[0]), "rpm": int(g.rpm.iloc[0]), "load_N": int(g.load_N.iloc[0]),
                    "snapshots": int(len(g)), "life_s": life, "irregular_steps": int((g.qc_flag != "ok").sum())}
            eqs.append(_eq(eid, f"Roulement PRONOSTIA {b} ({'apprentissage' if meta['split'] == 'learning' else 'test complet'})", "roulement", "Mécanique tournante (référence)",
                           "femto_pronostia", PROV_EXPERIMENTAL, "s", "wheel_1..6 (roulements de roue, substitution)", meta))
            for r in g.itertuples(index=False):
                for v in FEMTO_VARS:
                    x = getattr(r, v)
                    sens.append((eid, float(r.t_s), v, None if not np.isfinite(x) else float(x), "g" if v.endswith(("rms", "peak")) else "—", r.qc_flag))
            oper.append({"equipment_id": eid, "t_start": 0, "t_end": life, "unit": "s", "usage_value": life, "usage_unit": "s d'essai accéléré", "conditions": db.j(meta)})
            fail.append({"equipment_id": eid, "t_event": life, "unit": "s", "event": 1, "failure_mode": "dégradation du roulement (essai mené jusqu'à défaillance)",
                         "criterion": "arrêt de l'essai PRONOSTIA (dépassement du niveau vibratoire admissible, Nectoux et al. 2012)", "provenance": PROV_EXPERIMENTAL})
    hp = _os.path.join(PROCESSED, "hirf_runs.csv")
    if _os.path.exists(hp):
        R = pd.read_csv(hp)
        for p in ("LLF20", "ULA20", "LRF40", "URA40"):
            eid = f"HIRF-{p}"
            eqs.append(_eq(eid, f"Pack batterie {p} — avion Edge 540 (essais HIRF)", "batterie_li_ion", "Énergie (référence)", "hirf_edge540", PROV_EXPERIMENTAL, "essai",
                           "battery (substitution)", {"runs": int(len(R)), "position": p[:3], "nominal_V": int(p[3:])}))
            for r in R.itertuples(index=False):
                for q, unit in (("R_ohm", "Ω"), ("Ah", "Ah"), ("Wh", "Wh"), ("T_rise", "unité non documentée"), ("V_end", "V"), ("dVdAh", "V/Ah")):
                    v = getattr(r, f"{p}_{q}", np.nan)
                    sens.append((eid, float(r.run), q, None if not np.isfinite(v) else float(v), unit, "ok" if np.isfinite(v) else "invalide"))
            oper.append({"equipment_id": eid, "t_start": float(R.run.min()), "t_end": float(R.run.max()), "unit": "essai", "usage_value": float(R[f"{p}_Ah"].sum()),
                         "usage_unit": "Ah cumulés", "conditions": db.j({"essais": R.run.tolist()})})
    db.insert_many(con, "equipment", eqs)
    with db._lock:
        con.executemany("INSERT INTO sensor_data (equipment_id, t, variable, value, unit, qc_flag) VALUES (?,?,?,?,?,?)", sens)
    db.insert_many(con, "operating_history", oper)
    db.insert_many(con, "failure_history", fail)
    return {"equipment": len(eqs), "sensor_data": len(sens), "failures": len(fail)}
