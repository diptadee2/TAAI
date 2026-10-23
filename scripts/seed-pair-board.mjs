// Loads (or reloads) a private pair-study board: roadmap + passcode hash into
// pair_boards. The roadmap file stays out of git (keep it in sheets/), because
// the repo is public.
//
//   node --env-file=.env scripts/seed-pair-board.mjs <board-slug> <roadmap.md> [passcode]
//   ... --dry   prints the parsed roadmap as JSON and touches nothing
//
// Without a passcode argument one is generated and printed once. Re-running with
// a new roadmap keeps the existing passcode unless one is given, and never
// touches ticks (a tick on a task that disappears is simply no longer shown).
//
// Roadmap format (markdown): "## <n>. <Subject> (<range>)" headings, then
// "- [ ] **Oct 23 (Fri):** task text" lines. "**Every day:**" / "**Every
// Sunday:**" lines become notes. Months Aug-Dec are read as START_YEAR, Jan-Jul
// as START_YEAR + 1.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { getSupabase } from '../netlify/functions/lib/supabase.js';
import { passcodeHash } from '../netlify/functions/pair-board.js';

const START_YEAR = 2026;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const DRY = process.argv.includes('--dry');
const [slug, file, givenCode] = process.argv.slice(2).filter(a => a !== '--dry');
if (!slug || !file) { console.error('usage: seed-pair-board.mjs <board-slug> <roadmap.md> [passcode]'); process.exit(1); }

const md = fs.readFileSync(file, 'utf8');
const title = (md.match(/^#\s+(.+)$/m) || [, 'Roadmap'])[1].trim();
const notes = [...md.matchAll(/^\*\*(Every [^*]+):\*\*\s*(.+)$/gm)].map(m => ({ label: m[1].trim(), text: m[2].trim() }));
const sections = [];
for (const line of md.split('\n')) {
  const h = line.match(/^##\s+(?:\d+\.\s*)?(.+?)(?:\s+\(([^)]+)\))?\s*$/);
  if (h) { sections.push({ title: h[1].trim(), range: (h[2] || '').trim(), tasks: [] }); continue; }
  const t = line.match(/^-\s*\[[ x]\]\s*\*\*([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s*\(([A-Za-z]{3})\):\*\*\s*(.+)$/);
  if (t) {
    if (!sections.length) throw new Error('task before any section: ' + line);
    const mon = MONTHS[t[1].toLowerCase()], day = Number(t[2]);
    const year = mon >= 8 ? START_YEAR : START_YEAR + 1;
    const id = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const wd = new Date(id + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    if (wd.slice(0, 3).toLowerCase() !== t[3].toLowerCase()) throw new Error(`weekday mismatch on ${id}: file says ${t[3]}, calendar says ${wd}`);
    const text = t[4].trim();
    sections[sections.length - 1].tasks.push({ id, text, weeklyTest: /weekly test/i.test(text) });
  }
}
const all = sections.flatMap(s => s.tasks);
const ids = new Set(all.map(x => x.id));
if (ids.size !== all.length) throw new Error('two tasks share a date');
if (!all.length) throw new Error('no tasks found');

if (DRY) { console.log(JSON.stringify({ title, notes, sections })); process.exit(0); }

const supabase = getSupabase();
const { data: existing, error: readErr } = await supabase.from('pair_boards').select('slug, passcode_hash, names').eq('slug', slug).maybeSingle();
if (readErr) throw new Error(readErr.message);

let code = givenCode || null;
if (!code && !existing) {
  const words = ['amber', 'basil', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'haven', 'iris', 'juniper', 'koala', 'lotus', 'maple', 'nova', 'onyx', 'pixel', 'quill', 'raven', 'sable', 'tundra', 'umber', 'vivid', 'willow', 'zephyr'];
  const pick = () => words[crypto.randomInt(words.length)];
  code = `${pick()}-${pick()}-${pick()}-${crypto.randomInt(1000, 9999)}`;
}
const row = {
  slug,
  roadmap: { title, notes, sections },
  names: existing ? existing.names : ['Person 1', 'Person 2'],
  passcode_hash: code ? passcodeHash(slug, code) : existing.passcode_hash,
  updated_at: new Date().toISOString(),
};
const { error } = await supabase.from('pair_boards').upsert(row, { onConflict: 'slug' });
if (error) throw new Error(error.message);
console.log(`Board "${slug}": ${sections.length} sections, ${all.length} tasks (${all[0].id} to ${all[all.length - 1].id}).`);
console.log(code ? `Passcode: ${code}` : 'Passcode unchanged.');
