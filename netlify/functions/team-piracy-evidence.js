// /team > Piracy > Evidence (2026-11-24). Admin only.
// GET /api/team-piracy-evidence -> { files: [...manifest entries, url], updated_at }
//
// Evidence screenshots for possible legal action live in the PRIVATE storage
// bucket "piracy-evidence" (uploaded unchanged by scripts/upload-piracy-
// evidence.mjs, which also keeps manifest.json there: SHA-256, size, capture
// date, network, target, links, description per file). The bucket is never
// public; this hands out signed links that stop working after an hour.
import { getSupabase, json, requireAdmin } from './lib/supabase.js';

const BUCKET = 'piracy-evidence';
const LINK_SECONDS = 60 * 60;

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });
  const s = getSupabase();
  const { data, error } = await s.storage.from(BUCKET).download('manifest.json');
  if (error || !data) return json(200, { files: [], ready: false, error: error ? error.message : 'no manifest yet' });
  let manifest;
  try { manifest = JSON.parse(await data.text()); } catch (e) { return json(500, { error: 'manifest unreadable' }); }
  const files = manifest.files || [];
  const urls = {};
  for (let i = 0; i < files.length; i += 100) {
    const { data: signed, error: sErr } = await s.storage.from(BUCKET)
      .createSignedUrls(files.slice(i, i + 100).map(f => f.path), LINK_SECONDS);
    if (sErr) return json(500, { error: sErr.message });
    for (const x of signed || []) if (x.signedUrl) urls[x.path] = x.signedUrl;
  }
  return json(200, {
    ready: true,
    updated_at: manifest.updated_at || null,
    expires_in: LINK_SECONDS,
    files: files.map(f => Object.assign({}, f, { url: urls[f.path] || null })),
  });
}
