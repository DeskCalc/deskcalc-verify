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

## License

MIT - see [LICENSE](LICENSE). Source: https://github.com/deskcalc/deskcalc-verify
