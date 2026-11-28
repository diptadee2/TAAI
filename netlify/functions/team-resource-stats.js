// GET /api/team-resource-stats -> { today, visits: {total, d7, d30, today, daily: [{day, count, fresh}]},
//                                   newVisitors: {total, d7, d30, today},
//                                   items: { <id>: { note|play|slides: {total, d7, d30} } },
//                                   survey: { sv_year|sv_gate|sv_src|sv_done: { <answer>: {total, d30} } },
//                                   actions: { note|play|slides: {total, d7, d30, today} },
//                                   actionsDaily: [{day, note, play, slides}] (30 days), firstDay }
//
// Admin-only read of the Resources page counters (resource_stats, written by
// resource-event.js), shown in /team Site data > Notes and Lectures.
// Days are IST dates. daily covers the last 30 days, oldest first, zero-filled.
import { getSupabase, json, requireAdmin, todayIST, fetchAllRows } from './lib/supabase.js';

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });
  const supabase = getSupabase();
  let rows;
  try {
    rows = await fetchAllRows(() => supabase.from('resource_stats').select('day, kind, item_id, count').order('day'));
  } catch (e) {
    return json(200, { ready: false, error: e.message || String(e) });
  }
  const today = todayIST();
  const from7 = addDays(today, -6), from30 = addDays(today, -29);
  const visits = { total: 0, d7: 0, d30: 0, today: 0, daily: [] };
  const byDay = {};
  const fresh = { total: 0, d7: 0, d30: 0, today: 0 };
  const newByDay = {};
  const items = {};
  const survey = {};
  // Page-wide downloads/plays (2026-11-28): totals per kind and per day.
  const actions = {}, actByDay = {};
  let firstDay = null;
  for (const r of rows) {
    const c = r.count || 0;
    if (!firstDay || r.day < firstDay) firstDay = r.day;
    if (r.kind.startsWith('sv_')) {
      const q = survey[r.kind] = survey[r.kind] || {};
      const a = q[r.item_id] = q[r.item_id] || { total: 0, d30: 0 };
      a.total += c; if (r.day >= from30) a.d30 += c;
      continue;
    }
    if (r.kind === 'new') {
      fresh.total += c;
      if (r.day >= from7) fresh.d7 += c;
      if (r.day >= from30) fresh.d30 += c;
      if (r.day === today) fresh.today += c;
      newByDay[r.day] = (newByDay[r.day] || 0) + c;
      continue;
    }
    if (r.kind === 'visit') {
      visits.total += c;
      if (r.day >= from7) visits.d7 += c;
      if (r.day >= from30) visits.d30 += c;
      if (r.day === today) visits.today += c;
      byDay[r.day] = (byDay[r.day] || 0) + c;
      continue;
    }
    const a = actions[r.kind] = actions[r.kind] || { total: 0, d7: 0, d30: 0, today: 0 };
    a.total += c; if (r.day >= from7) a.d7 += c; if (r.day >= from30) a.d30 += c; if (r.day === today) a.today += c;
    const ad = actByDay[r.day] = actByDay[r.day] || {}; ad[r.kind] = (ad[r.kind] || 0) + c;
    const it = items[r.item_id] = items[r.item_id] || {};
    const k = it[r.kind] = it[r.kind] || { total: 0, d7: 0, d30: 0 };
    k.total += c;
    if (r.day >= from7) k.d7 += c;
    if (r.day >= from30) k.d30 += c;
  }
  for (let i = 29; i >= 0; i--) { const d = addDays(today, -i); visits.daily.push({ day: d, count: byDay[d] || 0, fresh: newByDay[d] || 0 }); }
  const actionsDaily = [];
  for (let i = 29; i >= 0; i--) { const d = addDays(today, -i); const x = actByDay[d] || {}; actionsDaily.push({ day: d, note: x.note || 0, play: x.play || 0, slides: x.slides || 0 }); }
  return json(200, { ready: true, today, firstDay, visits, newVisitors: fresh, items, survey, actions, actionsDaily });
}
