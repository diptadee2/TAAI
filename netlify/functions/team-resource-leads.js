// /team > Site data > Notes / Lectures (2026-11-27): emails left at the end of
// the Resources page survey, newest first, with their answers.
// GET -> { ready, leads: [{email, year, prep, source, created_at, sent_at}] }
// POST { email, sent: true|false } -> marks a code as sent (or not)
import { getSupabase, json, requireAdmin } from './lib/supabase.js';

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;
  const s = getSupabase();
  if (event.httpMethod === 'GET') {
    const { data, error } = await s.from('resource_leads').select('email, year, prep, source, created_at, updated_at, sent_at').order('created_at', { ascending: false }).limit(2000);
    if (error) return json(200, { ready: false, error: error.message });
    return json(200, { ready: true, leads: data || [] });
  }
  if (event.httpMethod === 'POST') {
    let b; try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
    if (!b.email) return json(400, { error: 'email required' });
    const { error } = await s.from('resource_leads').update({ sent_at: b.sent ? new Date().toISOString() : null }).eq('email', String(b.email).toLowerCase());
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }
  return json(405, { error: 'method not allowed' });
}
