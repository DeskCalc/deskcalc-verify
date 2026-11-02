// Manual check against a real DeskCalc with an invoice (qty x price, VAT, expected total).
// PowerShell: $env:DESKCALC_PATH='...\Release\deskcalc.exe'; $env:DESKCALC_EXTRA_ARGS='/probe'; node test/live-invoice.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ name: 'live-invoice', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist', 'server.js')], env: process.env, stderr: 'inherit' }));
const r = await client.callTool({
  name: 'verify_numbers',
  arguments: {
    title: 'Baumarkt',
    items: [
      { label: 'Pos.1 Wandfarbe', qty: 3, price: 42.01, value: 126.03 },
      { label: 'Pos.2 Schrauben', qty: 2, price: 12.5, value: 25.0 },
      { label: 'Pos.3 Gipskarton', qty: 15, price: 7.1, value: 106.5 },
      { label: 'Pos.4 Versand', value: 35.0 },
      { type: 'tax', rate: 19, label: 'USt 19 %', value: 55.58 },
    ],
    expected_total: 348.11,
    wait_seconds: 60,
  },
}, undefined, { timeout: 300000 });
console.log(JSON.stringify(r.structuredContent, null, 2));
await client.close();
