// GET /api/site-settings       -> { row: { id, hide_financial_assistance, updated_at } }
// PUT /api/site-settings  {...} -> updates whichever known toggle fields are
//                                  present in the body, returns the updated row
//
// Backs /team's Site data > Settings sub-tab — role-gated (see requireAdmin
// in lib/supabase.js), same shape as site-pricing.js/site-notes.js/
// site-lectures.js. Unlike those three, this isn't a list of rows — it's
// one fixed settings row (id='main', see schema.sql), read publicly (no
// auth) via the separate site-settings-public.js for the live page.
import { getSupabase, json, requireAdmin } from './lib/supabase.js';

const ROW_ID = 'main';

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;

  const supabase = getSupabase();

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase.from('site_settings').select('*').eq('id', ROW_ID).maybeSingle();
    if (error) return json(500, { error: error.message });
    // No row yet (migration ran but the seed INSERT hasn't, or a brand
    // new table) — fall back to the column defaults rather than
    // erroring, same "never surprise the admin with an error for an
    // unconfigured toggle" reasoning this project already applies
    // elsewhere (e.g. site-pricing-public.js's empty-map fallback).
    return json(200, { row: data || { id: ROW_ID, hide_financial_assistance: false, updated_at: null } });
  }

  if (event.httpMethod === 'PUT') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

    const patch = { id: ROW_ID, updated_at: new Date().toISOString() };
    // Only ever touches a toggle whose value is genuinely present and a
    // real boolean — a missing/malformed field in the request body is
    // silently ignored rather than overwriting an existing setting with
    // something unintended.
    if (typeof body.hide_financial_assistance === 'boolean') {
      patch.hide_financial_assistance = body.hide_financial_assistance;
    }

    // upsert, not update-only — self-heals even if the schema
    // migration's own seed INSERT was skipped or the row was somehow
    // deleted, rather than requiring that manual step to have gone
    // exactly right first.
    const { data, error } = await supabase.from('site_settings').upsert(patch, { onConflict: 'id' }).select().maybeSingle();
    if (error) return json(500, { error: error.message });
    return json(200, { row: data });
  }

  return json(405, { error: 'method not allowed' });
}
