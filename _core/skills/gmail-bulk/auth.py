#!/usr/bin/env python3
"""OAuth installed-app flow for Gmail Bulk.

Stores per-account refresh tokens in macOS Keychain (service: quantum-gmail-bulk).
"""

import argparse
import json
import keyring
import sys
from pathlib import Path
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

SKILL_DIR = Path(__file__).resolve().parent
CLIENT_PATH = SKILL_DIR / "credentials" / "oauth_client.json"
KEYRING_SERVICE = "quantum-gmail-bulk"
SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]


def _load_client_config():
    if not CLIENT_PATH.exists():
        sys.exit(
            f"missing OAuth client at {CLIENT_PATH}\n"
            "create one in GCP console > APIs & Services > Credentials > Create OAuth client ID > Desktop app, "
            "then save the downloaded JSON to that path."
        )
    return json.loads(CLIENT_PATH.read_text())


def add(email: str):
    flow = InstalledAppFlow.from_client_config(_load_client_config(), SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent", access_type="offline")
    token_blob = creds.to_json()
    keyring.set_password(KEYRING_SERVICE, email, token_blob)
    print(f"OK stored refresh token for {email}")


def get_creds(email: str) -> Credentials:
    blob = keyring.get_password(KEYRING_SERVICE, email)
    if not blob:
        sys.exit(f"no token for {email}; run: python auth.py add {email}")
    info = json.loads(blob)
    creds = Credentials.from_authorized_user_info(info, SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        keyring.set_password(KEYRING_SERVICE, email, creds.to_json())
    return creds


def list_accounts():
    import subprocess
    out = subprocess.run(
        ["security", "find-generic-password", "-s", KEYRING_SERVICE, "-g"],
        capture_output=True, text=True
    )
    print("(use Keychain Access > search 'quantum-gmail-bulk' to view stored accounts)")
    print(f"keyring service: {KEYRING_SERVICE}")


def remove(email: str):
    keyring.delete_password(KEYRING_SERVICE, email)
    print(f"removed {email}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    pa = sub.add_parser("add"); pa.add_argument("email")
    pl = sub.add_parser("list")
    pr = sub.add_parser("remove"); pr.add_argument("email")
    args = p.parse_args()
    if args.cmd == "add":
        add(args.email)
    elif args.cmd == "list":
        list_accounts()
    elif args.cmd == "remove":
        remove(args.email)
