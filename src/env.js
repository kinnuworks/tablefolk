import fs from 'node:fs';
export function loadEnv() {
  const file = new URL('../.env', import.meta.url);
  const out = { ...process.env };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !out[m[1]]) out[m[1]] = m[2];
    }
  }
  return out;
}
