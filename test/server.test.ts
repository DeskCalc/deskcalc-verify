// End-to-end over MCP stdio: real server (dist/server.js), fake DeskCalc.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const root = resolve(__dirname, '..');
const fake = join(root, 'test', 'fake-deskcalc.mjs');
let dir: string;

beforeAll(() => {
  execSync('npm run build', { cwd: root, stdio: 'ignore' });
  dir = mkdtempSync(join(tmpdir(), 'dcv-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'dist', 'server.js')],
    env: { ...process.env as Record<string, string>, DESKCALC_PATH: fake, DESKCALC_VERIFY_DIR: dir, DESKCALC_ACK_TIMEOUT_MS: '1500', ...env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return r.structuredContent as any;
}

const items = [
  { value: 45.8, label: '12.10. Shell' },
  { value: '189.00', label: '14.10. Hotel Ibis Köln' },
  { value: -20, label: 'Gutschrift' },
  { value: 12.3, label: 'Parken 8 €' },
];

describe('deskcalc-verify over MCP', () => {
  it('lists three tools with annotations', async () => {
    const c = await connect({});
    const { tools } = await c.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['deskcalc_status', 'get_verification', 'verify_numbers']);
    expect(tools.find(t => t.name === 'verify_numbers')!.annotations?.destructiveHint).toBe(false);
    await c.close();
  });

  it('returns the confirmed total and no corrections', async () => {
    const c = await connect({ FAKE_MODE: 'confirm' });
    const r = await call(c, 'verify_numbers', { title: 'Spesen Oktober', items });
    expect(r.status).toBe('confirmed');
    expect(r.total).toBe('227.1');
    expect(r.confirmed_by_user).toBe(true);
    expect(r.corrections).toEqual([]);
    expect(r.lines[3].label).toBe('Parken 8 €');
    expect(readdirSync(dir).filter(f => f.startsWith('v-'))).toEqual([]);   // cleaned up
    await c.close();
  });

  it('reports the user\'s corrections', async () => {
    const c = await connect({ FAKE_MODE: 'edit' });
    const r = await call(c, 'verify_numbers', { title: 'Spesen', items });
    expect(r.status).toBe('confirmed');
    expect(r.total).toBe('108.8');
    expect(r.corrections.map((x: any) => x.type)).toEqual(['changed', 'added', 'removed']);
    await c.close();
  });

  it('returns pending, then the result via get_verification', async () => {
    const c = await connect({ FAKE_MODE: 'confirm', FAKE_DELAY_MS: '2500' });
    const p = await call(c, 'verify_numbers', { title: 'Langsam', items, wait_seconds: 1 });
    expect(p.status).toBe('pending');
    const busy = await call(c, 'verify_numbers', { title: 'Zweiter', items });
    expect(busy.status).toBe('busy');
    const r = await call(c, 'get_verification', { review_id: p.review_id, wait_seconds: 10 });
    expect(r.status).toBe('confirmed');
    await c.close();
  });

  it('passes cancel, no_free_tab and limit through', async () => {
    for (const [mode, st] of [['cancel', 'cancelled'], ['no_free_tab', 'no_free_tab'], ['limit', 'limit_reached']]) {
      const c = await connect({ FAKE_MODE: mode });
      const r = await call(c, 'verify_numbers', { title: 'x', items });
      expect(r.status).toBe(st);
      await c.close();
    }
  });

  it('detects a DeskCalc without /verify (no acknowledgement)', async () => {
    const c = await connect({ FAKE_MODE: 'silent' });
    const r = await call(c, 'verify_numbers', { title: 'x', items });
    expect(r.status).toBe('deskcalc_update_required');
    await c.close();
  });

  it('rejects localized values before starting DeskCalc', async () => {
    const c = await connect({});
    const r = await call(c, 'verify_numbers', { title: 'x', items: [{ value: '1.234,56', label: 'a' }] });
    expect(r.status).toBe('bad_request');
    expect(r.problem.line).toBe(1);
    await c.close();
  });

  it('reports a missing DeskCalc', async () => {
    const c = await connect({ DESKCALC_PATH: join(dir, 'nope.exe') });
    const r = await call(c, 'verify_numbers', { title: 'x', items });
    expect(r.status).toBe('deskcalc_not_found');
    const s = await call(c, 'deskcalc_status', {});
    expect(s.found).toBe(false);
    await c.close();
  });
});
