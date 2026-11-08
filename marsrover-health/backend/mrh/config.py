"""Configuration centrale du backend (chemins, graine, seuils techniques documentés)."""
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # .../backend
DATA = os.path.join(BASE, "data")
RAW = os.path.join(DATA, "raw")
PROCESSED = os.path.join(DATA, "processed")
MODELS = os.path.join(BASE, "models")
DB_PATH = os.environ.get("MRH_DB", os.path.join(DATA, "mrh.sqlite"))
APP_ROOT = os.path.dirname(BASE)  # racine de l'application web (index.html)
SNAPSHOT_JS = os.path.join(APP_ROOT, "data", "ml_snapshot.js")

SEED = 20261107

# Provenance (mêmes catégories que le frontend)
PROV_EXPERIMENTAL = "experimental"   # mesures de laboratoire (NASA Ames / UC Berkeley)
PROV_SIMULATED = "simulated"         # simulation (C-MAPSS, télémétrie rover)
PROV_SUBSTITUTED = "substituted"     # transfert d'un analogue vers un composant rover (non validé)

# ---- Seuils techniques (sources indiquées ; modifiables) -------------------------------------
RUL_CAP = 125            # plafond RUL linéaire par morceaux, C-MAPSS (Heimes 2008 ; Babu et al. 2016)
RISK_RUL = 30            # fenêtre « à risque » : RUL ≤ 30 cycles (convention PHM08 / littérature C-MAPSS)
CMAPSS_SENSORS = ["s2", "s3", "s4", "s7", "s8", "s9", "s11", "s12", "s13", "s14", "s15", "s17", "s20", "s21"]
CMAPSS_SENSOR_INFO = {  # nom, unité (Saxena et al. 2008, tableau 2)
    "s2": ("T24 — température sortie LPC", "°R"), "s3": ("T30 — température sortie HPC", "°R"),
    "s4": ("T50 — température sortie LPT", "°R"), "s7": ("P30 — pression sortie HPC", "psia"),
    "s8": ("Nf — vitesse physique fan", "rpm"), "s9": ("Nc — vitesse physique core", "rpm"),
    "s11": ("Ps30 — pression statique HPC", "psia"), "s12": ("phi — débit carburant / Ps30", "pps/psi"),
    "s13": ("NRf — vitesse corrigée fan", "rpm"), "s14": ("NRc — vitesse corrigée core", "rpm"),
    "s15": ("BPR — taux de dilution", "—"), "s17": ("htBleed — enthalpie de prélèvement", "—"),
    "s20": ("W31 — débit de refroidissement HPT", "lbm/s"), "s21": ("W32 — débit de refroidissement LPT", "lbm/s"),
}
VB_CLASSES = [  # ISO 3685:1993 — critère de durée de vie outil : VB_B = 0,3 mm (moyenne), VB_B,max = 0,6 mm
    (0.0, 0.3, "normal", "Fonctionnement normal (VB < 0,3 mm)"),
    (0.3, 0.6, "usure_critique", "Usure critique — fin de vie ISO 3685 (0,3 ≤ VB < 0,6 mm)"),
    (0.6, 99, "defaut_mecanique", "Défaut mécanique — usure sévère (VB ≥ 0,6 mm)"),
]
BATTERY_EOL_AH = 1.4      # critère EOL du jeu NASA : 30 % de perte sur 2,0 Ah nominal
BATTERY_MIN_C0 = 1.7      # cellules retenues pour la fiabilité : capacité initiale ≥ 1,7 Ah (cellules saines au départ)
ANOMALY_PERSIST = 3       # anomalie persistante : ≥ 3 observations consécutives au-dessus du seuil
MIN_REPAIRS_MTTR_MODEL = 30   # minimum de réparations terminées pour entraîner un modèle MTTR
MIN_PERIODS_AVAIL_MODEL = 24  # minimum de périodes (ex. mois × équipement) pour prédire la disponibilité
