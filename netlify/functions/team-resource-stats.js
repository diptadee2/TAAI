// GET /api/team-resource-stats -> { today, visits: {total, d7, d30, today, daily: [{day, count}]},
//                                   items: { <id>: { note|play|slides: {total, d7, d30} } } }
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
  const items = {};
  for (const r of rows) {
    const c = r.count || 0;
    if (r.kind === 'visit') {
      visits.total += c;
      if (r.day >= from7) visits.d7 += c;
      if (r.day >= from30) visits.d30 += c;
      if (r.day === today) visits.today += c;
      byDay[r.day] = (byDay[r.day] || 0) + c;
      continue;
    }
    const it = items[r.item_id] = items[r.item_id] || {};
    const k = it[r.kind] = it[r.kind] || { total: 0, d7: 0, d30: 0 };
    k.total += c;
    if (r.day >= from7) k.d7 += c;
    if (r.day >= from30) k.d30 += c;
  }
  for (let i = 29; i >= 0; i--) { const d = addDays(today, -i); visits.daily.push({ day: d, count: byDay[d] || 0 }); }
  return json(200, { ready: true, today, visits, items });
}
