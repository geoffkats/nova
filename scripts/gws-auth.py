#!/usr/bin/env python3
"""Re-auth local google-workspace-mcp (CoPa) for Nova — no Developer Preview needed."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/contacts",
]

GWS_DIR = Path(
    os.environ.get(
        "NOVA_GWS_MCP_DIR",
        str(Path.home() / "Desktop" / "CoPa" / "google-workspace-mcp-server"),
    )
)
HOME_CFG = Path.home() / ".config" / "google-workspace-mcp"


def main() -> int:
    env_file = GWS_DIR / ".env"
    if env_file.exists():
        load_dotenv(env_file)

    cred_path = Path(
        os.environ.get("GOOGLE_CREDENTIALS_PATH")
        or (GWS_DIR / "credentials.json" if (GWS_DIR / "credentials.json").exists() else HOME_CFG / "credentials.json")
    )
    token_path = Path(
        os.environ.get("GOOGLE_TOKEN_PATH")
        or str(HOME_CFG / "token.json")
    )
    # Always mirror into CoPa so relative ./token.json never stays stale.
    copa_token = GWS_DIR / "token.json"

    print("Nova → local Google Workspace MCP (CoPa)")
    print(f"  dir:   {GWS_DIR}")
    print(f"  creds: {cred_path}")
    print(f"  token: {token_path}")
    print()

    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8080")

    if cred_path.exists():
        flow = InstalledAppFlow.from_client_secrets_file(str(cred_path), SCOPES)
    elif client_id and client_secret:
        flow = InstalledAppFlow.from_client_config(
            {
                "installed": {
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "redirect_uris": [redirect_uri],
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                }
            },
            SCOPES,
        )
    else:
        print("Missing credentials.json / GOOGLE_CLIENT_ID+SECRET in CoPa .env")
        return 1

    from urllib.parse import urlparse

    port = urlparse(redirect_uri).port or 8080
    print(f"Opening browser (port {port}) — sign in and allow access…")
    creds = flow.run_local_server(
        port=port,
        open_browser=True,
        access_type="offline",
        prompt="consent",
        success_message="Nova ↔ Google Workspace connected. You can close this window.",
    )

    token_json = creds.to_json()
    HOME_CFG.mkdir(parents=True, exist_ok=True)
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(token_json, encoding="utf-8")
    if GWS_DIR.exists():
        copa_token.write_text(token_json, encoding="utf-8")

    # Sanity: build Gmail service
    from googleapiclient.discovery import build

    service = build("gmail", "v1", credentials=creds)
    profile = service.users().getProfile(userId="me").execute()
    unread = (
        service.users()
        .messages()
        .list(userId="me", q="is:unread", maxResults=1)
        .execute()
        .get("resultSizeEstimate", 0)
    )

    print()
    print(f"OK — signed in as {profile.get('emailAddress')}")
    print(f"Unread estimate: {unread}")
    print(f"Saved: {token_path}")
    if GWS_DIR.exists():
        print(f"Saved: {copa_token}")
    print()
    print("Next: restart Electron, then ask Nova to check your email.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:  # noqa: BLE001
        print(f"gws:auth failed: {err}", file=sys.stderr)
        raise SystemExit(1)
