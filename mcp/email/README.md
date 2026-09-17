# Email for Nova (MCP)

Nova talks to email only through MCP. The avatar never sees Gmail credentials.

## Preferred: local Google Workspace MCP (CoPa)

This is the server you already use at:

`Desktop/CoPa/google-workspace-mcp-server`

It talks to the normal Gmail API — **no** Google Workspace Developer Preview.

```bash
npm run gws:auth
```

Browser opens → sign in → tokens saved to CoPa `token.json` and `~/.config/google-workspace-mcp/token.json`.

Restart Electron. Ask Nova to check email.

Nova sees **one** Workspace tool (`google_workspace`) with known actions. The MCP server still loads every Gmail/Calendar/Drive/Docs/Sheets function internally; the model cannot browse all 50 schemas.

| Action | Internally calls |
|------|----------|
| `email_list` / `email_search` / `email_read` | Gmail list/search/get (no send/trash) |
| `calendar_list` / `calendar_get` / `calendar_create` / `calendar_update` / `calendar_delete` | Calendar read + write + delete |
| `drive_search` / `drive_list` / `drive_get` / `drive_share` | Drive search/list/get/share |
| `docs_read` / `docs_create` / `docs_append` | Docs get/create/append |
| `sheets_read` / `sheets_create` / `sheets_write` / `sheets_append` / `sheets_clear` | Sheets read + edit. `sheets_read` without a range uses the first tab (`A1:Z20`). |

Created Docs/Sheets/events surface as an always-on-top card with an Open link. Gmail trash and Drive file delete stay blocked. Re-auth if a Calendar/Drive call fails with insufficient scopes: `npm run gws:auth`.

### Env (optional)

```env
NOVA_GWS_MCP_DIR=C:\Users\User\Desktop\CoPa\google-workspace-mcp-server
GOOGLE_CREDENTIALS_PATH=...
GOOGLE_TOKEN_PATH=...
```

## Not preferred: Google remote Gmail MCP

`https://gmailmcp.googleapis.com/mcp/v1` needs the [Developer Preview Program](https://developers.google.com/workspace/preview). Only enable if enrolled:

```env
NOVA_GMAIL_REMOTE=1
```

Then `npm run gmail:auth`.

## Fallback: demo mailbox

Without a working Workspace token, Nova uses `mcp/email/demo-mailbox.json`.
