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
// "DA" is matched case-sensitively: lowercase "da" is a common word in
// Punjabi/Hindi/Spanish titles ("Home da Gate", 2026-11-27).
const DA_RE = /\bDA\b|\bDS\s*&?\s*AI\b|\bDSAI\b/;
const DA_RE_I = /data science|data\s*science\s*(and|&)\s*(ai|artificial)/i;
const CSE_RE = /\bCSE?\b|\bCS\s*[\/&-]?\s*IT\b|\bCSIT\b/;
const CSE_RE_I = /computer science/i;
// Relevance (2026-11-27, "so many irrelevant videos"): plain "gate" also
// means a door (Nankana Sahib, Amritsar's gates) and other exams' videos
// mention GATE too. Keep a video only if GATE is written in capitals with an
// exam word nearby, and drop other branches / recruitment exams unless the
// title is about CSE or DA. Mirrored by mktRelevant() in team/team.js.
export const EXAM_WORD_RE = /\bGATE\s*['’]?\s*(20\d\d|\d\d)\b|\b(exam|preparation|prep|strategy|syllabus|IIT|M\.?\s?Tech|AIR|rank|mock|PYQs?|marks?|score|cutoff|lectures?|one\s*shot|topper|revision|test series|weightage|paper|admit card|result|crack|admission|PhD|PSU|aspirants?|worth it)\b/i;
// Abbreviations are case-sensitive ("Got Me" is not ME); words are not.
export const OTHER_RE = /\b(EE|ECE|EC|ME|CE|ESE|IES|AAI|JE|AE|ICAR|SSC|RRB|DSSSB|TGT|PGT)\b|\b(Civil|Mechanical|Electrical|Electronics|Chemical|Instrumentation|Signals|Control Systems?|Network Theory|Thermodynamics|Fluid Mechanics|Surveying|Agriculture|Biotechnology|Physics|Chemistry)\b/;
export const OTHER_RE_I = /\b(Civil|Mechanical|Electrical|Electronics|Chemical|Instrumentation|Signals|Control Systems?|Network Theory|Thermodynamics|Fluid Mechanics|Surveying|Agriculture|Biotechnology|Physics|Chemistry)\b/i;
export function marketRelevant(title, text) {
  const t = title || '';
  if (!/\bGATE\b/.test(t + ' ' + text)) return false;
  const ex = examOf(t + ' ' + text);
  if (ex === 'gate' && !EXAM_WORD_RE.test(t)) return false;
  if ((OTHER_RE.test(t) || OTHER_RE_I.test(t)) && examOf(t) === 'gate') return false;
  return true;
}

function todayIST() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }

export function examOf(text) {
  const da = DA_RE.test(text) || DA_RE_I.test(text), cse = CSE_RE.test(text) || CSE_RE_I.test(text);
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
      if (!marketRelevant(sn.title, text)) continue;
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
