// POST /api/resource-lead  { email, year, prep, src, website } -> 204
//
// Optional email at the end of the Resources page survey (2026-11-27): "Want a
// discount code sent to you? Leave your email." Saved with the visitor's three
// answers in resource_leads (one row per email; a repeat updates the answers).
// Public and unauthenticated like resource-event.js; the answers must be the
// survey's own values, `website` is a honeypot (bots fill it, people never see
// it). Always answers 204: nobody waits on it.
import { getSupabase } from './lib/supabase.js';
import { cleanSurveyValue } from './resource-event.js';

const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i;
const done = { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  let b = {};
  try { b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : (event.body || '{}')); } catch (e) { return done; }
  if (b.website) return done;
  const email = String(b.email || '').trim().toLowerCase();
  if (email.length > 200 || !EMAIL.test(email)) return done;
  const row = {
    email,
    year: cleanSurveyValue('sv_year', b.year),
    prep: cleanSurveyValue('sv_gate', b.prep),
    source: cleanSurveyValue('sv_src', b.src),
    updated_at: new Date().toISOString(),
  };
  try { await getSupabase().from('resource_leads').upsert(row, { onConflict: 'email' }); } catch (e) { /* best-effort */ }
  return done;
}
