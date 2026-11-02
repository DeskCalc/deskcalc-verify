# DeskCalc Verify (MCP server)

Let a human check and confirm numbers in **DeskCalc** before an AI agent relies on the total.

An agent (Claude Desktop / Claude for Work, Codex, …) extracts amounts from receipts,
statements or invoices and calls `verify_numbers`. The lines open as a labelled tape in
DeskCalc on the user's Windows PC; the user checks every line, corrects what is wrong and
presses **Confirm** in DeskCalc. Only then does the agent get the confirmed total, the lines
and the list of corrections.

Everything runs locally: no network, no account, no telemetry.

## Requirements

- Windows, DeskCalc **11.3 or later** (website or Microsoft Store version)
- Node.js 20+ (Claude Desktop brings its own)

## Tools

| Tool | Purpose |
|---|---|
| `verify_numbers` | `title`, `items: [{value, label}]` → `confirmed` (total, lines, corrections) or `pending` |
| `get_verification` | continue waiting for a `pending` review |
| `deskcalc_status` | is DeskCalc installed, is a review open |

Values are plain numbers with `.` as decimal separator; negative for credits.

## Configuration

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "deskcalc-verify": { "command": "npx", "args": ["-y", "@deskcalc/verify"] } } }
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.deskcalc-verify]
command = "npx"
args = ["-y", "@deskcalc/verify"]
```

Environment (optional): `DESKCALC_PATH` (path to deskcalc.exe), `DESKCALC_VERIFY_DIR`
(exchange folder, default `Documents\DeskCalc Verify`).

## Development

```
npm install
npm run build     # dist/server.js
npm test          # unit + end-to-end tests with a fake DeskCalc
node test/live-client.mjs 40   # against a real DeskCalc (set DESKCALC_PATH; run from PowerShell)
```

Protocol and plan: website repo `plans/09.4-w17-verify-bauplan.md`.
