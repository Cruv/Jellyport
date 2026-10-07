"""SQLite audit records and encrypted operational secrets."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet

DEFAULT_SETTINGS = {
    "emby_url": "", "emby_api_key": "", "jellyfin_url": "", "jellyfin_api_key": "",
    "jellyfin_public_url": "", "template_user_id": "", "path_mappings": [],
    "discord_enabled": False, "discord_bot_token": "", "discord_guild_id": "",
    "discord_admin_role_id": "", "discord_member_role_id": "", "discord_application_id": "",
    "discord_subscription_channel_id": "", "discord_subscription_bot_id": "",
    "discord_message_events": False, "discord_role_events": False,
    "auto_provision": False, "auto_disable": False, "disable_on_cancel": False,
}


class Store:
    def __init__(self, directory: str | Path):
        directory = Path(directory)
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        keyfile = directory / "secret.key"
        if not keyfile.exists():
            with keyfile.open("xb") as output:
                os.chmod(keyfile, 0o600)
                output.write(Fernet.generate_key())
        self.cipher = Fernet(keyfile.read_bytes())
        self.db = sqlite3.connect(directory / "jellyport.db")
        os.chmod(directory / "jellyport.db", 0o600)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, encrypted BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS accounts (
                name_key TEXT PRIMARY KEY, username TEXT NOT NULL,
                remote_id TEXT, status TEXT NOT NULL, password BLOB, expires REAL
            );
            CREATE TABLE IF NOT EXISTS credentials (
                job_id TEXT NOT NULL, username TEXT NOT NULL, encrypted BLOB NOT NULL,
                expires REAL NOT NULL, PRIMARY KEY (job_id,username)
            );
            CREATE TABLE IF NOT EXISTS links (
                discord_user_id TEXT PRIMARY KEY, username TEXT NOT NULL,
                remote_id TEXT NOT NULL UNIQUE, disabled_by_jellyport INTEGER NOT NULL DEFAULT 0,
                pending_disabled INTEGER
            );
            CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        """)
        if "pending_disabled" not in {row[1] for row in self.db.execute("PRAGMA table_info(links)")}:
            self.db.execute("ALTER TABLE links ADD COLUMN pending_disabled INTEGER")
        self.db.commit()
        for job in self.jobs():
            if job["status"] in {"queued", "running"}:
                job.update(status="interrupted", error="App restarted during this job. Review its results and run again; existing accounts are preserved.")
                self.save_job(job)
        for event in self.subscriptions():
            if event["status"] == "processing":
                event.update(status="failed", error="App restarted during this event. Review account and job status before applying again.")
                self.save_subscription(event)

    def encrypt(self, value: Any) -> bytes:
        return self.cipher.encrypt(json.dumps(value).encode())

    def decrypt(self, value: bytes) -> Any:
        return json.loads(self.cipher.decrypt(value))

    def settings(self) -> dict:
        row = self.db.execute("SELECT encrypted FROM settings WHERE id=1").fetchone()
        return DEFAULT_SETTINGS | (self.decrypt(row[0]) if row else {})

    def save_settings(self, settings: dict):
        self.db.execute("INSERT OR REPLACE INTO settings VALUES (1,?)", (self.encrypt(settings),))
        self.db.commit()

    def save_job(self, job: dict):
        self.db.execute("INSERT OR REPLACE INTO jobs VALUES (?,?)", (job["id"], json.dumps(job)))
        self.db.commit()

    def job(self, job_id: str) -> dict | None:
        row = self.db.execute("SELECT payload FROM jobs WHERE id=?", (job_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def jobs(self) -> list[dict]:
        return sorted([json.loads(row[0]) for row in self.db.execute("SELECT payload FROM jobs")], key=lambda j: j["created_at"], reverse=True)

    def account(self, username: str) -> dict | None:
        row = self.db.execute("SELECT * FROM accounts WHERE name_key=?", (username.casefold(),)).fetchone()
        return dict(row) if row else None

    def save_account(self, username: str, remote_id: str | None, status: str, password: str | None = None):
        self.db.execute("INSERT OR REPLACE INTO accounts VALUES (?,?,?,?,?,?)", (
            username.casefold(), username, remote_id, status,
            self.encrypt(password) if password else None, time.time() + 86400 if password else None,
        ))
        self.db.commit()

    def account_password(self, account: dict) -> str | None:
        if account["password"] and (account["expires"] or 0) > time.time():
            return self.decrypt(account["password"])
        return None

    def save_credentials(self, job_id: str, username: str, password: str, server_url: str):
        value = {"username": username, "password": password, "server_url": server_url}
        self.db.execute("INSERT OR REPLACE INTO credentials VALUES (?,?,?,?)", (job_id, username, self.encrypt(value), time.time() + 86400))
        self.db.commit()

    def delete_credentials(self, job_id: str, username: str):
        self.db.execute("DELETE FROM credentials WHERE job_id=? AND username=?", (job_id, username))
        self.db.commit()

    def take_credentials(self, job_id: str) -> list[dict]:
        rows = self.db.execute("SELECT encrypted FROM credentials WHERE job_id=? AND expires>?", (job_id, time.time())).fetchall()
        values = [self.decrypt(row[0]) for row in rows]
        self.db.execute("DELETE FROM credentials WHERE job_id=? OR expires<=?", (job_id, time.time()))
        self.db.commit()
        return values

    def close(self):
        self.db.close()

    def link(self, discord_user_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM links WHERE discord_user_id=?", (str(discord_user_id),)).fetchone()
        return dict(row) if row else None

    def link_for_remote(self, remote_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM links WHERE remote_id=?", (remote_id,)).fetchone()
        return dict(row) if row else None

    def links(self) -> list[dict]:
        return [dict(row) for row in self.db.execute("SELECT * FROM links")]

    def purge_expired(self):
        self.db.execute("DELETE FROM credentials WHERE expires<=?", (time.time(),))
        self.db.execute("UPDATE accounts SET password=NULL, expires=NULL WHERE expires<=?", (time.time(),))
        self.db.commit()

    def save_link(self, discord_user_id: str, username: str, remote_id: str, disabled=False):
        self.db.execute("INSERT INTO links (discord_user_id,username,remote_id,disabled_by_jellyport,pending_disabled) VALUES (?,?,?,?,NULL) ON CONFLICT(discord_user_id) DO UPDATE SET username=excluded.username, remote_id=excluded.remote_id, disabled_by_jellyport=excluded.disabled_by_jellyport, pending_disabled=NULL", (str(discord_user_id), username, remote_id, int(disabled)))
        self.db.commit()

    def set_link_pending(self, discord_user_id, disabled: bool | None):
        self.db.execute("UPDATE links SET pending_disabled=? WHERE discord_user_id=?", (None if disabled is None else int(disabled), str(discord_user_id)))
        self.db.commit()

    def subscription(self, event_id: str) -> dict | None:
        row = self.db.execute("SELECT payload FROM subscriptions WHERE id=?", (event_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def subscriptions(self) -> list[dict]:
        return sorted([json.loads(row[0]) for row in self.db.execute("SELECT payload FROM subscriptions")], key=lambda e: e["created_at"], reverse=True)

    def save_subscription(self, event: dict):
        self.db.execute("INSERT OR REPLACE INTO subscriptions VALUES (?,?)", (event["id"], json.dumps(event)))
        self.db.commit()
