# DeskCalc Verify

Let a human check and confirm numbers in DeskCalc before Claude relies on the total.

## What it does

Claude reads the amounts from invoices, receipts, bank statements or tables and hands them to
DeskCalc, a Windows adding machine app, as a labelled tape. You check every line, correct what is
wrong and press **Confirm** in DeskCalc. Only then does Claude get the confirmed total, your
corrections and a check of the printed figures to the cent: VAT, quantity x price, discounts, mixed
VAT rates, carry-overs, cross-footing and foreign currency. A PDF audit record can be saved for the
working papers.

## Install

Claude Code:

```
/plugin install deskcalc-verify --marketplace deskcalc/deskcalc-verify
```

Cowork and claude.ai: Customize > Plugins > Add > Add marketplace, repository `deskcalc/deskcalc-verify`.

## Use it

Attach a document and ask Claude to check it, for example "check this invoice", "add up these
receipts", "foot and cross-foot this table" or "check this statement". The skills in this plugin
tell Claude how to send the lines; the work happens in DeskCalc on your screen.

Requirements: Windows, [DeskCalc](https://www.deskcalc.com/download-windows-tape-calculator.html?from=verify)
11.3 or later and Node.js 20+. The server runs locally, so it works in Claude Code and in Cowork
sessions on your computer. In the Claude Desktop chat, install the extension
[`deskcalc-verify.mcpb`](https://www.deskcalc.com/downloads/deskcalc-verify.mcpb) instead.

## Data

Everything runs on your PC. The server talks to DeskCalc through files in
`Documents\DeskCalc Verify`; it opens no network connection, needs no account and sends no
telemetry. Claude sees the document you give it and the confirmed result. The tapes and audit
records stay on your PC; job files are deleted after each check. Privacy policy:
https://www.deskcalc.com/privacy-policy.html

## What it runs and reads on your PC

- **Runs:** `server/index.js` with Node.js - the DeskCalc Verify MCP server, bundled into one
  file (source: `src/` in this repository). It starts DeskCalc (`deskcalc.exe /verify <job file>`).
- **Reads, to find DeskCalc:** the Microsoft Store alias `%LOCALAPPDATA%\Microsoft\WindowsApps\deskcalc.exe`
  and the registry values `HKCU\Software\DeskCalc\InstallDir` and
  `HKLM\...\Uninstall\DeskCalc\InstallLocation` (via `reg query`).
- **Reads, for the audit record only:** your Windows user name and PC name, printed as
  "checked by" in the PDF you ask it to save. Nothing else is read and nothing is sent anywhere.
- **Writes:** job and result files in `Documents\DeskCalc Verify` (deleted after each check) and,
  on request, audit records (PDF) in `Documents\DeskCalc Verify\Audit records` or `Prüfnachweise`.
- **Optional environment variables:** `DESKCALC_PATH` (path to deskcalc.exe) and
  `DESKCALC_VERIFY_DIR` (exchange folder). No credentials or tokens are used.

## License

MIT - see [LICENSE](LICENSE). Source: https://github.com/deskcalc/deskcalc-verify
