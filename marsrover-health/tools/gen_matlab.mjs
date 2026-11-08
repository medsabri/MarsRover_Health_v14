// Écrit le projet matlab/ statique (mêmes scripts que ceux générés dans l'application).
import fs from 'fs'; import path from 'path';
import { matlabFiles, MATLAB_README } from '../src/core/matlab.js';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const F = matlabFiles();
fs.mkdirSync(path.join(root, 'matlab/scripts'), { recursive: true }); fs.mkdirSync(path.join(root, 'matlab/data'), { recursive: true }); fs.mkdirSync(path.join(root, 'matlab/results'), { recursive: true });
for (const [n, c] of Object.entries(F)) fs.writeFileSync(path.join(root, 'matlab/scripts', n), c);
fs.writeFileSync(path.join(root, 'matlab/README.md'), MATLAB_README);
for (const f of fs.readdirSync(path.join(root, 'data/datasets'))) if (f.endsWith('.csv')) fs.copyFileSync(path.join(root, 'data/datasets', f), path.join(root, 'matlab/data', f));
fs.writeFileSync(path.join(root, 'matlab/results/.gitkeep'), '');
console.log('matlab/ :', Object.keys(F).join(', '));
