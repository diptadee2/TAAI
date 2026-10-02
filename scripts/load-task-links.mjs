// Loads task -> LMS lesson links into Supabase (schedule_task_links), so a
// schedule task's text becomes clickable on the tracker without a redeploy.
//   npm run load-task-links -- --batch=D sheets/task-links-D.csv
//   npm run load-task-links -- --batch=D sheets/task-links-D.csv --prune
// CSV columns: Subject,Task,URL. Task must match the schedule's task text
// exactly (it's the key). Upserts by (batch, subject, task); --prune also
// deletes this batch's links that aren't in the file. Only
// https://learn.taai.live/ URLs are accepted (the tracker ignores others).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCsv } from '../netlify/functions/lib/csv.js';
import { getSupabase } from '../netlify/functions/lib/supabase.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^=#]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function main() {
  loadEnvFile();
  const args = process.argv.slice(2);
  const batchArg = args.find(a => a.startsWith('--batch='));
  const batch = batchArg ? batchArg.slice(8).trim() : '';
  const prune = args.includes('--prune');
  const file = args.find(a => !a.startsWith('--'));
  if (!batch || !file) { console.error('Usage: npm run load-task-links -- --batch=D <file.csv> [--prune]'); process.exit(1); }
  const rows = parseCsv(fs.readFileSync(path.resolve(file), 'utf8'));
  const [, ...data] = rows;
  const links = [];
  const bad = [];
  for (const r of data) {
    const subject = (r[0] || '').trim(), task = (r[1] || '').trim(), url = (r[2] || '').trim();
    if (!subject && !task && !url) continue;
    if (!subject || !task || !/^https:\/\/learn\.taai\.live\//.test(url)) { bad.push(r.join(' | ')); continue; }
    links.push({ batch, subject, task_text: task, url, updated_at: new Date().toISOString() });
  }
  if (bad.length) { console.error('Rejected rows (need Subject, Task and a https://learn.taai.live/ URL):\n  ' + bad.join('\n  ')); process.exit(1); }

  const supabase = getSupabase();
  // Warn (don't fail) about tasks that aren't in this batch's schedule:
  // the key must match exactly or the link never shows.
  const { data: sched, error: schedErr } = await supabase.from('schedule_tasks').select('subject, task_text').eq('batch', batch);
  if (!schedErr) {
    const known = new Set((sched || []).map(r => r.subject + '\u0000' + r.task_text));
    const missing = links.filter(l => !known.has(l.subject + '\u0000' + l.task_text));
    if (missing.length) console.warn(`Warning: ${missing.length} link(s) don't match any batch ${batch} task yet:\n  ` + missing.map(l => `${l.subject}: ${l.task_text}`).join('\n  '));
  }

  if (links.length) {
    const { error } = await supabase.from('schedule_task_links').upsert(links, { onConflict: 'batch,subject,task_text' });
    if (error) { console.error('Upsert failed:', error.message); process.exit(1); }
  }
  let pruned = 0;
  if (prune) {
    const { data: existing, error } = await supabase.from('schedule_task_links').select('subject, task_text').eq('batch', batch);
    if (error) { console.error('Prune lookup failed:', error.message); process.exit(1); }
    const keep = new Set(links.map(l => l.subject + '\u0000' + l.task_text));
    for (const r of existing || []) {
      if (keep.has(r.subject + '\u0000' + r.task_text)) continue;
      await supabase.from('schedule_task_links').delete().eq('batch', batch).eq('subject', r.subject).eq('task_text', r.task_text);
      pruned++;
    }
  }
  console.log(`Loaded ${links.length} link(s) for batch ${batch}${prune ? `, pruned ${pruned}` : ''}.`);
}
main();
