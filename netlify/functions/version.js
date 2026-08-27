// GET /api/version
// Trivial, no-database endpoint progress.js polls periodically to detect a
// stale in-memory copy of itself — see CLIENT_VERSION in lib/supabase.js
// for why this exists. Deliberately doesn't touch Supabase: this needs to
// stay cheap enough to poll every couple of minutes from every open tab,
// running timer or not.
import { json, CLIENT_VERSION } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });
  return json(200, { version: CLIENT_VERSION });
}
