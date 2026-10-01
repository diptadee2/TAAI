// POST { match, diffKeys, oldMs, edgeMs, edgeServerMs, isStudent, error }
// from progress.js's tracker-data shadow comparison (TRACKER_EDGE_MODE =
// 'shadow'). Best-effort: a missing table or bad payload is ignored, and
// it always answers 204, since nobody waits on it.
import { getSupabase } from './lib/supabase.js';

const toInt = (v) => (Number.isFinite(+v) ? Math.round(+v) : null);

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  try {
    const b = JSON.parse(event.body || '{}');
    await getSupabase().from('edge_shadow_log').insert({
      match: !!b.match,
      diff_keys: Array.isArray(b.diffKeys) ? b.diffKeys.slice(0, 20).map(String) : null,
      old_ms: toInt(b.oldMs),
      edge_ms: toInt(b.edgeMs),
      edge_server_ms: toInt(b.edgeServerMs),
      is_student: !!b.isStudent,
      error: b.error ? String(b.error).slice(0, 300) : null,
    });
  } catch (e) { /* best-effort */ }
  return { statusCode: 204, body: '' };
}
