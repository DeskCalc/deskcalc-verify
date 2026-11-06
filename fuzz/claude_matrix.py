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
DE = LANG == 'de'
def F(en, de): return de if DE else en          # file names differ per language; amounts are the same
CASES = {
 'V1-invoice':  dict(files=[F('V1 Invoice/Invoice INV-2026-2041.pdf', 'V1 Rechnung/Rechnung RE-2026-2041.pdf')], prompt='check_invoice',
                     expect=lambda f: any(c['check'].startswith('line') and c['document'] == '98.40' and not c.get('follows') for c in f),
                     key='10.48'),
 'V4-receipts': dict(files=[F('V4 Expenses/30 expense receipts October 2026.pdf', 'V4 Spesen/30 Spesenbelege Oktober 2026.pdf')], prompt='add_expenses',
                     expect=lambda f: any(c['check'].startswith('tax') and c['document'] == F('8.72', '5.04') for c in f), key=F('8.72', '5.04')),
 'V4-claim':    dict(files=[F('V4 Expenses/Expense claim October 2026.pdf', 'V4 Spesen/Spesenabrechnung Oktober 2026.pdf')], prompt='add_expenses',
                     expect=lambda f: any(c['check'] == 'total' and c['document'] == '1311.45' for c in f), key='1.00'),
 'V5-statement': dict(files=[F('V5 Bank statement/Bank statement 10-2026 Sample Bank.pdf', 'V5 Kontoauszug/Kontoauszug 10-2026 Musterbank.pdf')],
                     prompt='bank_statement',
                     expect=lambda f: any(c['check'].startswith('subtotal') and c['document'] == '28522.36' and not c.get('follows') for c in f),
                     key='10.00'),
 'V6-daybook':  dict(files=[F('V6 Cross-footing/Sales day book Q3 2026.pdf', 'V6 Querfussen/Rechnungsausgangsbuch Q3 2026.pdf')], prompt='foot_table',
                     expect=lambda f: any(c['check'].startswith('row') and '1107' in c['check'] for c in f)
                                      and any(c['check'] == 'net column' for c in f), key='100.00'),
 'V7-reconcile': dict(files=[F('V7 Reconcile/Purchase order PO-2026-0457.pdf', 'V7 Abgleich/Bestellung B-2026-0457.pdf'),
                             F('V7 Reconcile/Invoice INV-2026-1189.pdf', 'V7 Abgleich/Rechnung RE-2026-1189.pdf')],
                     prompt='reconcile_documents', expect=None, key='13.10'),      # judged on compare_verifications
 'V8-travel':   dict(files=[F('V8 Foreign currency/Travel expenses New York Zurich.pdf', 'V8 Fremdwaehrung/Reisekosten New York Zuerich.pdf')], prompt=None,
                     text=F('Check the conversions and the total of the attached travel expense claim with DeskCalc (verify_numbers).',
                            'Prüfe die Umrechnungen und die Summe der angehängten Reisekostenabrechnung mit DeskCalc (verify_numbers).'),
                     expect=lambda f: any(c['check'].startswith('line') and c['document'] in ('193.23', '227.57') for c in f),
                     key=F('193.23', '227.57')),
}
# New document types (samples/make_more.py): wrong = every printed figure that is wrong (incl. follow-ups);
# found = a failing check on one of the wrong figures (Claude may encode a discount as its own line, so
# the error shows up on the discount instead of the item); any other failing check is a false alarm.
def doc_of(c): return str(c.get('document', '')).lstrip('-')     # a credit note may be sent negative
MORE = os.path.join(S, 'more.json')
if os.path.exists(MORE):
    for name, m in json.load(open(MORE, encoding='utf-8')).items():
        w = {x.lstrip('-') for x in m['wrong']}
        CASES[name] = dict(files=m['files'], prompt=m.get('prompt'), text=m.get('text'), key=m['key'],
                           expect=(lambda w: lambda f: any(doc_of(c) in w for c in f))(w), wrong=w)
# Public documents (fuzz/public/ferd, FeRD ZUGFeRD samples, Apache-2.0 corpus; not committed). They add up -
# except where the XML itself says the amount payable differs from the grand total (Kraftfahrversicherung:
# gross 220.00, payable 440.00): then that figure must be reported. Key = the amount payable.
TRUTH = os.path.join(os.path.dirname(__file__), 'public', 'ferd', 'truth.json')
if DE and os.path.exists(TRUTH):
    for n, m in json.load(open(TRUTH, encoding='utf-8')).items():
        odd = {m['due'].lstrip('-')} if m['due'] != m['grand'] and m['allowances'] == '0.00' else set()
        CASES['P-' + n] = dict(files=[os.path.join(os.path.dirname(TRUTH), n + '.pdf')], prompt='check_invoice',
                               expect=(lambda odd: (lambda f: any(doc_of(c) in odd for c in f)) if odd else (lambda f: not f))(odd),
                               wrong=odd, key=m['due'].lstrip('-'))
# Practice documents (fuzz/public/practice, sample bills published by utilities/banks; internal only).
# first = the figure that is really wrong in the document (None: it adds up - any failing check is a false alarm).
PRACTICE = os.path.join(os.path.dirname(__file__), 'public', 'practice', 'practice.json')
if DE and os.path.exists(PRACTICE):
    for n, m in json.load(open(PRACTICE, encoding='utf-8')).items():
        CASES[n] = dict(files=[os.path.join(os.path.dirname(PRACTICE), f) for f in m['files']], prompt=m.get('prompt'), text=m.get('text'),
                        expect=(lambda first: (lambda f: not f) if first is None else
                                (lambda f: any(str(c.get('document', '')).lstrip('-') == first for c in f)))(m['first']),
                        wrong=set(m['wrong']), key=m['key'])
EXPECTED_KINDS = {'V1-invoice': ('line', 'tax', 'discount', 'total'), 'V4-receipts': ('tax',), 'V4-claim': ('total',),
                  'V5-statement': ('subtotal', 'total'), 'V6-daybook': ('row', 'net column', 'total'), 'V8-travel': ('line', 'total')}

cfg = {'mcpServers': {'deskcalc-verify': {'command': 'node', 'args': [os.path.join(ROOT, 'dist', 'server.js')],
       'env': {'DESKCALC_PATH': fv.EXE, 'DESKCALC_EXTRA_ARGS': '/probe'}}}}
cfgfile = os.path.join(tempfile.gettempdir(), 'dcv_matrix_mcp.json')
json.dump(cfg, open(cfgfile, 'w'))
TOOLS = ['mcp__deskcalc-verify__verify_numbers', 'mcp__deskcalc-verify__get_verification',
         'mcp__deskcalc-verify__compare_verifications', 'Read']

# Screenshots: before each Confirm the DeskCalc window is saved twice (top and end of the tapes)
# to fuzz/shots/<date>-<lang>/<sample>/run<N>-<k>-top.png / -end.png, so a result can be traced.
import ctypes, ctypes.wintypes as wt, time, threading
from PIL import ImageGrab
user32 = ctypes.windll.user32; user32.SetProcessDPIAware()
SHOTS = os.path.join(os.path.dirname(__file__), 'shots', f"{datetime.date.today().isoformat()}-{LANG}")

def grids(main):
    found = []
    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def cb(h, _):
        n = ctypes.create_string_buffer(64); user32.GetClassNameA(h, n, 64)
        if n.value == b'MFCGridCtrl' and user32.IsWindowVisible(h): found.append(h)
        return True
    user32.EnumChildWindows(main, cb, 0)
    return found

class ShotClicker(threading.Thread):
    daemon = True
    def __init__(self):
        super().__init__(); self.stop = False; self.prefix = None; self.n = 0
    def shot(self, main, tag):
        # PrintWindow lets DeskCalc draw itself into a bitmap: works when the window is covered or the
        # screen is locked/off (a screen grab is then black). PW_RENDERFULLCONTENT = 2.
        gdi32 = ctypes.windll.gdi32
        r = wt.RECT(); user32.GetWindowRect(main, ctypes.byref(r))
        w, h = r.right - r.left, r.bottom - r.top
        hdc = user32.GetWindowDC(main); mem = gdi32.CreateCompatibleDC(hdc)
        bmp = gdi32.CreateCompatibleBitmap(hdc, w, h); gdi32.SelectObject(mem, bmp)
        user32.PrintWindow(main, mem, 2)
        class BMI(ctypes.Structure):
            _fields_ = [('biSize', ctypes.c_uint32), ('biWidth', ctypes.c_int32), ('biHeight', ctypes.c_int32), ('biPlanes', ctypes.c_uint16),
                        ('biBitCount', ctypes.c_uint16), ('biCompression', ctypes.c_uint32), ('rest', ctypes.c_uint32 * 6)]
        bi = BMI(); bi.biSize = 40; bi.biWidth = w; bi.biHeight = -h; bi.biPlanes = 1; bi.biBitCount = 32
        buf = ctypes.create_string_buffer(w * h * 4)
        gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)
        gdi32.DeleteObject(bmp); gdi32.DeleteDC(mem); user32.ReleaseDC(main, hdc)
        from PIL import Image
        os.makedirs(os.path.dirname(self.prefix), exist_ok=True)
        img = Image.frombuffer('RGB', (w, h), buf, 'raw', 'BGRX', 0, 1)
        # PrintWindow draws unscaled: cut the black rest
        img.crop(img.getbbox() or (0, 0, w, h)).save(f'{self.prefix}-{self.n}-{tag}.png')
    def run(self):
        while not self.stop:
            bar = user32.FindWindowA(None, b'DeskCalc Verify')
            if bar:
                time.sleep(1.2)                              # let DeskCalc draw both tapes
                btn = user32.FindWindowExA(bar, None, b'Button', None)
                if btn:
                    if self.prefix:
                        try:
                            main = user32.GetWindow(bar, 4)  # the DeskCalc window that owns the bar
                            user32.SetForegroundWindow(main); time.sleep(0.3)
                            self.n += 1
                            for g in grids(main): user32.SendMessageA(g, 0x0115, 6, 0)     # top
                            time.sleep(0.4); self.shot(main, 'top')
                            for g in grids(main): user32.SendMessageA(g, 0x0115, 7, 0)     # end
                            time.sleep(0.4); self.shot(main, 'end')
                        except Exception as e:
                            print('  screenshot failed:', e, flush=True)
                    user32.SendMessageA(btn, 0x00F5, 0, 0)  # BM_CLICK = Confirm
                    time.sleep(0.5)
            time.sleep(0.15)

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
        if 'wrong' in case:
            false = [c['check'] for c in f if str(c.get('document', '')).lstrip('-') not in case['wrong'] and not c.get('follows')]
        else:
            kinds = EXPECTED_KINDS[name]
            false = [c['check'] for c in f if not c.get('follows') and not any(c['check'].startswith(k) for k in kinds)]
    printed = any(any(it.get('value') is not None and (it.get('type') in ('tax', 'percent', 'subtotal') or 'qty' in it or 'net' in it or 'foreign' in it)
                      for it in a.get('items', [])) or a.get('expected_total') is not None for a in sent)
    return dict(calls=len(sent), printed=printed, found=found, false=false, sent=sent,
                failing=[{k: c.get(k) for k in ('check', 'document', 'deskcalc', 'difference', 'follows')} for c in f],
                answer_key=any(case['key'] in x for x in (answer, answer.replace(',', '.'), answer.replace(',', ''),
                                                    answer.replace('.', '').replace(',', '.'))), answer=answer)

clicker = ShotClicker(); clicker.start()
rows, raw = [], {}
try:
    for name, case in CASES.items():
        if ONLY and name not in ONLY: continue
        raw[name] = []
        for i in range(RUNS):
            clicker.prefix, clicker.n = os.path.join(SHOTS, name, f'run{i + 1}'), 0
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
# a run of selected samples gets its own file - it must not overwrite the full matrix of the day
sub = '-subset-' + datetime.datetime.now().strftime('%H%M') if ONLY else ''
out = os.path.join(os.path.dirname(__file__), f'matrix-{stamp}-{LANG}{sub}')
open(out + '.md', 'w', encoding='utf-8').write('\n'.join(md) + '\n')
json.dump(raw, open(out + '.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('\n'.join(md)); print('->', out + '.md')
