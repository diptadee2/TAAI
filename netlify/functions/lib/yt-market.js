// Whole GATE CSE / DA YouTube market (2026-11-25): /team > Competitors >
// Whole market. "A general idea about GATE CSE and GATE DA except our
// competitors and what is working." Once a day (yt-market.js, and "Scan now"
// in /team) this runs YouTube searches for GATE CSE and GATE DA videos from the
// last 30 days, most viewed first, from ANY channel, and saves what it finds
// with each channel's subscriber count. The page leaves out the channels
// already tracked in yt_channels.
//
// Quota: a search costs 100 units, so MARKET_QUERIES (7) is about 700 units,
// plus ~15 for the video and channel numbers, against 10,000 free a day.
// Kept in the private storage bucket "competitor-insights" as
// market/latest.json, plus market/<IST date>.json each day (a history for later).
import { makeApi, isoDuration, ytKey } from './yt-monitor.js';

const BUCKET = 'competitor-insights';
export const MARKET_QUERIES = [
  'GATE CSE', 'GATE computer science 2027', 'GATE CS IT preparation',
  'GATE DA', 'GATE data science and AI', 'GATE DA 2027',
  'GATE 2027 preparation strategy',
];
const DA_RE = /\bDA\b|data science|\bDS\s*&?\s*AI\b|\bDSAI\b|\bDS\s*AI\b|data\s*science\s*(and|&)\s*(ai|artificial)/i;
const CSE_RE = /\bCSE?\b|computer science|\bCS\s*[\/&-]?\s*IT\b|\bCSIT\b/i;

function todayIST() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }

export function examOf(text) {
  const da = DA_RE.test(text), cse = CSE_RE.test(text);
  return da && cse ? 'both' : da ? 'da' : cse ? 'cse' : 'gate';
}

export async function runYtMarket(supabase, { days = 30 } = {}) {
  if (!ytKey()) throw new Error('YOUTUBE_API_KEY is not set');
  const api = makeApi();
  const after = new Date(Date.now() - days * 86400000).toISOString();
  const hits = {};   // videoId -> [query, ...]
  const errors = [];
  for (const q of MARKET_QUERIES) {
    const d = await api.get('search', { part: 'id', type: 'video', q, order: 'viewCount', publishedAfter: after, regionCode: 'IN', maxResults: 50 })
      .catch(e => { errors.push(q + ': ' + e.message); return null; });
    for (const it of (d && d.items) || []) {
      const id = it.id && it.id.videoId;
      if (id) (hits[id] = hits[id] || []).push(q);
    }
  }
  const ids = Object.keys(hits);
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await api.get('videos', { part: 'snippet,statistics,contentDetails,liveStreamingDetails', id: ids.slice(i, i + 50).join(','), maxResults: 50 });
    for (const v of d.items || []) {
      const sn = v.snippet || {}, st = v.statistics || {};
      if (sn.liveBroadcastContent === 'upcoming' || sn.liveBroadcastContent === 'live') continue;
      const text = (sn.title || '') + ' ' + (sn.description || '').slice(0, 600) + ' ' + (sn.tags || []).join(' ');
      // Search also returns loosely related videos: keep only ones that are about GATE.
      if (!/\bgate\b/i.test(text)) continue;
      const live = !!(v.liveStreamingDetails && v.liveStreamingDetails.actualStartTime);
      const dur = isoDuration(v.contentDetails && v.contentDetails.duration);
      videos.push({
        id: v.id, channel_id: sn.channelId, title: sn.title,
        published_at: (v.liveStreamingDetails && v.liveStreamingDetails.actualStartTime) || sn.publishedAt,
        kind: live ? 'live' : (dur != null && dur <= 180 ? 'short' : 'video'), duration_s: dur,
        views: st.viewCount != null ? +st.viewCount : null, likes: st.likeCount != null ? +st.likeCount : null,
        comments: st.commentCount != null ? +st.commentCount : null,
        exam: examOf(text), lang: /[ऀ-ॿ]/.test(sn.title || '') || /\b(kaise|kya|hai|karo|kare|sabse|padhai)\b/i.test(sn.title || '') ? 'hi' : null,
        queries: hits[v.id],
      });
    }
  }
  const chIds = [...new Set(videos.map(v => v.channel_id))];
  const channels = {};
  for (let i = 0; i < chIds.length; i += 50) {
    const d = await api.get('channels', { part: 'snippet,statistics', id: chIds.slice(i, i + 50).join(','), maxResults: 50 });
    for (const c of d.items || []) {
      const sn = c.snippet || {}, st = c.statistics || {};
      channels[c.id] = {
        title: sn.title, handle: sn.customUrl ? sn.customUrl.replace(/^@/, '') : null,
        thumbnail: (sn.thumbnails && (sn.thumbnails.default || sn.thumbnails.medium) || {}).url || null,
        subs: st.hiddenSubscriberCount ? null : (st.subscriberCount != null ? +st.subscriberCount : null),
      };
    }
  }
  const doc = { scannedAt: new Date().toISOString(), days, units: api.units, queries: MARKET_QUERIES, errors, videos, channels };
  await supabase.storage.createBucket(BUCKET, { public: false }).catch(() => {});
  const body = JSON.stringify(doc);
  const up1 = await supabase.storage.from(BUCKET).upload('market/latest.json', body, { contentType: 'application/json', upsert: true });
  if (up1.error) throw up1.error;
  await supabase.storage.from(BUCKET).upload('market/' + todayIST() + '.json', body, { contentType: 'application/json', upsert: true });
  return { videos: videos.length, channels: chIds.length, units: api.units, errors };
}

export async function readYtMarket(supabase) {
  const { data } = await supabase.storage.from(BUCKET).download('market/latest.json');
  if (!data) return null;
  try { return JSON.parse(await data.text()); } catch { return null; }
}
