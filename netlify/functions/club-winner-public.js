// GET /api/club-winner-public                 -> { active, key, items: [{kind, key}], runners }
// GET /api/club-winner-public?full=1          -> 1st place: { active, key, winner }
// GET /api/club-winner-public?full=1&kind=runners -> the other places: { active, key, runners }
//
// Public: the tracker shows the 2 AM Club announcement to everyone between
// the dates set in /team. Two rows in club_winner: 'main' (1st place, whose
// switch and dates decide) and 'runners' (2nd, another 2nd, 3rd; shown in
// the same popup since 2026-11-21). Nothing is returned outside those
// dates, so winners can't be seen early. Cached at Netlify's edge for 60s.
import { getSupabase } from './lib/supabase.js';
import { winnerActive } from './lib/club-winner.js';

function reply(body) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      'Netlify-Vary': 'query=full|kind',
    },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: '' };
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.from('club_winner').select('id, data, updated_at').in('id', ['main', 'runners']);
    if (error || !data) return reply({ active: false });
    const main = data.find(r => r.id === 'main');
    const run = data.find(r => r.id === 'runners');
    // One announcement (2026-11-21): 1st place's switch and dates decide;
    // the other places (runners row) are shown in the same popup.
    if (!main || !winnerActive(main.data)) return reply({ active: false });
    const others = run && run.data && Array.isArray(run.data.people) ? run.data.people.filter(p => p && p.name) : [];
    const t = Math.max(new Date(main.updated_at).getTime(), others.length ? new Date(run.updated_at).getTime() : 0);
    const key = String(t);
    const q = event.queryStringParameters || {};
    if (!q.full) return reply({ active: true, key, items: [{ kind: 'winner', key }], runners: others.length > 0 });
    if (q.kind === 'runners') return reply({ active: true, key, runners: { month: run.data.month, note: run.data.note || '', people: others } });
    const d = main.data;
    return reply({
      active: true, key,
      winner: { name: d.name, month: d.month, prize: d.prize, photos: d.photos, linkedin_text: d.linkedin_text, linkedin_url: d.linkedin_url, headline: d.headline || '', avatar: d.avatar || null },
    });
  } catch (e) {
    return reply({ active: false });
  }
}
