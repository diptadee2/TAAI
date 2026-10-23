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
// Cumulative revision (2026-10-23): every day gets its own revision item
// (id "<date>:rev", ticked on its own, per person) naming ONE specific earlier
// topic, so 30 minutes has a clear target and the page can show that day's
// saved notes next to it. Subjects rotate (finished ones, most recent first,
// rotation restarting when a new subject starts); within a subject its topics
// come up in order, then cycle. During the first subject it's the previous
// day's topic (none on day 1). Revision sections themselves get none.
const isRevisionSection = sec => /revision/i.test(sec.title);
if (notes.some(n => /^cumulative revision$/i.test(n.label))) {
  const pointer = {};
  sections.forEach((sec, k) => {
    if (isRevisionSection(sec)) return;
    const finished = sections.map((x, i) => i).slice(0, k).filter(i => !isRevisionSection(sections[i])).reverse();
    sec.tasks.forEach((t, j) => {
      let from, subj;
      if (!finished.length) {
        if (j === 0) return;
        subj = k; from = sec.tasks[j - 1];
      } else {
        subj = finished[j % finished.length];
        const list = sections[subj].tasks;
        pointer[subj] = pointer[subj] || 0;
        from = list[pointer[subj] % list.length];
        pointer[subj] += 1;
      }
      t.revision = { id: t.id + ':rev', subject: subj, fromId: from.id, text: from.text };
    });
  });
}

// Weekly tests say what they cover: subjects finished so far plus the current one.
sections.forEach((sec, k) => {
  sec.tasks.forEach(t => {
    if (!t.weeklyTest) return;
    t.testCovers = sections.slice(0, k + 1).map((x, i) => i).filter(i => !isRevisionSection(sections[i]));
  });
});

// Days in a revision section that name subjects ("Revise PDS + Algorithms") get
// those subjects' indexes, so the page can link straight to their saved notes.
// A subject matches by its full title, first word, first two words, or acronym
// (Programming & Data Structures -> PDS, Theory of Computation -> TOC).
const aliases = sections.map(sec => {
  const words = sec.title.replace(/&/g, ' ').split(/\s+/).filter(Boolean);
  const acr = words.filter(w => /^[A-Z]/.test(w) && !/^(of|and)$/i.test(w)).map(w => w[0]).join('');
  const acrAll = words.map(w => w[0]).join('').toUpperCase(); // Theory of Computation -> TOC
  return [sec.title, words[0], words.slice(0, 2).join(' '), acr, acrAll].filter(a => a && a.length >= 2);
});
sections.forEach(sec => {
  if (!isRevisionSection(sec)) return;
  sec.tasks.forEach(t => {
    const hits = [];
    aliases.forEach((list, i) => {
      if (isRevisionSection(sections[i])) return;
      if (list.some(a => new RegExp('(^|[^A-Za-z])' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z]|$)', 'i').test(t.text))) hits.push(i);
    });
    // Mock-analysis and last-day revision name no subject: link all of them.
    t.reviseSubjects = hits.length ? hits : sections.map((x, i) => i).filter(i => !isRevisionSection(sections[i]));
    if (!hits.length) t.reviseAll = true;
  });
});
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
