// POST /api/rename  { email, display_name }
// The one path that actually changes a student's display name. Deliberately
// separate from register.js, which recognizes a returning student by email
// and ignores whatever name they typed that time — this is only reachable
// from an explicit "Rename" action the student takes on purpose, not a
// side effect of registering again on a new device.
import { getSupabase, json } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const displayName = String(body.display_name || '').trim();
  if (!email) return json(400, { error: 'email is required' });
  if (!displayName) return json(400, { error: 'display_name is required' });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('students')
    .update({ display_name: displayName })
    .eq('email', email)
    .select('email, display_name')
    .maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!data) return json(404, { error: 'student not found' });

  return json(200, data);
}
