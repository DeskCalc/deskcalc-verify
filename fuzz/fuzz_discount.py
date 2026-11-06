"""Random comparison: position discount (V10) against Python's Decimal.

    python fuzz/fuzz_discount.py [n] [seed]
For random qty, unit price and discount %, the server's discount line plus the rounded
qty x price must give the line total an invoice prints: round(qty x price x (1 - d/100), 2),
half away from zero. Reports every mismatch; exit code 1 if there is one.
"""
import json, os, random, subprocess, sys, tempfile
from decimal import Decimal, ROUND_HALF_UP

n = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
seed = int(sys.argv[2]) if len(sys.argv) > 2 else 1
rnd = random.Random(seed)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

cases = []
for _ in range(n):
    qty = str(rnd.choice([rnd.randint(1, 50), round(rnd.uniform(0.1, 999), rnd.choice([1, 2, 3]))]))
    price = f'{rnd.uniform(0.01, 5000):.{rnd.choice([2, 2, 3, 4])}f}'
    if rnd.random() < 0.1: price = '-' + price          # credit note
    disc = rnd.choice([str(rnd.randint(1, 100)), f'{rnd.uniform(0.1, 99.9):.1f}', f'{rnd.uniform(0.01, 99.99):.2f}'])
    cases.append((qty, price, disc))

js = """
const { decimalMul, decimalSum, roundCents, positionDiscount } = await import(process.argv[1]);
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(JSON.stringify(cases.map(([q, p, d]) => { const v = decimalMul(q, p); return roundCents(decimalSum([roundCents(v), positionDiscount(v, d)])); })));
"""
# The server ships as one bundle; bundle src/protocol.ts on its own for this test.
mod = os.path.join(tempfile.mkdtemp(), 'protocol.mjs')
subprocess.run([os.path.join(ROOT, 'node_modules', '.bin', 'esbuild.cmd' if os.name == 'nt' else 'esbuild'),
                os.path.join(ROOT, 'src', 'protocol.ts'), '--bundle', '--format=esm', '--platform=node',
                '--log-level=error', f'--outfile={mod}'], check=True)
url = 'file:///' + mod.replace('\\', '/')
out = subprocess.run(['node', '--input-type=commonjs', '-e', f'(async()=>{{{js}}})()', url],
                     input=json.dumps(cases), capture_output=True, text=True, check=True).stdout
got = json.loads(out)

def ref(q, p, d):
    x = Decimal(q) * Decimal(p) * (Decimal(1) - Decimal(d) / Decimal(100))
    return str(x.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))   # half away from zero

bad = [(c, g, ref(*c)) for c, g in zip(cases, got) if Decimal(g) != Decimal(ref(*c))]
for c, g, r in bad[:20]: print('MISMATCH qty=%s price=%s disc=%s server=%s reference=%s' % (*c, g, r))
print(f'{n} cases, seed {seed}: {len(bad)} mismatch(es)')
sys.exit(1 if bad else 0)
