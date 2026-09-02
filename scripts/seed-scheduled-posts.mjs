// One-time seed: inserts scheduled_posts rows reproducing exactly what
// the 3 old standalone Discord functions already did, so retiring them in
// favor of discord-dispatch.js changes nothing about actual posting
// behavior until someone edits a post via /team. Safe to re-run (skips
// any source that already has a row) — not meant to run more than once
// per environment in practice.
//   npm run seed-scheduled-posts
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSupabase, computeNextFireAt } from '../netlify/functions/lib/supabase.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, '..');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^=#]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function main() {
  loadEnvFile();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set (check .env).');
    process.exit(1);
  }
  if (!process.env.DISCORD_WEBHOOK_URL) {
    console.error('DISCORD_WEBHOOK_URL is not set (check .env) — the seeded rows need it.');
    process.exit(1);
  }

  const supabase = getSupabase();
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  const seeds = [
    {
      source: 'daily_leader',
      webhook_url: webhookUrl,
      tag_everyone: false,
      schedule_type: 'daily',
      schedule_time: '10:00',
    },
    {
      source: 'weekly_leaderboard',
      webhook_url: webhookUrl,
      tag_everyone: true,
      schedule_type: 'weekly',
      schedule_day_of_week: 1, // Monday
      schedule_time: '10:30',
    },
    {
      source: 'monthly_consistency',
      webhook_url: webhookUrl,
      tag_everyone: true,
      schedule_type: 'monthly',
      schedule_day_of_month: 1,
      schedule_time: '12:00',
    },
  ];

  for (const seed of seeds) {
    const { data: existing, error: existingError } = await supabase
      .from('scheduled_posts')
      .select('id')
      .eq('source', seed.source)
      .maybeSingle();
    if (existingError) { console.error(seed.source, 'lookup failed:', existingError.message); process.exit(1); }
    if (existing) { console.log(seed.source, '-> already exists, skipping'); continue; }

    const nextFireAt = computeNextFireAt(seed);
    const { error } = await supabase.from('scheduled_posts').insert({
      ...seed,
      title: null,
      body: null,
      color: null,
      schedule_date: null,
      next_fire_at: nextFireAt.toISOString(),
      enabled: true,
    });
    if (error) { console.error(seed.source, 'insert failed:', error.message); process.exit(1); }
    console.log(seed.source, '-> seeded, next fires', nextFireAt.toISOString());
  }
}

main();
