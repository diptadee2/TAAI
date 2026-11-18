// GET /api/club-winner-public          -> { active, key }      (small, every tracker load)
// GET /api/club-winner-public?full=1   -> { active, key, winner } (photos included)
//
// Public: the tracker shows the 2 AM Club winner popup to everyone between
// the dates set in /team. Nothing is returned outside those dates, so the
// winner can't be seen early. Cached at Netlify's edge for 60s.
import { getSupabase } from './lib/supabase.js';
import { winnerActive } from './lib/club-winner.js';

function reply(body) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      'Netlify-Vary': 'query=full',
    },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: '' };
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.from('club_winner').select('data, updated_at').eq('id', 'main').maybeSingle();
    if (error || !data || !winnerActive(data.data)) return reply({ active: false });
    const key = String(new Date(data.updated_at).getTime());
    const full = event.queryStringParameters && event.queryStringParameters.full;
    if (!full) return reply({ active: true, key });
    const d = data.data;
    return reply({
      active: true, key,
      winner: { name: d.name, month: d.month, prize: d.prize, photos: d.photos, linkedin_text: d.linkedin_text, linkedin_url: d.linkedin_url },
    });
  } catch (e) {
    return reply({ active: false });
  }
}
