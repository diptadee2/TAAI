// "No more schedule coming" link from the schedule run-out reminder, and the
// "Done, schedules posted" link from the weekly schedule-pictures reminder
// (?w=<sunday>&t=<sig>), both in Discord (2026-11-06). GET shows a small confirm page (Discord fetches links
// for previews, so a GET must never change anything); POST applies it.
//   GET  /api/schedule-done?b=D&d=2026-11-15&t=<sig>
//   POST same query, form field action=stop|undo
// The signature (see scheduleDoneSig) covers the batch and the last schedule
// date the reminder was about, so the link can't be forged and does nothing
// once a newer schedule has been loaded.
import crypto from 'node:crypto';
import { getSupabase, fetchScheduleRunout, scheduleDoneSig, SCHEDULE_BATCH_LABELS, weeklyPostSunday } from './lib/supabase.js';

const fmt = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, bodyHtml) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#FFF4D6;font:16px/1.5 system-ui,-apple-system,sans-serif;color:#111;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
.card{background:#fff;border:3px solid #111;box-shadow:6px 6px 0 #111;padding:24px;max-width:440px;width:100%;box-sizing:border-box}
h1{font-size:20px;margin:0 0 10px}p{margin:0 0 16px;color:#333}
button{font:600 15px system-ui,sans-serif;padding:12px 18px;border:2px solid #111;background:#FDE047;cursor:pointer;width:100%}
button.ghost{background:#fff;margin-top:10px}</style></head><body><div class="card">${bodyHtml}</div></body></html>`,
  };
}

function sigOk(batch, date, t) {
  const want = scheduleDoneSig(batch, date);
  return typeof t === 'string' && t.length === want.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(want));
}

function postedAction(event) {
  if (event.httpMethod !== 'POST') return null;
  return new URLSearchParams(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : (event.body || '')).get('action');
}

// Reads the stored "done" marks, applies change(off), drops weekly marks older
// than ~5 weeks so the map stays small, and saves.
async function updateOff(supabase, change) {
  const { data: cur, error: readErr } = await supabase.from('site_settings').select('*').eq('id', 'main').maybeSingle();
  if (readErr) return readErr.message;
  const off = Object.assign({}, (cur && cur.schedule_reminder_off) || {});
  change(off);
  const cutoff = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
  for (const k of Object.keys(off)) if (k.startsWith('weekly:') && k.slice(7) < cutoff) delete off[k];
  const { error } = await supabase.from('site_settings').upsert({ id: 'main', schedule_reminder_off: off, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  return error ? error.message : null;
}

// "Done, schedules posted" for the weekly schedule-pictures reminder.
async function weeklyHandler(event, sunday, t) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sunday || '') || !sigOk('weekly', sunday, t)) {
    return page('Link not valid', '<h1>This link isn\'t valid</h1><p>Use the link from the latest reminder.</p>');
  }
  if (sunday !== weeklyPostSunday()) {
    return page('Old reminder', `<h1>This reminder is from an earlier week</h1><p>It was for the week starting ${esc(fmt(sunday))}. Use the link in this week's reminder.</p>`);
  }
  const supabase = getSupabase();
  const key = 'weekly:' + sunday;
  const action = postedAction(event);
  if (action === 'stop' || action === 'undo') {
    const err = await updateOff(supabase, off => { if (action === 'stop') off[key] = true; else delete off[key]; });
    if (err) return page('Something went wrong', `<h1>Couldn't save</h1><p>${esc(err)}</p>`);
  }
  const { data } = await supabase.from('site_settings').select('*').eq('id', 'main').maybeSingle();
  const done = !!(data && data.schedule_reminder_off && data.schedule_reminder_off[key]);
  const form = (act, text, cls) => `<form method="post"><input type="hidden" name="action" value="${act}"><button${cls ? ` class="${cls}"` : ''}>${text}</button></form>`;
  if (done) {
    return page('Marked done', `<h1>Schedules marked as posted</h1><p>No more reminders this week. The next one comes on Sunday at midnight.</p>${form('undo', 'Undo, not posted yet', 'ghost')}`);
  }
  return page('Schedules posted?', `<h1>Have this week's schedules been posted?</h1><p>Confirm once the schedule pictures are up in each batch's channel, so Monday's reminder doesn't go out.</p>${form('stop', 'Yes, they\'re posted')}`);
}

export async function handler(event) {
  const q = event.queryStringParameters || {};
  if (q.w) return weeklyHandler(event, q.w, q.t);
  const batch = q.b, date = q.d, t = q.t;
  if (!SCHEDULE_BATCH_LABELS[batch] || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !sigOk(batch, date, t)) {
    return page('Link not valid', '<h1>This link isn\'t valid</h1><p>Use the link from the latest reminder, or switch it in /team under Site data &gt; Settings.</p>');
  }
  const label = SCHEDULE_BATCH_LABELS[batch];
  const supabase = getSupabase();
  const runout = (await fetchScheduleRunout(supabase)).find(b => b.batch === batch);
  const action = postedAction(event);

  if (!runout || runout.lastDate !== date) {
    return page('Schedule already updated', `<h1>A newer schedule is already loaded</h1><p>${esc(label)} now runs until ${esc(runout && runout.lastDate ? fmt(runout.lastDate) : 'a later date')}, so this link no longer applies. Reminders will start again 5 days before that.</p>`);
  }

  if (action === 'stop' || action === 'undo') {
    const err = await updateOff(supabase, off => { if (action === 'stop') off[batch] = date; else delete off[batch]; });
    if (err) return page('Something went wrong', `<h1>Couldn't save</h1><p>${esc(err)}</p>`);
    runout.off = action === 'stop';
  }

  const form = (act, text, cls) => `<form method="post"><input type="hidden" name="action" value="${act}"><button${cls ? ` class="${cls}"` : ''}>${text}</button></form>`;
  if (runout.off) {
    return page('Reminders stopped', `<h1>Reminders stopped for ${esc(label)}</h1><p>No more schedule is coming after ${esc(fmt(date))}, so there will be no more reminders for it. If a newer schedule is loaded later, reminders turn back on by themselves.</p>${form('undo', 'Undo, keep reminding', 'ghost')}`);
  }
  return page('No more schedule coming?', `<h1>No more schedule coming for ${esc(label)}?</h1><p>Its loaded schedule ends ${esc(fmt(date))}. Confirm and the daily reminder stops for this batch.</p>${form('stop', 'Yes, stop the reminders')}`);
}
