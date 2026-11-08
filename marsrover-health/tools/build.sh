#!/usr/bin/env bash
# Construction de MarsRover Health (à relancer après modification de src/ ou data/*.json)
set -euo pipefail
cd "$(dirname "$0")/.."
# 1. configuration embarquée (ouverture file://)
python3 - <<'PY'
import json
comp=json.load(open('data/components.json',encoding='utf-8')); fm=json.load(open('data/fmeca.json',encoding='utf-8'))
open('data/components.js','w',encoding='utf-8').write('/* Généré par tools/build.sh depuis data/components.json et data/fmeca.json — éditer les .json puis relancer le build */\nwindow.MRH_CONFIG = '+json.dumps({'components':comp,'fmeca':fm},ensure_ascii=False)+';\n')
PY
# 2. modèle 3D embarqué en base64 (file://)
if [ ! -f assets/models/perseverance.glb.js ] || [ assets/models/perseverance.glb -nt assets/models/perseverance.glb.js ]; then
  python3 -c "import base64;open('assets/models/perseverance.glb.js','w').write('/* GLB Perseverance (fourni) encodé en base64 pour file:// */\nwindow.MRH_GLB_B64=\"'+base64.b64encode(open('assets/models/perseverance.glb','rb').read()).decode()+'\";\n')"
fi
# 3. bundle JavaScript (IIFE, compatible file://)
npx esbuild src/main.js --bundle --format=iife --target=es2020 --minify --sourcemap --legal-comments=none --outfile=assets/js/app.bundle.js --log-level=warning
echo "Build OK : $(du -h assets/js/app.bundle.js | cut -f1) bundle"
