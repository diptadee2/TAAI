// The 2 AM Club winner announcement (2026-11-18). Stored as one JSONB row in
// club_winner (see schema.sql), edited in /team > Marketing > 2 AM winner,
// shown as a popup on the tracker between show_from and show_until (IST dates).
import { todayIST } from './supabase.js';

export const MAX_PHOTO_CHARS = 1_400_000; // ~1 MB of JPEG once base64 encoded

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Cleans an admin's input; returns { data } or { error }.
export function cleanWinner(b) {
  if (!b || typeof b !== 'object') return { error: 'missing winner data' };
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const out = {
    enabled: !!b.enabled,
    name: str(b.name, 80),
    month: str(b.month, 30) || 'November',
    prize: Math.max(0, Math.min(1_000_000, Math.round(Number(b.prize) || 0))),
    linkedin_text: str(b.linkedin_text, 3000),
    linkedin_url: str(b.linkedin_url, 500),
    show_from: str(b.show_from, 10),
    show_until: str(b.show_until, 10),
    photos: [],
  };
  if (out.linkedin_url && !/^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(out.linkedin_url)) {
    return { error: 'the LinkedIn link must start with https:// and be on linkedin.com' };
  }
  if (out.show_from && !DATE_RE.test(out.show_from)) return { error: 'show from must be a date' };
  if (out.show_until && !DATE_RE.test(out.show_until)) return { error: 'show until must be a date' };
  if (out.show_from && out.show_until && out.show_until < out.show_from) return { error: 'show until is before show from' };
  const photos = Array.isArray(b.photos) ? b.photos.slice(0, 2) : [];
  for (const p of photos) {
    const src = p && typeof p.src === 'string' ? p.src : '';
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) return { error: 'a photo is not a valid image' };
    if (src.length > MAX_PHOTO_CHARS) return { error: 'a photo is too large, please use a smaller one' };
    out.photos.push({ src, caption: str(p.caption, 80) });
  }
  if (out.enabled) {
    if (!out.name) return { error: 'add the winner\'s name before switching it on' };
    if (!out.photos.length) return { error: 'add at least one photo before switching it on' };
    if (!out.show_from || !out.show_until) return { error: 'set both dates before switching it on' };
  }
  return { data: out };
}

// Whether the popup should show today (IST).
export function winnerActive(d) {
  if (!d || !d.enabled || !d.name || !d.photos || !d.photos.length || !d.show_from || !d.show_until) return false;
  const t = todayIST();
  return t >= d.show_from && t <= d.show_until;
}

// 2nd and 3rd place (2026-11-19): a second row in club_winner (id
// 'runners'), released on its own dates in one popup. 3rd place is optional
// (there may not be enough entries for it).
export function cleanRunners(b) {
  if (!b || typeof b !== 'object') return { error: 'missing runners-up data' };
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const out = {
    enabled: !!b.enabled,
    month: str(b.month, 30) || 'November',
    show_from: str(b.show_from, 10),
    show_until: str(b.show_until, 10),
    people: [],
  };
  if (out.show_from && !DATE_RE.test(out.show_from)) return { error: 'show from must be a date' };
  if (out.show_until && !DATE_RE.test(out.show_until)) return { error: 'show until must be a date' };
  if (out.show_from && out.show_until && out.show_until < out.show_from) return { error: 'show until is before show from' };
  const people = Array.isArray(b.people) ? b.people.slice(0, 2) : [];
  for (let i = 0; i < people.length; i++) {
    const p = people[i] || {};
    const place = i + 2;
    const person = {
      place,
      name: str(p.name, 80),
      prize: Math.max(0, Math.min(1_000_000, Math.round(Number(p.prize) || 0))),
      linkedin_url: str(p.linkedin_url, 500),
      photo: null,
    };
    if (person.linkedin_url && !/^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(person.linkedin_url)) {
      return { error: `the ${place === 2 ? '2nd' : '3rd'} place LinkedIn link must start with https:// and be on linkedin.com` };
    }
    const src = p.photo && typeof p.photo.src === 'string' ? p.photo.src : '';
    if (src) {
      if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) return { error: 'a photo is not a valid image' };
      if (src.length > MAX_PHOTO_CHARS) return { error: 'a photo is too large, please use a smaller one' };
      person.photo = { src, caption: str(p.photo.caption, 80) };
    }
    if (!person.name && !person.photo) continue; // empty slot (no 3rd place)
    if (out.enabled && (!person.name || !person.photo)) return { error: `add both a name and a photo for ${place === 2 ? '2nd' : '3rd'} place, or leave it empty` };
    out.people.push(person);
  }
  if (out.enabled) {
    if (!out.people.length || out.people[0].place !== 2) return { error: 'add 2nd place before switching it on' };
    if (!out.show_from || !out.show_until) return { error: 'set both dates before switching it on' };
  }
  return { data: out };
}

export function runnersActive(d) {
  if (!d || !d.enabled || !Array.isArray(d.people) || !d.people.length || !d.show_from || !d.show_until) return false;
  const t = todayIST();
  return t >= d.show_from && t <= d.show_until;
}
