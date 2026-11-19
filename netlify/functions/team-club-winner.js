// GET /api/team-club-winner        -> { winner, updated_at }
// PUT /api/team-club-winner {...}  -> saves it, returns the same shape
// ?slot=runners (2nd and 3rd place, 2026-11-19): same, with { runners }.
// Admin only (/team > Marketing > 2 AM winner). The public side is
// club-winner-public.js.
import { getSupabase, json, requireAdmin } from './lib/supabase.js';
import { cleanWinner, cleanRunners } from './lib/club-winner.js';

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;
  const supabase = getSupabase();
  const runners = (event.queryStringParameters || {}).slot === 'runners';
  const id = runners ? 'runners' : 'main';
  const field = runners ? 'runners' : 'winner';

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase.from('club_winner').select('data, updated_at').eq('id', id).maybeSingle();
    if (error) return json(500, { error: error.message });
    return json(200, { [field]: (data && data.data) || null, updated_at: (data && data.updated_at) || null });
  }

  if (event.httpMethod === 'PUT') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
    const c = runners ? cleanRunners(body.runners) : cleanWinner(body.winner);
    if (c.error) return json(400, { error: c.error });
    const row = { id, data: c.data, updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from('club_winner').upsert(row, { onConflict: 'id' }).select('data, updated_at').maybeSingle();
    if (error) return json(500, { error: error.message });
    return json(200, { [field]: data.data, updated_at: data.updated_at });
  }

  return json(405, { error: 'method not allowed' });
}
