// End-to-end over MCP stdio: real server (dist/server.js), fake DeskCalc.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
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
  it('lists the tools with annotations and the ready-made prompts', async () => {
    const c = await connect({});
    const { tools } = await c.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['compare_verifications', 'deskcalc_status', 'get_verification', 'save_audit_record', 'verify_numbers']);
    const { prompts } = await c.listPrompts();
    expect(prompts.map(p => p.name)).toEqual(['check_invoice', 'add_expenses', 'foot_table', 'bank_statement', 'reconcile_documents']);
    const p = await c.getPrompt({ name: 'add_expenses' });
    expect((p.messages[0].content as any).text).toMatch(/ONE call and ONE tape/);
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

  const mixed = {
    title: 'Gemischt',
    items: [
      { type: 'group', label: '20 %' },
      { label: '01 Dienstleistung', qty: 2, price: 150, value: 300 },
      { label: '03 Software-Lizenz', qty: 1, price: 200, value: 200 },
      { type: 'tax', rate: 20, label: 'USt 20 %', value: 100 },
      { type: 'group', label: '10 %' },
      { label: '02 Fachbuch', qty: 3, price: 25, value: 75 },
      { type: 'tax', rate: 10, label: 'USt 10 %', value: 7.5 },
    ],
    expected_total: 682.5,
  };

  it('checks mixed tax rates in blocks (one pass without corrections)', async () => {
    const c = await connect({ FAKE_MODE: 'confirm' });
    const r = await call(c, 'verify_numbers', mixed);
    expect(r.status).toBe('confirmed');
    expect(r.total).toBe('682.5');
    expect(r.gt_outdated).toBeUndefined();
    expect(r.document_check.ok).toBe(true);
    expect(r.corrections).toEqual([]);
    await c.close();
  });

  it('asks for a second pass when a correction made the GT line outdated', async () => {
    const c = await connect({ FAKE_MODE: 'edit_qty_once' });
    const r1 = await call(c, 'verify_numbers', mixed);
    expect(r1.status).toBe('confirmed');
    expect(r1.gt_outdated).toBe(true);
    expect(r1.total).toBe('862.5');                          // fresh blocks, not the snapshot
    expect(r1.corrections.map((x: any) => x.type)).toEqual(['changed']);
    expect(r1.rerun.replace_review_id).toBe(r1.review_id);
    expect(r1.rerun.items.filter((x: any) => x.type === 'group')).toHaveLength(2);
    expect(r1.rerun.items.find((x: any) => x.label === '01 Dienstleistung').qty).toBe('3');
    const r2 = await call(c, 'verify_numbers', r1.rerun);
    expect(r2.status).toBe('confirmed');
    expect(r2.gt_outdated).toBeUndefined();
    expect(r2.corrections).toEqual([]);
    expect(r2.total).toBe('862.5');
    expect(r2.document_check.ok).toBe(false);                // invoice says 682.50, user says qty 3
    await c.close();
  });

  it('second pass reuses the tab even without replace_review_id (same title)', async () => {
    const log = join(tmpdir(), `fake-log-${Date.now()}.txt`);
    const c = await connect({ FAKE_MODE: 'edit_qty_once', FAKE_LOG: log });
    const r1 = await call(c, 'verify_numbers', mixed);
    expect(r1.gt_outdated).toBe(true);
    const { replace_review_id, ...args } = r1.rerun;          // the agent forgets it
    const r2 = await call(c, 'verify_numbers', args);
    expect(r2.status).toBe('confirmed');
    const jobs = readFileSync(log, 'utf8').trim().split('\n');
    expect(jobs[1]).toMatch(new RegExp(`replace=${r1.review_id}$`));
    const r3 = await call(c, 'verify_numbers', mixed);        // a fresh check: no replace
    expect(r3.status).toBe('confirmed');
    expect(readFileSync(log, 'utf8').trim().split('\n')[2]).toMatch(/replace=-$/);
    await c.close();
  });

  it('tells the user to restart an old DeskCalc that does not know groups', async () => {
    const c = await connect({ FAKE_MODE: 'old' });
    const r = await call(c, 'verify_numbers', mixed);
    expect(r.status).toBe('deskcalc_update_required');
    expect(r.message).toMatch(/close DeskCalc completely/);
    await c.close();
  });

  it('checks carry-overs: names the first wrong one, later ones follow from it', async () => {
    const c = await connect({ FAKE_MODE: 'confirm' });
    const r = await call(c, 'verify_numbers', {
      title: 'Konto 10/26',
      items: [
        { label: 'Anfangssaldo', value: 1000 },
        { label: '02.10. Miete', value: -650 },
        { label: '05.10. Kunde A', value: 1200.5 },
        { type: 'subtotal', label: 'Übertrag S.1', value: 1550.5 },
        { label: '12.10. Strom', value: -84.2 },
        { type: 'subtotal', label: 'Übertrag S.2', value: 1476.3 },      // misprint: should be 1466.30
        { label: '20.10. Kunde B', value: 300 },
        { type: 'subtotal', label: 'Übertrag S.3', value: 1776.3 },      // follows from S.2
      ],
      expected_total: 1776.3,
    });
    expect(r.status).toBe('confirmed');
    expect(r.total).toBe('1766.3');
    const sub = r.document_check.checks.filter((x: any) => x.check.startsWith('subtotal'));
    expect(sub.map((x: any) => x.ok)).toEqual([true, false, false]);
    expect(sub[1].difference).toBe('-10.00');
    expect(sub[2].follows).toBe(true);
    expect(r.message).toMatch(/follows from the difference above/);
    expect(r.corrections).toEqual([]);
    await c.close();
  });

  it('converts a foreign currency line and checks the printed home amount', async () => {
    const c = await connect({ FAKE_MODE: 'confirm' });
    const r = await call(c, 'verify_numbers', {
      title: 'USD',
      items: [{ label: 'Inv 7 AWS', foreign: 100, currency: 'USD', fx_rate: 0.92, value: 92 }, { label: 'Fee', value: 1.5 }],
      expected_total: 93.5,
    });
    expect(r.status).toBe('confirmed');
    expect(r.total).toBe('93.5');
    expect(r.document_check.ok).toBe(true);
    const bad = await call(c, 'verify_numbers', { title: 'x', items: [{ foreign: 100, fx_rate: 0 }] });
    expect(bad.status).toBe('bad_request');
    await c.close();
  });

  it('cross-foots a table (rows and columns)', async () => {
    const c = await connect({ FAKE_MODE: 'confirm', FAKE_LANG: 'en' });
    await call(c, 'verify_numbers', { title: 'warm', items: [{ value: 1 }] });   // DeskCalc reports its language
    const r = await call(c, 'verify_numbers', {
      title: 'Tabelle',
      items: [{ label: 'R1', value: 120, net: 100, tax: 20 }, { label: 'R2', value: 56, net: 50, tax: 5 }],
      expected_total: 176, expected_net_total: 150, expected_tax_total: 25,
    });
    const rows = r.document_check.checks.filter((x: any) => x.check.startsWith('row'));
    expect(rows.map((x: any) => x.ok)).toEqual([true, false]);
    // each row is its own block on the tape: net, tax, checkpoint
    expect(r.lines.map((l: any) => [l.label, l.block ?? 1])).toEqual([
      ['Net', 1], ['Tax', 1], ['Gross per document', 1], ['Net', 2], ['Tax', 2], ['Gross per document', 2]]);
    expect(r.document_check.checks.filter((x: any) => x.check.startsWith('subtotal'))).toEqual([]);
    const half = await call(c, 'verify_numbers', { title: 'x', items: [{ value: 1, net: 1 }] });
    expect(half.status).toBe('bad_request');
    const mixed = await call(c, 'verify_numbers', { title: 'x', items: [{ label: 'R1', value: 2, net: 1, tax: 1 }, { value: 5 }] });
    expect(mixed.status).toBe('bad_request');
    const many = await call(c, 'verify_numbers', { title: 'x', items: Array.from({ length: 126 }, (_, i) => ({ label: `R${i}`, value: 2, net: 1, tax: 1 })) });
    expect(many.status).toBe('bad_request');
    expect(many.message).toContain('125 rows');
    await c.close();
  });

  it('cross-footing: a corrected row comes back as a second pass with the row labels', async () => {
    const c = await connect({ FAKE_MODE: 'edit' });
    const r = await call(c, 'verify_numbers', {
      title: 'Tabelle', row_labels: { net: 'Netto', tax: 'USt', gross: 'Brutto lt. Beleg' },
      items: [{ label: 'R1', value: 120, net: 100, tax: 20 }, { label: 'R2', value: 55, net: 50, tax: 5 }],
    });
    expect(r.lines[0].label).toBe('Netto');
    expect(r.gt_outdated).toBe(true);
    expect(r.rerun.row_labels).toEqual({ net: 'Netto', tax: 'USt', gross: 'Brutto lt. Beleg' });
    expect(r.rerun.items.map((x: any) => x.label)).toEqual(['R1', 'R2']);
    expect(r.rerun.items[0].value).toBe('120');
    await c.close();
  });

  it('writes the audit record and the row labels in the language DeskCalc runs in', async () => {
    for (const [lang, folder, net, word] of [['en', 'Audit records', 'Net', 'Audit record'], ['de', 'Prüfnachweise', 'Netto', 'Prüfnachweis']]) {
      const c = await connect({ FAKE_MODE: 'confirm', FAKE_LANG: lang });
      await call(c, 'verify_numbers', { title: 'warm', items: [{ value: 1 }] });          // DeskCalc reports its language
      const v = await call(c, 'verify_numbers', { title: 'Table', items: [{ label: 'R1', value: 120, net: 100, tax: 20 }] });
      expect(v.lines[0].label).toBe(net);
      const s = await call(c, 'save_audit_record', { review_id: v.review_id });
      expect(s.file).toContain(folder);
      expect(readFileSync(s.file).toString('latin1')).toContain(word);
      await c.close();
    }
  });

  it('reconciles two confirmed tapes', async () => {
    const c = await connect({ FAKE_MODE: 'confirm' });
    const inv = await call(c, 'verify_numbers', { title: 'Rechnung', items: [
      { label: 'Schrauben', value: 12.5 }, { label: 'Dübel', value: 8 }, { label: 'Farbe', value: 45 }, { label: 'Pinsel', value: 6.9 }] });
    const dn = await call(c, 'verify_numbers', { title: 'Lieferschein', items: [
      { label: 'Dübel', value: 8 }, { label: 'Schrauben', value: 12.5 }, { label: 'Farbe', value: 40 }] });
    const r = await call(c, 'compare_verifications', { review_a: inv.review_id, review_b: dn.review_id });
    expect(r.status).toBe('compared');
    expect(r.reconciliation.matched).toHaveLength(2);
    expect(r.reconciliation.amount_differs[0]).toMatchObject({ label: 'Farbe', difference: '5.00' });
    expect(r.reconciliation.only_in_a.map((x: any) => x.label)).toEqual(['Pinsel']);
    expect(r.reconciliation.difference).toBe('11.90');
    const u = await call(c, 'compare_verifications', { review_a: inv.review_id, review_b: 'nope' });
    expect(u.status).toBe('unknown_review');
    await c.close();
  });

  it('saves an audit record as PDF, also over several pages', async () => {
    const c = await connect({ FAKE_MODE: 'edit' });
    const v = await call(c, 'verify_numbers', { title: 'Spesen: Okt/26', items, expected_total: 227.1 });
    const s = await call(c, 'save_audit_record', { review_id: v.review_id, source: 'Belege Oktober.pdf', language: 'de' });
    expect(s.status).toBe('saved');
    expect(s.file).toMatch(/Prüfnachweise[\\/]\d{4}-\d\d-\d\d \d{4} Spesen Okt 26 [0-9a-f]{8}\.pdf$/);
    const pdf = readFileSync(s.file);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdf.toString('latin1');
    expect(text).toContain('Prüfnachweis');                    // cp1252 = latin1 for umlauts
    expect(text).toContain('geändert');                        // the user's corrections are in it
    expect(text).toContain('/Count 1');
    const many = await call(c, 'verify_numbers', { title: 'Viele', items: Array.from({ length: 200 }, (_, i) => ({ label: `B${i}`, value: i + 0.5 })) });
    await c.close();
    const c2 = await connect({ FAKE_MODE: 'confirm', FAKE_LANG: 'en' });
    const m = await call(c2, 'verify_numbers', { title: 'Viele', items: Array.from({ length: 200 }, (_, i) => ({ label: `B${i}`, value: i + 0.5 })) });
    const s2 = await call(c2, 'save_audit_record', { review_id: m.review_id });
    expect(s2.file).toMatch(/Audit records/);
    expect(readFileSync(s2.file).toString('latin1')).toMatch(/\/Count [3-9]/);
    const nc = await call(c2, 'save_audit_record', { review_id: 'nope' });
    expect(nc.status).toBe('unknown_review');
    await c2.close();
    void many;
  });

  it('rejects an empty group and a tax line at the start of a group', async () => {
    const c = await connect({});
    const e1 = await call(c, 'verify_numbers', { title: 'x', items: [{ type: 'group', label: 'A' }, { type: 'group', label: 'B' }, { value: 1 }] });
    expect(e1.status).toBe('bad_request');
    const e2 = await call(c, 'verify_numbers', { title: 'x', items: [{ value: 1 }, { type: 'group', label: 'B' }, { type: 'tax', rate: 10 }, { value: 2 }] });
    expect(e2.status).toBe('bad_request');
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
