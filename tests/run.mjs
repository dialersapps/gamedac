// node tests/run.mjs   (Node 18+). Exits 1 if any check fails.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const gd = require('../gamedac.js');
const { run } = require('./checks.js');
const { failed } = await run(gd, (name, pass, detail, summary) => { console.log(summary ? '\n' + detail : (pass ? 'PASS ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : '')); });
process.exit(failed ? 1 : 0);