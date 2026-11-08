-- MarsRover Health — schéma FMDS / ML (SQLite 3)
-- Conventions :
--   * toute table de résultats porte : equipment_id, computed_at (ISO 8601 UTC), algorithm, model_version,
--     value, unit, status, validation (JSON : jeu, split, métriques de référence), provenance ;
--   * provenance ∈ ('mission','experimental','simulated','substituted') — jamais de valeur inventée ;
--   * les mesures brutes ne sont jamais écrasées (tables append-only, sauf fmea éditable et tracée).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS equipment (
  equipment_id   TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,              -- turbofan | outil_fraisage | batterie_li_ion | igbt | composant_rover
  subsystem      TEXT,
  dataset        TEXT NOT NULL,              -- identifiant du jeu de données source
  provenance     TEXT NOT NULL CHECK (provenance IN ('mission','experimental','simulated','substituted')),
  time_unit      TEXT NOT NULL,              -- cycle | min | s | h | décharge
  rover_analog   TEXT,                       -- composant rover analogue (transfert NON validé)
  meta           TEXT                        -- JSON (conditions d'essai, fichier d'origine…)
);

CREATE TABLE IF NOT EXISTS sensor_data (
  id             INTEGER PRIMARY KEY,
  equipment_id   TEXT NOT NULL REFERENCES equipment(equipment_id),
  t              REAL NOT NULL,              -- instant dans l'unité equipment.time_unit
  variable       TEXT NOT NULL,
  value          REAL,                       -- NULL = valeur manquante (jamais imputée en base)
  unit           TEXT,
  qc_flag        TEXT DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS ix_sensor_eq_t ON sensor_data(equipment_id, t);
CREATE INDEX IF NOT EXISTS ix_sensor_eq_var ON sensor_data(equipment_id, variable);

CREATE TABLE IF NOT EXISTS operating_history (
  id INTEGER PRIMARY KEY,
  equipment_id   TEXT NOT NULL REFERENCES equipment(equipment_id),
  t_start REAL, t_end REAL, unit TEXT,
  usage_value REAL, usage_unit TEXT,         -- cycles cumulés, minutes de coupe, décharges…
  conditions TEXT                            -- JSON (régime, température ambiante, profondeur de passe…)
);
CREATE INDEX IF NOT EXISTS ix_oper_eq ON operating_history(equipment_id);

CREATE TABLE IF NOT EXISTS failure_history (
  id INTEGER PRIMARY KEY,
  equipment_id   TEXT NOT NULL REFERENCES equipment(equipment_id),
  t_event        REAL NOT NULL,              -- durée observée (défaillance ou censure)
  unit           TEXT NOT NULL,
  event          INTEGER NOT NULL CHECK (event IN (0,1)),   -- 1 = défaillance observée, 0 = censure à droite
  failure_mode   TEXT,
  criterion      TEXT NOT NULL,              -- définition opérationnelle de la défaillance / fin de vie
  provenance     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_fail_eq ON failure_history(equipment_id);

CREATE TABLE IF NOT EXISTS maintenance_history (
  id INTEGER PRIMARY KEY,
  equipment_id   TEXT NOT NULL REFERENCES equipment(equipment_id),
  type           TEXT NOT NULL CHECK (type IN ('panne','planifiee','preventive','corrective')),
  t_start REAL NOT NULL, t_end REAL,         -- t_end NULL = réparation non terminée (exclue du MTTR)
  unit TEXT NOT NULL DEFAULT 'h',
  failure_type TEXT, severity INTEGER, complexity INTEGER, spare_parts_available INTEGER,
  provenance     TEXT NOT NULL,
  source         TEXT
);
CREATE INDEX IF NOT EXISTS ix_maint_eq ON maintenance_history(equipment_id);

-- ---------------------------------------------------------------- résultats analytiques
CREATE TABLE IF NOT EXISTS anomaly_history (
  id INTEGER PRIMARY KEY,
  equipment_id TEXT NOT NULL, computed_at TEXT NOT NULL, algorithm TEXT NOT NULL, model_version TEXT NOT NULL,
  t_start REAL NOT NULL, t_end REAL NOT NULL, unit TEXT NOT NULL,
  value REAL NOT NULL,                       -- score d'anomalie maximal sur l'épisode
  threshold REAL NOT NULL,
  sensors TEXT,                              -- JSON : capteurs les plus contributifs (z-score)
  priority TEXT NOT NULL,                    -- haute | moyenne | basse (règle documentée)
  status TEXT NOT NULL DEFAULT 'a_verifier',
  validation TEXT, provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_anom_eq ON anomaly_history(equipment_id, computed_at);

CREATE TABLE IF NOT EXISTS diagnosis_results (
  id INTEGER PRIMARY KEY,
  equipment_id TEXT NOT NULL, computed_at TEXT NOT NULL, algorithm TEXT NOT NULL, model_version TEXT NOT NULL,
  t REAL, unit TEXT,
  value TEXT NOT NULL,                       -- classe prédite
  probabilities TEXT NOT NULL,               -- JSON {classe: p}
  confidence REAL NOT NULL,
  true_label TEXT,                           -- vérité terrain si mesurée (VB), sinon NULL
  contributors TEXT,                         -- JSON variables contributives
  status TEXT NOT NULL, validation TEXT, provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_diag_eq ON diagnosis_results(equipment_id);

CREATE TABLE IF NOT EXISTS reliability_results (
  id INTEGER PRIMARY KEY,
  equipment_id TEXT NOT NULL,                -- équipement ou population (ex. 'POP:CMAPSS')
  computed_at TEXT NOT NULL, algorithm TEXT NOT NULL, model_version TEXT NOT NULL,
  quantity TEXT NOT NULL,                    -- beta | eta | R(t) | MTTF | c_index | ibs …
  t REAL, value REAL, unit TEXT, ci_low REAL, ci_high REAL,
  status TEXT NOT NULL, validation TEXT, provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rel_eq ON reliability_results(equipment_id, quantity);

CREATE TABLE IF NOT EXISTS rul_predictions (
  id INTEGER PRIMARY KEY,
  equipment_id TEXT NOT NULL, computed_at TEXT NOT NULL, algorithm TEXT NOT NULL, model_version TEXT NOT NULL,
  t REAL NOT NULL,                           -- instant de prédiction (cycle)
  value REAL NOT NULL, unit TEXT NOT NULL,   -- RUL prédite
  true_value REAL,                           -- RUL réelle quand connue (jeu de test)
  health_index REAL,
  status TEXT NOT NULL, validation TEXT, provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rul_eq ON rul_predictions(equipment_id, algorithm, t);

CREATE TABLE IF NOT EXISTS availability_results (
  id INTEGER PRIMARY KEY,
  equipment_id TEXT NOT NULL, computed_at TEXT NOT NULL, algorithm TEXT NOT NULL, model_version TEXT NOT NULL,
  quantity TEXT NOT NULL,                    -- MTBF | MTTR | Ai | Ao | downtime | MTTR_pred | A_pred
  nature TEXT NOT NULL CHECK (nature IN ('historique','prevision')),
  period TEXT, value REAL, unit TEXT,
  status TEXT NOT NULL, validation TEXT, provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_avail_eq ON availability_results(equipment_id, quantity);

CREATE TABLE IF NOT EXISTS fmea (
  fmea_id TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL, subsystem TEXT, mode TEXT NOT NULL, cause TEXT, effect TEXT, detection TEXT,
  G INTEGER NOT NULL CHECK (G BETWEEN 1 AND 10), O INTEGER NOT NULL CHECK (O BETWEEN 1 AND 10), D INTEGER NOT NULL CHECK (D BETWEEN 1 AND 10),
  NPR INTEGER GENERATED ALWAYS AS (G * O * D) STORED,
  mitigation TEXT, source TEXT, updated_at TEXT NOT NULL, updated_by TEXT
);

CREATE TABLE IF NOT EXISTS fta_events (
  event_id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('top','intermediate','basic')),
  gate TEXT CHECK (gate IN ('AND','OR') OR gate IS NULL),
  parent_id TEXT REFERENCES fta_events(event_id),
  probability REAL CHECK (probability IS NULL OR (probability >= 0 AND probability <= 1)),
  prob_source TEXT,                          -- origine de la probabilité (calcul Weibull, saisie…) ; NULL = non renseignée
  horizon TEXT, equipment_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_fta_tree ON fta_events(tree_id);

-- ---------------------------------------------------------------- gestion des modèles
CREATE TABLE IF NOT EXISTS model_registry (
  model_id TEXT PRIMARY KEY,                 -- <module>:<algo>:v<n>
  module TEXT NOT NULL, algorithm TEXT NOT NULL, version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('non_entraine','attente_donnees','entrainement','entraine','valide','erreur')),
  dataset TEXT, provenance TEXT, target TEXT, unit TEXT,
  hyperparams TEXT, features TEXT, split TEXT,
  n_train INTEGER, n_val INTEGER, n_test INTEGER,
  train_time_s REAL, predict_time_ms REAL,
  artifact TEXT, data_hash TEXT,
  validation_rule TEXT, message TEXT,
  created_at TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_reg_module ON model_registry(module, algorithm, version);

CREATE TABLE IF NOT EXISTS model_evaluation (
  id INTEGER PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES model_registry(model_id),
  split TEXT NOT NULL,                       -- cv | validation | test
  metric TEXT NOT NULL, value REAL, computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_eval_model ON model_evaluation(model_id);

CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY,
  equipment_id TEXT NOT NULL, generated_at TEXT NOT NULL,
  rule_id TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT NOT NULL,   -- JSON : résultats analytiques liés (table, id, valeur)
  priority TEXT NOT NULL, action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'a_valider' CHECK (status IN ('a_valider','validee','rejetee')),
  validated_by TEXT, validated_at TEXT, comment TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL, detail TEXT
);
