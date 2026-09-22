// GET    /api/site-pricing                -> list every pricing row
// POST   /api/site-pricing   { id, ... }   -> create one (id is the real PK — see schema.sql)
// PUT    /api/site-pricing   { id, ... }   -> update one
// DELETE /api/site-pricing?id=...          -> remove one
//
// Backs /team's Site data > Pricing sub-tab — role-gated (see requireAdmin
// in lib/supabase.js) CRUD for site_pricing, which mirrors sheets/pricing.csv
// 1:1 (same id slugs the live pages' pricingMap already keys off). The live
// pages themselves are NOT reading from this table yet — they still fetch
// the published Google Sheet CSV directly, by explicit instruction, until a
// later, separate cutover. See CLAUDE.md's "Site data corner" section.
import { getSupabase, json, requireAdmin } from './lib/supabase.js';

const VALID_TYPES = ['combo', 'individual', 'test-series'];

// YYYY-MM-DD from a real <input type="date"> value, or null — never
// trust a client-sent date string further than that shape, but no real
// parsing is needed since Postgres's own DATE column does the rest.
function sanitizeDate(v) {
  if (typeof v !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function sanitizeInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function validateBody(body) {
  if (!body.id || typeof body.id !== 'string') return 'id is required';
  if (!VALID_TYPES.includes(body.type)) return 'invalid type';
  if (!body.name || typeof body.name !== 'string') return 'name is required';
  return null;
}

function rowFromBody(body) {
  return {
    id: body.id.trim(),
    type: body.type,
    name: body.name.trim(),
    price: sanitizeInt(body.price),
    price_old: sanitizeInt(body.price_old),
    discount: body.discount || null,
    discount_reason: body.discount_reason || null,
    discount_deadline: sanitizeDate(body.discount_deadline),
    validity: sanitizeDate(body.validity),
  };
}

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;

  const supabase = getSupabase();

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase.from('site_pricing').select('*').order('type', { ascending: true }).order('id', { ascending: true });
    if (error) return json(500, { error: error.message });
    return json(200, { rows: data });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
    const err = validateBody(body);
    if (err) return json(400, { error: err });

    const { data, error } = await supabase.from('site_pricing').insert(rowFromBody(body)).select().maybeSingle();
    if (error) return json(500, { error: error.message });
    return json(200, { row: data });
  }

  if (event.httpMethod === 'PUT') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
    const err = validateBody(body);
    if (err) return json(400, { error: err });

    const row = { ...rowFromBody(body), updated_at: new Date().toISOString() };
    delete row.id; // id is the PK we match on, not a field to overwrite
    const { data, error } = await supabase.from('site_pricing').update(row).eq('id', body.id.trim()).select().maybeSingle();
    if (error) return json(500, { error: error.message });
    if (!data) return json(404, { error: 'not found' });
    return json(200, { row: data });
  }

  if (event.httpMethod === 'DELETE') {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: 'id is required' });
    const { error } = await supabase.from('site_pricing').delete().eq('id', id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(405, { error: 'method not allowed' });
}
