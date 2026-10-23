// Loads (or reloads) a private pair-study board: roadmap + passcode hash into
// pair_boards. The roadmap file stays out of git (keep it in sheets/), because
// the repo is public.
//
//   node --env-file=.env scripts/seed-pair-board.mjs <board-slug> <roadmap.md> [passcode]
//   ... --dry   prints the parsed roadmap as JSON and touches nothing
//   ... --open  no passcode at all (anyone with the link); a later run without
//               --open or a passcode keeps whatever the board has now
//
// Without a passcode argument one is generated and printed once. Re-running with
// a new roadmap keeps the existing passcode unless one is given, and never
// touches ticks (a tick on a task that disappears is simply no longer shown).
//
// Roadmap format (markdown): "## <n>. <Subject> (<range>)" headings, then
// "- [ ] **Oct 23 (Fri):** task text" lines. "**Every day:**" / "**Every
// Sunday:**" lines become notes. A "**Cumulative revision:**" line also adds a
// revision item to each day (see addRevision below). Months Aug-Dec are read as START_YEAR, Jan-Jul
// as START_YEAR + 1.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { getSupabase } from '../netlify/functions/lib/supabase.js';
import { passcodeHash } from '../netlify/functions/pair-board.js';

const START_YEAR = 2026;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const DRY = process.argv.includes('--dry'), OPEN = process.argv.includes('--open');
const [slug, file, givenCode] = process.argv.slice(2).filter(a => a !== '--dry' && a !== '--open');
if (!slug || !file) { console.error('usage: seed-pair-board.mjs <board-slug> <roadmap.md> [passcode]'); process.exit(1); }

const md = fs.readFileSync(file, 'utf8');
const title = (md.match(/^#\s+(.+)$/m) || [, 'Roadmap'])[1].trim();
const notes = [...md.matchAll(/^\*\*(Every [^*]+|Cumulative revision):\*\*\s*(.+)$/gm)].map(m => ({ label: m[1].trim(), text: m[2].trim() }));
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
// Cumulative revision (2026-10-23): every day gets its own "Revise ..." item
// (id "<date>:rev") for the subjects already finished, one per day in rotation,
// most recently finished first, restarting the rotation when a new subject
// starts. During the first subject it's that subject's topics so far (none on
// day 1). Sections that are themselves revision ("Revision & Full Mocks") get none.
if (notes.some(n => /^cumulative revision$/i.test(n.label))) {
  sections.forEach((sec, k) => {
    if (/revision/i.test(sec.title)) return;
    const finished = sections.slice(0, k).filter(x => !/revision/i.test(x.title)).map(x => x.title).reverse();
    sec.tasks.forEach((t, j) => {
      if (!finished.length) {
        if (j > 0) t.revision = { id: t.id + ':rev', text: 'Revise ' + sec.title + ' topics so far' };
        return;
      }
      t.revision = { id: t.id + ':rev', text: 'Revise ' + finished[j % finished.length] };
    });
  });
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
if (!code && !existing && !OPEN) {
  const words = ['amber', 'basil', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'haven', 'iris', 'juniper', 'koala', 'lotus', 'maple', 'nova', 'onyx', 'pixel', 'quill', 'raven', 'sable', 'tundra', 'umber', 'vivid', 'willow', 'zephyr'];
  const pick = () => words[crypto.randomInt(words.length)];
  code = `${pick()}-${pick()}-${pick()}-${crypto.randomInt(1000, 9999)}`;
}
const row = {
  slug,
  roadmap: { title, notes, sections },
  names: existing ? existing.names : ['Person 1', 'Person 2'],
  passcode_hash: OPEN ? '' : code ? passcodeHash(slug, code) : existing.passcode_hash,
  updated_at: new Date().toISOString(),
};
const { error } = await supabase.from('pair_boards').upsert(row, { onConflict: 'slug' });
if (error) throw new Error(error.message);
console.log(`Board "${slug}": ${sections.length} sections, ${all.length} tasks (${all[0].id} to ${all[all.length - 1].id}).`);
console.log(OPEN ? 'No passcode: open to anyone with the link.' : code ? `Passcode: ${code}` : 'Passcode unchanged.');
