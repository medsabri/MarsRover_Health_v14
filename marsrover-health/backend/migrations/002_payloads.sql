-- Résultats agrégés par module, produits à l'entraînement et relus par l'API / le tableau de bord
-- (le tableau de bord ne réentraîne jamais un modèle et ne refait aucun calcul lourd).
CREATE TABLE IF NOT EXISTS module_payload (
  module TEXT PRIMARY KEY,
  computed_at TEXT NOT NULL,
  payload TEXT NOT NULL            -- JSON
);
