// Loads sheets/schedule.csv into Supabase (schedule_days + schedule_tasks).
// Run after updating that file with a new/changed schedule:
//   npm run load-schedule
//   npm run load-schedule -- --batch=D   (a second/later batch's schedule)
//
// Schedule data is provided directly (as PDFs, etc.), converted to this CSV
// format by hand, and loaded with this script — deliberately no automatic
// fetch from Google Sheets or anywhere else. Uses whichever Supabase
// SUPABASE_URL/SUPABASE_SERVICE_KEY are set in .env (local or production).
//
// --batch defaults to 'C' — the original, only batch this project assumed
// until second-batch support was added (2026-09-28). Every insert/upsert/
// delete below is scoped to the given batch, so loading one batch's
// schedule never touches another batch's rows even on overlapping dates.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCsv, toIsoDate } from '../netlify/functions/lib/csv.js';
import { getSupabase } from '../netlify/functions/lib/supabase.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, '..');
const CSV_PATH = path.join(ROOT, 'sheets', 'schedule.csv');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^=#]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function parseBatchArg() {
  const arg = process.argv.find(a => a.startsWith('--batch='));
  return arg ? arg.slice('--batch='.length).trim() || 'C' : 'C';
}

async function main() {
  loadEnvFile();
  const batch = parseBatchArg();

  if (!fs.existsSync(CSV_PATH)) {
    console.error(`No schedule found at ${CSV_PATH} — nothing to load.`);
    process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set (check .env).');
    process.exit(1);
  }

  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.error('sheets/schedule.csv has no data rows.');
    process.exit(1);
  }

  const [header, ...dataRows] = rows;
  const subjectColumns = header.slice(1).map((name, i) => ({ name: name.trim(), col: i + 1 })).filter(c => c.name);

  const days = new Set();
  const tasks = [];
  for (const row of dataRows) {
    const isoDate = toIsoDate(row[0]);
    if (!isoDate) continue;
    days.add(isoDate);
    for (const { name: subject, col } of subjectColumns) {
      const taskText = (row[col] || '').trim();
      if (!taskText) continue;
      tasks.push({ date: isoDate, subject, task_text: taskText, position: col, batch });
    }
  }

  if (!days.size) {
    console.error('No valid DD/MM/YYYY dates found in sheets/schedule.csv.');
    process.exit(1);
  }

  const supabase = getSupabase();
  const dateList = [...days];

  const { error: daysError } = await supabase
    .from('schedule_days')
    .upsert(dateList.map(date => ({ date, batch })), { onConflict: 'date,batch' });
  if (daysError) { console.error('schedule_days upsert failed:', daysError.message); process.exit(1); }

  // Full replace for every date the CSV covers, so a cell cleared in a
  // re-exported schedule actually disappears instead of lingering — scoped
  // to this batch only, so re-loading batch D's schedule can never delete
  // batch C's rows even on a shared date.
  const { error: deleteError } = await supabase.from('schedule_tasks').delete().eq('batch', batch).in('date', dateList);
  if (deleteError) { console.error('schedule_tasks delete failed:', deleteError.message); process.exit(1); }

  if (tasks.length) {
    const { error: insertError } = await supabase.from('schedule_tasks').insert(tasks);
    if (insertError) { console.error('schedule_tasks insert failed:', insertError.message); process.exit(1); }
  }

  console.log(`Loaded ${dateList.length} days, ${tasks.length} tasks for batch ${batch} from sheets/schedule.csv into Supabase (${process.env.SUPABASE_URL}).`);
}

main();
