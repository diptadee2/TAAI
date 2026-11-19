// GET /api/club-winner-public                 -> { active, key, items: [{kind, key}] }
// GET /api/club-winner-public?full=1          -> 1st place: { active, key, winner }
// GET /api/club-winner-public?full=1&kind=runners -> { active, key, runners }
//
// Public: the tracker shows the 2 AM Club popups to everyone between the
// dates set in /team. Two rows in club_winner: 'main' (1st place) and
// 'runners' (2nd, and 3rd if there is one; 2026-11-19), each on its own
// dates. Nothing is returned outside those dates, so a winner can't be seen
// early. Cached at Netlify's edge for 60s.
import { getSupabase } from './lib/supabase.js';
import { winnerActive, runnersActive } from './lib/club-winner.js';

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
    const items = [];
    if (main && winnerActive(main.data)) items.push({ kind: 'winner', key: String(new Date(main.updated_at).getTime()) });
    if (run && runnersActive(run.data)) items.push({ kind: 'runners', key: 'r' + new Date(run.updated_at).getTime() });
    if (!items.length) return reply({ active: false });
    const q = event.queryStringParameters || {};
    if (!q.full) return reply({ active: true, key: items[0].key, items });
    if (q.kind === 'runners') {
      const it = items.find(i => i.kind === 'runners');
      if (!it) return reply({ active: false });
      const d = run.data;
      return reply({ active: true, key: it.key, runners: { month: d.month, people: d.people } });
    }
    const it = items.find(i => i.kind === 'winner');
    if (!it) return reply({ active: false });
    const d = main.data;
    return reply({
      active: true, key: it.key,
      winner: { name: d.name, month: d.month, prize: d.prize, photos: d.photos, linkedin_text: d.linkedin_text, linkedin_url: d.linkedin_url },
    });
  } catch (e) {
    return reply({ active: false });
  }
}
