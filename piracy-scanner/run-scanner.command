#!/bin/bash
# Double-click on a Mac to run the TAAI piracy scanner (Terminal opens).
# First time: installs what it needs and asks for the Telegram login code.
cd "$(dirname "$0")" || exit 1
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Fill in .env first (it just opened), save it, then double-click this again."
  open -e .env
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
# Find a Python 3.9+ that actually runs (an old one left on the Mac can fail
# with "Bad CPU type").
PY=""
for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 python3.13 python3.12 python3.11 python3.10 /usr/bin/python3 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "No working Python 3 found. Install it from https://www.python.org/downloads/ and try again."
  read -n 1 -s -r -p "Press any key to close."; exit 1
fi
if [ ! -d .venv ]; then
  echo "First run: installing (one minute)..."
  "$PY" -m venv .venv && .venv/bin/pip install -q -r requirements.txt || { echo "Install failed. Is Python 3 installed?"; read -n 1 -s -r; exit 1; }
fi
if .venv/bin/python scanner.py; then
  echo; echo "Done. New finds are in /team > Piracy > Found."
else
  echo; echo "The scan stopped with the error above."
fi
read -n 1 -s -r -p "Press any key to close."
