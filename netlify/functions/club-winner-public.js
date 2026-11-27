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
    const q = event.queryStringParameters || {};
    // Every tracker load and 10-minute poll asks the light question (no
    // ?full). The rows hold the photos as data URLs (~1 MB together), so that
    // question reads only the few small fields it needs: reading whole rows
    // on every call cost ~1.5 GB of Supabase egress a day (2026-11-27).
    // cleanWinner only lets the switch be on with a photo, so the light check
    // doesn't need the photo itself.
    if (!q.full) {
      const { data: rows, error: e1 } = await supabase.from('club_winner')
        .select('id, updated_at, enabled:data->enabled, name:data->>name, show_until:data->>show_until, n0:data->people->0->>name, n1:data->people->1->>name, n2:data->people->2->>name, n3:data->people->3->>name')
        .in('id', ['main', 'runners']);
      if (e1 || !rows) return reply({ active: false });
      const m = rows.find(r => r.id === 'main');
      const rr = rows.find(r => r.id === 'runners');
      if (!m || !winnerActive({ enabled: m.enabled === true, name: m.name, photos: [1], show_until: m.show_until })) return reply({ active: false });
      const hasOthers = !!(rr && (rr.n0 || rr.n1 || rr.n2 || rr.n3));
      const k = String(Math.max(new Date(m.updated_at).getTime(), hasOthers ? new Date(rr.updated_at).getTime() : 0));
      return reply({ active: true, key: k, items: [{ kind: 'winner', key: k }], runners: hasOthers });
    }
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
