"""TAAI piracy scanner (2026-11-12).

Runs once a day on GitHub Actions (.github/workflows/piracy-scanner.yml),
logged into a spare Telegram account. It never reports anything by itself: it finds public
Telegram channels, groups and posts that look like they share TAAI's paid
courses and puts them in the `piracy_candidates` table. The team reviews them
in /team > Piracy > Found, and sends notices by hand.

How it finds things
  1. Name search: Telegram's contact search for every search term (TAAI and its
     disguised spellings, course and lesson titles, "Manoj Kumar GATE").
  2. Post search: inside every public channel it knows about (search results,
     channels already in the takedown log, channels found by step 3), it
     searches the posts for the same terms and reads the latest posts.
  3. Following the trail: t.me links, @mentions, forwarded-from channels and
     invite links in matching posts are added to the queue (2 hops at most).
Each channel gets a score from what was found (name, file names, lesson
titles, sale posts); only channels scoring MIN_SCORE or more are saved.

Rate limits: Telegram slows down accounts that do too much. The scanner caps
lookups per run, sleeps between calls and stops for the day on a long
FloodWait instead of hammering. Leave the caps as they are unless Telegram
never complains.
"""

import asyncio
import json
import os
import random
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone

import httpx
from telethon import TelegramClient, errors, functions, types
from telethon.sessions import StringSession

HERE = os.path.dirname(os.path.abspath(__file__))


def load_env(path):
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env(os.path.join(HERE, ".env"))

_api_id = os.environ.get("TG_API_ID", "").strip()
API_ID = int(_api_id) if _api_id.isdigit() else 0
API_HASH = os.environ.get("TG_API_HASH", "")
PHONE = os.environ.get("TG_PHONE", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
# The saved Telegram login as a text string (made once with login.py). Used on
# GitHub Actions, where there is no disk to keep a .session file between runs.
SESSION = os.environ.get("TG_SESSION", "").strip()

MIN_SCORE = 4
MAX_RESOLVES = 60          # username lookups per run (Telegram limits these)
MAX_CHANNELS = 120         # channels whose posts are read per run
POSTS_PER_SEARCH = 30
RECENT_POSTS = 60
MAX_DEPTH = 2
PAUSE = (1.5, 3.5)         # seconds between Telegram calls
MAX_POST_SEARCHES = 5      # "search public posts" per run (the account gets 10 free a day; leave 5 for manual use)

# Used when /team has no search terms saved (site_settings.piracy_terms).
DEFAULT_TERMS = [
    "TAAI", "TAAI GATE", "TAAI GATE DA", "Taai course", "TAAI Manoj", "Manoj Kumar GATE DA",
    "GATE DA 2027 course", "GATE DA 2028 course", "GATE DA full course free",
    "Maths ML Bundle GATE DA", "Linear Algebra -GATE DA", "Probability -GATE DA",
    "Statistics - GATE DA", "Calculus and Optimization -GATE DA",
    "GATE DA Maths Practice Quizzes", "TAAI Full Length Tests", "Say Hi to ML",
]

# Words that only score when they appear together with a TAAI/Manoj mention,
# because on their own they are common in every GATE channel.
COURSE_HINTS = [
    "linear algebra -gate da", "probability -gate da", "statistics - gate da",
    "calculus and optimization -gate da", "maths +ml bundle", "mathematics bundle -gate da",
    "gate da maths practice quizzes", "gate da ml&ai practice quizzes", "taai full length tests",
    "say hi to ml", "hello to machine learning", "linear algebra p.o.v", "solution existence-1",
    "imp concept of matrix multiplication", "complete analysis of ab", "rank - 1 representation of svd",
    "computational cost of gaussian elimination", "grouping & distribution", "why do we need counting",
    "basics - 1 (optional - use for revision)", "module 4 and 5 combined notes",
    "mixed subject wise tests(mini flts)", "cse portion test series (gate da)",
    "taai - gate da", "tomorrow's architect of ai",
]

# "l" is deliberately NOT mapped to "i": it would turn the common word "taal" into "taai".
LOOKALIKE = str.maketrans({"1": "i", "!": "i", "|": "i", "@": "a", "4": "a", "0": "o", "$": "s"})


def norm(text):
    """Lowercase, undo fancy Unicode fonts (𝙏𝘼𝘼𝙄), drop everything but letters."""
    t = unicodedata.normalize("NFKC", text or "").lower()
    t = "".join(c for c in unicodedata.normalize("NFKD", t) if not unicodedata.combining(c))
    return t


def squash(text):
    t = norm(text).translate(LOOKALIKE)
    return re.sub(r"[^a-z]", "", t)


def mentions_taai(text):
    """True for TAAI, T*AI, T.A.A.I, T A A I, TAA1, ta@i … but not for words that
    merely contain the letters (checked on word-ish boundaries first)."""
    n = norm(text).translate(LOOKALIKE)
    if re.search(r"(?<![a-z])t[\W_]{0,2}a[\W_]{0,2}a[\W_]{0,2}i(?![a-z])", n):
        return True
    # A symbol standing in for a letter (T*AI, T#AI, TA*I), only counted next
    # to GATE/DA/Manoj so a stray "t*ai" elsewhere doesn't match.
    if re.search(r"(?<![a-z])(t[*#_.\-]{1,2}a?a?[*#_.\-]?i|ta[*#_.\-]{1,2}a?i)(?![a-z])", n) and re.search(r"gate|\bda\b|manoj", n):
        return True
    return "taaigate" in squash(text) or "taaimanoj" in squash(text)


def mentions_manoj(text):
    s = squash(text)
    return "manojkumar" in s and ("gate" in s or "da" in s or "taai" in s)


def course_hits(text):
    n = norm(text)
    return [h for h in COURSE_HINTS if h in n]


TME_RE = re.compile(r"(?:https?://)?(?:t\.me|telegram\.me)/(\+[\w-]+|joinchat/[\w-]+|[A-Za-z0-9_]{5,32})(?:/\d+)?", re.I)
AT_RE = re.compile(r"(?<![\w@])@([A-Za-z0-9_]{5,32})")
SKIP_USERNAMES = {"joinchat", "share", "addstickers", "proxy", "iv", "s", "c"}


def links_in(message):
    found = set()
    text = message.message or ""
    for ent in message.entities or []:
        if isinstance(ent, types.MessageEntityTextUrl):
            text += " " + ent.url
    for m in TME_RE.finditer(text):
        found.add(m.group(1))
    for m in AT_RE.finditer(text):
        found.add(m.group(1))
    return {f for f in found if f.lower() not in SKIP_USERNAMES}


class Supabase:
    def __init__(self):
        self.http = httpx.Client(
            base_url=SUPABASE_URL + "/rest/v1",
            headers={"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Content-Type": "application/json"},
            timeout=30,
        )

    def terms(self):
        try:
            r = self.http.get("/site_settings", params={"id": "eq.main", "select": "piracy_terms"})
            rows = r.json() if r.status_code == 200 else []
            raw = (rows[0].get("piracy_terms") if rows else None) or ""
            terms = [t.strip() for t in raw.splitlines() if t.strip() and not t.strip().startswith("#")]
            return terms or DEFAULT_TERMS
        except Exception:
            return DEFAULT_TERMS

    def known_usernames(self):
        """Public channels already in the takedown log or already found: crawl them again."""
        names = set()
        for table in ("piracy_reports", "piracy_candidates"):
            try:
                r = self.http.get("/" + table, params={"select": "link"})
                for row in r.json() if r.status_code == 200 else []:
                    m = re.match(r"https://t\.me/([A-Za-z0-9_]{5,32})(?:/\d+)?$", row.get("link") or "")
                    if m and m.group(1).lower() != "c":
                        names.add(m.group(1))
            except Exception:
                pass
        return names

    def save(self, rows):
        if not rows:
            return
        post = lambda rs: self.http.post(
            "/piracy_candidates", params={"on_conflict": "link"}, content=json.dumps(rs),
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
        )
        r = post(rows)
        if r.status_code >= 300 and "matched_terms" in r.text:
            # Column not added yet: save the finds without it.
            r = post([{k: v for k, v in row.items() if k != "matched_terms"} for row in rows])
        if r.status_code >= 300:
            print("save failed", r.status_code, r.text[:300], file=sys.stderr)
            sys.exit(1)

    def save_run(self, row):
        """One row per run with per-term numbers, for /team's search-term stats."""
        try:
            r = self.http.post("/piracy_scan_runs", content=json.dumps(row), headers={"Prefer": "return=minimal"})
            if r.status_code >= 300:
                print("run stats not saved (piracy_scan_runs table missing?)")
        except Exception:
            print("run stats not saved")


async def pause():
    await asyncio.sleep(random.uniform(*PAUSE))


class Stop(Exception):
    pass


async def call(coro_fn, *a, **kw):
    """Run a Telegram call; short FloodWaits are waited out, long ones end the run."""
    for _ in range(2):
        try:
            res = await coro_fn(*a, **kw)
            await pause()
            return res
        except errors.FloodWaitError as e:
            if e.seconds > 300:
                raise Stop(f"Telegram asked to wait {e.seconds}s; stopping for today")
            print(f"flood wait {e.seconds}s")
            await asyncio.sleep(e.seconds + 2)
    return None


def chan_link(ch):
    uname = getattr(ch, "username", None)
    if not uname and getattr(ch, "usernames", None):
        uname = next((u.username for u in ch.usernames if u.active), None)
    return ("https://t.me/" + uname) if uname else ("https://t.me/c/" + str(ch.id)), uname


async def scan():
    if os.environ.get("GITHUB_ACTIONS") and not SESSION:
        print("Scanner not set up on GitHub (no TG_SESSION secret); skipping.")
        return
    if not (API_ID and API_HASH and SUPABASE_URL and SUPABASE_KEY):
        sys.exit("Missing or wrong values in .env: fill in TG_API_ID (numbers only), TG_API_HASH, TG_PHONE, SUPABASE_URL and SUPABASE_SERVICE_KEY.")
    db = Supabase()
    terms = db.terms()
    if SESSION:
        client = TelegramClient(StringSession(SESSION), API_ID, API_HASH)
        await client.connect()
        if not await client.is_user_authorized():
            sys.exit("TG_SESSION is no longer logged in. Run login.py again and update the secret.")
    else:
        client = TelegramClient(os.path.join(HERE, "taai-scanner"), API_ID, API_HASH)
        await client.start(phone=PHONE)
    started = time.time()
    print(f"scan started, {len(terms)} terms")

    queue = []            # (entity, depth, via)
    seen_ids = set()
    resolves = 0
    found = {}            # link -> candidate row
    invites = {}          # invite hash -> via
    post_hits = {}        # channel id -> posts found by the all-public-posts search
    # Which search terms turn things up (shown in /team > Piracy > Found):
    # name = channels returned by name search, posts = posts returned by the
    # all-public-posts search, inside = posts found when searching inside a
    # channel. chan_terms = every term that surfaced or matched each channel.
    term_stats = {t: {"name": 0, "posts": 0, "inside": 0, "finds": 0} for t in terms}
    chan_terms = {}
    post_searches = 0

    def enqueue(ch, depth, via):
        if not isinstance(ch, types.Channel) or ch.id in seen_ids:
            return
        seen_ids.add(ch.id)
        queue.append((ch, depth, via))

    async def resolve(name, depth, via):
        nonlocal resolves
        if name.startswith("+") or name.lower().startswith("joinchat/"):
            invites.setdefault(name.split("/")[-1].lstrip("+"), via)
            return
        if resolves >= MAX_RESOLVES:
            return
        resolves += 1
        try:
            ent = await call(client.get_entity, name)
            enqueue(ent, depth, via)
        except (ValueError, errors.UsernameInvalidError, errors.UsernameNotOccupiedError):
            pass
        except Stop:
            raise
        except Exception as e:
            print("lookup failed:", type(e).__name__)

    try:
        # 1. Name search
        for term in terms:
            res = await call(client, functions.contacts.SearchRequest(q=term, limit=50))
            chats = [c for c in (res.chats if res else []) if isinstance(c, types.Channel)]
            term_stats[term]["name"] += len(chats)
            for ch in chats:
                chan_terms.setdefault(ch.id, set()).add(term)
                enqueue(ch, 0, "search: " + term)

        # 1b. Search inside ALL public posts on Telegram (Telegram's "search public
        # posts", 2025). Finds sale/promo posts in channels whose name has nothing
        # to do with TAAI. Every account gets a few free searches a day; Telegram
        # Premium gets more. Only free searches are used: it never pays Stars.
        for term in terms:
            if post_searches >= MAX_POST_SEARCHES:
                break
            try:
                quota = await call(client, functions.channels.CheckSearchPostsFloodRequest(query=term))
            except Stop:
                raise
            except Exception as e:
                print("post search not available:", type(e).__name__)
                break
            if not quota or not (quota.query_is_free or quota.remains > 0):
                break
            try:
                res = await call(client, functions.channels.SearchPostsRequest(
                    offset_rate=0, offset_peer=types.InputPeerEmpty(), offset_id=0, limit=50, query=term))
            except Stop:
                raise
            except Exception as e:
                print("post search stopped:", type(e).__name__)
                break
            post_searches += 1
            term_stats[term]["posts"] += len(getattr(res, "messages", None) or [])
            for ch in getattr(res, "chats", None) or []:
                if isinstance(ch, types.Channel):
                    chan_terms.setdefault(ch.id, set()).add(term)
                enqueue(ch, 0, "public post search: " + term)
            for m in getattr(res, "messages", None) or []:
                peer = getattr(m, "peer_id", None)
                if isinstance(peer, types.PeerChannel):
                    post_hits.setdefault(peer.channel_id, []).append(m)
        print(f"public post searches used: {post_searches}")

        # Channels already known (takedown log, earlier finds)
        for name in sorted(db.known_usernames()):
            await resolve(name, 0, "already in the log")

        # 2 + 3. Read posts, follow the trail
        read = 0
        while queue and read < MAX_CHANNELS:
            ch, depth, via = queue.pop(0)
            read += 1
            link, uname = chan_link(ch)
            title = ch.title or ""
            reasons, score, samples, files = [], 0, [], []
            about, subs = "", getattr(ch, "participants_count", None)
            try:
                full = await call(client, functions.channels.GetFullChannelRequest(ch))
                if full:
                    about = full.full_chat.about or ""
                    subs = full.full_chat.participants_count or subs
            except Stop:
                raise
            except Exception:
                pass

            name_text = f"{title} {uname or ''} {about}"
            if mentions_taai(name_text):
                score += 5; reasons.append("TAAI in the channel name or description")
            if mentions_manoj(name_text):
                score += 4; reasons.append("Manoj Kumar in the channel name or description")

            msgs = []
            try:
                for term in terms[:8]:
                    batch = await call(client.get_messages, ch, limit=POSTS_PER_SEARCH, search=term)
                    msgs.extend(batch or [])
                    if batch:
                        term_stats[term]["inside"] += len(batch)
                        chan_terms.setdefault(ch.id, set()).add(term)
                recent = await call(client.get_messages, ch, limit=RECENT_POSTS)
                msgs.extend(recent or [])
            except Stop:
                raise
            except (errors.ChannelPrivateError, errors.ChatAdminRequiredError):
                pass
            except Exception as e:
                print("read failed:", type(e).__name__)

            msgs.extend(post_hits.get(ch.id, []))
            uniq = {m.id: m for m in msgs if m}
            trail = set()
            hit_courses = set()
            for m in uniq.values():
                text = m.message or ""
                fname = (m.file.name if m.file and m.file.name else "") or ""
                blob = text + " " + fname
                taai = mentions_taai(blob) or mentions_manoj(blob)
                hits = course_hits(blob)
                lyst = "lyst" in fname.lower()
                if taai or lyst or (hits and (score > 0 or len(hits) > 1)):
                    if len(samples) < 6:
                        samples.append(f"{link}/{m.id}")
                    if fname and len(files) < 6:
                        files.append(fname)
                    hit_courses.update(hits)
                    if taai and re.search(r"(₹|rs\.?|inr)\s?\d|\bfee\b|\bprice\b|25k", text, re.I):
                        reasons.append("Sale or price post mentioning TAAI")
                    trail |= links_in(m)
                    if m.fwd_from and isinstance(getattr(m.fwd_from, "from_id", None), types.PeerChannel):
                        try:
                            if depth < MAX_DEPTH:
                                src = await call(client.get_entity, m.fwd_from.from_id)
                                enqueue(src, depth + 1, "forwarded into " + link)
                        except Stop:
                            raise
                        except Exception:
                            pass
                if lyst:
                    reasons.append("Learnyst file names (lyst…)")
                if taai:
                    reasons.append("Posts mention TAAI")

            if any("Posts mention TAAI" == r for r in reasons):
                score += 3
            if any(r.startswith("Learnyst") for r in reasons):
                score += 4
            if hit_courses:
                score += min(6, 2 * len(hit_courses)); reasons.append("TAAI course or lesson titles: " + ", ".join(sorted(hit_courses)[:4]))
            if any(r.startswith("Sale") for r in reasons):
                score += 2
            if depth > 0:
                score += 1

            if score >= MIN_SCORE:
                reasons = list(dict.fromkeys(reasons))
                found[link] = {
                    "link": link, "kind": "channel" if ch.broadcast else "group", "title": title, "username": uname,
                    "tg_id": str(ch.id), "subscribers": subs, "score": score, "reasons": reasons,
                    "sample_links": samples, "file_names": files, "found_via": via,
                    "matched_terms": sorted(chan_terms.get(ch.id, [])),
                    "last_seen_at": datetime.now(timezone.utc).isoformat(),
                }
                if depth < MAX_DEPTH:
                    for name in trail:
                        await resolve(name, depth + 1, "linked from " + link)

        # Invite links seen in matching posts: peek without joining
        for h, via in list(invites.items())[:40]:
            try:
                inv = await call(client, functions.messages.CheckChatInviteRequest(hash=h))
            except Stop:
                raise
            except (errors.InviteHashExpiredError, errors.InviteHashInvalidError):
                continue
            except Exception:
                continue
            title = getattr(inv, "title", None) or getattr(getattr(inv, "chat", None), "title", "") or ""
            subs = getattr(inv, "participants_count", None)
            score = (5 if mentions_taai(title) else 0) + (4 if mentions_manoj(title) else 0) + (2 if course_hits(title) else 0) + 1
            if score >= MIN_SCORE:
                link = "https://t.me/+" + h
                found[link] = {
                    "link": link, "kind": "invite", "title": title, "username": None, "tg_id": None,
                    "subscribers": subs, "score": score, "reasons": ["Private invite link whose name mentions TAAI"],
                    "sample_links": [], "file_names": [], "found_via": via, "matched_terms": [],
                    "last_seen_at": datetime.now(timezone.utc).isoformat(),
                }
    except Stop as e:
        print(str(e))
    finally:
        db.save(list(found.values()))
        for row in found.values():
            for t in row.get("matched_terms") or []:
                if t in term_stats:
                    term_stats[t]["finds"] += 1
        db.save_run({
            "duration_s": int(time.time() - started), "candidates": len(found), "lookups": resolves,
            "post_searches": post_searches, "term_stats": term_stats,
        })
        await client.disconnect()
    print(f"done in {int(time.time() - started)}s: {len(found)} candidates, {resolves} lookups, {post_searches} post searches")


if __name__ == "__main__":
    asyncio.run(scan())
