#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MarsRover Health — génération / conversion reproductible des jeux de données.

Deux familles :
  1. CONVERSION des ressources FOURNIES (aucune valeur modifiée) :
     - degradation_vibration.csv  (Exemples de scripts / Estimation RUL par extrapolation)  -> SIMULÉ
     - reliability_data.mat (500 obs.) (Estimation non paramétrique)                        -> SIMULÉ
     - DataReal.m : 23 durées de roulements (valeurs recopiées du script)                     -> EXPÉRIMENTAL
     - EtudeCas_KM.m : 20 durées « détecteurs incendie » (valeurs recopiées du script)        -> SIMULÉ (source non documentée)
  2. GÉNÉRATION de données de démonstration SIMULÉES (graine fixe, jamais présentées comme réelles) :
     - rover_telemetry_sim.csv : télémétrie rover synthétique avec anomalies injectées et étiquetées
     - battery_packs_sim.csv   : vieillissement synthétique de packs Li-ion (fin de vie = 80 % C0)
     - rover_events_sim.csv    : journal d'événements synthétique (pannes / indisponibilités)

Usage :  python3 tools/gen_datasets.py      (écrit data/datasets/*.csv et data/datasets.js)
"""
import json, math, os, sys
import numpy as np

SEED = 20261106
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "sources")
OUT = os.path.join(ROOT, "data", "datasets")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(SEED)

def write_csv(name, header, rows):
    p = os.path.join(OUT, name)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(",".join(header) + "\n")
        for r in rows:
            f.write(",".join("" if v is None else (f"{v:.4f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)) for v in r) + "\n")
    return p

# ---------------------------------------------------------------- 1. conversions
def conv_vibration():
    src = os.path.join(SRC, "degradation_vibration.csv")
    txt = open(src, encoding="utf-8-sig").read().strip().splitlines()
    open(os.path.join(OUT, "degradation_vibration.csv"), "w", encoding="utf-8").write("\n".join(txt) + "\n")
    return len(txt) - 1

def conv_rel500():
    import scipy.io as sio
    m = sio.loadmat(os.path.join(SRC, "reliability_data_500.mat"))
    T = m["T_obs"].ravel().astype(float); C = m["C_ind"].ravel().astype(int)
    rows = [[f"U{i+1:03d}", float(t), int(c)] for i, (t, c) in enumerate(zip(T, C))]
    write_csv("reliability_500_sim.csv", ["unit_id", "T_obs_h", "event_1_panne_0_censure"], rows)
    return len(rows), int(C.sum())

def check_corrupt():
    import scipy.io as sio
    m = sio.loadmat(os.path.join(SRC, "reliability_data_RUL_corrompu.mat"))
    t = m["T_obs"]
    return str(t.dtype), int(m["C_ind"].sum()), len(t)

LZ_T = [17.88, 28.92, 33.00, 41.52, 42.12, 45.60, 48.48, 51.84, 51.96, 54.12, 55.56, 67.80, 68.64,
        68.64, 68.88, 84.12, 93.12, 98.64, 105.12, 105.84, 127.92, 128.04, 173.40]
LZ_E = [1]*22 + [0]
FIRE_T = [3, 5, 5, 7, 8, 9, 10, 10, 12, 15, 15, 16, 18, 20, 22, 24, 24, 26, 28, 30]
FIRE_E = [1,1,0,1,1,0,1,0,1,1,0,1,1,0,1,0,1,0,0,0]

def conv_small():
    write_csv("bearings_datareal_exp.csv", ["unit_id", "T_obs_Mcycles", "event_1_panne_0_censure"],
              [[f"B{i+1:02d}", t, e] for i, (t, e) in enumerate(zip(LZ_T, LZ_E))])
    write_csv("fire_detectors_demo.csv", ["unit_id", "T_obs_mois", "event_1_panne_0_censure"],
              [[f"D{i+1:02d}", t, e] for i, (t, e) in enumerate(zip(FIRE_T, FIRE_E))])

# ---------------------------------------------------------------- 2. télémétrie simulée
def gen_telemetry():
    dt = 2.0                       # h
    N = 1500                       # 3000 h ≈ 122 sols
    SOL = 24.66
    t = np.arange(N) * dt
    sol = np.floor(t / SOL).astype(int) + 1
    hour_of_sol = (t % SOL) / SOL
    T_amb = -45 + 35 * np.sin(2 * np.pi * (hour_of_sol - 0.3))          # °C, cycle diurne simplifié
    # mode opératoire : conduite le jour 1 sol sur 2, bras les autres jours, sinon repos
    op = np.array(["idle"] * N, dtype=object)
    day = (hour_of_sol > 0.38) & (hour_of_sol < 0.62)
    op[day & (sol % 2 == 0)] = "drive"
    op[day & (sol % 2 == 1) & (sol % 5 != 0)] = "arm"
    op[(hour_of_sol > 0.70) & (hour_of_sol < 0.74)] = "comm"
    terrain = np.array(["nominal"] * N, dtype=object)
    for s in range(1, sol.max() + 1):
        r = rng.random()
        if r < 0.20: terrain[sol == s] = "pente"
        elif r < 0.32: terrain[sol == s] = "sable"
    tf = np.where(terrain == "pente", 1.45, np.where(terrain == "sable", 1.30, 1.0))
    drive = (op == "drive").astype(float)
    labels = {}

    # moteurs de roue
    cur = {}; tmp = {}
    for i in range(1, 7):
        base = 0.55 + 0.04 * (i - 3.5) ** 2 / 6
        I = drive * (base * tf + rng.normal(0, 0.04, N)) + (1 - drive) * np.abs(rng.normal(0.02, 0.005, N))
        cur[i] = I
    # ANOMALIE 1 : dérive progressive du courant moteur roue 3 à partir de t = 2100 h (frottement croissant)
    on = t >= 2100
    cur[3] = cur[3] + drive * on * (0.0009 * (t - 2100)) * 0.55
    labels["label_motor3_drift"] = (on & (drive > 0)).astype(int)
    for i in range(1, 7):
        heat = 30 * cur[i] ** 2
        tmp[i] = np.maximum(T_amb, -40) + heat + rng.normal(0, 1.2, N)   # chauffage de survie ≥ -40 °C
    # odométrie et heures moteur
    speed_kmh = 0.03                                                     # vitesse moyenne de conduite (démo)
    odo = np.cumsum(drive * speed_kmh * dt)
    # bras robotique
    arm = (op == "arm").astype(float)
    arm_I = arm * (1.1 + rng.normal(0, 0.08, N)) + (1 - arm) * 0.01
    # ANOMALIE 2 : surcharge ponctuelle du bras (blocage) sur 3 fenêtres
    lab_arm = np.zeros(N, int)
    for c in [820, 1630, 2560]:
        w = (t >= c) & (t < c + 8) & (arm > 0)
        if not w.any():                                   # garantit l'occurrence pendant une opération bras
            idx = np.where((arm > 0) & (t >= c))[0][:4]; w = np.zeros(N, bool); w[idx] = True
        arm_I[w] += 1.6 + rng.normal(0, 0.1, w.sum()); lab_arm[w] = 1
    labels["label_arm_overload"] = lab_arm
    arm_cycles = np.cumsum(arm * 6)                                      # 6 mouvements / pas de 2 h (démo)
    # batterie
    soc = 0.85 - 0.25 * drive - 0.12 * arm + 0.05 * np.sin(2 * np.pi * hour_of_sol)
    vbat = 26.5 + 6.0 * soc + rng.normal(0, 0.08, N) - 0.0002 * t        # légère perte de tension (vieillissement)
    lab_v = np.zeros(N, int)
    for c in [1210, 2740]:                                               # ANOMALIE 3 : chute de tension
        w = (t >= c) & (t < c + 10); vbat[w] -= 3.2; lab_v[w] = 1
    labels["label_bat_voltage_drop"] = lab_v
    tbat = np.maximum(T_amb + 30, -10) + 4 * drive + rng.normal(0, 0.6, N)
    # contrôle thermique / avionique
    tav = 20 + 2.0 * np.sin(2 * np.pi * hour_of_sol) + rng.normal(0, 0.5, N)
    heater = np.clip(60 - 1.2 * (T_amb + 45), 5, 110) + rng.normal(0, 2, N)
    lab_th = np.zeros(N, int)
    w = (t >= 1820) & (t < 1880)                                          # ANOMALIE 4 : réchauffeur bloqué ON
    tav[w] += 13 * (1 - np.exp(-(t[w] - 1820) / 12)); heater[w] = 115; lab_th[w] = 1
    labels["label_thermal_heater_stuck"] = lab_th
    # communications
    planned = ((hour_of_sol < 0.66) | (hour_of_sol > 0.78)).astype(int)  # hors fenêtre de passage orbiteur = coupure planifiée
    link = np.where(planned == 1, np.nan, 6.0 + rng.normal(0, 0.7, N))
    lab_c = np.zeros(N, int)
    for c in [900, 2300, 2900]:                                          # ANOMALIE 5 : perte de liaison non planifiée
        w = (t >= c - 30) & (t < c + 30) & (planned == 0)
        link[w] = -4 + rng.normal(0, 0.5, w.sum()); lab_c[w] = 1
    labels["label_comm_unplanned_loss"] = lab_c
    # calculateur
    cpu = 35 + 0.3 * (T_amb + 45) / 10 + 6 * drive + rng.normal(0, 0.8, N)
    # capteur hazcam (température capteur)
    haz = np.maximum(T_amb, -55) + 8 + rng.normal(0, 0.9, N)
    lab_h = np.zeros(N, int)
    w = (t >= 2450) & (t < 2620)                                          # ANOMALIE 6 : valeur figée
    haz[w] = round(float(haz[np.where(w)[0][0]]), 2); lab_h[w] = 1
    labels["label_hazcam_stuck"] = lab_h
    mast = np.maximum(T_amb, -50) + 5 + 3 * (op == "comm") + rng.normal(0, 1.0, N)

    header = ["time_h", "sol", "op_mode", "terrain"] + [f"motor{i}_current_A" for i in range(1, 7)] + \
             [f"motor{i}_temp_C" for i in range(1, 7)] + \
             ["bat_voltage_V", "bat_temp_C", "avionics_temp_C", "heater_power_W", "link_margin_dB", "comm_planned_blackout",
              "cpu_temp_C", "hazcam_temp_C", "arm_current_A", "mast_temp_C", "odometry_km", "arm_cycles", "ambient_temp_C"] + list(labels)
    rows = []
    for k in range(N):
        r = [float(t[k]), int(sol[k]), op[k], terrain[k]] + [float(cur[i][k]) for i in range(1, 7)] + \
            [float(tmp[i][k]) for i in range(1, 7)] + \
            [float(vbat[k]), float(tbat[k]), float(tav[k]), float(heater[k]),
             (None if np.isnan(link[k]) else float(link[k])), int(planned[k]), float(cpu[k]), float(haz[k]),
             float(arm_I[k]), float(mast[k]), float(odo[k]), int(arm_cycles[k]), float(T_amb[k])] + [int(labels[n][k]) for n in labels]
        rows.append(r)
    write_csv("rover_telemetry_sim.csv", header, rows)
    return N, float(odo[-1]), int(arm_cycles[-1])

def gen_battery():
    rows = []
    C0 = 40.0
    packs = [("P01", 0.0021), ("P02", 0.0018), ("P03", 0.0024), ("P04", 0.0020), ("P05", 0.0017), ("P06", 0.0022), ("P07", 0.0019)]
    for pid, a in packs:
        b = 0.75 + rng.normal(0, 0.03)
        n = 1
        while True:
            fade = a * n ** b
            cap = C0 * (1 - fade) + rng.normal(0, 0.12)
            r_int = 0.050 * (1 + 1.6 * fade) + rng.normal(0, 0.0008)
            temp = 18 + 2 * math.sin(n / 30) + rng.normal(0, 0.5)
            rows.append([pid, n, cap, r_int, temp])
            if (1 - fade) <= 0.795 or n > 3000: break
            n += 5
    # pack « rover » en cours d'usage : censuré (non arrivé en fin de vie)
    a, b = 0.0015, 0.76
    for n in range(1, 520, 5):
        fade = a * n ** b
        rows.append(["ROVER_PACK", n, C0 * (1 - fade) + rng.normal(0, 0.12), 0.050 * (1 + 1.6 * fade) + rng.normal(0, 0.0008), 18 + rng.normal(0, 0.5)])
    write_csv("battery_packs_sim.csv", ["pack_id", "cycle", "capacity_Ah", "r_internal_ohm", "temp_C"], rows)
    return len(rows)

def gen_events():
    rows = []; k = 1
    tmax = 3000.0
    def add(comp, typ, start, dur, desc):
        nonlocal k
        rows.append([f"E{k:03d}", comp, typ, round(start, 2), round(start + dur, 2), desc]); k += 1
    # redémarrages calculateur : processus de Poisson (MTBF « vrai » simulé = 600 h), durée lognormale
    t = 0.0
    while True:
        t += rng.exponential(600.0)
        if t > tmax: break
        add("computer", "panne", t, float(rng.lognormal(math.log(1.5), 0.4)), "Redémarrage logiciel non commandé (simulé)")
    # pertes de liaison non planifiées
    for c in [900, 2300, 2900]:
        add("comms", "panne", c - 30, 60.0, "Perte de liaison non planifiée (simulée)")
    # indisponibilités planifiées (conjonction solaire raccourcie, maintenance logicielle)
    add("comms", "planifiee", 1400.0, 48.0, "Indisponibilité planifiée (simulée)")
    add("computer", "planifiee", 2000.0, 6.0, "Mise à jour logicielle planifiée (simulée)")
    write_csv("rover_events_sim.csv", ["event_id", "component_id", "type", "start_h", "end_h", "description"], rows)
    return len(rows)

def build_embed(meta):
    """data/datasets.js : copie embarquée pour l'ouverture en file:// (fetch interdit)."""
    emb = {}
    for m in meta:
        emb[m["id"]] = {"meta": m, "csv": open(os.path.join(OUT, m["file"]), encoding="utf-8").read()}
    with open(os.path.join(ROOT, "data", "datasets.js"), "w", encoding="utf-8") as f:
        f.write("/* Généré par tools/gen_datasets.py — NE PAS ÉDITER À LA MAIN. Copie embarquée des CSV de data/datasets/ */\n")
        f.write("window.MRH_EMBEDDED_DATASETS = " + json.dumps(emb, ensure_ascii=False) + ";\n")

if __name__ == "__main__":
    n_vib = conv_vibration(); n500, f500 = conv_rel500(); corrupt = check_corrupt(); conv_small()
    n_tel, odo, armc = gen_telemetry(); n_bat = gen_battery(); n_ev = gen_events()
    meta = json.load(open(os.path.join(ROOT, "data", "datasets_meta.json"), encoding="utf-8"))
    build_embed(meta)
    print(json.dumps({"vibration_rows": n_vib, "rel500": [n500, f500], "corrupt_mat": corrupt, "telemetry_rows": n_tel,
                      "odometry_km_end": round(odo, 2), "arm_cycles_end": armc, "battery_rows": n_bat, "events": n_ev, "seed": SEED}, ensure_ascii=False))
