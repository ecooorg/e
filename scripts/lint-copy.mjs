/**
 * Forbidden copy scan — TZ A-05, T14
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('src');
const FORBIDDEN = [
  /calculateOptionScore/,
  /Weighted Score Index/,
  /sensitivitySliders/,
  /costOfInactionAnnual/,
  /Recalculate scenarios/,
  /Anti-hallucination radar/,
  /Critical for forecast/,
  /probability calculation/,
];

let failed = false;
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
      const text = fs.readFileSync(p, 'utf8');
      for (const re of FORBIDDEN) {
        if (re.test(text)) {
          console.error(`FORBIDDEN ${re} in ${p}`);
          failed = true;
        }
      }
    }
  }
}
walk(ROOT);
if (failed) {
  console.error('lint:copy failed');
  process.exit(1);
}
console.log('lint:copy OK');
