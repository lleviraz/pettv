// In-memory debug log (newest MAX_LINES lines) for the admin's "Export logs".
// The home phone uploads its copy to /debug/home; lines must stay under 300 chars for the rules.
const MAX_LINES = 200;
const lines = [];
let version = 0;

export function dlog(msg) {
  lines.push(`${new Date().toISOString()} ${String(msg).slice(0, 250)}`);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  version++;
}

export const getLines = () => lines.slice();
export const logVersion = () => version;

function describe(a) {
  if (a instanceof Error) return a.message;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

// Also keep the warnings and errors the app already prints
if (!console.__pettvCaptured) {
  console.__pettvCaptured = true;
  for (const level of ['warn', 'error']) {
    const original = console[level];
    console[level] = (...args) => {
      try { dlog(`${level}: ${args.map(describe).join(' ')}`); } catch {}
      original.apply(console, args);
    };
  }
}
