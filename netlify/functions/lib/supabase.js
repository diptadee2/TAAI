import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

let client = null;

export function getSupabase() {
  if (!client) {
    // supabase-js constructs a Realtime client eagerly even though these
    // functions never subscribe to anything — it needs a WebSocket ctor to
    // do that, which isn't a guaranteed global across every Lambda/Node
    // runtime a Netlify Function might execute on. Supplying `ws` avoids a
    // hard crash on every single request in environments without one.
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      realtime: { transport: ws },
    });
  }
  return client;
}

export function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Validates "YYYY-MM" and returns the [start, end) date range for a SQL query.
export function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return null;
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const endMonth = m === 12 ? 1 : m + 1;
  const endYear = m === 12 ? y + 1 : y;
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
  return { start, end };
}
