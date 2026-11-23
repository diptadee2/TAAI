// GET /api/site-settings-public -> { hideFinancialAssistance: bool, miniFlt: {enabled, topics, url} }
//
// Public, UNAUTHENTICATED — same reasoning as site-pricing-public.js: read
// directly by index.html at page load to decide whether the "Can't afford
// it right now?" CTA card renders at all. Only ever returns booleans that
// are already meant to be visible as page behavior itself (whether a
// section shows), nothing sensitive.
import { getSupabase, json } from './lib/supabase.js';
import { MINI_FLT_DEFAULT, publicMiniFlt, TOP_STRIP_DEFAULT, publicTopStrip } from './lib/mini-flt.js';

// Read on every page load of home, test series and the tracker, so it's cached
// at Netlify's edge for 60s (browsers always revalidate). A /team change shows
// within about a minute.
const CACHE = { 'Cache-Control': 'public, max-age=0, must-revalidate', 'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' };
function out(body) { const r = json(200, body); r.headers = Object.assign({}, r.headers, CACHE); return r; }

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const supabase = getSupabase();
  // select('*') so a not-yet-added mini_flt column can't fail the query.
  const { data, error } = await supabase.from('site_settings').select('*').eq('id', 'main').maybeSingle();

  // Fails cleanly to "show everything" on any hiccup (table missing
  // pre-migration, a transient Supabase error, no row yet) — a broken
  // toggle must never be able to hide real content from the live site,
  // only an explicit, successfully-saved admin choice can.
  if (error || !data) return out({ hideFinancialAssistance: false, miniFlt: MINI_FLT_DEFAULT, topStrip: TOP_STRIP_DEFAULT });
  return out({ hideFinancialAssistance: !!data.hide_financial_assistance, miniFlt: publicMiniFlt(data), topStrip: publicTopStrip(data) });
}
