// GET /api/site-settings-public -> { hideFinancialAssistance: bool }
//
// Public, UNAUTHENTICATED — same reasoning as site-pricing-public.js: read
// directly by index.html at page load to decide whether the "Can't afford
// it right now?" CTA card renders at all. Only ever returns booleans that
// are already meant to be visible as page behavior itself (whether a
// section shows), nothing sensitive.
import { getSupabase, json } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const supabase = getSupabase();
  const { data, error } = await supabase.from('site_settings').select('hide_financial_assistance').eq('id', 'main').maybeSingle();

  // Fails cleanly to "show everything" on any hiccup (table missing
  // pre-migration, a transient Supabase error, no row yet) — a broken
  // toggle must never be able to hide real content from the live site,
  // only an explicit, successfully-saved admin choice can.
  if (error || !data) return json(200, { hideFinancialAssistance: false });
  return json(200, { hideFinancialAssistance: !!data.hide_financial_assistance });
}
