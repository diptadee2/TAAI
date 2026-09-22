// One-time load of the site's real pricing/notes/lectures data into the
// new site_pricing / site_notes / site_lectures tables (see
// supabase/schema.sql, CLAUDE.md's "Site data corner" section) — so
// /team's new Site data tab starts populated with real data instead of
// empty. Run once, manually, after the schema migration:
//   npm run seed-site-data
//
// Fetches the SAME published Google Sheet CSV URLs the live pages
// themselves already read (PRICING_CSV_URL in gate-da-courses.html,
// NOTES_CSV_URL/LECTURES_CSV_URL in gate-da-free-notes.html) — NOT the
// local sheets/*.csv files. Those local files are gitignored, one-off
// snapshots someone saved at some point, never kept in sync — confirmed
// stale against the real sheet the first time this ran (11 vs 12 pricing
// rows with different prices, 1 vs 3 real notes, lecture rows missing
// real slides links). Unlike schedule.csv, which has an explicit,
// deliberate "provided directly, never auto-synced" policy (see
// load-schedule.mjs's own comment and CLAUDE.md's "Schedule data flow"
// section), pricing/notes/lectures have always been live-synced from
// this same sheet by the pages that read them — seeding from anywhere
// else would just be seeding stale data.
//
// Deliberately still a one-time script, not an ongoing cron — this
// project's standing rule is no automatic background sync of anything;
// re-run this by hand whenever /team's copy needs to be refreshed from
// the sheet again (e.g. before a first real cutover).
//
// Idempotent, safe to re-run: site_pricing is upserted by its own stable
// id (the same slug already used everywhere else on the site); site_notes/
// site_lectures have no natural business key of their own (a UUID PK), so
// they're fully replaced (delete-all, then re-insert) instead.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCsv } from '../netlify/functions/lib/csv.js';
import { getSupabase } from '../netlify/functions/lib/supabase.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, '..');

// Same published sheet, three tabs (different gid) — see PRICING_CSV_URL
// in gate-da-courses.html and NOTES_CSV_URL/LECTURES_CSV_URL in
// gate-da-free-notes.html. Keep these in sync by hand if those ever
// change (same maintenance burden as every other hand-duplicated
// constant already documented in this codebase).
const PRICING_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSVYXQcKli0NtjXf93cxRwx3A15WiNcETEw26MubPYIihLyMQs2rfZjXKm85fNsOxxlUWkoyR89DKCK/pub?gid=0&single=true&output=csv';
const NOTES_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSVYXQcKli0NtjXf93cxRwx3A15WiNcETEw26MubPYIihLyMQs2rfZjXKm85fNsOxxlUWkoyR89DKCK/pub?gid=850997370&single=true&output=csv';
const LECTURES_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSVYXQcKli0NtjXf93cxRwx3A15WiNcETEw26MubPYIihLyMQs2rfZjXKm85fNsOxxlUWkoyR89DKCK/pub?gid=725480532&single=true&output=csv';

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^=#]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function fetchCsvAsObjects(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
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
  const csvRows = await fetchCsvAsObjects(PRICING_CSV_URL);
  const rows = csvRows.map(r => ({
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

  if (!rows.length) { console.log('No rows fetched from the pricing sheet — skipping site_pricing.'); return; }
  const { error } = await supabase.from('site_pricing').upsert(rows, { onConflict: 'id' });
  if (error) { console.error('site_pricing upsert failed:', error.message); process.exit(1); }
  console.log(`site_pricing: upserted ${rows.length} rows.`);
}

async function seedNotes(supabase) {
  const csvRows = await fetchCsvAsObjects(NOTES_CSV_URL);
  const rows = csvRows.map(r => ({
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
  const csvRows = await fetchCsvAsObjects(LECTURES_CSV_URL);
  const rows = csvRows.map(r => ({
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
