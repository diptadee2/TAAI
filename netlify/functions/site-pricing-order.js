// GET /api/site-pricing-order -> { order: { "<id>": <display_order>, ... } }
//
// Public, UNAUTHENTICATED — unlike every other site-pricing/site-*
// function (all requireAdmin-gated, /team only), this one is read by
// gate-da-courses.html itself at page load, which has no Identity JWT to
// send. Deliberately exposes ONLY id + display_order, nothing else (no
// price, no discount, no enroll_url) — reordering the live cards is the
// one piece of /team's Pricing tab this session wired up to actually
// affect taai.live (see CLAUDE.md's "Site data corner" section); every
// other field there is still admin-only preview.
import { getSupabase, json } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const supabase = getSupabase();
  const { data, error } = await supabase.from('site_pricing').select('id, display_order');

  // Fails cleanly (an empty order map, not an error response) whenever
  // display_order doesn't exist yet (pre-migration) or any other
  // Supabase hiccup — the live page's own fallback is its hardcoded
  // COMBOS/INDIVIDUAL array order, so this must never be able to break
  // the courses page, only ever fail to improve on it.
  if (error) return json(200, { order: {} });

  const order = {};
  (data || []).forEach((row) => {
    if (row.display_order != null) order[row.id] = row.display_order;
  });
  return json(200, { order });
}
