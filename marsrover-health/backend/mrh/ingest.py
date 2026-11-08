"""Extraction des jeux de données réels/de référence bruts vers des fichiers traités (CSV).

Chaque fonction lit le format d'origine (txt NASA, .mat MATLAB) sans altérer les valeurs mesurées.
Les seules transformations sont : agrégation (fenêtres, statistiques par passe/cycle) et
marquage explicite des valeurs manquantes ou aberrantes (colonne `qc_flag`), jamais leur remplacement.

Usage : python -m mrh.cli ingest --raw-dir <dossier des archives décompressées>
"""
from __future__ import annotations

import glob
import re
import os

import numpy as np
import pandas as pd

from .config import PROCESSED, RAW

CMAPSS_COLS = ["unit", "cycle", "op1", "op2", "op3"] + [f"s{i}" for i in range(1, 22)]


# ------------------------------------------------------------------ C-MAPSS (fichiers texte NASA)
def read_cmapss(kind: str, fd: str) -> pd.DataFrame:
    """kind ∈ {train, test}; fd ∈ {FD001..FD004}. Colonnes : unit, cycle, op1..3, s1..s21."""
    path = os.path.join(RAW, "cmapss", f"{kind}_{fd}.txt")
    df = pd.read_csv(path, sep=r"\s+", header=None)
    df = df.iloc[:, : len(CMAPSS_COLS)]
    df.columns = CMAPSS_COLS
    return df


def read_cmapss_rul(fd: str) -> np.ndarray:
    return pd.read_csv(os.path.join(RAW, "cmapss", f"RUL_{fd}.txt"), header=None).iloc[:, 0].to_numpy()


# ------------------------------------------------------------------ Milling (UC Berkeley / NASA, mill.mat)
MILL_SIGNALS = ["smcAC", "smcDC", "vib_table", "vib_spindle", "AE_table", "AE_spindle"]


def _sig_features(x: np.ndarray, name: str) -> dict:
    x = np.asarray(x, float)
    xc = x - x.mean()
    sd = xc.std()
    rms = np.sqrt(np.mean(x ** 2))
    kurt = float(np.mean(xc ** 4) / sd ** 4) if sd > 0 else np.nan
    return {
        f"{name}_mean": float(x.mean()),
        f"{name}_std": float(sd),
        f"{name}_rms": float(rms),
        f"{name}_p2p": float(x.max() - x.min()),
        f"{name}_kurt": kurt,
        f"{name}_crest": float(np.max(np.abs(x)) / rms) if rms > 0 else np.nan,
    }


def ingest_milling(raw_dir: str) -> pd.DataFrame:
    import scipy.io as sio

    path = glob.glob(os.path.join(raw_dir, "**", "mill.mat"), recursive=True)[0]
    m = sio.loadmat(path, squeeze_me=True, struct_as_record=False)["mill"]
    rows = []
    for r in m:
        row = {
            "case": int(r.case), "run": int(r.run), "VB_mm": float(r.VB) if np.isfinite(r.VB) else np.nan,
            "time_min": float(r.time), "DOC_mm": float(r.DOC), "feed_mm_rev": float(r.feed), "material": int(r.material),
        }
        n = len(r.smcAC)
        a, b = int(n * 0.25), int(n * 0.75)  # zone de coupe stabilisée (50 % central de l'enregistrement)
        for s in MILL_SIGNALS:
            row.update(_sig_features(getattr(r, s)[a:b], s))
        rows.append(row)
    df = pd.DataFrame(rows).sort_values(["case", "run"]).reset_index(drop=True)
    df["qc_flag"] = np.where(df["VB_mm"].isna(), "VB_non_mesure", "ok")
    df.to_csv(os.path.join(PROCESSED, "milling_runs.csv"), index=False)
    return df


# ------------------------------------------------------------------ Batteries Li-ion (NASA PCoE)
def ingest_battery(raw_dir: str) -> pd.DataFrame:
    import scipy.io as sio

    files = sorted(glob.glob(os.path.join(raw_dir, "**", "B00*.mat"), recursive=True))
    seen, rows = set(), []
    for f in files:
        name = os.path.basename(f)[:-4]
        if name in seen:  # B0025..B0028 sont livrés deux fois (archives 2 et 3) : on garde la première copie
            continue
        seen.add(name)
        cyc = sio.loadmat(f, squeeze_me=True, struct_as_record=False)[name].cycle
        k = 0
        for c in cyc:
            if c.type != "discharge":
                continue
            k += 1
            d = c.data
            try:
                cap = float(np.atleast_1d(d.Capacity)[0])
            except Exception:
                cap = np.nan
            v = np.atleast_1d(d.Voltage_measured).astype(float)
            t = np.atleast_1d(d.Temperature_measured).astype(float)
            tt = np.atleast_1d(d.Time).astype(float)
            i = np.atleast_1d(d.Current_measured).astype(float)
            rows.append({
                "battery": name, "discharge_idx": k, "ambient_C": float(c.ambient_temperature),
                "capacity_Ah": cap, "temp_max_C": float(np.nanmax(t)) if t.size else np.nan,
                "temp_mean_C": float(np.nanmean(t)) if t.size else np.nan,
                "v_min_V": float(np.nanmin(v)) if v.size else np.nan, "v_mean_V": float(np.nanmean(v)) if v.size else np.nan,
                "i_mean_A": float(np.nanmean(i)) if i.size else np.nan,
                "duration_s": float(tt[-1] - tt[0]) if tt.size > 1 else np.nan,
            })
    df = pd.DataFrame(rows)
    # Contrôle qualité : capacité nulle / non finie = mesure invalide (signalée, non corrigée)
    df["qc_flag"] = np.where(~np.isfinite(df["capacity_Ah"]) | (df["capacity_Ah"] <= 0.05), "capacite_invalide", "ok")
    df.to_csv(os.path.join(PROCESSED, "battery_discharges.csv"), index=False)
    return df


# ------------------------------------------------------------------ IGBT (NASA PCoE, vieillissement thermique, grille DC)
def ingest_igbt(raw_dir: str, window_s: float = 10.0) -> pd.DataFrame:
    import scipy.io as sio

    path = glob.glob(os.path.join(raw_dir, "**", "Thermal Overstress Aging with DC at gate", "*.mat"), recursive=True)[0]
    m = sio.loadmat(path, squeeze_me=True)
    t = (m["TIME"] - m["TIME"][0]).astype(float)  # secondes depuis le début de l'essai
    chans = {"gate_voltage_V": "GATE_VOLTAGE", "collector_voltage_V": "COLLECTOR_VOLTAGE", "collector_current_A": "COLLECTOR_CURRENT",
             "gate_current_A": "GATE_CURRENT", "package_temp_C": "PACKAGE_TEMP", "heatsink_raw": "HEAT_SINK_TEMP"}
    w = np.floor(t / window_s).astype(int)
    out = {"t_s": pd.Series(t).groupby(w).min().to_numpy()}
    for k, src in chans.items():
        s = pd.Series(m[src].astype(float)).groupby(w)
        out[k] = s.mean().to_numpy()
        out[k + "_std"] = s.std().to_numpy()
    df = pd.DataFrame(out)
    df.insert(0, "device", "IGBT-IRG4BC30K-DC")
    df.to_csv(os.path.join(PROCESSED, "igbt_dc_windows.csv"), index=False)
    return df


def ingest_all(raw_dir: str) -> dict:
    os.makedirs(PROCESSED, exist_ok=True)
    out = {}
    for name, fn in (("milling", ingest_milling), ("battery", ingest_battery), ("igbt", ingest_igbt), ("femto", ingest_femto), ("hirf", ingest_hirf)):
        try:
            res = fn(raw_dir)
            out[name] = len(res) if hasattr(res, "__len__") and not isinstance(res, dict) else res
        except (IndexError, ValueError, KeyError):
            out[name] = "source brute absente (fichier traité existant conservé)"
    return out


# ------------------------------------------------------------------ FEMTO / PRONOSTIA (IEEE PHM 2012, roulements)
# Chaque fichier acc_NNNNN.csv = instantané de 0,1 s (2 560 points à 25,6 kHz) toutes les 10 s ;
# colonnes : heure, minute, seconde, microseconde, accélération horizontale, accélération verticale (g).
# temp_NNNNN.csv (quand présent) : 600 points à 10 Hz, toutes les minutes ; 5ᵉ colonne = température.
# Conditions (Nectoux et al. 2012) : 1 → 1 800 tr/min, 4 000 N ; 2 → 1 650 tr/min, 4 200 N ; 3 → 1 500 tr/min, 5 000 N.
FEMTO_COND = {1: (1800, 4000), 2: (1650, 4200), 3: (1500, 5000)}


def _read_femto(path):
    with open(path, "r") as fh:
        head = fh.readline()
    sep = ";" if head.count(";") > head.count(",") else ","
    return pd.read_csv(path, sep=sep, header=None).to_numpy(float)


def _femto_snapshot(args):
    path, k = args
    a = _read_femto(path)
    row = {"snapshot": k, "clock_s": float(a[0, 0] * 3600 + a[0, 1] * 60 + a[0, 2] + a[0, 3] * 1e-6), "n_points": int(len(a))}
    for j, ax in ((4, "h"), (5, "v")):
        x = a[:, j]
        xc = x - x.mean()
        sd = xc.std()
        rms = float(np.sqrt(np.mean(x ** 2)))
        row.update({f"{ax}_rms": rms, f"{ax}_std": float(sd), f"{ax}_peak": float(np.abs(x).max()), f"{ax}_p2p": float(x.max() - x.min()),
                    f"{ax}_kurt": float(np.mean(xc ** 4) / sd ** 4) if sd > 0 else np.nan,
                    f"{ax}_skew": float(np.mean(xc ** 3) / sd ** 3) if sd > 0 else np.nan, f"{ax}_crest": float(np.abs(x).max() / rms) if rms > 0 else np.nan})
        # énergie relative par bande (FFT) : 0–1 kHz, 1–3 kHz, 3–6 kHz, 6–12,8 kHz
        P = np.abs(np.fft.rfft(xc)) ** 2
        f = np.fft.rfftfreq(len(xc), 1 / 25600)
        tot = P.sum() or 1.0
        for lo, hi in ((0, 1000), (1000, 3000), (3000, 6000), (6000, 12800)):
            row[f"{ax}_band_{lo // 1000}_{hi // 1000}k"] = float(P[(f >= lo) & (f < hi)].sum() / tot)
    return row


def ingest_femto(raw_dir: str) -> pd.DataFrame:
    from concurrent.futures import ProcessPoolExecutor
    dirs = sorted({os.path.dirname(p) for p in glob.glob(os.path.join(raw_dir, "**", "Bearing*_*", "acc_*.csv"), recursive=True)})
    rows, temps = [], []
    for d in dirs:
        name = os.path.basename(d)
        split = "learning" if "Learning" in d else "test_complet"
        files = sorted(glob.glob(os.path.join(d, "acc_*.csv")))
        with ProcessPoolExecutor(max_workers=2) as ex:
            feats = list(ex.map(_femto_snapshot, [(f, k + 1) for k, f in enumerate(files)], chunksize=64))
        cond = int(name.split("_")[0].replace("Bearing", ""))
        for r in feats:
            r.update(bearing=name, split=split, condition=cond, rpm=FEMTO_COND[cond][0], load_N=FEMTO_COND[cond][1], t_s=(r["snapshot"] - 1) * 10.0)
        rows.extend(feats)
        for k, f in enumerate(sorted(glob.glob(os.path.join(d, "temp_*.csv")))):
            a = _read_femto(f)
            temps.append({"bearing": name, "k": k + 1, "clock_s": float(a[0, 0] * 3600 + a[0, 1] * 60 + a[0, 2]), "temp_mean": float(a[:, 4].mean()),
                          "temp_max": float(a[:, 4].max())})
        print(f"FEMTO {name} : {len(files)} instantanés", flush=True)
    df = pd.DataFrame(rows)
    # horloge réelle : détection des passages à minuit et cohérence du pas de 10 s
    out = []
    for b, g in df.groupby("bearing"):
        g = g.sort_values("snapshot").copy()
        c = g.clock_s.to_numpy()
        c = c + 86400 * np.cumsum(np.r_[0, np.diff(c) < -43200])
        g["elapsed_clock_s"] = c - c[0]
        g["qc_flag"] = np.where(np.r_[False, np.abs(np.diff(c) - 10) > 1], "pas_temporel_irregulier", "ok")
        out.append(g)
    df = pd.concat(out, ignore_index=True)
    df.to_csv(os.path.join(PROCESSED, "femto_snapshots.csv"), index=False)
    T = pd.DataFrame(temps)
    T.to_csv(os.path.join(PROCESSED, "femto_temperatures.csv"), index=False)
    return df


# ------------------------------------------------------------------ HIRF (NASA PCoE, avion électrique Edge 540, chambre HIRF)
# 53 essais HIRFn.mat (structure data) échantillonnés à 200 Hz : t (s), RPM, tensions *V, courants *C et températures *T
# des 4 packs de batteries (LLF, ULA, LRF, URA ; 20 / 40 = pack « 20 V » ou « 40 V » nominal), courants ESC (LESCIM2, RESCIM1)
# ou moteur (FMC, AMC) selon l'essai, et sorties du moniteur de santé batterie BHM (EOD, RUL, SOC, V_est) quand présent.
HIRF_PACKS = ["LLF20", "ULA20", "LRF40", "URA40"]


def ingest_hirf(raw_dir: str, step_s: float = 10.0) -> dict:
    import scipy.io as sio
    files = sorted(glob.glob(os.path.join(raw_dir, "**", "HIRF*.mat"), recursive=True), key=lambda p: int(re.sub(r"\D", "", os.path.basename(p))))
    runs, series, bhm = [], [], []
    for f in files:
        run = int(re.sub(r"\D", "", os.path.basename(f)))
        s = os.path.basename(os.path.dirname(f))
        d = sio.loadmat(f, squeeze_me=True, struct_as_record=False)["data"]
        t = np.asarray(d.t, float)
        dt = float(np.median(np.diff(t)))
        fields = [x for x in d._fieldnames if x not in ("t", "BHM")]
        X = {k: np.asarray(getattr(d, k), float) for k in fields}
        r = {"run": run, "set": s, "duration_s": float(t[-1] - t[0]), "n": int(len(t)), "fs_hz": round(1 / dt, 3), "fields": " ".join(fields),
             "has_bhm": "BHM" in d._fieldnames, "rpm_max": float(np.nanmax(X["RPM"])), "rpm_mean_active": float(np.nanmean(X["RPM"][X["RPM"] > 500])) if (X["RPM"] > 500).any() else np.nan,
             "active_s": float((X["RPM"] > 500).sum() * dt), "nan_total": int(sum(np.isnan(v).sum() for v in X.values()))}
        # contrôle qualité : plages physiquement plausibles (choix d'analyse documenté) — hors plage = mesure invalide, exclue, comptée
        # packs « 20 » ≈ 5 éléments Li-polymère (21 V chargé), packs « 40 » ≈ 10 éléments (42 V) : V ∈ [0,6 ; 1,05] × V_plein ;
        # températures (unité non documentée, ≈ 75 au départ → °F probable) : [20 ; 200] ; courants : [−10 ; 100] A.
        valid = {}
        for k, v in X.items():
            if k.endswith("V") and k[-3:-1] in ("20", "40"):
                vmax = 21.0 if k[-3:-1] == "20" else 42.0
                valid[k] = (v > 0.6 * vmax) & (v < 1.05 * vmax)
            elif k.endswith("T"):
                valid[k] = (v > 20) & (v < 200)
            elif k.endswith("C"):
                valid[k] = (v > -10) & (v < 100)
            r[f"invalid_pct_{k}"] = float(100 * (1 - valid[k].mean())) if k in valid else 0.0
        for p in HIRF_PACKS + ["LRF20", "URA20"]:
            if p + "V" in X:
                v, ok = X[p + "V"], valid[p + "V"]
                n5 = int(5 / dt)
                r[f"{p}_V_start"] = float(np.median(v[:n5][ok[:n5]])) if ok[:n5].any() else np.nan
                r[f"{p}_V_end"] = float(np.median(v[-n5:][ok[-n5:]])) if ok[-n5:].any() else np.nan
                r[f"{p}_V_min"] = float(np.nanmin(v[ok])) if ok.any() else np.nan
            if p + "C" in X:
                c = np.where(valid[p + "C"], X[p + "C"], 0.0)
                ah = np.concatenate([[0], np.cumsum(np.clip(c[1:], 0, None) * np.diff(t))]) / 3600
                r[f"{p}_Ah"] = float(ah[-1])
                r[f"{p}_C_max"] = float(np.nanmax(c))
                if p + "V" in X:
                    v, ok = X[p + "V"], valid[p + "V"] & valid[p + "C"]
                    r[f"{p}_Wh"] = float(np.trapezoid(np.where(ok, np.clip(c, 0, None) * v, 0), t) / 3600)
                    # résistance interne apparente : V = E0 − R·I − k·Ah (la décharge cumulée absorbe la baisse de tension à vide)
                    m = ok & (c > 2)
                    if m.sum() > 2000:
                        A = np.vstack([c[m], ah[m], np.ones(m.sum())]).T
                        coef = np.linalg.lstsq(A, v[m], rcond=None)[0]
                        r[f"{p}_R_ohm"] = float(-coef[0])
                        r[f"{p}_dVdAh"] = float(coef[1])
            if p + "T" in X:
                T, ok = X[p + "T"], valid[p + "T"]
                n5 = int(5 / dt)
                r[f"{p}_T_start"] = float(np.median(T[:n5][ok[:n5]])) if ok[:n5].any() else np.nan
                r[f"{p}_T_max"] = float(np.nanpercentile(T[ok], 99.5)) if ok.any() else np.nan  # percentile 99,5 : robuste aux pics isolés
                r[f"{p}_T_rise"] = r[f"{p}_T_max"] - r[f"{p}_T_start"]
        # perturbations ponctuelles (pics) : |Δx| > 8 × MAD(Δx) sur les tensions et températures (signature possible des champs HIRF)
        sp = 0
        for k, v in X.items():
            if k.endswith(("V", "T")) and k != "RPM":
                dv = np.diff(v)
                mad = np.median(np.abs(dv - np.median(dv))) * 1.4826
                if mad > 0:
                    sp += int((np.abs(dv) > 8 * mad + 0.05 * (np.nanmax(v) - np.nanmin(v))).sum())
        r["spikes_V_T"] = sp
        runs.append(r)
        # série rééchantillonnée (moyenne par fenêtre de step_s)
        w = np.floor(t / step_s).astype(int)
        df = pd.DataFrame({"w": w, **{k: np.where(valid.get(k, np.ones_like(v, bool)), v, np.nan) for k, v in X.items()}}).groupby("w").mean()
        df.insert(0, "t_s", df.index * step_s)
        df.insert(0, "run", run)
        series.append(df.reset_index(drop=True))
        if "BHM" in d._fieldnames:
            B = d.BHM
            bt = np.asarray(B.t, float)
            bd = {"run": run, "t_s": bt}
            for p in ("LLF", "ULA", "LRF", "URA"):
                for q in ("EOD", "RUL", "SOC"):
                    a = np.asarray(getattr(B, f"{p}_{q}"), float)
                    a = a.reshape(len(bt), -1)
                    bd[f"{p}_{q}_med"] = np.nanmedian(a, axis=1)
                    bd[f"{p}_{q}_p05"] = np.nanpercentile(a, 5, axis=1)
                    bd[f"{p}_{q}_p95"] = np.nanpercentile(a, 95, axis=1)
                bd[f"{p}_V_est"] = np.asarray(getattr(B, f"{p}_V_est"), float).reshape(len(bt))
            bb = pd.DataFrame(bd)
            bb = bb.iloc[:: max(1, int(round(step_s / max(1e-9, np.median(np.diff(bt))))))]
            bhm.append(bb)
        print(f"HIRF {run} : {r['duration_s']:.0f} s", flush=True)
    R = pd.DataFrame(runs)
    R.to_csv(os.path.join(PROCESSED, "hirf_runs.csv"), index=False)
    S = pd.concat(series, ignore_index=True)
    S.to_csv(os.path.join(PROCESSED, "hirf_series_10s.csv"), index=False)
    if bhm:
        pd.concat(bhm, ignore_index=True).to_csv(os.path.join(PROCESSED, "hirf_bhm_10s.csv"), index=False)
    return {"runs": len(R), "series_rows": len(S)}
