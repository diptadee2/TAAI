// One-time load of sheets/pricing.csv, sheets/notes.csv, sheets/lectures.csv
// into the new site_pricing / site_notes / site_lectures tables (see
// supabase/schema.sql, CLAUDE.md's "Site data corner" section) — so /team's
// new Site data tab starts populated with today's real data instead of
// empty. Run once, manually, after the schema migration:
//   node scripts/seed-site-data.mjs
//
// Deliberately not an ongoing sync — same "provided directly, loaded by
// hand" discipline already established for schedule.csv (see
// load-schedule.mjs's own comment). The live pages keep reading the
// published Google Sheet CSV directly; this script only seeds the new
// admin-editable copy, it doesn't change what those pages read from.
//
// Idempotent, safe to re-run: site_pricing is upserted by its own stable
// id (the same slug already used everywhere else on the site); site_notes/
// site_lectures have no natural business key of their own (a UUID PK), so
// they're fully replaced (delete-all, then re-insert from the CSV) instead.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCsv } from '../netlify/functions/lib/csv.js';
import { getSupabase } from '../netlify/functions/lib/supabase.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, '..');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^=#]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function readCsvAsObjects(relPath) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) return [];
  const rows = parseCsv(fs.readFileSync(fullPath, 'utf8'));
  if (rows.length < 2) return [];
  const [header, ...dataRows] = rows;
  return dataRows
    .filter(r => r.some(cell => cell.trim()))
    .map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

function intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function dateOrNull(v) {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

async function seedPricing(supabase) {
  const rows = readCsvAsObjects('sheets/pricing.csv').map(r => ({
    id: r.id,
    type: r.type,
    name: r.name,
    price: intOrNull(r.price),
    price_old: intOrNull(r.priceOld),
    discount: r.discount || null,
    discount_reason: r.discountReason || null,
    discount_deadline: dateOrNull(r.discountDeadline),
    validity: dateOrNull(r.validity),
  })).filter(r => r.id);

  if (!rows.length) { console.log('No rows in sheets/pricing.csv — skipping site_pricing.'); return; }
  const { error } = await supabase.from('site_pricing').upsert(rows, { onConflict: 'id' });
  if (error) { console.error('site_pricing upsert failed:', error.message); process.exit(1); }
  console.log(`site_pricing: upserted ${rows.length} rows.`);
}

async function seedNotes(supabase) {
  const rows = readCsvAsObjects('sheets/notes.csv').map(r => ({
    subject: r.subject,
    title: r.title || null,
    description: r.desc || null,
    file_url: r.file || null,
    posted_on: dateOrNull(r.postedOn),
  })).filter(r => r.subject);

  const { error: delErr } = await supabase.from('site_notes').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (delErr) { console.error('site_notes delete-all failed:', delErr.message); process.exit(1); }
  if (rows.length) {
    const { error } = await supabase.from('site_notes').insert(rows);
    if (error) { console.error('site_notes insert failed:', error.message); process.exit(1); }
  }
  console.log(`site_notes: replaced with ${rows.length} rows.`);
}

async function seedLectures(supabase) {
  const rows = readCsvAsObjects('sheets/lectures.csv').map(r => ({
    subject: r.subject,
    lecture_number: intOrNull(r.lectureNumber),
    title: r.title || null,
    youtube_url: r.youtubeUrl || null,
    slides_url: r.slidesFile || null,
    posted_on: dateOrNull(r.postedOn),
  })).filter(r => r.subject);

  const { error: delErr } = await supabase.from('site_lectures').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (delErr) { console.error('site_lectures delete-all failed:', delErr.message); process.exit(1); }
  if (rows.length) {
    const { error } = await supabase.from('site_lectures').insert(rows);
    if (error) { console.error('site_lectures insert failed:', error.message); process.exit(1); }
  }
  console.log(`site_lectures: replaced with ${rows.length} rows.`);
}

async function main() {
  loadEnvFile();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set (check .env).');
    process.exit(1);
  }
  const supabase = getSupabase();
  await seedPricing(supabase);
  await seedNotes(supabase);
  await seedLectures(supabase);
  console.log(`Done (${process.env.SUPABASE_URL}).`);
}

main();
