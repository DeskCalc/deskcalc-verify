"""
fuzz_verify.py - differential test: random invoices through the REAL DeskCalc.

For each case: generate a random invoice, compute an independent exact
reference (Python Decimal), send it via MCP (dist/server.js) to DeskCalc
(/verify, probe mode), press Confirm automatically, then compare:

  A  DeskCalc total and every tax/percent amount == exact reference
  B  DeskCalc's total == sum of its own lines (internal consistency)
  C  status confirmed, no corrections (nobody edited)
  D  document check: correct documents pass (exact or invoice rounding);
     a deliberately mis-printed figure is reported as not ok

Usage (PowerShell, from the repo root, after `npm run build`):
  python -I fuzz\\fuzz_verify.py --cases 200 --seed 1
Writes fuzz\\report-<seed>.md and fuzz\\failures-<seed>.json (cases to replay).
"""
import argparse, ctypes, json, os, random, subprocess, sys, threading, time
from ctypes import wintypes
from decimal import Decimal as D, ROUND_HALF_UP, getcontext

getcontext().prec = 60
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.environ.get('DESKCALC_PATH', r'D:\Projects\DeskCalc10.5.claude\Release\deskcalc.exe')
CENT = D('0.01')
r2 = lambda x: x.quantize(CENT, ROUND_HALF_UP)

# ------------------------------------------------------------------ generator

TAX_RATES = ['19', '7', '20', '10', '13', '5', '16', '8.1', '2.5']
DISCOUNTS = ['-2', '-3', '-5', '-10', '-12.5', '-0.5']
SURCHARGES = ['5', '2.5', '10']

def money(rng, lo=0.01, hi=500.0, decimals=2):
    return D(str(round(rng.uniform(lo, hi), decimals))).quantize(D(1).scaleb(-decimals))

def gen_positions(rng, count, start=1):
    items = []
    for i in range(count):
        label = f'Pos.{start + i}'
        if rng.random() < 0.5:
            dec = 2 if rng.random() < 0.8 else rng.choice([3, 4])
            items.append({'label': label, 'qty': rng.choice([1, 2, 3, 5, 12, 0.5, 2.25]), 'price': str(money(rng, 0.01, 300, dec))})
        else:
            items.append({'label': label, 'value': str(money(rng))})
    return items

def gen_mixed(rng, n):
    """Mixed tax rates: one group per rate (DeskCalc block + GT)."""
    rates = rng.sample(TAX_RATES, rng.choice([2, 2, 3]))
    items, k = [], 1
    for r in rates:
        items.append({'type': 'group', 'label': f'{r} %'})
        pos = gen_positions(rng, rng.randint(1, 4), k); k += len(pos)
        items += pos
        if rng.random() < 0.2:
            items.append({'type': 'percent', 'rate': rng.choice(DISCOUNTS), 'label': 'Rabatt'})
        items.append({'type': 'tax', 'rate': r, 'label': f'USt {r} %'})
    return {'title': f'Fuzz {n} gemischt', 'items': items}

def gen_case(rng, n):
    """Random invoice: positions, optional discount, one tax (excl/incl), optional skonto."""
    if rng.random() < 0.3:
        return gen_mixed(rng, n)
    items = []
    for i in range(rng.randint(1, 7)):
        kind = rng.random()
        label = f'Pos.{i + 1}'
        if kind < 0.45:
            dec = 2 if rng.random() < 0.8 else rng.choice([3, 4])      # fuel/kWh prices have 3-4 decimals
            items.append({'label': label, 'qty': rng.choice([1, 2, 3, 4, 5, 10, 12, 15, 25, 0.5, 1.5, 2.25]),
                          'price': str(money(rng, 0.01, 300, dec))})
        elif kind < 0.92:
            items.append({'label': label, 'value': str(money(rng))})
        else:
            items.append({'label': label + ' Gutschrift', 'value': str(-money(rng, 0.01, 80))})
    incl = rng.random() < 0.25
    if not incl and rng.random() < 0.35:
        items.append({'type': 'percent', 'rate': rng.choice(DISCOUNTS + SURCHARGES[:1]), 'label': 'Rabatt'})
    items.append({'type': 'tax', 'rate': rng.choice(TAX_RATES), 'included': incl, 'label': 'USt'})
    if not incl and rng.random() < 0.25:
        items.append({'type': 'percent', 'rate': rng.choice(['-2', '-3']), 'label': 'Skonto'})
    return {'title': f'Fuzz {n}', 'items': items}

# ------------------------------------------------------------------ reference

def reference(case):
    """Exact amounts per line (as DeskCalc should compute) and the invoice's printed
    figures (every line and every tax/discount rounded to the cent, as invoices do)."""
    run, doc = D(0), D(0)
    exact, printed = [], []
    runs, docs = [], []
    for it in case['items']:
        if it.get('type') == 'group':
            if exact:                       # close the previous block
                runs.append(run); docs.append(doc); run, doc = D(0), D(0)
            exact.append(None); printed.append(None)
            continue
        if it.get('type') == 'tax':
            r = D(it['rate'])
            if it.get('included'):
                amt, pamt = -(run - run / (1 + r / 100)), -r2(doc - doc / (1 + r / 100))
            else:
                amt, pamt = run * r / 100, r2(doc * r / 100)
        elif it.get('type') == 'percent':
            amt, pamt = run * D(it['rate']) / 100, r2(doc * D(it['rate']) / 100)
        elif 'qty' in it:
            amt = D(str(it['qty'])) * D(it['price'])
            pamt = r2(amt)
        else:
            amt = pamt = D(it['value'])
        exact.append(amt); printed.append(pamt)
        run += amt; doc += pamt
    runs.append(run); docs.append(doc)
    run, doc = sum(runs, D(0)), sum(docs, D(0))              # several blocks: sum of blocks
    incl = [p for it, p in zip(case['items'], printed) if it.get('type') == 'tax' and it.get('included')]
    incl_x = [e for it, e in zip(case['items'], exact) if it.get('type') == 'tax' and it.get('included')]
    doc_total = doc + sum((-p for p in incl), D(0))          # gross for included tax
    exact_gross = run + sum((-e for e in incl_x), D(0))
    # group markers are structure: DeskCalc returns no line for them
    keep = [i for i, it in enumerate(case['items']) if it.get('type') != 'group']
    return {'exact': [exact[i] for i in keep], 'exact_total': run, 'printed': printed, 'doc_total': doc_total,
            'exact_gross': exact_gross, 'keep': keep}

def with_printed(case, ref, rng):
    """Attach printed figures; sometimes mis-print one of them (must be reported)."""
    c = json.loads(json.dumps(case))
    for it, p in zip(c['items'], ref['printed']):
        if p is not None and ('qty' in it or it.get('type') in ('tax', 'percent')):
            it['value'] = str(p)
    c['expected_total'] = str(r2(ref['doc_total']))
    c['wait_seconds'] = 30
    wrong = None
    if rng.random() < 0.3:
        targets = [i for i, it in enumerate(c['items']) if 'value' in it and ('qty' in it or it.get('type') in ('tax', 'percent'))] + ['total']
        t = rng.choice(targets)
        delta = rng.choice(['0.01', '-0.01', '0.10', '1.00', '-2.50'])
        if t == 'total':
            new = D(c['expected_total']) + D(delta)
            c['expected_total'] = str(new)
            valid = {r2(ref['exact_gross']), r2(ref['doc_total'])}
        else:
            v = D(c['items'][t]['value'])
            new = v + D(delta) if v >= 0 else v - D(delta)
            c['items'][t]['value'] = str(new)
            ex = ref['exact'][ref['keep'].index(t)]
            valid = {abs(r2(ex)), abs(ref['printed'][t])}
        # A mis-print that equals another valid way of computing (exact vs. rounded
        # per step) cannot be told apart from a correct document.
        wrong = {'target': t, 'delta': delta, 'ambiguous': abs(new) in valid}
    return c, wrong

# ------------------------------------------------------------------ MCP client (stdio, newline JSON)

class Mcp:
    def __init__(self):
        env = dict(os.environ, DESKCALC_PATH=EXE, DESKCALC_EXTRA_ARGS='/probe')
        self.p = subprocess.Popen(['node', os.path.join(ROOT, 'dist', 'server.js')], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True, encoding='utf-8')
        self.n = 0
        self.call('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'fuzz', 'version': '1'}})
        self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})

    def send(self, msg):
        self.p.stdin.write(json.dumps(msg) + '\n'); self.p.stdin.flush()

    def call(self, method, params):
        self.n += 1
        self.send({'jsonrpc': '2.0', 'id': self.n, 'method': method, 'params': params})
        while True:
            line = self.p.stdout.readline()
            if not line: raise RuntimeError('server closed')
            msg = json.loads(line)
            if msg.get('id') == self.n:
                if 'error' in msg: raise RuntimeError(msg['error'])
                return msg['result']

    def tool(self, name, args):
        return self.call('tools/call', {'name': name, 'arguments': args}).get('structuredContent')

    def close(self):
        self.p.stdin.close(); self.p.wait(5)

# ------------------------------------------------------------------ auto-confirm

user32 = ctypes.windll.user32
user32.FindWindowA.restype = wintypes.HWND
user32.FindWindowExA.restype = wintypes.HWND
BM_CLICK = 0x00F5

class Clicker(threading.Thread):
    """Presses Confirm on every DeskCalc Verify bar that appears."""
    daemon = True
    def __init__(self):
        super().__init__(); self.stop = False; self.clicks = 0
    def run(self):
        while not self.stop:
            bar = user32.FindWindowA(None, b'DeskCalc Verify')
            if bar:
                time.sleep(0.3)
                btn = user32.FindWindowExA(bar, None, b'Button', None)
                if btn:
                    user32.SendMessageA(btn, BM_CLICK, 0, 0); self.clicks += 1
                    time.sleep(0.5)
            time.sleep(0.15)

def restart_probe():
    subprocess.run([EXE, 'kill', '/probe'], timeout=30)
    time.sleep(1.5)

# ------------------------------------------------------------------ compare

def close(a, b, rel=D('1e-9')):
    a, b = D(str(a)), D(str(b))
    return abs(a - b) <= rel * max(D(1), abs(b))

def evaluate(case, ref, res, wrong):
    errs = []
    if res.get('status') != 'confirmed':
        return [f"status {res.get('status')}: {res.get('message', '')[:160]}"]
    lines = res['lines']
    n_lines = len([it for it in case['items'] if it.get('type') != 'group'])
    if len(lines) != n_lines:
        errs.append(f'{len(lines)} lines back, {n_lines} sent')
    if res.get('gt_outdated'):
        errs.append('E GT reported outdated although nobody edited')
    for i, (l, e) in enumerate(zip(lines, ref['exact'])):
        # tax/percent amounts are computed from DeskCalc's subtotal (exact to ~1e-6)
        if (abs(D(str(l['value'])) - e) > D('0.000002')) if l.get('type') else not close(l['value'], e):
            errs.append(f'A line {i + 1} ({l.get("type") or "pos"}): DeskCalc {l["value"]} != exact {e}')
    # DeskCalc evaluates the tape as a text expression with 6 decimals per number,
    # so its total is exact to ~1e-6 only (irrelevant for cents; core left unchanged).
    TOL = D('0.000002')
    if abs(D(str(res['total'])) - ref['exact_total']) > TOL:
        errs.append(f'A total: DeskCalc {res["total"]} != exact {ref["exact_total"]}')
    s = sum((D(str(l['value'])) for l in lines), D(0))
    if abs(s - D(str(res['total']))) > TOL:
        errs.append(f'B DeskCalc lines sum {s} != DeskCalc total {res["total"]}')
    if res.get('corrections'):
        errs.append(f'C unexpected corrections {res["corrections"]}')
    checks = (res.get('document_check') or {}).get('checks', [])
    bad = [c for c in checks if not c['ok']]
    if wrong is None and bad:
        errs.append('D correct document flagged: ' + '; '.join(f"{c['check']} doc {c['document']} dc {c['deskcalc']}" for c in bad))
    if wrong is not None and not wrong.get('ambiguous') and not bad:
        errs.append(f'D mis-print not detected: {wrong}')
    return errs

# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cases', type=int, default=100)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--replay', help='failures-*.json to replay')
    a = ap.parse_args()
    rng = random.Random(a.seed)
    if a.replay:
        cases = json.load(open(a.replay, encoding='utf-8'))
    else:
        cases = []
        for n in range(1, a.cases + 1):
            case = gen_case(rng, n)
            ref = reference(case)
            c, wrong = with_printed(case, ref, rng)
            cases.append({'n': n, 'base': case, 'call': c, 'wrong': wrong})

    restart_probe()
    clicker = Clicker(); clicker.start()
    mcp = Mcp()
    failures, done, t0 = [], 0, time.time()
    try:
        for k, cs in enumerate(cases):
            if k and k % 8 == 0: restart_probe()          # DeskCalc keeps max. 10 tapes open
            ref = reference(cs['base'])
            res = mcp.tool('verify_numbers', cs['call'])
            if res.get('status') == 'no_free_tab':
                restart_probe(); res = mcp.tool('verify_numbers', cs['call'])
            errs = evaluate(cs['base'], ref, res, cs['wrong'])
            done += 1
            if errs:
                failures.append({**cs, 'errors': errs, 'result': res})
                print(f"#{cs['n']:4} FAIL  " + ' | '.join(errs)[:300], flush=True)
            elif done % 10 == 0:
                print(f'{done}/{len(cases)} ok ({time.time() - t0:.0f} s)', flush=True)
    finally:
        clicker.stop = True
        mcp.close()
        restart_probe()

    here = os.path.dirname(os.path.abspath(__file__))
    tag = f'replay' if a.replay else f'seed{a.seed}'
    json.dump(failures, open(os.path.join(here, f'failures-{tag}.json'), 'w', encoding='utf-8'), indent=2, default=str)
    with open(os.path.join(here, f'report-{tag}.md'), 'w', encoding='utf-8') as f:
        f.write(f'# Fuzz report {tag}\n\n{done} cases, {len(failures)} failures, {time.time() - t0:.0f} s, '
                f'{clicker.clicks} confirms.\n\n')
        cats = {}
        for fl in failures:
            for e in fl['errors']: cats.setdefault(e.split(' ')[0], []).append(fl['n'])
        for c, ns in sorted(cats.items()): f.write(f'- **{c}**: {len(ns)} case(s): {ns[:20]}\n')
        for fl in failures[:40]:
            f.write(f"\n## Case {fl['n']}\n\n```json\n{json.dumps(fl['call'], indent=1)}\n```\n\n")
            for e in fl['errors']: f.write(f'- {e}\n')
    print(f'\n{done} cases, {len(failures)} failures -> fuzz\\report-{tag}.md')

if __name__ == '__main__':
    main()
