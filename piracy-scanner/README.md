# TAAI piracy scanner

Finds public Telegram channels, groups and posts that look like they share
TAAI's paid courses, and lists them in /team > Piracy > Found for the team to
review. It never reports anything itself; notices are still sent by a person.

It needs a real Telegram account (Telegram doesn't let bots or websites search),
so it runs on a small always-on server, once a day.

## What you need

1. **A spare SIM** with Telegram installed. Don't use anyone's personal
   number: if Telegram limits the account, nothing else is affected.
   Leave the account in normal use (profile name, maybe join a few public
   channels by hand) for a few days before the first scan; brand-new accounts
   that start searching straight away get limited faster.
2. **Telegram API keys** for that account: log in at https://my.telegram.org
   with the spare number, open "API development tools", create an app
   (any name, platform "Other"). Note the `api_id` and `api_hash`.
3. **A small Linux server** (Ubuntu 24.04, 1 GB RAM is plenty): any VPS
   around ₹400-800 a month (Hetzner, DigitalOcean, AWS Lightsail Mumbai, …).
4. The site's `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (same as `.env`).
5. The SQL for `piracy_candidates` (end of `supabase/schema.sql`) run once.

## Setup on the server

```bash
sudo apt update && sudo apt install -y python3-venv git
sudo adduser --disabled-password --gecos "" scanner
sudo -iu scanner
# copy this folder to /home/scanner/piracy-scanner (scp, or git clone the repo and move it)
cd ~/piracy-scanner
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env && nano .env        # fill in the five values
.venv/bin/python scanner.py              # FIRST RUN: asks for the login code Telegram sends to the spare phone
exit
```

The first run creates `taai-scanner.session`, the saved Telegram login. Keep it
private: anyone with that file is logged into the account. If the account has
two-step verification, the first run also asks for that password.

Then schedule it daily (07:30 IST, give or take 15 minutes):

```bash
sudo cp /home/scanner/piracy-scanner/taai-scanner.service /home/scanner/piracy-scanner/taai-scanner.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now taai-scanner.timer
sudo systemctl start taai-scanner.service    # run once now
journalctl -u taai-scanner.service -n 50     # see what it found
```

## Changing what it searches for

/team > Piracy > Found > "Search terms": one term per line. Saved in the
database, read at the start of every run; no server access needed.

## How it decides something is a match

Each channel gets points: TAAI (including T*AI, T.A.A.I, TAA1, fancy fonts) or
"Manoj Kumar" in its name or description, posts mentioning TAAI, Learnyst file
names ("lyst…"), TAAI course or lesson titles, sale posts with a price, and
being linked from another match. 4 points or more = shown in /team. Channels
dismissed in /team stay dismissed; it only refreshes their numbers.

## Limits

- Private channels and invite-only groups can't be searched or read. Invite
  links seen in public posts are checked without joining (name and member
  count only).
- Posts that are only videos or files with no TAAI wording or file names
  won't match.
- Telegram limits how many usernames an account can look up per day; the
  scanner stops for the day if Telegram asks it to wait more than 5 minutes.
