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
    // For the downloadable LinkedIn-post mockup only (2026-11-21); not sent
    // to the tracker popup.
    headline: str(b.headline, 120),
    avatar: null,
    show_from: str(b.show_from, 10),
    show_until: str(b.show_until, 10),
    photos: [],
  };
  const av = b.avatar && typeof b.avatar.src === 'string' ? b.avatar.src : '';
  if (av) {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(av)) return { error: 'the profile picture is not a valid image' };
    if (av.length > 400_000) return { error: 'the profile picture is too large, please use a smaller one' };
    out.avatar = { src: av };
  }
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
  // Manual only (2026-11-21, "nothing should come without manually
  // triggering it"): no start date; it shows from the moment it's switched
  // on and saved. show_until is an optional automatic stop.
  out.show_from = '';
  if (out.enabled) {
    if (!out.name) return { error: 'add the winner\'s name before switching it on' };
    if (!out.photos.length) return { error: 'add at least one photo before switching it on' };
    if (out.show_until && out.show_until < todayIST()) return { error: 'the stop date has already passed; clear it or pick a later one' };
  }
  return { data: out };
}

// Whether the popup shows now: only while switched on (by hand), and not
// after the optional stop date (IST). Never starts on its own.
export function winnerActive(d) {
  if (!d || !d.enabled || !d.name || !d.photos || !d.photos.length) return false;
  return !d.show_until || todayIST() <= d.show_until;
}

// Other places (2026-11-21, design B): a second row in club_winner (id
// 'runners') with up to three more people (2nd, another 2nd, 3rd), each
// shown as a full LinkedIn-style post in the SAME popup as 1st place. They
// are published together: there is no separate switch or dates here; 1st
// place's switch and dates decide when everyone shows. Older rows with one
// `photo` per person are read as photos[0].
const PLACES = [2, 2, 3];
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
export const MAX_RUNNERS_CHARS = 5_200_000; // keeps the request under Netlify's 6 MB limit
export function cleanRunners(b) {
  if (!b || typeof b !== 'object') return { error: 'missing runners-up data' };
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const out = { month: str(b.month, 30) || 'November', note: str(b.note, 120), people: [] };
  const people = Array.isArray(b.people) ? b.people.slice(0, PLACES.length) : [];
  let total = 0;
  for (let i = 0; i < people.length; i++) {
    const p = people[i] || {};
    const place = PLACES[i];
    const label = i === 0 ? '2nd place' : i === 1 ? 'the other 2nd place' : '3rd place';
    const person = {
      place,
      name: str(p.name, 80),
      prize: Math.max(0, Math.min(1_000_000, Math.round(Number(p.prize) || 0))),
      linkedin_url: str(p.linkedin_url, 500),
      headline: str(p.headline, 120),
      linkedin_text: str(p.linkedin_text, 3000),
      avatar: null,
      photos: [],
    };
    if (person.linkedin_url && !/^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(person.linkedin_url)) {
      return { error: `the ${label} LinkedIn link must start with https:// and be on linkedin.com` };
    }
    const av = p.avatar && typeof p.avatar.src === 'string' ? p.avatar.src : '';
    if (av) {
      if (!IMG_RE.test(av)) return { error: `the ${label} profile picture is not a valid image` };
      if (av.length > 400_000) return { error: `the ${label} profile picture is too large` };
      person.avatar = { src: av }; total += av.length;
    }
    const srcs = (Array.isArray(p.photos) ? p.photos : (p.photo ? [p.photo] : [])).slice(0, 2);
    for (const ph of srcs) {
      const src = ph && typeof ph.src === 'string' ? ph.src : '';
      if (!src) continue;
      if (!IMG_RE.test(src)) return { error: `a ${label} photo is not a valid image` };
      if (src.length > MAX_PHOTO_CHARS) return { error: `a ${label} photo is too large, please use a smaller one` };
      person.photos.push({ src, caption: '' }); total += src.length;
    }
    const empty = !person.name && !person.photos.length && !person.linkedin_text && !person.avatar;
    if (empty) continue; // nobody in this place (yet)
    if (!person.name) return { error: `add a name for ${label}, or clear that place` };
    out.people.push(person);
  }
  if (total > MAX_RUNNERS_CHARS) return { error: 'the photos together are too large; use fewer or smaller photos' };
  return { data: out };
}
