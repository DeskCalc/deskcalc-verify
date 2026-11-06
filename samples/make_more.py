r"""More sample documents for DeskCalc Verify (V9-V13), German and English.

New document types for the Claude test matrix (plan 09.5 §7):
  V9  credit note            - VAT misprinted, total follows
  V10 two VAT rates          - per-line discount misprinted on one line (5 % instead of 10 %)
  V11 early payment discount - Skonto amount misprinted, amount payable follows
  V12 till receipt as photo  - JPG, slightly rotated and noisy; one line misprinted
  V13 two-page invoice       - carry-over misprinted, totals follow

All companies and people are made up. Amounts are computed with Decimal.
Besides the PDFs/JPG and Lösung.txt / Solution.txt it writes samples/<lang>/more.json
for fuzz/claude_matrix.py: per document the files, the prompt, the FIRST wrong printed
figure (must be found), ALL wrong printed figures (follow-ups are no false alarm) and the
key figure the answer should name.

    python samples/make_more.py
Needs PyMuPDF and Pillow.
"""
import io, json, os, random, sys
from decimal import Decimal as D, ROUND_HALF_UP
import fitz
from PIL import Image, ImageFilter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_samples import Maker, A4, r2, swap

def p2(x): return f'{r2(x):.2f}'          # how the server reports a document figure


class More(Maker):
    def __init__(self, lang, out):
        super().__init__(lang, out)
        self.de = lang == 'de'
        self.cases = {}

    def L(self, de, en): return de if self.de else en

    def case(self, name, folder, files, first, wrong, key, prompt='check_invoice', text=None):
        self.cases[name] = dict(files=[f'{folder}/{f}' for f in files], prompt=prompt, text=text,
                                first=p2(first), wrong=sorted({p2(w) for w in wrong}), key=p2(key))

    # A simple invoice page laid out with fixed positions (like V1).
    def invoice(self, pg, sup, addr, title, no, meta, cols, rows, sums, cur, y0=215, header=True, foot=None):
        A = self.amt
        X0, X1 = 48, A4.width - 48
        INK, SOFT, BLUE, LINE = (0.13, 0.13, 0.13), (0.4, 0.4, 0.4), (0.12, 0.31, 0.47), (0.8, 0.8, 0.8)
        def txt(x, y, t, size=9.5, font='helv', color=INK, right=False):
            if right: x -= fitz.get_text_length(t, fontname=font, fontsize=size)
            pg.insert_text((x, y), t, fontsize=size, fontname=font, color=color)
        def line(y, w=0.6, color=LINE, x0=X0, x1=X1): pg.draw_line((x0, y), (x1, y), color=color, width=w)
        if header:
            txt(X0, 72, sup, 17, 'hebo', BLUE); txt(X0, 88, addr, 8.5, color=SOFT)
            txt(X1, 74, title.upper(), 22, 'hebo', right=True); txt(X1, 92, no, 10, 'hebo', right=True)
            line(114, 1.2, BLUE)
            txt(X0, 136, self.L('Rechnung an', 'Bill to'), 8, color=SOFT)
            for i, part in enumerate(self.t['firm'].split(', ')): txt(X0, 150 + i * 13, part, 10)
            for i, (k, v) in enumerate(meta):
                txt(330, 136 + i * 14, k, 8.5, color=SOFT); txt(X1, 136 + i * 14, v, 9.5, right=True)
        else:
            txt(X0, 72, f'{sup} - {title} {no}', 11, 'hebo', BLUE); line(80, 1.0, BLUE)
        xs = cols['x']; y = y0
        for (label, x, right) in zip(cols['names'], xs, cols['right']):
            txt(x, y, label, 8.5, 'hebo', right=right)
        line(y + 6, 0.9, INK); y += 22
        for r in rows:
            if r.get('bold'):
                txt(xs[1], y, r['cells'][1], 9.5, 'hebo'); txt(xs[-1], y, r['cells'][-1], 9.5, 'hebo', right=True)
            else:
                for c, x, right in zip(r['cells'], xs, cols['right']): txt(x, y, c, right=right)
            line(y + 7); y += 19
        y += 6
        for label, v, strong in sums:
            if strong:
                line(y - 12, 0.9, INK, 300); txt(300, y + 2, label, 11, 'hebo'); txt(X1, y + 2, f'{cur} {v}', 11, 'hebo', right=True); y += 22
            else:
                txt(300, y, label); txt(X1, y, v, right=True); y += 17
        if foot:
            for i, part in enumerate(foot): txt(X0, y + 24 + i * 12, part, 8.5, color=SOFT)
        txt(A4.width / 2 - fitz.get_text_length(self.t['sample'], fontname='helv', fontsize=7.5) / 2, A4.height - 30,
            self.t['sample'], 7.5, color=SOFT)

    def cols5(self):
        return dict(names=self.L(['Pos.', 'Artikel', 'Menge', 'Einzelpreis', 'Betrag'], ['Item', 'Description', 'Qty', 'Unit price', 'Amount']),
                    x=[48, 82, 360, 440, A4.width - 48], right=[False, False, True, True, True])

    SUP = dict(de=('Muster Büroausstattung GmbH', 'Gewerbepark 7, 8010 Graz - UID ATU00000000 (Muster)'),
               en=('Example Stationery Ltd', '7 Trade Park, Sampleford SF2 7XX - VAT reg. GB 000 0000 00 (sample)'))

    # ------------------------------------------------------------ V9 credit note
    def v9(self):
        A, de = self.amt, self.de
        folder = self.L('V9 Gutschrift', 'V9 Credit note')
        file = self.L('Gutschrift GS-2026-0318.pdf', 'Credit note CN-2026-0318.pdf')
        items = [(self.L('Toner schwarz TX-200', 'Toner cartridge black TX-200'), 1, D('89.90')),
                 (self.L('Ordner breit, blau', 'Lever arch files, blue'), 5, D('2.35')),
                 (self.L('Haftnotizen 76x76, 12er-Pack', 'Sticky notes 76x76, pack of 12'), 2, D('7.45'))]
        net = sum(r2(q * p) for _, q, p in items); vat = r2(net * D('0.2')); vat_p = swap(vat, cents=True)
        tot, tot_p = net + vat, net + vat_p
        cur = self.L('EUR', 'GBP')
        doc = fitz.open(); pg = doc.new_page(width=A4.width, height=A4.height)
        sup, addr = self.SUP[self.lang]
        rows = [dict(cells=[str(i + 1), n, str(q), A(p), A(r2(q * p))]) for i, (n, q, p) in enumerate(items)]
        self.invoice(pg, sup, addr, self.L('Gutschrift', 'Credit note'), self.L('GS-2026-0318', 'CN-2026-0318'),
                     self.L([('Datum', '05.11.2026'), ('zu Rechnung', 'RE-2026-2041'), ('Grund', 'Rücksendung')],
                            [('Date', '05/11/2026'), ('Re invoice', 'INV-2026-2041'), ('Reason', 'Goods returned')]),
                     self.cols5(), rows,
                     [(self.L('Summe netto', 'Net total'), A(net), False), (self.L('zuzüglich 20 % USt', 'VAT 20 %'), A(vat_p), False),
                      (self.L('Gutschriftsbetrag', 'Total credit'), A(tot_p), True)], cur,
                     foot=[self.L('Der Betrag wird Ihrem Kundenkonto K-10457 gutgeschrieben.', 'The amount is credited to your account C-10457.')])
        self.save(doc, os.path.join(self.out, folder), file)
        self.write(os.path.join(self.out, folder), self.t['sol'], self.L(
            f"""V9 Gutschrift - Musterlösung

"{file}" anhängen, Prompt "Check an invoice".
Gutschrift = Rechnung mit umgekehrtem Vorzeichen; Claude darf positiv oder negativ schicken.
Fehler: USt gedruckt {A(vat_p)}, richtig 20 % von {A(net)} = {A(vat)} (Zahlendreher in den Cent).
Gutschriftsbetrag gedruckt {A(tot_p)}, richtig {A(tot)} - Folgefehler.""",
            f"""V9 Credit note - solution

Attach "{file}", prompt "Check an invoice".
A credit note is an invoice with the sign reversed; the AI may send positive or negative amounts.
Error: VAT printed {A(vat_p)}, correct 20 % of {A(net)} = {A(vat)} (transposed pence).
Total credit printed {A(tot_p)}, correct {A(tot)} - follows from the VAT."""))
        self.case('V9-credit-note', folder, [file], vat_p, [vat_p, tot_p], vat)

    # ------------------------------------------------------------ V10 two VAT rates, per-line discount
    def v10(self):
        A = self.amt
        folder = self.L('V10 Zwei Steuersaetze', 'V10 Two VAT rates')
        file = self.L('Rechnung RE-2026-2077.pdf', 'Invoice INV-2026-2077.pdf')
        lo = 10 if self.de else 5
        items = [(self.L('Fachbuch Steuerrecht 2026', 'Child car seat K-200'), 2, D('48.00'), lo, 0),
                 (self.L('Fachzeitschrift Jahresabo', 'Child booster cushion'), 1, D('129.00'), lo, 0),
                 (self.L('Druckerpapier A4, Karton', 'Printer paper A4, box'), 10, D('4.90'), 20, 10),
                 (self.L('USB-Stick 64 GB', 'USB stick 64 GB'), 6, D('12.90'), 20, 10),
                 (self.L('Schreibtischlampe LED', 'LED desk lamp'), 1, D('59.90'), 20, 0)]
        rows, net, net_p = [], {lo: D(0), 20: D(0)}, {lo: D(0), 20: D(0)}
        for i, (n, q, p, rate, disc) in enumerate(items):
            a = r2(q * p * (1 - D(disc) / 100))
            ap = r2(q * p * D('0.95')) if i == 3 else a           # error: 5 % taken off instead of 10 %
            net[rate] += a; net_p[rate] += ap
            rows.append((n, q, p, rate, disc, a, ap))
        vat = {k: r2(v * k / 100) for k, v in net.items()}; vat_p = {k: r2(v * k / 100) for k, v in net_p.items()}
        tot = sum(net.values()) + sum(vat.values()); tot_p = sum(net_p.values()) + sum(vat_p.values())
        cur = self.L('EUR', 'GBP')
        cols = dict(names=self.L(['Pos.', 'Artikel', 'Menge', 'Preis', 'Rabatt', 'USt', 'Betrag'],
                                 ['Item', 'Description', 'Qty', 'Price', 'Disc.', 'VAT', 'Amount']),
                    x=[48, 76, 300, 360, 410, 450, A4.width - 48], right=[False, False, True, True, True, True, True])
        trows = [dict(cells=[str(i + 1), n, str(q), A(p), f'{d} %' if d else '', f'{r} %', A(ap)])
                 for i, (n, q, p, r, d, a, ap) in enumerate(rows)]
        sums = [(self.L(f'Netto {lo} %', f'Net {lo} %'), A(net_p[lo]), False), (self.L(f'USt {lo} %', f'VAT {lo} %'), A(vat_p[lo]), False),
                (self.L('Netto 20 %', 'Net 20 %'), A(net_p[20]), False), (self.L('USt 20 %', 'VAT 20 %'), A(vat_p[20]), False),
                (self.L('Rechnungsbetrag', 'Total due'), A(tot_p), True)]
        doc = fitz.open(); pg = doc.new_page(width=A4.width, height=A4.height)
        sup, addr = self.SUP[self.lang]
        self.invoice(pg, sup, addr, self.L('Rechnung', 'Invoice'), self.L('RE-2026-2077', 'INV-2026-2077'),
                     self.L([('Rechnungsdatum', '04.11.2026'), ('Kundennummer', 'K-10457')], [('Invoice date', '04/11/2026'), ('Customer no.', 'C-10457')]),
                     cols, trows, sums, cur,
                     foot=[self.L('Rabatt = Positionsrabatt auf Menge x Preis.', 'Disc. = line discount on qty x price.')])
        self.save(doc, os.path.join(self.out, folder), file)
        n4, q4, pr4 = rows[3][0], rows[3][1], rows[3][2]
        self.write(os.path.join(self.out, folder), self.t['sol'], self.L(
            f"""V10 Zwei Steuersätze und Positionsrabatt - Musterlösung

"{file}" anhängen, Prompt "Check an invoice".
Pos. 3 und 4 haben 10 % Positionsrabatt, zwei USt-Sätze ({lo} % und 20 %).
Fehler: Pos. 4 {n4}: {q4} x {A(pr4)} = {A(r2(q4 * pr4))} abzüglich 10 % = {A(rows[3][5])}, gedruckt {A(rows[3][6])} (nur 5 % abgezogen).
Folgefehler: Netto 20 % {A(net_p[20])} statt {A(net[20])}, USt 20 % {A(vat_p[20])} statt {A(vat[20])},
Rechnungsbetrag {A(tot_p)} statt {A(tot)} (Differenz {A(tot_p - tot)}).
{lo}-%-Teil ist richtig (Netto {A(net[lo])}, USt {A(vat[lo])}).""",
            f"""V10 Two VAT rates and a line discount - solution

Attach "{file}", prompt "Check an invoice".
Items 3 and 4 carry a 10 % line discount; two VAT rates ({lo} % and 20 %).
Error: item 4 {n4}: {q4} x {A(pr4)} = {A(r2(q4 * pr4))} less 10 % = {A(rows[3][5])}, printed {A(rows[3][6])} (only 5 % taken off).
Follows: net 20 % {A(net_p[20])} instead of {A(net[20])}, VAT 20 % {A(vat_p[20])} instead of {A(vat[20])},
total due {A(tot_p)} instead of {A(tot)} (difference {A(tot_p - tot)}).
The {lo} % part is correct (net {A(net[lo])}, VAT {A(vat[lo])})."""))
        # Claude may send items 3+4 with ONE 10 % discount line; the discount the printed amounts imply is then the wrong figure
        disc_p = sum(r2(q * p) for _, q, p, _, d, _, _ in rows if d) - sum(ap for *_, d, a, ap in rows if d)
        self.case('V10-two-rates', folder, [file], rows[3][6],
                  [rows[3][6], net_p[20], vat_p[20], tot_p, sum(net_p.values()), sum(net_p.values()) + vat_p[20], disc_p], rows[3][5])

    # ------------------------------------------------------------ V11 early payment discount (Skonto)
    def v11(self):
        A = self.amt
        folder = self.L('V11 Skonto', 'V11 Early payment discount')
        file = self.L('Rechnung RE-2026-2090.pdf', 'Invoice INV-2026-2090.pdf')
        items = [(self.L('Bürostuhl ergonomisch', 'Ergonomic office chair'), 2, D('189.00')),
                 (self.L('Schreibtisch 160x80', 'Desk 160x80'), 1, D('449.00')),
                 (self.L('Rollcontainer', 'Mobile pedestal'), 2, D('129.00')),
                 (self.L('Lieferung und Montage', 'Delivery and assembly'), 1, D('85.00'))]
        net = sum(r2(q * p) for _, q, p in items); vat = r2(net * D('0.2')); gross = net + vat
        sk = r2(gross * D('0.02')); sk_p = swap(sk, cents=True); pay, pay_p = gross - sk, gross - sk_p
        cur = self.L('EUR', 'GBP')
        rows = [dict(cells=[str(i + 1), n, str(q), A(p), A(r2(q * p))]) for i, (n, q, p) in enumerate(items)]
        doc = fitz.open(); pg = doc.new_page(width=A4.width, height=A4.height)
        sup, addr = self.SUP[self.lang]
        self.invoice(pg, sup, addr, self.L('Rechnung', 'Invoice'), self.L('RE-2026-2090', 'INV-2026-2090'),
                     self.L([('Rechnungsdatum', '06.11.2026'), ('Kundennummer', 'K-10457')], [('Invoice date', '06/11/2026'), ('Customer no.', 'C-10457')]),
                     self.cols5(), rows,
                     [(self.L('Summe netto', 'Net total'), A(net), False), (self.L('zuzüglich 20 % USt', 'VAT 20 %'), A(vat), False),
                      (self.L('Rechnungsbetrag', 'Total due'), A(gross), True),
                      (self.L('abzüglich 2 % Skonto bis 16.11.2026', 'Less 2 % if paid by 16/11/2026'), A(-sk_p), False),
                      (self.L('Zahlbetrag bei Skonto', 'Amount payable with discount'), A(pay_p), False)], cur,
                     foot=[self.L('Zahlbar bis 16.11.2026 mit 2 % Skonto vom Rechnungsbetrag oder bis 06.12.2026 ohne Abzug.',
                                  'Payable by 16/11/2026 less 2 % of the total due, or by 06/12/2026 without deduction.')])
        self.save(doc, os.path.join(self.out, folder), file)
        self.write(os.path.join(self.out, folder), self.t['sol'], self.L(
            f"""V11 Skonto - Musterlösung

"{file}" anhängen, Prompt "Check an invoice".
Netto {A(net)}, USt {A(vat)}, Rechnungsbetrag {A(gross)} - richtig.
Fehler: 2 % Skonto von {A(gross)} = {A(sk)}, gedruckt {A(sk_p)} (Zahlendreher).
Zahlbetrag bei Skonto gedruckt {A(pay_p)}, richtig {A(pay)} - Folgefehler.""",
            f"""V11 Early payment discount - solution

Attach "{file}", prompt "Check an invoice".
Net {A(net)}, VAT {A(vat)}, total due {A(gross)} - correct.
Error: 2 % of {A(gross)} = {A(sk)}, printed {A(sk_p)} (transposed digits).
Amount payable with discount printed {A(pay_p)}, correct {A(pay)} - follows."""))
        self.case('V11-skonto', folder, [file], sk_p, [sk_p, pay_p, -sk_p, -pay_p], sk)

    # ------------------------------------------------------------ V12 till receipt as a photo
    def v12(self):
        A = self.amt
        folder = self.L('V12 Kassenzettel Foto', 'V12 Till receipt photo')
        file = self.L('Kassenzettel Nahversorger.jpg', 'Till receipt corner shop.jpg')
        lo = 10 if self.de else 0
        items = [(self.L('Vollmilch 1 l', 'Whole milk 2 pt'), 2, D('1.29'), lo), (self.L('Vollkornbrot', 'Wholemeal bread'), 1, D('3.49'), lo),
                 (self.L('Äpfel 1 kg', 'Apples 1 kg'), 1, D('2.99'), lo), (self.L('Butter 250 g', 'Butter 250 g'), 1, D('2.79'), lo),
                 (self.L('Joghurt Natur', 'Natural yoghurt'), 3, D('0.89'), lo), (self.L('Kaffee 500 g', 'Coffee 500 g'), 1, D('7.99'), lo),
                 (self.L('Mineralwasser 1,5 l', 'Sparkling water 1.5 l'), 6, D('0.49'), 20), (self.L('Spülmittel', 'Washing-up liquid'), 1, D('1.99'), 20),
                 (self.L('Küchenrolle 4er', 'Kitchen roll 4 pack'), 1, D('3.29'), 20), (self.L('Schokolade 100 g', 'Chocolate 100 g'), 3, D('1.49'), 20 if not self.de else lo),
                 (self.L('Nudeln 500 g', 'Pasta 500 g'), 2, D('1.19'), lo), (self.L('Batterien AA 4er', 'AA batteries 4 pack'), 1, D('4.99'), 20)]
        lines = []
        for i, (n, q, p, r) in enumerate(items):
            a = r2(q * p); ap = D('4.77') if i == 9 else a        # error: 3 x 1.49 = 4.47, printed 4.77
            lines.append((n, q, p, r, a, ap))
        tot = sum(l[4] for l in lines); tot_p = sum(l[5] for l in lines)
        grp = {}
        for n, q, p, r, a, ap in lines:
            g = grp.setdefault(r, [D(0), D(0)]); g[0] += a; g[1] += ap
        def split(g, r): v = r2(g - g / (1 + D(r) / 100)); return g, g - v, v
        # receipt laid out on a narrow page in a monospace font, then photographed
        W = 260; doc = fitz.open(); pg = doc.new_page(width=W, height=560)
        y = 30
        def t(s, size=8.2, center=False, bold=False):
            nonlocal y
            font = 'cobo' if bold else 'cour'
            x = (W - fitz.get_text_length(s, fontname=font, fontsize=size)) / 2 if center else 14
            pg.insert_text((x, y), s, fontsize=size, fontname=font); y += size + 3.4
        def lr(l, r, bold=False):
            w = 38; t(l[:w - len(r) - 1].ljust(w - len(r)) + r, bold=bold)
        t(self.L('NAHVERSORGER MUSTER', 'CORNER SHOP SAMPLE'), 10, True, True)
        t(self.L('Dorfplatz 3, 3100 Musterdorf', '3 Village Green, Exampleton'), center=True)
        t(self.L('UID ATU00000000 (Muster)', 'VAT GB 000 0000 00 (sample)'), center=True)
        t(self.L('06.11.2026  17:42  Kasse 2  Bon 4711', '06/11/2026 17:42 till 2 rcpt 4711'), center=True); y += 4
        cur = self.L('EUR', 'GBP'); tag = {lo: 'A', 20: 'B'}
        for n, q, p, r, a, ap in lines:
            lr(n, f'{A(ap)} {tag[r]}')
            if q > 1: t(f'  {q} x {A(p)}')                         # quantity line under its article
        t('-' * 38); lr(self.L('SUMME', 'TOTAL') + f' {cur}', A(tot_p), True); t('-' * 38)
        lr(self.L('Bankomat', 'Card'), A(tot_p)); y += 4
        t(self.L('MwSt     Brutto    Netto   MwSt', 'VAT      Gross     Net    VAT'))
        printed_split = {}
        for r in sorted(grp):
            g, nn, v = split(grp[r][1], r); printed_split[r] = (g, nn, v)
            t(f'{tag[r]} {r:>2}% {A(g):>9} {A(nn):>8} {A(v):>6}')
        y += 6; t(self.L('Danke für Ihren Einkauf!', 'Thank you for shopping!'), center=True)
        t(self.t['sample'], 7, True)
        pg.set_cropbox(fitz.Rect(0, 0, W, y + 12))                   # receipt ends after the last line
        pix = pg.get_pixmap(dpi=170, colorspace=fitz.csGRAY)
        img = Image.frombytes('L', (pix.width, pix.height), pix.samples)
        img = img.point(lambda v: 60 + v * 0.62)                      # thermal paper: grey ink, off-white paper
        img = Image.blend(img, Image.effect_noise(img.size, 40), 0.12)   # sensor noise
        bg = Image.new('L', (img.width + 260, img.height + 220), 92)  # table behind the receipt
        bg.paste(img, (130, 110))
        bg = bg.rotate(-1.4, resample=Image.BICUBIC, fillcolor=92).filter(ImageFilter.GaussianBlur(0.7))
        os.makedirs(os.path.join(self.out, folder), exist_ok=True)
        bg.convert('RGB').save(os.path.join(self.out, folder, file), quality=72)
        doc.close()
        wrong = [D('4.77'), tot_p]
        for r, (g, nn, v) in printed_split.items():
            tg, tn, tv = split(grp[r][0], r)
            if g != tg: wrong += [g, nn, v]
        self.write(os.path.join(self.out, folder), self.t['sol'], self.L(
            f"""V12 Kassenzettel als Foto - Musterlösung

"{file}" (Foto, leicht schräg) anhängen, Prompt "Check an invoice" oder "Add up expense receipts".
12 Positionen, zwei Steuersätze (A {lo} %, B 20 %), Mengenzeilen "3 x 1,49".
Fehler: Schokolade 3 x 1,49 = 4,47, gedruckt 4,77.
SUMME gedruckt {A(tot_p)}, richtig {A(tot)} - Folgefehler; ebenso die MwSt-Zeile des betroffenen Satzes.""",
            f"""V12 Till receipt as a photo - solution

Attach "{file}" (photo, slightly skewed), prompt "Check an invoice" or "Add up expense receipts".
12 lines, two VAT rates (A {lo} %, B 20 %), quantity lines "3 x 1.49".
Error: chocolate 3 x 1.49 = 4.47, printed 4.77.
TOTAL printed {A(tot_p)}, correct {A(tot)} - follows; so does the VAT line of that rate."""))
        self.case('V12-receipt-photo', folder, [file], D('4.77'), wrong, D('4.47'))

    # ------------------------------------------------------------ V13 two-page invoice with carry-over
    def v13(self):
        A = self.amt
        folder = self.L('V13 Uebertrag', 'V13 Carried forward')
        file = self.L('Rechnung RE-2026-2102.pdf', 'Invoice INV-2026-2102.pdf')
        rng = random.Random(13)
        names = self.L(['Patchkabel Cat6 2 m', 'Netzwerkdose 2-fach', 'Switch 8 Port', 'Kabelkanal 2 m', 'Steckdosenleiste 6-fach',
                        'Monitorhalter', 'Dockingstation USB-C', 'Tastatur kabellos', 'Maus kabellos', 'HDMI-Kabel 3 m',
                        'Arbeitsstunde Techniker', 'Fahrtkostenpauschale'],
                       ['Patch cable Cat6 2 m', 'Network socket double', 'Switch 8 port', 'Cable duct 2 m', 'Power strip 6 way',
                        'Monitor arm', 'USB-C docking station', 'Wireless keyboard', 'Wireless mouse', 'HDMI cable 3 m',
                        'Technician hour', 'Call-out charge'])
        items = []
        for i in range(24):
            n = names[i % 10] if i < 22 else names[10 + (i - 22)]
            q = rng.randint(1, 12) if i < 22 else (6 if i == 22 else 1)
            p = r2(D(rng.randint(290, 14900)) / 100) if i < 22 else (D('78.00') if i == 22 else D('45.00'))
            items.append((n, q, p))
        p1, p2_ = items[:14], items[14:]
        cf = sum(r2(q * p) for _, q, p in p1); cf_p = swap(cf)
        net = cf + sum(r2(q * p) for _, q, p in p2_); net_p = cf_p + sum(r2(q * p) for _, q, p in p2_)
        vat, vat_p = r2(net * D('0.2')), r2(net_p * D('0.2')); tot, tot_p = net + vat, net_p + vat_p
        cur = self.L('EUR', 'GBP'); sup, addr = self.SUP[self.lang]
        no = self.L('RE-2026-2102', 'INV-2026-2102'); title = self.L('Rechnung', 'Invoice')
        cfl = self.L('Übertrag', 'Carried forward'); bfl = self.L('Übertrag von Seite 1', 'Brought forward from page 1')
        doc = fitz.open()
        pg = doc.new_page(width=A4.width, height=A4.height)
        rows = [dict(cells=[str(i + 1), n, str(q), A(p), A(r2(q * p))]) for i, (n, q, p) in enumerate(p1)]
        self.invoice(pg, sup, addr, title, no,
                     self.L([('Rechnungsdatum', '05.11.2026'), ('Kundennummer', 'K-10457'), ('Seite', '1 von 2')],
                            [('Invoice date', '05/11/2026'), ('Customer no.', 'C-10457'), ('Page', '1 of 2')]),
                     self.cols5(), rows, [(cfl, A(cf_p), False)], cur)
        pg = doc.new_page(width=A4.width, height=A4.height)
        rows = [dict(cells=['', bfl, '', '', A(cf_p)], bold=True)] + \
               [dict(cells=[str(i + 15), n, str(q), A(p), A(r2(q * p))]) for i, (n, q, p) in enumerate(p2_)]
        self.invoice(pg, sup, addr, title, no + self.L(' - Seite 2 von 2', ' - page 2 of 2'), [], self.cols5(), rows,
                     [(self.L('Summe netto', 'Net total'), A(net_p), False), (self.L('zuzüglich 20 % USt', 'VAT 20 %'), A(vat_p), False),
                      (self.L('Rechnungsbetrag', 'Total due'), A(tot_p), True)], cur, y0=110, header=False)
        self.save(doc, os.path.join(self.out, folder), file)
        self.write(os.path.join(self.out, folder), self.t['sol'], self.L(
            f"""V13 Zweiseitige Rechnung mit Übertrag - Musterlösung

"{file}" anhängen, Prompt "Check an invoice".
24 Positionen auf 2 Seiten; Übertrag am Ende von Seite 1 und am Anfang von Seite 2.
Fehler: Übertrag gedruckt {A(cf_p)}, Summe der Positionen 1-14 = {A(cf)} (Zahlendreher).
Folgefehler: Summe netto {A(net_p)} statt {A(net)}, USt {A(vat_p)} statt {A(vat)}, Rechnungsbetrag {A(tot_p)} statt {A(tot)}.""",
            f"""V13 Two-page invoice with carry-over - solution

Attach "{file}", prompt "Check an invoice".
24 items on 2 pages; carried forward at the end of page 1 and brought forward on page 2.
Error: carried forward printed {A(cf_p)}, sum of items 1-14 = {A(cf)} (transposed digits).
Follows: net total {A(net_p)} instead of {A(net)}, VAT {A(vat_p)} instead of {A(vat)}, total due {A(tot_p)} instead of {A(tot)}."""))
        self.case('V13-carry-over', folder, [file], cf_p, [cf_p, net_p, vat_p, tot_p], cf)

    def more(self):
        for fn in (self.v9, self.v10, self.v11, self.v12, self.v13): fn()
        io.open(os.path.join(self.out, 'more.json'), 'w', encoding='utf-8').write(json.dumps(self.cases, indent=1, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    for lang in ('de', 'en'):
        m = More(lang, os.path.join(here, lang)); m.more()
        print('ok', lang, ', '.join(f"{k}: {v['first']}" for k, v in m.cases.items()))
