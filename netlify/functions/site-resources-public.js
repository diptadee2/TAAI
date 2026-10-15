// GET /api/site-resources-public -> { notes: [...], lectures: [...] }
//
// Public, unauthenticated read of /team's Site data > Notes and Lectures
// (site_notes / site_lectures), for gate-da-free-notes.html. Replaces the
// published Google Sheet CSVs that page used to read (2026-10-15). Rows are
// returned in the sheet's old column names so the page's rendering code is
// unchanged. Everything here is already shown publicly on that page.
import { getSupabase, json } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });
  const supabase = getSupabase();
  const [n, l] = await Promise.all([
    supabase.from('site_notes').select('subject, title, description, file_url, posted_on'),
    supabase.from('site_lectures').select('subject, lecture_number, title, youtube_url, slides_url, posted_on'),
  ]);
  if (n.error || l.error) return json(500, { error: (n.error || l.error).message });
  const notes = (n.data || []).map(r => ({ subject: r.subject, title: r.title || '', desc: r.description || '', file: r.file_url || '', postedOn: r.posted_on || '' }));
  const lectures = (l.data || []).map(r => ({ subject: r.subject, lectureNumber: r.lecture_number == null ? '' : String(r.lecture_number), title: r.title || '', youtubeUrl: r.youtube_url || '', slidesFile: r.slides_url || '', postedOn: r.posted_on || '' }));
  // Cached at Netlify's edge for 60s (browsers always revalidate): a /team edit shows within about a minute.
  const res = json(200, { notes, lectures });
  res.headers['Netlify-CDN-Cache-Control'] = 'public, s-maxage=60, stale-while-revalidate=300';
  res.headers['Cache-Control'] = 'public, max-age=0, must-revalidate';
  return res;
}
