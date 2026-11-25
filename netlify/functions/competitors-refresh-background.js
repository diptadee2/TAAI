// Netlify Background Function (the -background.js suffix: the caller gets an
// immediate 202 and this keeps running, up to 15 minutes). /team's
// "Refresh now" (YouTube) and "Check now" (websites) used to run inside a
// normal request, which Netlify cuts off after about 10 seconds: the work
// finished but the button stayed on "Updating…" (2026-11-25). Now
// team-competitors.js / team-web-watch.js start this and the page waits for
// the new run to show up in the database.
// Body: { what: 'yt' | 'web' }. Internal only, same shared-secret check as
// check-name-background.js.
import { getSupabase } from './lib/supabase.js';
import { runYtMonitor } from './lib/yt-monitor.js';
import { runWebMonitor } from './lib/web-monitor.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  const secret = event.headers['x-internal-secret'] || event.headers['X-Internal-Secret'];
  if (!process.env.SUPABASE_SERVICE_KEY || secret !== process.env.SUPABASE_SERVICE_KEY) return { statusCode: 200, body: '' };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
  const s = getSupabase();
  try {
    if (body.what === 'web') await runWebMonitor(s, { budgetMs: 240000 });
    else await runYtMonitor(s, { budgetMs: 240000 });
  } catch (e) { console.error('competitors-refresh-background', body.what, e); }
  return { statusCode: 200, body: '' };
}

// Starts the background run from a request handler; resolves once Netlify
// has accepted it (immediate 202), not when the run finishes.
export async function startCompetitorsRefresh(event, what) {
  const proto = (event.headers && (event.headers['x-forwarded-proto'] || event.headers['X-Forwarded-Proto'])) || 'http';
  const host = event.headers && (event.headers.host || event.headers.Host);
  if (!host) throw new Error('no host header');
  const r = await fetch(proto + '://' + host + '/.netlify/functions/competitors-refresh-background', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.SUPABASE_SERVICE_KEY || '' },
    body: JSON.stringify({ what }),
  });
  if (r.status >= 400) throw new Error('could not start the update (HTTP ' + r.status + ')');
}
