// GET /mini-flt -> 302 to the live Mini FLT test (2026-11-24).
//
// Short link for posters and captions ("taai.live/mini-flt"). It reads the
// test link from /team > Site data > Settings > Free Mini FLT promo, so the
// same printed link keeps working when the live test changes. When the
// promo is switched off it goes to the test series page instead.
import { getSupabase } from './lib/supabase.js';
import { MINI_FLT_DEFAULT, publicMiniFlt } from './lib/mini-flt.js';

const FALLBACK = 'https://taai.live/gate-da-test-series';

export async function handler() {
  let m = MINI_FLT_DEFAULT;
  try {
    const { data, error } = await getSupabase().from('site_settings').select('*').eq('id', 'main').maybeSingle();
    if (!error && data) m = publicMiniFlt(data);
  } catch (e) { /* keep the default */ }
  const to = (m && m.enabled && m.url) ? m.url : FALLBACK;
  return {
    statusCode: 302,
    headers: {
      Location: to,
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
    },
    body: '',
  };
}
