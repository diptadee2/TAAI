// Edge Function version of /api/tracker-data (step 3 of the tracker
// load-time plan, 2026-10-01). It runs the EXACT same handler as the
// regular function (imported, not copied), just on Netlify's edge network
// near the visitor instead of a regular function in US East, so the
// round trips to the database are short. Served at /edge/tracker-data.
//
// Rollout is controlled by TRACKER_EDGE_MODE in progress.js:
//   'shadow' - students keep using /api/tracker-data; ~1 in 10 page loads
//              also calls this in the background and logs whether the two
//              responses matched and how long each took (edge-shadow-log).
//   'on'     - the page uses this, falling back to /api/tracker-data on any
//              error or slow response.
// x-edge-ms reports this handler's own wall time for those comparisons.
import { handler } from '../functions/tracker-data.js';

export default async (request) => {
  const url = new URL(request.url);
  const queryStringParameters = Object.fromEntries(url.searchParams.entries());
  const started = Date.now();
  const result = await handler({ httpMethod: request.method, queryStringParameters });
  const headers = new Headers(result.headers || {});
  headers.set('x-edge-ms', String(Date.now() - started));
  headers.set('cache-control', 'no-store');
  return new Response(result.body, { status: result.statusCode, headers });
};

export const config = { path: '/edge/tracker-data' };
