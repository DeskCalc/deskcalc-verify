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
      'Show a list of numbers as a labelled adding-machine tape in DeskCalc so the user can check every line, ' +
      'correct it and press Confirm. Returns the confirmed total, the lines and any corrections. ' +
      'Use it before you rely on a sum you extracted from documents. If the result is "pending", tell the user ' +
      'to finish the check in DeskCalc and call get_verification with the review_id. ' +
      'Values: plain numbers with "." as decimal separator (negative for credits/refunds). ' +
      'Labels: short source references such as date and payee, e.g. "14.10. Hotel Ibis".',
    inputSchema: {
      title: z.string().min(1).max(60).describe('Short name for the tape, e.g. "Expenses October".'),
      items: z.array(z.object({
        value: z.union([z.number(), z.string()]).describe('Amount, e.g. 189.00 or "-20.50".'),
        label: z.string().max(200).optional().describe('Where the number comes from (max 60 characters are kept).'),
      })).min(1).max(500).describe('The lines in order.'),
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
