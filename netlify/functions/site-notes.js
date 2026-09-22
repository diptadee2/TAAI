// GET    /api/site-notes                 -> list every note row
// POST   /api/site-notes   { ... }        -> create one
// PUT    /api/site-notes   { id, ... }    -> update one
// DELETE /api/site-notes?id=...           -> remove one
//
// Backs /team's Site data > Notes sub-tab — role-gated (see requireAdmin
// in lib/supabase.js) CRUD for site_notes, which mirrors sheets/notes.csv
// (downloadable PDF notes per subject, read live today by
// gate-da-free-notes.html straight from a Google Sheet CSV — not from
// here yet, see CLAUDE.md's "Site data corner" section).
import { getSupabase, json, requireAdmin, SITE_DATA_SUBJECT_IDS } from './lib/supabase.js';

function sanitizeDate(v) {
  if (typeof v !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function validateBody(body) {
  if (!SITE_DATA_SUBJECT_IDS.includes(body.subject)) return 'invalid subject';
  return null;
}

function rowFromBody(body) {
  return {
    subject: body.subject,
    title: body.title || null,
    description: body.description || null,
    file_url: body.file_url || null,
    posted_on: sanitizeDate(body.posted_on),
  };
}

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;

  const supabase = getSupabase();

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase.from('site_notes').select('*').order('subject', { ascending: true }).order('posted_on', { ascending: false });
    if (error) return json(500, { error: error.message });
    return json(200, { rows: data });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
    const err = validateBody(body);
    if (err) return json(400, { error: err });

    const { data, error } = await supabase.from('site_notes').insert(rowFromBody(body)).select().maybeSingle();
    if (error) return json(500, { error: error.message });
    return json(200, { row: data });
  }

  if (event.httpMethod === 'PUT') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
    if (!body.id) return json(400, { error: 'id is required' });
    const err = validateBody(body);
    if (err) return json(400, { error: err });

    const row = { ...rowFromBody(body), updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from('site_notes').update(row).eq('id', body.id).select().maybeSingle();
    if (error) return json(500, { error: error.message });
    if (!data) return json(404, { error: 'not found' });
    return json(200, { row: data });
  }

  if (event.httpMethod === 'DELETE') {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: 'id is required' });
    const { error } = await supabase.from('site_notes').delete().eq('id', id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(405, { error: 'method not allowed' });
}
