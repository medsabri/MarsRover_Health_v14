# Guide d'utilisation (court)

1. **Ouvrir** `index.html` (ou `python3 -m http.server 8765`). La barre d'outils donne accès aux 9 sous-interfaces, au dataset de fiabilité actif, au filtre de provenance, à l'import, au thème et à l'état global.
2. **Accueil 3D** : cliquer une pièce ou une étiquette → panneau de détail (état, mesures, tendance, alertes, justification, RUL ou motif de masquage). Curseur « Instant d'analyse » pour rejouer l'historique. Vue éclatée, glisser-déposer d'un autre `.glb`.
3. **Tableau de bord** : choisir le sous-système, la variable et la période ; lire l'interprétation (fait / estimation / limite) ; éditer les cotations AMDEC ; exporter alertes, AMDEC et synthèse ; poser une question à l'assistant de correction.
4. **Maintenance** : sélectionner un composant. Paramétrique → courbes, verdict, plan. Non paramétrique → choisir la source de forme, l'interprétation de la durée nominale et R*, lire les hypothèses et la sensibilité, exporter le dataset dérivé et le plan (CSV / imprimable PDF).
5. **Catalogue** : comparer nominal et actuel, éditer durée et seuils (sauvegarde locale, export `components.json`).
6. **Perturbations** : composant, type, intensité, durée, début → avant/après, détection, propagation 3D ; sauvegarder et comparer des scénarios.
7. **Terrain** : régler cratère, pente, virage, rochers, sable → Simuler, Lecture ; « Appliquer l'impact » répercute surcharge/glissement et usage équivalent sur tous les modules.
8. **Données** : importer (provenance obligatoire, mapping), consulter fiches, dictionnaire, journal, ressources et limites.
9. **MATLAB** : télécharger le projet, exécuter `run_all.m`, réimporter `results/mrh_results.json` et les PNG.
10. **Assistant** : « aide », « que faire ? », « diagnostic roue 3 », « RUL batterie », « MTBF calculateur », « criticité », « limites ».
