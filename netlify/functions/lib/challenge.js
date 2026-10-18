// Shared by challenge-register.js (public) and team-challenge.js (admin).
//
// The "100 pe 100% off" registration cutoff: the GATE DA 2027 admit card
// release day. gate2027.iitm.ac.in listed "Admit Card: 4 January 2027" on
// 2026-10-18 ("dates are liable to change"), so that's the default; /team
// can override it via site_settings.challenge_cutoff without a deploy.
export const DEFAULT_CHALLENGE_CUTOFF = '2027-01-04';

// Effective cutoff date string (YYYY-MM-DD). Best-effort: a missing column
// (pre-migration) or any error falls back to the default.
export async function fetchChallengeCutoff(supabase) {
  try {
    const { data, error } = await supabase.from('site_settings').select('challenge_cutoff').eq('id', 'main').maybeSingle();
    if (!error && data && data.challenge_cutoff) return String(data.challenge_cutoff).slice(0, 10);
  } catch { /* fall through */ }
  return DEFAULT_CHALLENGE_CUTOFF;
}

// The form closes at the END of the cutoff day in IST.
export function challengeClosesAt(cutoff) {
  return new Date(cutoff + 'T23:59:59.999+05:30');
}

export function isChallengeOpen(cutoff, now = new Date()) {
  return now.getTime() <= challengeClosesAt(cutoff).getTime();
}
