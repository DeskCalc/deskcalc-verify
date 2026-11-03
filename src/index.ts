// deskcalc-verify - MCP server (stdio). A human checks and confirms numbers in
// DeskCalc before an AI agent relies on the total. Local only: no network.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { verifyNumbers, getVerification, status, compareVerifications, saveAuditRecord, DEFAULT_WAIT_S, MAX_WAIT_S, type Outcome, type WaitHooks } from './verify.js';
import { PROMPTS } from './prompts.js';
import pkg from '../package.json' with { type: 'json' };

const server = new McpServer(
  { name: 'deskcalc-verify', version: pkg.version },
  {
    instructions:
      'Use DeskCalc Verify whenever you are about to rely on a sum of numbers you extracted from documents, ' +
      'images, e-mails or spreadsheets (receipts, statements, invoices). The numbers open as a labelled tape in ' +
      'DeskCalc on the user\'s Windows PC; the user checks each line, corrects mistakes and presses Confirm. ' +
      'Only use the confirmed total and lines that come back. Never invent a total while a check is pending.',
  },
);

function reply(o: Outcome) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }],
    structuredContent: o as unknown as Record<string, unknown>,
    isError: !['confirmed', 'pending', 'compared', 'saved'].includes(o.status),
  };
}

// Progress notifications keep long waits alive in clients that support them.
function hooksFrom(extra: { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> }): WaitHooks {
  const token = extra._meta?.progressToken;
  return {
    signal: extra.signal,
    onTick: token === undefined ? undefined : async (elapsed) => {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: elapsed, message: 'Waiting for the user to confirm in DeskCalc' },
      }).catch(() => {});
    },
  };
}

const waitSchema = z.number().int().min(0).max(MAX_WAIT_S).optional()
  .describe(`How long to wait for the user before returning "pending" (default ${DEFAULT_WAIT_S} s).`);

server.registerTool(
  'verify_numbers',
  {
    title: 'Check numbers in DeskCalc',
    description:
      'Show numbers as a labelled adding-machine tape in DeskCalc so the user can check every line, correct it ' +
      'and press Confirm. Returns the confirmed total, the lines, the user\'s corrections and - if you pass the ' +
      'printed figures - a cent-exact check of the document. Use it before you rely on a sum you extracted from ' +
      'receipts, statements or invoices. If the result is "pending", tell the user to finish the check in DeskCalc ' +
      'and call get_verification with the review_id.\n' +
      'Line kinds: (1) amount: {label, value}. (2) quantity x unit price: {label, qty, price, value?} - value is the ' +
      'printed line total, checked against qty x price. (3) VAT/sales tax: {type:"tax", rate, included?, value?} - ' +
      'put it after the taxable lines; DeskCalc computes the tax from the subtotal above and recomputes it when the ' +
      'user corrects a line; value is the printed tax amount; included=true for gross prices ("incl. VAT"). ' +
      '(4) discount/surcharge in percent on the subtotal above: {type:"percent", rate, value?} - rate -3 for ' +
      '"3 % Rabatt", -2 for "2 % Skonto", +5 for a surcharge; value is the printed amount. A discount on a single ' +
      'position: give that position with its discounted amount or as a separate negative amount line. Prices per ' +
      '100/1000 units: convert to a unit price or give the line total as an amount. ' +
      '(5) MIXED TAX RATES (e.g. 20 % and 10 % on one invoice): a tax line always applies to the whole ' +
      'subtotal above, so put the positions of each rate in their own group: {type:"group", label:"20 %"}, its ' +
      'positions, its tax line; then {type:"group", label:"10 %"}, ... DeskCalc adds a GT (grand total) line. ' +
      'If the result has gt_outdated=true (the user corrected a line, the GT line is a snapshot), call ' +
      'verify_numbers again with exactly the arguments in "rerun" and use that second result. ' +
      '(6) MANY RECEIPTS (expenses, a stack of bills): ONE call, ONE tape - one amount line per receipt ' +
      '(label "14.10. Hotel"), never one call per receipt. Only if the VAT of each receipt matters, give each ' +
      'receipt its own group with its tax line (included=true for receipts). ' +
      '(7) PRINTED SUBTOTALS / CARRY-OVERS (bank statement, ledger over several pages, "Übertrag", "Zwischensumme"): ' +
      '{type:"subtotal", label:"Übertrag S.1", value} at that place - DeskCalc shows the running total there and the ' +
      'check names the first carry-over that is wrong. An opening balance is a normal amount line. ' +
      '(8) CROSS-FOOTING A TABLE (net, tax, gross columns): one line per row {label, value: gross, net, tax} and ' +
      'nothing else in that call; pass expected_total (gross column total), expected_net_total and expected_tax_total ' +
      'if printed (row_labels: omit - the tape uses DeskCalc\'s language). ' +
      'DeskCalc shows each row as its own block: net, tax, and the printed gross as a checkpoint. ' +
      '(9) FOREIGN CURRENCY: {label, foreign: 100, currency:"USD", fx_rate: 0.92, value: 92.00} - fx_rate is home ' +
      'currency per 1 unit; if the document quotes the inverse (1 EUR = 1.08 USD), give the printed home amount as ' +
      'a plain amount line and name the rate in the label. ' +
      'For invoices also pass expected_total (the printed amount payable). ' +
      'After a confirmed check, offer save_audit_record (PDF for the working papers); to reconcile two documents ' +
      '(invoice vs delivery note, order or payment), verify both, then call compare_verifications. ' +
      'If you use a figure that is NOT printed on the document (e.g. a fee from a published table, a rate you ' +
      'looked up), say so in the label, e.g. "(Tab. A, web)", and tell the user - the tape must not make your ' +
      'own assumptions look like the document.\n' +
      'Numbers: plain, "." as decimal separator, negative for credits. Labels: SHORT, max ~25 characters, ' +
      'e.g. "Pos.1 Wandfarbe" or "14.10. Hotel" - longer labels are cut off on the tape. Title: 1-3 words; it ' +
      'becomes the tab name in DeskCalc.',
    inputSchema: {
      title: z.string().min(1).max(60).describe('Short tab name, e.g. "Baumarkt 10/26" or "Spesen Oktober".'),
      items: z.array(z.object({
        type: z.enum(['amount', 'tax', 'percent', 'group', 'subtotal']).optional().describe('"tax" VAT line, "percent" discount/surcharge on the subtotal above, "group" starts a block (one per tax rate), "subtotal" a printed subtotal/carry-over to check; default amount.'),
        label: z.string().max(200).optional().describe('Short source reference, max ~25 characters.'),
        value: z.union([z.number(), z.string()]).optional()
          .describe('Amount. With qty/price: the printed line total (for the check). With type "tax": the printed tax amount (for the check).'),
        qty: z.union([z.number(), z.string()]).optional().describe('Quantity (with price).'),
        price: z.union([z.number(), z.string()]).optional().describe('Unit price (with qty).'),
        rate: z.union([z.number(), z.string()]).optional().describe('Percent: tax rate (type "tax", e.g. 19) or discount/surcharge (type "percent", e.g. -3 for 3 % discount).'),
        included: z.boolean().optional().describe('Tax is included in the amounts above (gross prices). Default false (tax added on top).'),
        net: z.union([z.number(), z.string()]).optional().describe('Cross-footing a table row: printed net of the row (value = printed gross, tax = printed tax).'),
        tax: z.union([z.number(), z.string()]).optional().describe('Cross-footing a table row: printed tax of the row.'),
        foreign: z.union([z.number(), z.string()]).optional().describe('Foreign currency amount (with fx_rate); value = printed amount in home currency.'),
        currency: z.string().max(4).optional().describe('Foreign currency code, e.g. "USD".'),
        fx_rate: z.union([z.number(), z.string()]).optional().describe('Home currency per 1 unit of the foreign currency, e.g. 0.92 for 1 USD = 0.92 EUR.'),
      })).min(1).max(500).describe('The lines in document order.'),
      expected_total: z.union([z.number(), z.string()]).optional()
        .describe('The printed total / amount payable of the document, checked to the cent against the confirmed tape.'),
      expected_net_total: z.union([z.number(), z.string()]).optional().describe('Cross-footing: printed total of the net column.'),
      row_labels: z.object({ net: z.string().max(25).optional(), tax: z.string().max(25).optional(), gross: z.string().max(25).optional() })
        .optional().describe('Cross-footing: tape labels of the net, tax and gross lines. Omit: DeskCalc\'s language is used.'),
      expected_tax_total: z.union([z.number(), z.string()]).optional().describe('Cross-footing: printed total of the tax column.'),
      wait_seconds: waitSchema,
      replace_review_id: z.string().optional().describe('Second pass after gt_outdated: the review_id from "rerun" - DeskCalc reuses that tab.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (args, extra) => reply(await verifyNumbers(args, hooksFrom(extra as any))),
);

server.registerTool(
  'get_verification',
  {
    title: 'Get the confirmed result from DeskCalc',
    description:
      'Wait for and return the result of a verification that came back "pending". ' +
      'Returns "confirmed" with total, lines and corrections once the user pressed Confirm in DeskCalc.',
    inputSchema: {
      review_id: z.string().min(1).describe('review_id from verify_numbers.'),
      wait_seconds: waitSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ review_id, wait_seconds }, extra) => reply(await getVerification(review_id, wait_seconds, hooksFrom(extra as any))),
);

server.registerTool(
  'compare_verifications',
  {
    title: 'Reconcile two confirmed tapes',
    description:
      'Compare the positions of two confirmed verifications to the cent, e.g. invoice vs delivery note, order, ' +
      'or bank statement. Returns matched positions, positions with a different amount (same text), positions ' +
      'only on one side and the difference of the totals. Verify both documents with verify_numbers first.',
    inputSchema: {
      review_a: z.string().min(1).describe('review_id of the first confirmed verification.'),
      review_b: z.string().min(1).describe('review_id of the second confirmed verification.'),
      ignore_sign: z.boolean().optional().describe('Compare amounts without sign (e.g. invoice amounts vs payments shown as negative).'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ review_a, review_b, ignore_sign }) => reply(compareVerifications(review_a, review_b, ignore_sign)),
);

server.registerTool(
  'save_audit_record',
  {
    title: 'Save the audit record (PDF)',
    description:
      'Save a confirmed verification as a PDF audit record for the working papers: document name, date and ' +
      'user, every line with its calculation, the user\'s corrections and the cent-exact document check. ' +
      'Saved locally in the DeskCalc Verify folder; returns the file path.',
    inputSchema: {
      review_id: z.string().min(1).describe('review_id of a confirmed verification.'),
      source: z.string().max(120).optional().describe('The checked document, e.g. "Invoice RE-2026-0001.pdf".'),
      note: z.string().max(300).optional().describe('Short note for the record, e.g. the client or the purpose of the check.'),
      language: z.enum(['de', 'en']).optional().describe('Omit: the record is written in the language DeskCalc runs in. Set only if the user explicitly asks for another language.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ review_id, source, note, language }) => reply(saveAuditRecord(review_id, { source, note, language, version: pkg.version })),
);

for (const p of PROMPTS) {
  server.registerPrompt(p.name, { title: p.title, description: p.description },
    () => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.text } }] }));
}

server.registerTool(
  'deskcalc_status',
  {
    title: 'DeskCalc status',
    description: 'Whether DeskCalc is installed and where, and whether a verification is open.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const s = status();
    return { content: [{ type: 'text' as const, text: JSON.stringify(s, null, 2) }], structuredContent: s as unknown as Record<string, unknown> };
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write(`deskcalc-verify ${pkg.version} ready\n`);
