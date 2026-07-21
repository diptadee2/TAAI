// Scheduled function (see netlify.toml [functions."sync-schedule"]) — runs
// daily at 3 AM IST. Fetches the published Google Sheet CSV, replaces the
// schedule for every date the sheet covers, and leaves everything else in
// Supabase untouched. If the fetch or parse fails, no writes happen at all,
// so a bad sync never wipes out yesterday's good schedule.
import { getSupabase } from './lib/supabase.js';
import { parseCsv, toIsoDate } from './lib/csv.js';

export async function handler() {
  const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;
  if (!csvUrl) {
    console.error('sync-schedule: GOOGLE_SHEET_CSV_URL is not set');
    return { statusCode: 500, body: 'GOOGLE_SHEET_CSV_URL is not set' };
  }

  let csvText;
  try {
    const res = await fetch(csvUrl);
    if (!res.ok) throw new Error(`sheet fetch failed: ${res.status}`);
    csvText = await res.text();
  } catch (err) {
    console.error('sync-schedule: fetch failed, previous schedule left intact —', err.message);
    return { statusCode: 502, body: `fetch failed: ${err.message}` };
  }

  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    console.error('sync-schedule: sheet has no data rows, aborting sync');
    return { statusCode: 200, body: 'no data rows, nothing synced' };
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
      tasks.push({ date: isoDate, subject, task_text: taskText, position: col });
    }
  }

  if (!days.size) {
    console.error('sync-schedule: no valid DD/MM/YYYY dates found, aborting sync');
    return { statusCode: 200, body: 'no valid dates, nothing synced' };
  }

  const supabase = getSupabase();
  const dateList = [...days];

  // schedule_days: mark each date as synced (upsert bumps synced_at)
  const { error: daysError } = await supabase
    .from('schedule_days')
    .upsert(dateList.map(date => ({ date })), { onConflict: 'date' });
  if (daysError) {
    console.error('sync-schedule: schedule_days upsert failed —', daysError.message);
    return { statusCode: 500, body: daysError.message };
  }

  // Full replace of schedule_tasks for every date in this sheet, so cells
  // the sheet owner cleared actually disappear instead of lingering.
  const { error: deleteError } = await supabase
    .from('schedule_tasks')
    .delete()
    .in('date', dateList);
  if (deleteError) {
    console.error('sync-schedule: schedule_tasks delete failed —', deleteError.message);
    return { statusCode: 500, body: deleteError.message };
  }

  if (tasks.length) {
    const { error: insertError } = await supabase.from('schedule_tasks').insert(tasks);
    if (insertError) {
      console.error('sync-schedule: schedule_tasks insert failed —', insertError.message);
      return { statusCode: 500, body: insertError.message };
    }
  }

  console.log(`sync-schedule: synced ${dateList.length} days, ${tasks.length} tasks`);
  return { statusCode: 200, body: `synced ${dateList.length} days, ${tasks.length} tasks` };
}
