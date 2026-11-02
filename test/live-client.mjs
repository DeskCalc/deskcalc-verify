// Manual check against a real DeskCalc: node test/live-client.mjs [wait_seconds]
// Env: DESKCALC_PATH (e.g. ...\Release\deskcalc.exe), DESKCALC_EXTRA_ARGS=/probe
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wait = Number(process.argv[2] ?? 30);
const client = new Client({ name: 'live-check', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist', 'server.js')], env: process.env, stderr: 'inherit' }));

console.log('status:', JSON.stringify((await client.callTool({ name: 'deskcalc_status', arguments: {} })).structuredContent));
const t0 = Date.now();
const r = await client.callTool({
  name: 'verify_numbers',
  arguments: {
    title: 'Spesen Oktober',
    items: [
      { value: 45.8, label: '12.10. Shell' },
      { value: '189.00', label: '14.10. Hotel Ibis Köln' },
      { value: -20, label: 'Gutschrift' },
      { value: 12.3, label: 'Parken 8 €' },
      { value: 7.5, label: 'Kaffee & Kuchen <Bahnhof>' },
    ],
    wait_seconds: wait,
  },
}, undefined, { timeout: 300000 });
console.log(`after ${((Date.now() - t0) / 1000).toFixed(1)} s:`);
console.log(JSON.stringify(r.structuredContent, null, 2));
await client.close();
