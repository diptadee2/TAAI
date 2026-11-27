// Netlify Background Function (the -background.js suffix: the caller gets an
// immediate 202 and this keeps running, up to 15 minutes). /team's
// "Refresh now" (YouTube) and "Check now" (websites) used to run inside a
// normal request, which Netlify cuts off after about 10 seconds: the work
// finished but the button stayed on "Updating…" (2026-11-25). Now
// team-competitors.js / team-web-watch.js start this and the page waits for
// the new run to show up in the database.
// Body: { what: 'yt' | 'web' | 'ideas' | 'comments' | 'backfill' | 'market', days }. Internal only, same shared-secret check as
// check-name-background.js.
import { getSupabase } from './lib/supabase.js';
import { runYtMonitor, backfillYtHistory } from './lib/yt-monitor.js';
import { runWebMonitor } from './lib/web-monitor.js';
import { buildVideoIdeas } from './lib/video-ideas.js';
import { runYtMarket } from './lib/yt-market.js';
import { runYtAlerts } from './lib/yt-alerts.js';
import { buildCommentInsights } from './lib/yt-comments.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  const secret = event.headers['x-internal-secret'] || event.headers['X-Internal-Secret'];
  if (!process.env.SUPABASE_SERVICE_KEY || secret !== process.env.SUPABASE_SERVICE_KEY) return { statusCode: 200, body: '' };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
  const s = getSupabase();
  try {
    if (body.what === 'web') await runWebMonitor(s, { budgetMs: 240000 });
    else if (body.what === 'ideas') await buildVideoIdeas(s, body.days);
    else if (body.what === 'market') await runYtMarket(s);
    else if (body.what === 'backfill') await backfillYtHistory(s, { days: 365, budgetMs: 780000 });
    else if (body.what === 'comments') await buildCommentInsights(s, body.days);
    else { await runYtMonitor(s, { budgetMs: 240000 }); await runYtAlerts(s).catch(() => {}); }
  } catch (e) {
    console.error('competitors-refresh-background', body.what, e);
    if (body.what === 'backfill') await s.from('yt_runs').insert({ source: 'backfill', channels: 0, videos: 0, units: 0, error: String(e.message || e).slice(0, 300) }).then(() => {}, () => {});
    // An ideas run that fails leaves a note, so the page stops waiting and says why.
    if (body.what === 'comments') {
      const days = [1, 3, 7, 30].includes(Number(body.days)) ? Number(body.days) : 7;
      await s.storage.from('competitor-insights').upload('comments-' + days + '.json', JSON.stringify({ generatedAt: new Date().toISOString(), days, error: String(e.message || e).slice(0, 300) }), { contentType: 'application/json', upsert: true }).catch(() => {});
    }
    if (body.what === 'ideas') {
      const days = [1, 3, 7, 30].includes(Number(body.days)) ? Number(body.days) : 3;
      await s.storage.from('competitor-insights').upload('ideas-' + days + '.json', JSON.stringify({ generatedAt: new Date().toISOString(), days, error: String(e.message || e).slice(0, 300) }), { contentType: 'application/json', upsert: true }).catch(() => {});
    }
  }
  return { statusCode: 200, body: '' };
}

// Starts the background run from a request handler; resolves once Netlify
// has accepted it (immediate 202), not when the run finishes.
export async function startCompetitorsRefresh(event, what, extra) {
  const proto = (event.headers && (event.headers['x-forwarded-proto'] || event.headers['X-Forwarded-Proto'])) || 'http';
  const host = event.headers && (event.headers.host || event.headers.Host);
  if (!host) throw new Error('no host header');
  const r = await fetch(proto + '://' + host + '/.netlify/functions/competitors-refresh-background', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.SUPABASE_SERVICE_KEY || '' },
    body: JSON.stringify(Object.assign({ what }, extra || {})),
  });
  if (r.status >= 400) throw new Error('could not start the update (HTTP ' + r.status + ')');
}
