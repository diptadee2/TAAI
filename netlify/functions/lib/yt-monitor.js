// Competitor YouTube monitor (2026-11-24): /team > Competitors.
//
// runYtMonitor() records, for every active row of yt_channels:
//   - the channel's subscribers / total views / video count (one row per IST
//     day in yt_channel_stats), and
//   - every video published in the last 30 days: title, type (video, short,
//     live), duration, views, likes, comments (yt_videos, updated each run),
//     plus a copy of the numbers per run in yt_video_stats, and the views at
//     about 24 hours and 7 days after publishing (views_24h / views_7d), which
//     make channels comparable however old their videos are.
//
// With YOUTUBE_API_KEY set it uses the YouTube Data API v3 (about 40 quota
// units a run against 10,000 free a day). Without it, it falls back to the
// public RSS feeds: only the latest 15 videos per channel, views and likes,
// no subscribers or comments.
// Runs every 6 hours (yt-monitor.js) and on "Refresh now" in /team.

export const YT_TRACK_DAYS = 30;
const API = 'https://www.googleapis.com/youtube/v3/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export function ytKey() { return process.env.YOUTUBE_API_KEY || ''; }

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

async function fetchT(url, opts = {}, ms = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, Object.assign({ signal: ac.signal }, opts)); }
  finally { clearTimeout(t); }
}

function makeApi() {
  const key = ytKey();
  const ctx = { units: 0 };
  ctx.get = async (path, params) => {
    const q = new URLSearchParams(Object.assign({}, params, { key }));
    const r = await fetchT(API + path + '?' + q.toString());
    ctx.units += 1;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('YouTube API ' + path + ': ' + ((d.error && d.error.message) || r.status));
    return d;
  };
  return ctx;
}

// "PT1H2M3S" -> 3723
function isoDuration(s) {
  const m = String(s || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

// youtube.com/shorts/<id> answers 200 for a Short and redirects for anything else.
async function isShort(videoId) {
  try {
    const r = await fetchT('https://www.youtube.com/shorts/' + videoId, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': UA } }, 6000);
    return r.status === 200;
  } catch (e) { return null; }
}

// Accepts a channel URL, @handle, handle or UC... id.
export async function resolveChannel(input) {
  let s = String(input || '').trim();
  const idm = s.match(/(UC[A-Za-z0-9_-]{22})/);
  if (idm) return { channel_id: idm[1], handle: null };
  const hm = s.match(/youtube\.com\/@([A-Za-z0-9_.-]+)/i) || s.match(/^@?([A-Za-z0-9_.-]{3,})$/);
  if (!hm) throw new Error('Paste a YouTube channel link, @handle or channel ID');
  const handle = hm[1];
  if (ytKey()) {
    const api = makeApi();
    const d = await api.get('channels', { part: 'id', forHandle: '@' + handle });
    if (d.items && d.items[0]) return { channel_id: d.items[0].id, handle };
  }
  const r = await fetchT('https://www.youtube.com/@' + encodeURIComponent(handle), { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  const html = await r.text();
  const m = html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/) || html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/);
  if (!m) throw new Error('Could not find a YouTube channel for @' + handle);
  return { channel_id: m[1], handle };
}

function decodeXml(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function rssVideos(channelId) {
  const r = await fetchT('https://www.youtube.com/feeds/videos.xml?channel_id=' + channelId, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('feed ' + r.status);
  const xml = await r.text();
  const title = decodeXml((xml.match(/<title>([^<]*)<\/title>/) || [])[1]);
  const out = [];
  for (const e of xml.split('<entry>').slice(1)) {
    const g = re => (e.match(re) || [])[1];
    out.push({
      video_id: g(/<yt:videoId>([^<]+)</),
      title: decodeXml(g(/<title>([^<]*)</)),
      published_at: g(/<published>([^<]+)</),
      kind: /\/shorts\//.test(g(/<link rel="alternate" href="([^"]+)"/) || '') ? 'short' : 'video',
      duration_s: null,
      views: +g(/<media:statistics views="(\d+)"/) || 0,
      likes: g(/<media:starRating count="(\d+)"/) != null ? +g(/<media:starRating count="(\d+)"/) : null,
      comments: null,
    });
  }
  return { title, videos: out.filter(v => v.video_id) };
}

export async function runYtMonitor(supabase, { budgetMs = 22000 } = {}) {
  const started = Date.now();
  const now = new Date();
  const runAt = new Date(Math.floor(now.getTime() / 60000) * 60000).toISOString();
  const cutoff = now.getTime() - YT_TRACK_DAYS * 86400000;
  const { data: channels, error } = await supabase.from('yt_channels').select('*').eq('active', true).order('sort');
  if (error) throw error;
  const useApi = !!ytKey();
  const api = useApi ? makeApi() : null;
  const found = [];          // { channel_id, ...video }
  const errors = [];

  if (useApi) {
    for (let i = 0; i < channels.length; i += 50) {
      const batch = channels.slice(i, i + 50);
      const d = await api.get('channels', { part: 'snippet,statistics,contentDetails', id: batch.map(c => c.channel_id).join(','), maxResults: 50 });
      for (const it of d.items || []) {
        const c = channels.find(x => x.channel_id === it.id);
        if (!c) continue;
        c.uploads_playlist = it.contentDetails && it.contentDetails.relatedPlaylists && it.contentDetails.relatedPlaylists.uploads;
        const sn = it.snippet || {}, st = it.statistics || {};
        await supabase.from('yt_channels').update({
          title: sn.title || c.title, thumbnail: (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.default) || {}).url || c.thumbnail,
          handle: c.handle || (sn.customUrl ? sn.customUrl.replace(/^@/, '') : null), uploads_playlist: c.uploads_playlist,
        }).eq('channel_id', c.channel_id);
        await supabase.from('yt_channel_stats').upsert({
          channel_id: c.channel_id, taken_on: todayIST(), taken_at: now.toISOString(),
          subscribers: st.hiddenSubscriberCount ? null : (st.subscriberCount != null ? +st.subscriberCount : null),
          total_views: st.viewCount != null ? +st.viewCount : null,
          video_count: st.videoCount != null ? +st.videoCount : null,
        }, { onConflict: 'channel_id,taken_on' });
      }
    }
    // Uploads of the last 30 days (newest first in the uploads playlist).
    const ids = [];
    const owner = {};
    for (const c of channels) {
      if (!c.uploads_playlist || Date.now() - started > budgetMs) continue;
      let page = null;
      for (let p = 0; p < 6; p++) {
        const d = await api.get('playlistItems', Object.assign({ part: 'contentDetails', playlistId: c.uploads_playlist, maxResults: 50 }, page ? { pageToken: page } : {}))
          .catch(e => { errors.push(c.label + ': ' + e.message); return null; });
        if (!d) break;
        let old = false;
        for (const it of d.items || []) {
          const pub = Date.parse(it.contentDetails.videoPublishedAt || '');
          if (pub && pub < cutoff) { old = true; continue; }
          ids.push(it.contentDetails.videoId); owner[it.contentDetails.videoId] = c.channel_id;
        }
        page = d.nextPageToken;
        if (old || !page) break;
      }
    }
    for (let i = 0; i < ids.length; i += 50) {
      const d = await api.get('videos', { part: 'snippet,statistics,contentDetails,liveStreamingDetails', id: ids.slice(i, i + 50).join(','), maxResults: 50 });
      for (const v of d.items || []) {
        const sn = v.snippet || {}, st = v.statistics || {};
        if (sn.liveBroadcastContent === 'upcoming') continue;
        const live = !!(v.liveStreamingDetails && v.liveStreamingDetails.actualStartTime);
        found.push({
          channel_id: owner[v.id] || sn.channelId, video_id: v.id, title: sn.title,
          published_at: (v.liveStreamingDetails && v.liveStreamingDetails.actualStartTime) || sn.publishedAt,
          kind: live ? 'live' : null, duration_s: isoDuration(v.contentDetails && v.contentDetails.duration),
          views: st.viewCount != null ? +st.viewCount : null, likes: st.likeCount != null ? +st.likeCount : null,
          comments: st.commentCount != null ? +st.commentCount : null,
        });
      }
    }
  } else {
    for (const c of channels) {
      if (Date.now() - started > budgetMs) break;
      try {
        const r = await rssVideos(c.channel_id);
        if (r.title && r.title !== c.title) await supabase.from('yt_channels').update({ title: r.title }).eq('channel_id', c.channel_id);
        r.videos.filter(v => Date.parse(v.published_at) >= cutoff).forEach(v => found.push(Object.assign({ channel_id: c.channel_id }, v)));
      } catch (e) { errors.push(c.label + ': ' + e.message); }
    }
  }

  // Merge with what's stored: keep the type once known, and fill the
  // views-at-24h / views-at-7-days marks the first run after each point.
  const existing = {};
  for (let i = 0; i < found.length; i += 200) {
    const { data } = await supabase.from('yt_videos').select('video_id, kind, views_24h, views_7d, first_seen')
      .in('video_id', found.slice(i, i + 200).map(v => v.video_id));
    (data || []).forEach(r => { existing[r.video_id] = r; });
  }
  const rows = [], stats = [];
  const shortChecks = [];
  for (const v of found) {
    const ex = existing[v.video_id] || {};
    const age = now.getTime() - Date.parse(v.published_at);
    let kind = v.kind || ex.kind || null;
    if (!kind) {
      if (v.duration_s != null && v.duration_s > 180) kind = 'video';
      else shortChecks.push(v);
    }
    const row = {
      video_id: v.video_id, channel_id: v.channel_id, title: v.title, published_at: v.published_at,
      kind, duration_s: v.duration_s, views: v.views, likes: v.likes, comments: v.comments,
      views_24h: ex.views_24h != null ? ex.views_24h : (age >= 86400000 && age <= 30 * 3600000 ? v.views : null),
      views_7d: ex.views_7d != null ? ex.views_7d : (age >= 7 * 86400000 && age <= 7 * 86400000 + 12 * 3600000 ? v.views : null),
      updated_at: now.toISOString(),
    };
    rows.push(row);
    stats.push({ video_id: v.video_id, taken_at: runAt, views: v.views, likes: v.likes, comments: v.comments });
  }
  for (let i = 0; i < shortChecks.length; i += 8) {
    if (Date.now() - started > budgetMs + 6000) break;
    const res = await Promise.all(shortChecks.slice(i, i + 8).map(v => isShort(v.video_id)));
    shortChecks.slice(i, i + 8).forEach((v, j) => {
      const row = rows.find(r => r.video_id === v.video_id);
      if (res[j] != null) row.kind = res[j] ? 'short' : 'video';
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    const { error: e1 } = await supabase.from('yt_videos').upsert(rows.slice(i, i + 200), { onConflict: 'video_id' });
    if (e1) throw e1;
    const { error: e2 } = await supabase.from('yt_video_stats').upsert(stats.slice(i, i + 200), { onConflict: 'video_id,taken_at' });
    if (e2) throw e2;
  }
  await supabase.from('yt_video_stats').delete().lt('taken_at', new Date(now.getTime() - 60 * 86400000).toISOString());
  const result = { source: useApi ? 'api' : 'rss', channels: channels.length, videos: rows.length, units: api ? api.units : 0, error: errors.join('; ').slice(0, 1000) || null };
  await supabase.from('yt_runs').insert(result);
  return result;
}
