"""Prüfmatrix (Plan 09.5 §7): every sample document, its prompt, N runs with REAL Claude
(Claude Code + local server + DeskCalc in probe mode; a clicker presses Confirm).

Per run it records what Claude SENT and what the check FOUND:
  sent     - verify_numbers called, how often (attempts), printed figures included?
  found    - the deliberate error of the sample reported (see EXPECT)
  false    - failing checks that are neither expected nor follow-ups (false alarms)
  answer   - Claude's final answer names the key figure (e.g. "10.48")
Threshold (plan): error found in >= 95 % of runs, no false alarms.

    python fuzz/claude_matrix.py [runs=5] [lang=en] [sample ...]
Writes fuzz/matrix-<date>-<lang>.md and .json (not committed). Uses your Claude Code account (one run reads one PDF).
"""
import sys, os, json, subprocess, tempfile, datetime, re
sys.path.insert(0, os.path.dirname(__file__))
import fuzz_verify as fv

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
args = [a for a in sys.argv[1:]]
RUNS = int(args.pop(0)) if args and args[0].isdigit() else 5
LANG = args.pop(0) if args and args[0] in ('en', 'de') else 'en'
ONLY = set(args)
S = os.path.join(ROOT, 'samples', LANG)

def prompt(name):
    """The prompt text exactly as the '+' menu sends it (from the built server)."""
    js = r'''
const src = require('fs').readFileSync(process.argv[1], 'utf8');
const m = src.match(new RegExp('name: "' + process.argv[2] + '"[\\s\\S]*?text: ([\\s\\S]*?) \\+ COMMON'));
const common = src.match(/COMMON = ([\s\S]*?);\n/);
console.log(eval(m[1]) + eval(common[1]));'''
    return subprocess.run(['node', '-e', js, os.path.join(ROOT, 'dist', 'server.js'), name],
                          capture_output=True, text=True).stdout.strip()

def failing(results):
    out = []
    for r in results:
        for c in (r.get('document_check') or {}).get('checks', []):
            if not c['ok']: out.append(c)
    return out

# sample -> files, prompt, how to recognise the deliberate error, the key figure in the answer
CASES = {
 'V1-invoice':  dict(files=['V1 Invoice/Invoice INV-2026-2041.pdf'], prompt='check_invoice',
                     expect=lambda f: any(c['check'].startswith('line') and c['document'] == '98.40' and not c.get('follows') for c in f),
                     key='10.48'),
 'V4-receipts': dict(files=['V4 Expenses/30 expense receipts October 2026.pdf'], prompt='add_expenses',
                     expect=lambda f: any(c['check'].startswith('tax') and c['document'] == '8.72' for c in f), key='8.72'),
 'V4-claim':    dict(files=['V4 Expenses/Expense claim October 2026.pdf'], prompt='add_expenses',
                     expect=lambda f: any(c['check'] == 'total' and c['document'] == '1311.45' for c in f), key='1.00'),
 'V5-statement': dict(files=['V5 Bank statement/Bank statement 10-2026 Sample Bank.pdf'], prompt='bank_statement',
                     expect=lambda f: any(c['check'].startswith('subtotal') and c['document'] == '28522.36' and not c.get('follows') for c in f),
                     key='10.00'),
 'V6-daybook':  dict(files=['V6 Cross-footing/Sales day book Q3 2026.pdf'], prompt='foot_table',
                     expect=lambda f: any(c['check'].startswith('row') and '1107' in c['check'] for c in f)
                                      and any(c['check'] == 'net column' for c in f), key='100.00'),
 'V7-reconcile': dict(files=['V7 Reconcile/Purchase order PO-2026-0457.pdf', 'V7 Reconcile/Invoice INV-2026-1189.pdf'],
                     prompt='reconcile_documents', expect=None, key='13.10'),      # judged on compare_verifications
 'V8-travel':   dict(files=['V8 Foreign currency/Travel expenses New York Zurich.pdf'], prompt=None,
                     text='Check the conversions and the total of the attached travel expense claim with DeskCalc (verify_numbers).',
                     expect=lambda f: any(c['check'].startswith('line') and c['document'] in ('193.23', '227.57') for c in f),
                     key='193.23' if LANG == 'en' else '227,57'),
}
EXPECTED_KINDS = {'V1-invoice': ('line', 'tax', 'discount', 'total'), 'V4-receipts': ('tax',), 'V4-claim': ('total',),
                  'V5-statement': ('subtotal', 'total'), 'V6-daybook': ('row', 'net column', 'total'), 'V8-travel': ('line', 'total')}

cfg = {'mcpServers': {'deskcalc-verify': {'command': 'node', 'args': [os.path.join(ROOT, 'dist', 'server.js')],
       'env': {'DESKCALC_PATH': fv.EXE, 'DESKCALC_EXTRA_ARGS': '/probe'}}}}
cfgfile = os.path.join(tempfile.gettempdir(), 'dcv_matrix_mcp.json')
json.dump(cfg, open(cfgfile, 'w'))
TOOLS = ['mcp__deskcalc-verify__verify_numbers', 'mcp__deskcalc-verify__get_verification',
         'mcp__deskcalc-verify__compare_verifications', 'Read']

def run_once(name, case):
    text = prompt(case['prompt']) if case.get('prompt') else case['text']
    files = '\n'.join(os.path.join(S, f) for f in case['files'])
    fv.restart_probe()
    p = subprocess.run(['claude', '-p', f'{text}\n\nAttached:\n{files}', '--mcp-config', cfgfile, '--allowedTools', *TOOLS,
                        '--output-format', 'stream-json', '--verbose'], capture_output=True, text=True, encoding='utf-8', timeout=1200)
    sent, results, compares, answer = [], [], [], ''
    for line in p.stdout.splitlines():
        try: ev = json.loads(line)
        except Exception: continue
        if ev.get('type') == 'result': answer = str(ev.get('result') or '')
        for part in (ev.get('message') or {}).get('content') or []:
            if part.get('type') == 'tool_use' and part.get('name', '').endswith('verify_numbers'): sent.append(part['input'])
            if part.get('type') == 'tool_result':
                c = part.get('content')
                txt = c if isinstance(c, str) else ' '.join(x.get('text', '') for x in c or [] if isinstance(x, dict))
                try: sc = json.loads(txt)
                except Exception: sc = None
                if isinstance(sc, dict):
                    if sc.get('status') == 'compared': compares.append(sc)
                    elif 'status' in sc: results.append(sc)
    f = failing([r for r in results if r.get('status') == 'confirmed'])
    if name == 'V7-reconcile':
        rc = (compares[-1].get('reconciliation') if compares else None) or {}
        found = bool(rc) and len(rc.get('matched', [])) == 6 and len(rc.get('amount_differs', [])) == 1 \
            and len(rc.get('only_in_a', [])) == 1 and len(rc.get('only_in_b', [])) == 1
        false = [c['check'] for c in f]                          # both documents add up: any failing check is a false alarm
    else:
        found = case['expect'](f)
        kinds = EXPECTED_KINDS[name]
        false = [c['check'] for c in f if not c.get('follows') and not any(c['check'].startswith(k) for k in kinds)]
    printed = any(any(it.get('value') is not None and (it.get('type') in ('tax', 'percent', 'subtotal') or 'qty' in it or 'net' in it or 'foreign' in it)
                      for it in a.get('items', [])) or a.get('expected_total') is not None for a in sent)
    return dict(calls=len(sent), printed=printed, found=found, false=false,
                answer_key=case['key'] in answer.replace(',', '.') or case['key'] in answer, answer=answer[:600])

clicker = fv.Clicker(); clicker.start()
rows, raw = [], {}
try:
    for name, case in CASES.items():
        if ONLY and name not in ONLY: continue
        raw[name] = []
        for i in range(RUNS):
            r = run_once(name, case); raw[name].append(r)
            print(f"{name} run {i + 1}: calls={r['calls']} printed={r['printed']} found={r['found']} false={r['false']} answer_key={r['answer_key']}", flush=True)
        rs = raw[name]
        rows.append((name, len(rs), sum(r['found'] for r in rs), sum(bool(r['false']) for r in rs),
                     sum(r['printed'] for r in rs), sum(r['calls'] for r in rs) / len(rs), sum(r['answer_key'] for r in rs)))
finally:
    clicker.stop = True
stamp = datetime.date.today().isoformat()
md = [f'# Prüfmatrix {stamp} ({LANG}, {RUNS} runs each)', '',
      '| Sample | runs | error found | false alarm | printed figures sent | avg. calls | answer names key figure |', '|---|---|---|---|---|---|---|']
for n, k, fo, fa, pr, ca, an in rows:
    md.append(f'| {n} | {k} | {fo}/{k} | {fa}/{k} | {pr}/{k} | {ca:.1f} | {an}/{k} |')
total = sum(r[1] for r in rows); found = sum(r[2] for r in rows); falses = sum(r[3] for r in rows)
md += ['', f'Overall: error found {found}/{total} ({100 * found / max(total, 1):.0f} %), runs with false alarm {falses}.',
       'Threshold: >= 95 % found, 0 false alarms.']
out = os.path.join(os.path.dirname(__file__), f'matrix-{stamp}-{LANG}')
open(out + '.md', 'w', encoding='utf-8').write('\n'.join(md) + '\n')
json.dump(raw, open(out + '.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('\n'.join(md)); print('->', out + '.md')
