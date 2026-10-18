// GET    /api/team-challenge          -> { rows, cutoff, open }
// DELETE /api/team-challenge?id=<uuid> -> { ok }  (lets a student resubmit
//                                         after a mistake they emailed about)
//
// Admin-only view of "100 pe 100% off" registrations for /team. The cutoff
// itself is saved through site-settings.js (challenge_cutoff).
import { getSupabase, json, requireAdmin } from './lib/supabase.js';
import { fetchChallengeCutoff, isChallengeOpen } from './lib/challenge.js';

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;
  const supabase = getSupabase();

  if (event.httpMethod === 'GET') {
    const cutoff = await fetchChallengeCutoff(supabase);
    const { data, error } = await supabase.from('challenge_registrations')
      .select('*')
      .order('submitted_at', { ascending: false });
    if (error) return json(200, { rows: [], cutoff, open: isChallengeOpen(cutoff), error: error.message });
    return json(200, { rows: data || [], cutoff, open: isChallengeOpen(cutoff) });
  }

  if (event.httpMethod === 'DELETE') {
    const id = (event.queryStringParameters || {}).id;
    if (!id) return json(400, { error: 'id required' });
    const { error } = await supabase.from('challenge_registrations').delete().eq('id', id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(405, { error: 'method not allowed' });
}
