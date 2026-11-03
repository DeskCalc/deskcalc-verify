// deskcalc-verify - MCP server (stdio). A human checks and confirms numbers in
// DeskCalc before an AI agent relies on the total. Local only: no network.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { verifyNumbers, getVerification, status, DEFAULT_WAIT_S, MAX_WAIT_S, type Outcome, type WaitHooks } from './verify.js';
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
    isError: !['confirmed', 'pending'].includes(o.status),
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
      'For invoices also pass expected_total (the printed amount payable). ' +
      'If you use a figure that is NOT printed on the document (e.g. a fee from a published table, a rate you ' +
      'looked up), say so in the label, e.g. "(Tab. A, web)", and tell the user - the tape must not make your ' +
      'own assumptions look like the document.\n' +
      'Numbers: plain, "." as decimal separator, negative for credits. Labels: SHORT, max ~25 characters, ' +
      'e.g. "Pos.1 Wandfarbe" or "14.10. Hotel" - longer labels are cut off on the tape. Title: 1-3 words; it ' +
      'becomes the tab name in DeskCalc.',
    inputSchema: {
      title: z.string().min(1).max(60).describe('Short tab name, e.g. "Baumarkt 10/26" or "Spesen Oktober".'),
      items: z.array(z.object({
        type: z.enum(['amount', 'tax', 'percent']).optional().describe('"tax" for a VAT/sales-tax line, "percent" for a discount/surcharge on the subtotal above; default amount.'),
        label: z.string().max(200).optional().describe('Short source reference, max ~25 characters.'),
        value: z.union([z.number(), z.string()]).optional()
          .describe('Amount. With qty/price: the printed line total (for the check). With type "tax": the printed tax amount (for the check).'),
        qty: z.union([z.number(), z.string()]).optional().describe('Quantity (with price).'),
        price: z.union([z.number(), z.string()]).optional().describe('Unit price (with qty).'),
        rate: z.union([z.number(), z.string()]).optional().describe('Percent: tax rate (type "tax", e.g. 19) or discount/surcharge (type "percent", e.g. -3 for 3 % discount).'),
        included: z.boolean().optional().describe('Tax is included in the amounts above (gross prices). Default false (tax added on top).'),
      })).min(1).max(500).describe('The lines in document order.'),
      expected_total: z.union([z.number(), z.string()]).optional()
        .describe('The printed total / amount payable of the document, checked to the cent against the confirmed tape.'),
      wait_seconds: waitSchema,
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
