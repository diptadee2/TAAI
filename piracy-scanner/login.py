"""One-time login for the piracy scanner.

Run on your own computer, with the spare phone nearby:
    pip install telethon
    python login.py
It asks for the API id/hash, the spare number and the code Telegram sends, then
prints a long text string: the saved login. Put it in the GitHub secret
TG_SESSION. Anyone with that string is logged into the spare account, so never
paste it anywhere else. Run this again (and update the secret) if Telegram ever
logs the scanner out.
"""
import asyncio

from telethon import TelegramClient
from telethon.sessions import StringSession


async def main():
    api_id = int(input("API id (my.telegram.org): ").strip())
    api_hash = input("API hash: ").strip()
    async with TelegramClient(StringSession(), api_id, api_hash) as client:
        me = await client.get_me()
        print(f"\nLogged in as {me.first_name} ({'+' + me.phone if me.phone else ''}).")
        print("\nCopy everything on the next line into the GitHub secret TG_SESSION:\n")
        print(client.session.save())


asyncio.run(main())
