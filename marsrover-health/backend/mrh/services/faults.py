"""Diagnostic des 5 classes de défaut — maintenance préventive (règles techniques explicites).

Classes : surchauffe · surpression · défaut électrique · défaut de capteur · surcharge moteur.
Aucun jeu fourni ne contient d'historique de pannes étiqueté par cause : un classifieur supervisé réel n'est donc pas
entraînable (cf. module 2). On applique des RÈGLES TECHNIQUES documentées, dont la référence normale est apprise sur
une période saine, et on les évalue là où une vérité existe :

  surchauffe        température (résidu après effet de l'ambiante) > référence + 4 σ robustes, ≥ 3 échantillons consécutifs
  surpression       pression statique (Ps30, C-MAPSS) > référence + 4 σ robustes, ≥ 3 cycles consécutifs
  défaut électrique tension < référence − 4 σ robustes (chute) ou tension hors plage physique
  défaut de capteur valeur figée (écart-type glissant nul sur 5 échantillons alors que la variable varie normalement)
                    ou valeur physiquement impossible / sauts brusques anormalement nombreux
  surcharge moteur  courant > référence + 4 σ robustes du même contexte (mode × terrain), ≥ 2 échantillons consécutifs

Application :
  1. télémétrie rover SIMULÉE : seule source avec vérité (anomalies injectées) → rappel par épisode, précision par
     échantillon, délai, matrice de confusion ; surpression non applicable (aucun capteur de pression sur le rover) ;
  2. mesures RÉELLES HIRF (batteries) et FEMTO (températures) : détections sans vérité terrain (aucune métrique) ;
  3. C-MAPSS (simulation NASA) pour la surpression : détections et avance avant défaillance.
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

from .. import db
from ..config import APP_ROOT, CMAPSS_SENSORS, PROCESSED, PROV_EXPERIMENTAL, PROV_SIMULATED
from ..ml.common import cmapss_fd001, save_payload
from . import registry as reg

TRAIN_END_H = 800.0
K = 4.0
CLASSES = {
    "surchauffe": ("Surchauffe", "Contrôler la régulation thermique (réchauffeurs, thermostats), réduire la charge et vérifier les dissipateurs avant la prochaine sortie."),
    "surpression": ("Surpression", "Inspecter le compresseur / circuit concerné, vérifier capteurs de pression et vannes ; planifier une inspection boroscopique."),
    "defaut_electrique": ("Défaut électrique", "Mesurer tension à vide et résistance interne, contrôler connectique et séquencement des charges ; prévoir l'échange du pack si confirmé."),
    "defaut_capteur": ("Défaut de capteur", "Comparer avec un capteur redondant, recalibrer ou remplacer le capteur ; ne pas exploiter ses mesures en attendant."),
    "surcharge_moteur": ("Surcharge moteur", "Vérifier frottements et réducteur, limiter le couple / la vitesse, inspecter la chaîne de traction ou l'articulation concernée."),
}
LABELS = {"surchauffe": ["label_thermal_heater_stuck"], "defaut_electrique": ["label_bat_voltage_drop"], "defaut_capteur": ["label_hazcam_stuck"],
          "surcharge_moteur": ["label_arm_overload", "label_motor3_drift"]}


def _robust(x, ref_mask):
    r = x[ref_mask & np.isfinite(x)]
    med = np.median(r)
    mad = np.median(np.abs(r - med)) * 1.4826
    return med, (mad if mad > 0 else (np.std(r) or 1.0))


def _persist(flag, k):
    out = np.zeros_like(flag)
    run = 0
    for i, f in enumerate(flag):
        run = run + 1 if f else 0
        if run >= k:
            out[i - k + 1:i + 1] = True
    return out


def _episodes(mask):
    eps, i, n = [], 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j + 1 < n and mask[j + 1]:
                j += 1
            eps.append((i, j))
            i = j + 1
        else:
            i += 1
    return eps


def rover_rules(T: pd.DataFrame) -> tuple[dict, pd.DataFrame]:
    ref = (T.time_h < TRAIN_END_H).to_numpy()
    flags, why = {}, {}
    # surchauffe : résidu température / ambiante
    temps = [c for c in T.columns if c.endswith("_temp_C") and c != "ambient_temp_C"]
    f = np.zeros(len(T), bool)
    src = np.array([""] * len(T), dtype=object)
    for c in temps:
        x = T[c].to_numpy(float)
        a, b = np.polyfit(T.ambient_temp_C[ref], x[ref], 1)
        res = x - (a * T.ambient_temp_C.to_numpy() + b)
        med, s = _robust(res, ref)
        fc = _persist((res - med) / s > K, 3)
        src[fc & ~f] = c
        f |= fc
    flags["surchauffe"], why["surchauffe"] = f, src
    # défaut électrique : chute de tension batterie
    x = T.bat_voltage_V.to_numpy(float)
    med, s = _robust(x, ref)
    f = ((x - med) / s < -K) | (x < 0) | (x > 60)
    flags["defaut_electrique"], why["defaut_electrique"] = f, np.where(f, "bat_voltage_V", "")
    # défaut de capteur : valeur figée
    f = np.zeros(len(T), bool)
    src = np.array([""] * len(T), dtype=object)
    for c in temps + ["bat_voltage_V", "link_margin_dB", "heater_power_W"]:
        x = T[c]
        if x[ref].std() <= 0:
            continue
        fc = (x.rolling(5).std() < 1e-9).to_numpy()
        src[fc & ~f] = c
        f |= fc
    flags["defaut_capteur"], why["defaut_capteur"] = f, src
    # surcharge moteur : courants, référence par contexte mode × terrain
    ctx = (T.op_mode.astype(str) + "|" + T.terrain.astype(str)).to_numpy()
    f = np.zeros(len(T), bool)
    src = np.array([""] * len(T), dtype=object)
    for c in [f"motor{i}_current_A" for i in range(1, 7)] + ["arm_current_A"]:
        x = T[c].to_numpy(float)
        z = np.zeros(len(T))
        for k in np.unique(ctx):
            m = ctx == k
            if (m & ref).sum() >= 10:
                med, s = _robust(x, m & ref)
            else:
                med, s = _robust(x, ref)
            z[m] = (x[m] - med) / s
        fc = _persist(z > K, 2)
        src[fc & ~f] = c
        f |= fc
    flags["surcharge_moteur"], why["surcharge_moteur"] = f, src
    return flags, pd.DataFrame(why)


def evaluate_rover(T, flags):
    ev = {}
    after = (T.time_h >= TRAIN_END_H).to_numpy()
    for cls, labs in LABELS.items():
        truth = np.zeros(len(T), bool)
        for l in labs:
            truth |= T[l].to_numpy().astype(bool)
        f = flags[cls] & after
        eps = _episodes(truth & after)
        tol = np.zeros(len(T), bool)
        for i, j in eps:
            tol[max(0, i - 2):min(len(T), j + 3)] = True
        det_eps, delays = 0, []
        for i, j in eps:
            hit = np.where(f[i:j + 1])[0]
            if len(hit):
                det_eps += 1
                delays.append(float(T.time_h.iloc[i + hit[0]] - T.time_h.iloc[i]))
        ev[cls] = {"episodes": len(eps), "episodes_detectes": det_eps, "rappel_episodes": det_eps / len(eps) if eps else None,
                   "precision_echantillons": float((f & tol).sum() / f.sum()) if f.sum() else None, "alarmes": int(f.sum()),
                   "fausses_alarmes": int((f & ~tol).sum()), "delai_median_h": float(np.median(delays)) if delays else None}
    # matrice de confusion (échantillons après 800 h) : vérité = classe injectée, prédiction = 1ʳᵉ règle déclenchée
    order = ["normal"] + list(LABELS)
    truth_c = np.array(["normal"] * len(T), dtype=object)
    for cls, labs in LABELS.items():
        for l in labs:
            truth_c[T[l].to_numpy().astype(bool)] = cls
    other = T.label_comm_unplanned_loss.to_numpy().astype(bool)  # classe hors périmètre : exclue
    pred_c = np.array(["normal"] * len(T), dtype=object)
    for cls in reversed(list(LABELS)):
        pred_c[flags[cls]] = cls
    m = after & ~other
    cm = [[int(((truth_c == a) & (pred_c == b) & m).sum()) for b in order] for a in order]
    return ev, {"labels": order, "matrix": cm}


def train(con) -> dict:
    T = pd.read_csv(os.path.join(APP_ROOT, "data", "datasets", "rover_telemetry_sim.csv"))
    flags, why = rover_rules(T)
    ev, cm = evaluate_rover(T, flags)
    mid = reg.create(con, "diagnostic", "regles_5_defauts", dataset="rover_telemetry_sim + hirf + femto + cmapss", provenance=f"{PROV_SIMULATED},{PROV_EXPERIMENTAL}",
                     target="classe de défaut", unit="classe", hyperparams={"seuil": "4 σ robustes", "référence": f"0–{TRAIN_END_H:.0f} h (rover)", "persistance": "2–3 échantillons"},
                     features=list(CLASSES), split={"évaluation": "télémétrie rover simulée après 800 h (vérité injectée)"},
                     validation_rule="rappel par épisode ≥ 0,5 pour chaque classe évaluable")
    valid = all((v["rappel_episodes"] or 0) >= 0.5 for v in ev.values())
    reg.evaluate(con, mid, "test", {f"rappel_{k}": v["rappel_episodes"] for k, v in ev.items()} | {f"precision_{k}": v["precision_echantillons"] for k, v in ev.items()})
    reg.finish(con, mid, valid=valid, n_test=int((T.time_h >= TRAIN_END_H).sum()), message="Règles techniques (pas d'apprentissage supervisé : aucune panne réelle étiquetée par cause).")
    # épisodes détectés (rover) pour l'historique
    rover_events = []
    for cls, f in flags.items():
        for i, j in _episodes(f & (T.time_h >= TRAIN_END_H).to_numpy()):
            rover_events.append({"source": "Rover (simulé)", "classe": cls, "equipement": why[cls].iloc[i] or "—", "debut": float(T.time_h.iloc[i]), "fin": float(T.time_h.iloc[j]),
                                 "unite": "h", "preuve": f"{why[cls].iloc[i]} : règle {CLASSES[cls][0].lower()} ({j - i + 1} échantillon(s))", "provenance": PROV_SIMULATED})
    # ---------- données réelles HIRF
    real = []
    hp = os.path.join(PROCESSED, "hirf_runs.csv")
    if os.path.exists(hp):
        R = pd.read_csv(hp)
        def outl(s, k=1.5):
            q1, q3 = s.quantile(.25), s.quantile(.75)
            return q3 + k * (q3 - q1)
        for p in ("LLF20", "ULA20", "LRF40", "URA40"):
            lim = outl(R[f"{p}_T_rise"])
            for r in R[R[f"{p}_T_rise"] > lim].itertuples():
                real.append({"source": "HIRF (réel)", "classe": "surchauffe", "equipement": f"pack {p}", "debut": int(r.run), "fin": int(r.run), "unite": "essai",
                             "preuve": f"échauffement {getattr(r, f'{p}_T_rise'):.1f} > seuil {lim:.1f} (Q3 + 1,5 IQR des 53 essais)", "provenance": PROV_EXPERIMENTAL})
            lim = outl(R[f"{p}_C_max"])
            for r in R[R[f"{p}_C_max"] > lim].itertuples():
                real.append({"source": "HIRF (réel)", "classe": "surcharge_moteur", "equipement": f"circuit {p}", "debut": int(r.run), "fin": int(r.run), "unite": "essai",
                             "preuve": f"courant max {getattr(r, f'{p}_C_max'):.1f} A > seuil {lim:.1f} A", "provenance": PROV_EXPERIMENTAL})
        for c in [c for c in R.columns if c.startswith("invalid_pct_") and c.endswith("V")]:
            for r in R[R[c] > 0].itertuples():
                real.append({"source": "HIRF (réel)", "classe": "defaut_electrique", "equipement": c.replace("invalid_pct_", ""), "debut": int(r.run), "fin": int(r.run), "unite": "essai",
                             "preuve": f"{getattr(r, c):.2f} % des mesures de tension hors plage (chute < 60 % du nominal / coupure)", "provenance": PROV_EXPERIMENTAL})
        for c in [c for c in R.columns if c.startswith("invalid_pct_") and c.endswith("T")]:
            for r in R[R[c] >= 99].itertuples():
                real.append({"source": "HIRF (réel)", "classe": "defaut_capteur", "equipement": c.replace("invalid_pct_", ""), "debut": int(r.run), "fin": int(r.run), "unite": "essai",
                             "preuve": "toutes les températures hors plage (échelle différente des autres essais)", "provenance": PROV_EXPERIMENTAL})
        lim = outl(R.spikes_V_T, 3)
        for r in R[R.spikes_V_T > lim].itertuples():
            real.append({"source": "HIRF (réel)", "classe": "defaut_capteur", "equipement": "voies tension / température", "debut": int(r.run), "fin": int(r.run), "unite": "essai",
                         "preuve": f"{int(r.spikes_V_T)} sauts brusques > seuil {lim:.0f} (Q3 + 3 IQR)", "provenance": PROV_EXPERIMENTAL})
    fp = os.path.join(PROCESSED, "femto_temperatures.csv")
    if os.path.exists(fp):
        Ft = pd.read_csv(fp)
        for b, g in Ft.groupby("bearing"):
            bad = g[(g.temp_max > 200) | (g.temp_mean < 0)]
            if len(bad):
                real.append({"source": "FEMTO (réel)", "classe": "defaut_capteur", "equipement": f"{b} — sonde de température", "debut": int(bad.k.min()), "fin": int(bad.k.max()),
                             "unite": "relevé (min)", "preuve": f"{len(bad)} relevé(s) > 200 (max {bad.temp_max.max():.0f}) : valeur physiquement implausible", "provenance": PROV_EXPERIMENTAL})
    # ---------- surpression : C-MAPSS Ps30 (s11)
    df = cmapss_fd001(con)
    over = []
    df = df.assign(s11m=df.groupby("equipment_id").s11.transform(lambda v: v.rolling(5, min_periods=1).mean()))
    tr = df[df.split == "train"]
    ref = tr[tr.cycle <= 50].s11m.to_numpy()  # référence = pression lissée des 50 premiers cycles (fonctionnement sain)
    med, s = np.median(ref), np.median(np.abs(ref - np.median(ref))) * 1.4826
    for e, g in df.groupby("equipment_id"):
        x = g.s11m.to_numpy()
        f = _persist((x - med) / s > K, 3)
        if f.any():
            i = int(np.argmax(f))
            over.append({"equipment_id": e, "cycle": int(g.cycle.iloc[i]), "rul_reelle": int(g.rul.iloc[i]), "z": float((x[i] - med) / s)})
    O = pd.DataFrame(over)
    sim_events = [{"source": "C-MAPSS (simulé NASA)", "classe": "surpression", "equipement": r.equipment_id, "debut": r.cycle, "fin": r.cycle, "unite": "cycle",
                   "preuve": f"Ps30 (pression statique HPC) +{r.z:.1f} σ ; RUL réelle à la détection {r.rul_reelle} cycles", "provenance": PROV_SIMULATED} for r in O.itertuples()]
    allev = real + sim_events + rover_events
    counts = pd.DataFrame(allev).groupby(["classe", "source"]).size().unstack(fill_value=0) if allev else pd.DataFrame()
    payload = {"classes": {k: {"label": v[0], "action": v[1]} for k, v in CLASSES.items()}, "rules": __doc__.split("Application :")[0].split("défaut moteur.")[-1].strip(),
               "rover_eval": ev, "confusion": cm, "events": allev[:600], "counts": counts.reset_index().to_dict("records") if len(counts) else [],
               "surpression": {"units": int(len(O)), "units_total": int(df.equipment_id.nunique()), "train_detected": int(O.equipment_id.str.contains("-TR-").sum()) if len(O) else 0,
                               "train_units": int(df[df.split == "train"].equipment_id.nunique()), "median_rul_at_detection": float(O.rul_reelle.median()) if len(O) else None,
                               "ref": {"median": float(med), "sigma": float(s), "unit": "psia"}},
               "model_id": mid, "limits": [
                   "Aucune panne réelle étiquetée par cause : les règles sont évaluées uniquement sur la télémétrie rover SIMULÉE (anomalies injectées).",
                   "Surpression : aucun capteur de pression sur le rover ni dans HIRF / FEMTO ; règle appliquée aux turboréacteurs C-MAPSS (simulés), sans étiquette de surpression.",
                   "Les détections sur données réelles (HIRF, FEMTO) sont des alertes à vérifier : aucune métrique de performance n'y est calculable.",
                   "Seuils (4 σ robustes, Q3 + 1,5 IQR) = choix d'analyse documentés, à ajuster avec l'exploitant."]}
    save_payload(con, "defauts", payload)
    return {"rover": {k: (v["episodes_detectes"], v["episodes"], None if v["precision_echantillons"] is None else round(v["precision_echantillons"], 3)) for k, v in ev.items()},
            "reel": len(real), "surpression_units": int(len(O))}
