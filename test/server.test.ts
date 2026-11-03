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

  it('checks an invoice with qty x price, tax and expected total', async () => {
    const invoice = {
      title: 'Baumarkt',
      items: [
        { label: 'Pos.1 Wandfarbe', qty: 3, price: 42.01, value: 126.03 },
        { label: 'Pos.2 Schrauben', qty: 2, price: 12.5, value: 25 },
        { label: 'Pos.3 Gipskarton', qty: 15, price: 7.1, value: 106.5 },
        { label: 'Pos.4 Versand', value: 35 },
        { type: 'tax', rate: 19, label: 'USt 19 %', value: 55.58 },
      ],
      expected_total: 348.11,
    };
    const c = await connect({ FAKE_MODE: 'confirm' });
    const r = await call(c, 'verify_numbers', invoice);
    expect(r.status).toBe('confirmed');
    expect(r.document_check.ok).toBe(true);
    expect(r.document_check.checks).toHaveLength(5);
    expect(r.corrections).toEqual([]);
    await c.close();

    // The user corrects a quantity: DeskCalc recomputes the tax, the check reports the differences.
    const c2 = await connect({ FAKE_MODE: 'edit_qty' });
    const r2 = await call(c2, 'verify_numbers', invoice);
    expect(r2.corrections.map((x: any) => x.type)).toEqual(['changed']);
    expect(r2.document_check.ok).toBe(false);
    const bad = r2.document_check.checks.filter((x: any) => !x.ok).map((x: any) => x.check.split(' ')[0]);
    expect(bad).toEqual(['tax', 'total']);
    expect(r2.message).toMatch(/do NOT match/);
    await c2.close();
  });

  it('handles a discount before tax and checks it', async () => {
    const c = await connect({ FAKE_MODE: 'confirm' });
    const r = await call(c, 'verify_numbers', {
      title: 'Rabatt',
      items: [
        { label: 'Pos.1', qty: 2, price: 100, value: 200 },
        { label: 'Pos.2', value: 50 },
        { type: 'percent', rate: -3, label: 'Rabatt 3 %', value: -7.5 },
        { type: 'tax', rate: 20, label: 'USt 20 %', value: 48.5 },
      ],
      expected_total: 291,
    });
    expect(r.status).toBe('confirmed');
    expect(r.total).toBe('291');
    expect(r.document_check.ok).toBe(true);
    expect(r.document_check.checks.map((x: any) => x.check.split(' ')[0])).toEqual(['line', 'tax', 'discount', 'total']);
    expect(r.corrections).toEqual([]);
    await c.close();
  });

  it('rejects a tax line without lines above', async () => {
    const c = await connect({});
    const r = await call(c, 'verify_numbers', { title: 'x', items: [{ type: 'tax', rate: 19 }] });
    expect(r.status).toBe('bad_request');
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
