// GET /api/site-pricing-public -> { rows: { "<id>": {price, price_old,
//   discount, discount_reason, discount_deadline, validity, sold_out_date,
//   enroll_url, display_order}, ... } }
//
// Public, UNAUTHENTICATED — unlike every other site-pricing/site-* function
// (all requireAdmin-gated, /team only), this one is read directly by
// gate-da-courses.html at page load, which has no Identity JWT to send.
// Every column returned here is already meant to be shown publicly on the
// live site (it's the exact same numbers/links the pages themselves
// display) — nothing sensitive, so no auth gate is needed.
//
// Replaces the earlier, narrower site-pricing-order.js (which only ever
// returned display_order) now that /team's Pricing tab controls price/
// discount/validity/enrol-link/sold-out-date live too, not just card
// order (2026-09-23 cutover — see CLAUDE.md's "Site data corner"
// section). One endpoint covering everything the live pages now read
// live, rather than a second near-duplicate fetch alongside this one.
import { getSupabase, json } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('site_pricing')
    .select('id, price, price_old, discount, discount_reason, discount_deadline, validity, sold_out_date, enroll_url, display_order');

  // Fails cleanly (an empty map, not an error response) on any Supabase
  // hiccup — the live pages' own fallback is their hardcoded COMBOS/
  // INDIVIDUAL data plus the pricing CSV, so this must never be able to
  // break a page, only ever improve on what's already there.
  if (error) return json(200, { rows: {} });

  const rows = {};
  (data || []).forEach((row) => { rows[row.id] = row; });
  return json(200, { rows });
}
