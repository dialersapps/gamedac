// node tools/build.mjs : generates gamedac.js (UMD / script-tag build) from gamedac.mjs (the source of truth).
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'gamedac.mjs'), 'utf8');
const strict = src.indexOf("'use strict';"), marker = src.indexOf('/* ---- exports ---- */');
if (strict < 0 || marker < 0) throw new Error('markers not found in gamedac.mjs');
const header = src.slice(0, strict), body = src.slice(strict + "'use strict';".length, marker);
const out = header + `(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.gamedac = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';` + body + `return api;
}));
`;
fs.writeFileSync(path.join(root, 'gamedac.js'), out);
console.log('gamedac.js written, ' + out.length + ' bytes');