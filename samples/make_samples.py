r"""Sample documents for DeskCalc Verify (V4-V8), German and English.

All companies, people and account numbers are made up. Every document has deliberate
errors; the expected findings are written next to it (Lösung.txt / Solution.txt).
Amounts are computed with Decimal, so the solutions are exact.

    python samples/make_samples.py            # -> samples/de, samples/en
    python samples/make_samples.py <out-dir>  # e.g. Documents\DeskCalc Verify
Needs PyMuPDF (pip install pymupdf).
"""
import io, os, random, re, sys
from decimal import Decimal as D, ROUND_HALF_UP
import fitz

C = D('0.01')
def r2(x): return D(x).quantize(C, ROUND_HALF_UP)
def swap(x, cents=False):
    """Transposed digits: units and first decimal (48.70 -> 47.80) or the two decimals (7420.20 -> 7420.02)."""
    for i, j in ([(-2, -1)] if cents else []) + [(-4, -2), (-5, -4)]:
        l = list(f'{x:.2f}'); l[i], l[j] = l[j], l[i]
        y = D(''.join(l))
        if y != x: return y
    return x + D('9.00')

# ------------------------------------------------------------------ texts
T = {
 'de': dict(
    dec=',', grp='.', cur='EUR', date=lambda d, m, y=2026: f'{d:02d}.{m:02d}.{y}',
    sol='Lösung.txt', readme='Liesmich.txt', sample='Musterbeleg (erfunden)', page='Seite',
    firm='Muster Handels GmbH, Hauptstraße 12, 1010 Wien', emp='A. Beispiel',
    readme_text='Musterbelege für DeskCalc Verify - alle Firmen, Personen und Kontonummern sind erfunden.\n'
                'Jeder Ordner enthält PDF-Belege mit absichtlichen Fehlern und eine Lösung.txt.\n'
                'Die Lösung NICHT an Claude anhängen.',
    # V4
    v4dir='V4 Spesen', v4kinds=[('Gasthaus Zum Goldenen Hirschen', 'Bewirtung', 10), ('Café Kranzler-Eck', 'Bewirtung', 10),
        ('Taxi Funkzentrale Süd', 'Taxi', 10), ('Tankstelle Am Gürtel', 'Treibstoff', 20), ('Parkgarage Stadtmitte', 'Parken', 20),
        ('Hotel Alpenblick', 'Nächtigung', 10), ('Papierwaren Huber', 'Bürobedarf', 20), ('Regionalbahn Ticketautomat', 'Fahrkarte', 10)],
    v4receipts='30 Spesenbelege Oktober 2026.pdf', v4head='Spesenbelege Oktober 2026 - Mitarbeiter: A. Beispiel',
    rcpt_no='Beleg Nr.', total_caps='SUMME', incl_vat='darin {r} % MwSt', net='Netto', exp_no='Spesenbeleg Nr.',
    v4claim='Spesenabrechnung Oktober 2026.pdf', v4claim_h='Spesenabrechnung Oktober 2026',
    v4claim_sub='Mitarbeiter: A. Beispiel, Kostenstelle 4100 Vertrieb',
    v4cols=['Nr.', 'Datum', 'Beleg', 'Art', 'Betrag EUR'], v4sum='Summe Auszahlung',
    v4foot='Belege liegen bei. Geprüft: ____________ &nbsp; Freigabe: ____________',
    v4sol="""V4 Spesen - Musterlösung (alle Firmen erfunden)

1) "{receipts}" anhängen, Prompt "Add up expense receipts".
   Erwartet: EIN Reiter, 30 Zeilen, Summe {total}.
   Variante mit USt: "jeder Beleg mit seiner enthaltenen USt" -> 30 Blöcke + GT {total}.
   Fehler: Beleg {bn} ({bf}, {bg}) druckt {br} % MwSt {bvp}, richtig ist {bv} (Differenz 0,40).

2) "{claim}": Summe gedruckt {ptot}, Summe der Zeilen {ltot} -> um 1,00 zu hoch addiert.

3) Beide prüfen, dann "gleiche die Abrechnung mit den Belegen ab" (compare_verifications):
   Nr. {tn} {tf}: Beleg {tg}, Abrechnung {ts} (Zahlendreher).""",
    # V5
    v5dir='V5 Kontoauszug', v5file='Kontoauszug 10-2026 Musterbank.pdf', bank='Musterbank AG', stmt='Kontoauszug 10/2026',
    holder='Kontoinhaber', acct='IBAN AT00 0000 0000 0000 0000 (Muster) &nbsp; Währung EUR',
    v5cols=['Datum', 'Buchungstext', 'Betrag'], opening='Anfangssaldo 01.10.2026', cf_from='Übertrag von Seite {p}',
    cf_to='Übertrag auf Seite {p}', closing='Endsaldo 31.10.2026',
    v5texts=['Gutschrift Kunde Beispiel KG RE-{n}', 'Lastschrift Stromlieferant Ost', 'Überweisung Miete Büro',
             'Gutschrift Kunde Alpha OG RE-{n}', 'Kartenzahlung Tankstelle', 'Überweisung Lieferant Muster Papier',
             'Lastschrift Telefon & Internet', 'Gutschrift Kunde Gamma GmbH RE-{n}', 'Gehalt A. Beispiel',
             'Kontoführung', 'Überweisung Finanzamt UVA', 'Gutschrift Kunde Delta e.U. RE-{n}'], credit='Gutschrift',
    v5sol="""V5 Kontoauszug mit Überträgen - Musterlösung

"{file}" anhängen, Prompt "Check a statement with carry-overs".
Anfangssaldo {start} ist eine Betragszeile, die Überträge sind Kontrollpunkte (subtotal).

Erwartet:
  Übertrag Seite 1: gedruckt {p1} = richtig -> ok
  Übertrag Seite 2: gedruckt {p2}, richtig {t2} -> Abweichung -10,00 (erster Fehler)
  Endsaldo:         gedruckt {p3}, richtig {t3} -> Folgefehler (gleiche Differenz)""",
    # V6
    v6dir='V6 Querfussen', v6file='Rechnungsausgangsbuch Q3 2026.pdf', v6h='Rechnungsausgangsbuch Q3 2026',
    v6cust=['Beispiel KG', 'Alpha OG', 'Gamma GmbH', 'Delta e.U.', 'Omega Bau GmbH', 'Sigma Consulting', 'Kappa Handel'],
    inv='RE', cn='GS', v6cols=['Rechnung', 'Datum', 'Kunde', 'Netto', 'Satz', 'USt', 'Brutto'], sum='Summe', rates=[20, 20, 20, 10, 13],
    v6sol="""V6 Fußen und Querfußen - Musterlösung

"{file}" anhängen, Prompt "Foot and cross-foot a table".
16 Zeilen, je Zeile Netto + USt = Brutto; eine Gutschrift ({cn}, negativ).

Erwartet:
  Zeile {bn}: Netto {bnet} + USt {btax} = {bg}, gedruckt {bgp} (Zahlendreher)
  Netto-Spalte: gedruckt {snp}, richtig {sn} -> 100,00 zu hoch
  USt-Spalte:   {st} -> ok
  Brutto-Summe: gedruckt {sgp} = Summe der gedruckten Bruttowerte -> ok
                (mit korrigierter Zeile {bn} wäre sie {sg})""",
    # V7
    v7dir='V7 Abgleich', po='Bestellung', po_no='B-2026-0457', invh='Rechnung', inv_no='RE-2026-1189',
    supplier='Beispiel Bürobedarf GmbH', supplier_addr='Industriestraße 5, 4020 Linz', vatid='UID ATU00000000 (Muster)',
    po_meta='Besteller: {firm}<br>Lieferant: {sup}, {addr}<br>Datum: 06.10.2026',
    inv_meta='<b>{sup}</b>, {addr}, {vatid}<br>An: {firm}<br>Rechnungsdatum 14.10.2026 &nbsp; Ihre Bestellung {po} vom 06.10.2026<br>Zahlbar 14 Tage netto',
    v7items=['Kopierpapier A4 80 g, Karton 5x500', 'Toner schwarz TX-200', 'Ordner breit, blau', 'Kugelschreiber Gel, 10er',
             'Haftnotizen 76x76, 12er', 'Archivbox A4', 'Etiketten 70x36, 100 Bl.', 'Whiteboard-Marker 4er'], ship='Versandkostenpauschale',
    v7cols=['Pos.', 'Artikel', 'Menge', 'Einzelpreis', 'Gesamt EUR'], netsum='Summe netto', plusvat='zzgl. 20 % USt', grand='Gesamtbetrag',
    v7sol="""V7 Zwei Belege abgleichen - Musterlösung

Beide PDFs anhängen, Prompt "Reconcile two documents" (Bestellung = A, Rechnung = B).
Bestellung netto {on} / brutto {og}; Rechnung netto {inn} / brutto {ig}.

Erwartet:
  gleich:            6 Positionen
  Betrag weicht ab:  {toner}: 4 x {p1} = {a1} bestellt, 4 x {p2} = {a2} berechnet (+{d})
  nur in Bestellung: {box} 20 x {pb} = {ab} (nicht geliefert/berechnet)
  nur in Rechnung:   {ship} {sp} (nicht bestellt)
  Differenz netto:   {diff}
Die Rechnung selbst rechnet richtig (Menge x Preis, USt, Gesamtbetrag ok).""",
    # V8
    v8dir='V8 Fremdwaehrung', v8file='Reisekosten New York Zuerich.pdf', v8h='Reisekostenabrechnung',
    trip='Reise: New York / Zürich, 15.-18.10.2026, Mitarbeiter: A. Beispiel',
    v8items=['Hotel Midtown, 2 Nächte', 'Taxi Flughafen - Hotel', 'Messeeintritt', 'Abendessen Kundentermin',
             'Bahn Zürich HB - Basel', 'Hotel am See, 1 Nacht', 'Mittagessen'],
    usd=D('0.9215'), chf=D('0.9365'), usdk='0,9215 EUR/USD', chfk='1 EUR = 0,9365 CHF',
    rates_note='Kurse: USD laut Kreditkartenabrechnung 0,9215 EUR je USD; CHF laut Bankkurs 1 EUR = 0,9365 CHF',
    v8cols=['Datum', 'Ausgabe', 'Fremdwährung', 'Kurs', 'EUR'], v8sum='Summe EUR',
    v8sol="""V8 Fremdwährung - Musterlösung

"{file}" anhängen: "prüfe die Umrechnungen und die Summe".
USD: Betrag x 0,9215 (fx_rate). CHF: Kurs ist 1 EUR = 0,9365 CHF (Kehrwert) -> Betrag / 0,9365;
laut Beschreibung gibt Claude dann den Euro-Betrag als Zeile, den Kurs im Text.

Richtig umgerechnet:
{lines}
Summe EUR richtig {tt}, gedruckt {pt} (Folge des Zahlendrehers).""", printed='gedruckt', swapped='Zahlendreher',
 ),
 'en': dict(
    dec='.', grp=',', cur='GBP', date=lambda d, m, y=2026: f'{d:02d}/{m:02d}/{y}',
    sol='Solution.txt', readme='Readme.txt', sample='Sample document (fictitious)', page='Page',
    firm='Sample Trading Ltd, 12 High Street, Exampleton EX1 2AB', emp='A. Example',
    readme_text='Sample documents for DeskCalc Verify - all companies, people and account numbers are fictitious.\n'
                'Each folder holds PDF documents with deliberate errors and a Solution.txt.\n'
                'Do NOT attach the solution to the AI.',
    v4dir='V4 Expenses', v4kinds=[('The Golden Stag Inn', 'Meals', 20), ('Corner Café', 'Meals', 20),
        ('City Cabs South', 'Taxi', 20), ('Ring Road Fuel', 'Fuel', 20), ('Central Car Park', 'Parking', 20),
        ('Hotel Hillview', 'Accommodation', 20), ('Huber Stationery', 'Office supplies', 20), ('Regional Rail ticket machine', 'Train fare', 0)],
    v4receipts='30 expense receipts October 2026.pdf', v4head='Expense receipts October 2026 - Employee: A. Example',
    rcpt_no='Receipt no.', total_caps='TOTAL', incl_vat='incl. VAT {r} %', net='Net', exp_no='Expense receipt no.',
    v4claim='Expense claim October 2026.pdf', v4claim_h='Expense claim October 2026',
    v4claim_sub='Employee: A. Example, cost centre 4100 Sales',
    v4cols=['No.', 'Date', 'Receipt', 'Type', 'Amount GBP'], v4sum='Total to reimburse',
    v4foot='Receipts attached. Checked: ____________ &nbsp; Approved: ____________',
    v4sol="""V4 Expenses - solution (all companies fictitious)

1) Attach "{receipts}", prompt "Add up expense receipts".
   Expected: ONE tape, 30 lines, total {total}.
   With VAT: "each receipt with its included VAT" -> 30 blocks + GT {total}.
   Error: receipt {bn} ({bf}, {bg}) prints VAT {br} % {bvp}, correct is {bv} (difference 0.40).

2) "{claim}": printed total {ptot}, sum of the lines {ltot} -> added up 1.00 too high.

3) Check both, then "reconcile the claim with the receipts" (compare_verifications):
   No. {tn} {tf}: receipt {tg}, claim {ts} (transposed digits).""",
    v5dir='V5 Bank statement', v5file='Bank statement 10-2026 Sample Bank.pdf', bank='Sample Bank plc', stmt='Statement 10/2026',
    holder='Account holder', acct='Sort code 00-00-00, account 00000000 (sample) &nbsp; Currency GBP',
    v5cols=['Date', 'Description', 'Amount'], opening='Opening balance 01/10/2026', cf_from='Brought forward from page {p}',
    cf_to='Carried forward to page {p}', closing='Closing balance 31/10/2026',
    v5texts=['Credit customer Example Ltd INV-{n}', 'Direct debit Eastern Power', 'Transfer office rent',
             'Credit customer Alpha LLP INV-{n}', 'Card payment fuel station', 'Transfer supplier Sample Paper',
             'Direct debit phone & internet', 'Credit customer Gamma Ltd INV-{n}', 'Salary A. Example',
             'Account fee', 'Transfer HMRC VAT', 'Credit customer Delta & Co INV-{n}'], credit='Credit',
    v5sol="""V5 Bank statement with carry-overs - solution

Attach "{file}", prompt "Check a statement with carry-overs".
The opening balance {start} is an amount line, the carried-forward balances are checkpoints (subtotal).

Expected:
  Carried forward page 1: printed {p1} = correct -> ok
  Carried forward page 2: printed {p2}, correct {t2} -> difference -10.00 (first error)
  Closing balance:        printed {p3}, correct {t3} -> follows from above (same difference)""",
    v6dir='V6 Cross-footing', v6file='Sales day book Q3 2026.pdf', v6h='Sales day book Q3 2026',
    v6cust=['Example Ltd', 'Alpha LLP', 'Gamma Ltd', 'Delta & Co', 'Omega Build Ltd', 'Sigma Consulting', 'Kappa Trading'],
    inv='INV', cn='CN', v6cols=['Invoice', 'Date', 'Customer', 'Net', 'Rate', 'VAT', 'Gross'], sum='Total', rates=[20, 20, 20, 5, 0],
    v6sol="""V6 Footing and cross-footing - solution

Attach "{file}", prompt "Foot and cross-foot a table".
16 rows, each row net + VAT = gross; one credit note ({cn}, negative).

Expected:
  Row {bn}: net {bnet} + VAT {btax} = {bg}, printed {bgp} (transposed digits)
  Net column:  printed {snp}, correct {sn} -> 100.00 too high
  VAT column:  {st} -> ok
  Gross total: printed {sgp} = sum of the printed gross amounts -> ok
               (with row {bn} corrected it would be {sg})""",
    v7dir='V7 Reconcile', po='Purchase order', po_no='PO-2026-0457', invh='Invoice', inv_no='INV-2026-1189',
    supplier='Example Office Supplies Ltd', supplier_addr='5 Industrial Way, Sampleford SF4 0AA', vatid='VAT reg. GB 000 0000 00 (sample)',
    po_meta='Ordered by: {firm}<br>Supplier: {sup}, {addr}<br>Date: 06/10/2026',
    inv_meta='<b>{sup}</b>, {addr}, {vatid}<br>To: {firm}<br>Invoice date 14/10/2026 &nbsp; Your order {po} of 06/10/2026<br>Payment terms 14 days',
    v7items=['Copy paper A4 80 gsm, box 5x500', 'Toner black TX-200', 'Lever arch file, blue', 'Gel pens, pack of 10',
             'Sticky notes 76x76, pack of 12', 'Archive box A4', 'Labels 70x36, 100 sheets', 'Whiteboard markers, 4 pack'], ship='Delivery charge',
    v7cols=['Item', 'Description', 'Qty', 'Unit price', 'Amount GBP'], netsum='Net total', plusvat='VAT 20 %', grand='Total due',
    v7sol="""V7 Reconcile two documents - solution

Attach both PDFs, prompt "Reconcile two documents" (purchase order = A, invoice = B).
Order net {on} / gross {og}; invoice net {inn} / gross {ig}.

Expected:
  matched:          6 items
  amount differs:   {toner}: 4 x {p1} = {a1} ordered, 4 x {p2} = {a2} invoiced (+{d})
  only in order:    {box} 20 x {pb} = {ab} (not delivered/invoiced)
  only in invoice:  {ship} {sp} (not ordered)
  net difference:   {diff}
The invoice itself adds up correctly (qty x price, VAT, total ok).""",
    v8dir='V8 Foreign currency', v8file='Travel expenses New York Zurich.pdf', v8h='Travel expense claim',
    trip='Trip: New York / Zurich, 15-18/10/2026, employee: A. Example',
    v8items=['Hotel Midtown, 2 nights', 'Taxi airport - hotel', 'Trade fair admission', 'Client dinner',
             'Train Zurich HB - Basel', 'Lakeside hotel, 1 night', 'Lunch'],
    usd=D('0.7850'), chf=D('1.1240'), usdk='0.7850 GBP/USD', chfk='1 GBP = 1.1240 CHF',
    rates_note='Rates: USD per credit card statement 0.7850 GBP per USD; CHF per bank rate 1 GBP = 1.1240 CHF',
    v8cols=['Date', 'Expense', 'Foreign amount', 'Rate', 'GBP'], v8sum='Total GBP',
    v8sol="""V8 Foreign currency - solution

Attach "{file}": "check the conversions and the total".
USD: amount x 0.7850 (fx_rate). CHF: the rate is 1 GBP = 1.1240 CHF (inverse) -> amount / 1.1240;
as the tool description says, the AI then sends the GBP amount as a line with the rate in the text.

Correctly converted:
{lines}
Total GBP correct {tt}, printed {pt} (follows from the transposed digits).""", printed='printed', swapped='transposed digits',
 ),
}

CSS = """
* { font-family: sans-serif; }
body { font-size: 9.5pt; color: #222; }
h1 { font-size: 15pt; margin: 0 0 4pt 0; }
h2 { font-size: 11pt; margin: 8pt 0 4pt 0; }
.small { font-size: 8pt; color: #555; }
table { border-collapse: collapse; width: 100%; }
th { text-align: left; border-bottom: 1px solid #333; padding: 3pt 4pt; font-size: 8.5pt; }
td { padding: 2.5pt 4pt; border-bottom: 1px solid #ddd; vertical-align: top; }
.r { text-align: right; }
.b { font-weight: bold; }
.tot td { border-top: 1.5px solid #333; border-bottom: none; font-weight: bold; }
.box { border: 1px solid #999; padding: 6pt; }
"""
A4 = fitz.paper_rect('a4')


class Maker:
    def __init__(self, lang, out):
        self.t, self.lang, self.out = T[lang], lang, out
        self.rng = random.Random(2026)          # same seed -> same amounts in both languages

    def amt(self, x):
        x = r2(x); s = '-' if x < 0 else ''
        i, f = f'{abs(x):.2f}'.split('.')
        return s + f'{int(i):,}'.replace(',', self.t['grp']) + self.t['dec'] + f

    def page(self, doc, html, footer=''):
        p = doc.new_page(width=A4.width, height=A4.height)
        p.insert_htmlbox(fitz.Rect(48, 42, A4.width - 48, A4.height - 50), html, css=CSS)
        if footer:
            p.insert_htmlbox(fitz.Rect(48, A4.height - 44, A4.width - 48, A4.height - 24),
                             f'<div class="small" style="text-align:center">{footer}</div>', css=CSS)

    def save(self, doc, folder, name):
        os.makedirs(folder, exist_ok=True)
        try: doc.save(os.path.join(folder, name))
        except Exception as e: print('  skipped (open in a viewer?):', os.path.join(folder, name))
        doc.close()

    def write(self, folder, name, text):
        os.makedirs(folder, exist_ok=True)
        io.open(os.path.join(folder, name), 'w', encoding='utf-8').write(text.strip() + '\n')

    # ------------------------------------------------------------ V4
    def v4(self):
        t, A, rng = self.t, self.amt, self.rng
        f = os.path.join(self.out, t['v4dir'])
        ranges = [(18, 95), (6, 28), (12, 48), (45, 95), (4, 26), (89, 189), (3, 60), (9, 65)]
        rec = []
        for i in range(30):
            k = rng.randrange(len(ranges)) if i else 0
            (firm, art, rate), (lo, hi) = t['v4kinds'][k], ranges[k]
            gross = r2(D(rng.randint(lo * 100, hi * 100)) / 100)
            vat = r2(gross - gross / (1 + D(rate) / 100))
            rec.append(dict(firm=firm, art=art, rate=rate, gross=gross, vat=vat, day=rng.randint(1, 31)))
        rec.sort(key=lambda r: r['day'])
        for i, r in enumerate(rec): r['nr'] = i + 1; r['date'] = t['date'](r['day'], 10)
        # error 1: receipt 17 prints a wrong VAT (pick a receipt that has VAT)
        bad = next(r for r in rec[16:] if r['rate'])
        bad['vat_p'] = bad['vat'] + D('0.40')
        doc = fitz.open()
        for p0 in range(0, 30, 6):
            cells = []
            for r in rec[p0:p0 + 6]:
                vp = r.get('vat_p', r['vat'])
                cells.append(f"""<td style="width:50%;padding:6pt;border:none"><div class="box">
                  <div class="b">{r['firm']}</div><div class="small">{t['rcpt_no']} {1000 + r['nr'] * 7} &nbsp; {r['date']}</div>
                  <div style="margin:6pt 0">{r['art']}</div>
                  <table><tr><td class="b">{t['total_caps']} {t['cur']}</td><td class="r b">{A(r['gross'])}</td></tr>
                  <tr><td class="small">{t['incl_vat'].format(r=r['rate'])}</td><td class="r small">{A(vp)}</td></tr>
                  <tr><td class="small">{t['net']}</td><td class="r small">{A(r['gross'] - vp)}</td></tr></table>
                  <div class="small" style="margin-top:4pt">{t['exp_no']} {r['nr']}</div></div></td>""")
            rows = ''.join(f'<tr>{cells[k]}{cells[k + 1] if k + 1 < len(cells) else "<td></td>"}</tr>' for k in range(0, len(cells), 2))
            self.page(doc, f"<h2>{t['v4head']}</h2><table>{rows}</table>", f"{t['sample']} - {t['page']} {p0 // 6 + 1}/5")
        self.save(doc, f, t['v4receipts'])

        listed = [r['gross'] for r in rec]
        tr = rec[11]; listed[11] = swap(tr['gross'])
        ptot = sum(listed) + D('1.00')
        c = t['v4cols']
        rows = ''.join(f"<tr><td>{r['nr']}</td><td>{r['date']}</td><td>{r['firm']}</td><td>{r['art']}</td><td class='r'>{A(listed[i])}</td></tr>"
                       for i, r in enumerate(rec))
        doc = fitz.open()
        self.page(doc, f"""<h1>{t['v4claim_h']}</h1><div>{t['firm']}<br>{t['v4claim_sub']}</div><br>
          <table><tr><th>{c[0]}</th><th>{c[1]}</th><th>{c[2]}</th><th>{c[3]}</th><th class='r'>{c[4]}</th></tr>{rows}
          <tr class='tot'><td></td><td></td><td>{t['v4sum']}</td><td></td><td class='r'>{A(ptot)}</td></tr></table>
          <br><div class='small'>{t['v4foot']}</div>""", t['sample'])
        self.save(doc, f, t['v4claim'])
        total = sum(r['gross'] for r in rec)
        self.write(f, t['sol'], t['v4sol'].format(
            receipts=t['v4receipts'], total=A(total), bn=bad['nr'], bf=bad['firm'], bg=A(bad['gross']), br=bad['rate'],
            bvp=A(bad['vat_p']), bv=A(bad['vat']), claim=t['v4claim'], ptot=A(ptot), ltot=A(sum(listed)),
            tn=tr['nr'], tf=tr['firm'], tg=A(tr['gross']), ts=A(listed[11])))

    # ------------------------------------------------------------ V5
    def v5(self):
        t, A, rng = self.t, self.amt, self.rng
        f = os.path.join(self.out, t['v5dir'])
        start = D('42480.35')
        pages = []
        for p in range(3):
            b = []
            for k in range(12):
                i = rng.randrange(len(t['v5texts']))
                txt = t['v5texts'][i].format(n=rng.randint(1100, 1299))
                sign = 1 if txt.startswith(t['credit']) else -1
                b.append((t['date'](p * 10 + k // 2 + 1, 10)[:6], txt, r2(D(rng.randint(1500, 480000)) / 100) * sign))
            pages.append(b)
        tr, pr, ct, cp = start, start, [], []
        for p, b in enumerate(pages):
            s = sum(a for _, _, a in b); tr += s; pr += s
            if p == 1: pr -= D('10.00')           # error: carry-over page 2 is 10.00 short
            ct.append(tr); cp.append(pr)
        c = t['v5cols']; doc = fitz.open(); prev = start
        for p, b in enumerate(pages):
            first = t['opening'] if p == 0 else t['cf_from'].format(p=p)
            last = t['closing'] if p == 2 else t['cf_to'].format(p=p + 2)
            rows = (f"<tr><td></td><td class='b'>{first}</td><td class='r b'>{A(prev)}</td></tr>"
                    + ''.join(f"<tr><td>{d}</td><td>{x}</td><td class='r'>{A(a)}</td></tr>" for d, x, a in b)
                    + f"<tr class='tot'><td></td><td>{last}</td><td class='r'>{A(cp[p])}</td></tr>")
            self.page(doc, f"""<h1>{t['bank']} &nbsp;<span class='small'>{t['stmt']}</span></h1>
              <div>{t['holder']}: {t['firm']}<br>{t['acct']}</div><br>
              <table><tr><th>{c[0]}</th><th>{c[1]}</th><th class='r'>{c[2]}</th></tr>{rows}</table>""",
                      f"{t['sample']} - {t['page']} {p + 1}/3")
            prev = cp[p]
        self.save(doc, f, t['v5file'])
        self.write(f, t['sol'], t['v5sol'].format(file=t['v5file'], start=A(start), p1=A(cp[0]), p2=A(cp[1]), t2=A(ct[1]),
                                                  p3=A(cp[2]), t3=A(ct[2])))

    # ------------------------------------------------------------ V6
    def v6(self):
        t, A, rng = self.t, self.amt, self.rng
        f = os.path.join(self.out, t['v6dir'])
        rows = []
        for i in range(16):
            ri = rng.randrange(5); rate = t['rates'][ri]
            if i == 6 and rate == 0: rate = t['rates'][3]      # the wrong row needs VAT
            net = r2(D(rng.randint(8000, 950000)) / 100)
            if i == 11: net = r2(-net / 4)                     # credit note
            tax = r2(net * rate / 100)
            day, month = rng.randint(1, 30), 7 + i // 6
            cust = t['v6cust'][rng.randrange(len(t['v6cust']))]
            rows.append(dict(nr=f"{t['cn'] if net < 0 else t['inv']}-2026-{1101 + i}", d=t['date'](day, month),
                             k=cust, rate=rate, net=net, tax=tax, gross=net + tax))
        bad = rows[6]; bad['gp'] = swap(bad['gross'], cents=True)
        sn, st, sg = (sum(r[k] for r in rows) for k in ('net', 'tax', 'gross'))
        sgp = sum(r.get('gp', r['gross']) for r in rows); snp = sn + D('100.00')
        c = t['v6cols']
        body = ''.join(f"<tr><td>{r['nr']}</td><td>{r['d']}</td><td>{r['k']}</td><td class='r'>{A(r['net'])}</td>"
                       f"<td class='r'>{r['rate']} %</td><td class='r'>{A(r['tax'])}</td><td class='r'>{A(r.get('gp', r['gross']))}</td></tr>" for r in rows)
        doc = fitz.open()
        self.page(doc, f"""<h1>{t['v6h']}</h1><div>{t['firm']}</div><br>
          <table><tr><th>{c[0]}</th><th>{c[1]}</th><th>{c[2]}</th><th class='r'>{c[3]}</th><th class='r'>{c[4]}</th><th class='r'>{c[5]}</th><th class='r'>{c[6]}</th></tr>{body}
          <tr class='tot'><td>{t['sum']}</td><td></td><td></td><td class='r'>{A(snp)}</td><td></td><td class='r'>{A(st)}</td><td class='r'>{A(sgp)}</td></tr></table>""",
                  t['sample'])
        self.save(doc, f, t['v6file'])
        self.write(f, t['sol'], t['v6sol'].format(file=t['v6file'], cn=rows[11]['nr'], bn=bad['nr'], bnet=A(bad['net']), btax=A(bad['tax']),
                                                  bg=A(bad['gross']), bgp=A(bad['gp']), snp=A(snp), sn=A(sn), st=A(st), sgp=A(sgp), sg=A(sg)))

    # ------------------------------------------------------------ V7
    def v7(self):
        t, A = self.t, self.amt
        f = os.path.join(self.out, t['v7dir'])
        it = t['v7items']
        qp = [(6, '24.90'), (4, '89.90'), (40, '2.35'), (12, '6.80'), (10, '7.45'), (20, '3.20'), (3, '18.60'), (8, '5.95')]
        order = [(it[i], q, D(p)) for i, (q, p) in enumerate(qp)]
        inv = [(n, q, D('98.90') if i == 1 else p) for i, (n, q, p) in enumerate(order) if i != 5]
        inv.append((t['ship'], 1, D('14.90')))
        c = t['v7cols']
        def html(title, no, items, meta):
            net = sum(r2(q * p) for _, q, p in items); vat = r2(net * D('0.2'))
            body = ''.join(f"<tr><td>{i + 1}</td><td>{n}</td><td class='r'>{q}</td><td class='r'>{A(p)}</td><td class='r'>{A(r2(q * p))}</td></tr>"
                           for i, (n, q, p) in enumerate(items))
            return f"""<h1>{title} {no}</h1><div>{meta}</div><br>
              <table><tr><th>{c[0]}</th><th>{c[1]}</th><th class='r'>{c[2]}</th><th class='r'>{c[3]}</th><th class='r'>{c[4]}</th></tr>{body}
              <tr><td></td><td>{t['netsum']}</td><td></td><td></td><td class='r'>{A(net)}</td></tr>
              <tr><td></td><td>{t['plusvat']}</td><td></td><td></td><td class='r'>{A(vat)}</td></tr>
              <tr class='tot'><td></td><td>{t['grand']}</td><td></td><td></td><td class='r'>{A(net + vat)}</td></tr></table>""", net, vat
        kw = dict(firm=t['firm'], sup=t['supplier'], addr=t['supplier_addr'], vatid=t['vatid'], po=t['po_no'])
        h, on, ov = html(t['po'], t['po_no'], order, t['po_meta'].format(**kw))
        d = fitz.open(); self.page(d, h, t['sample']); self.save(d, f, f"{t['po']} {t['po_no']}.pdf")
        h, inn, iv = html(t['invh'], t['inv_no'], inv, t['inv_meta'].format(**kw))
        d = fitz.open(); self.page(d, h, t['sample']); self.save(d, f, f"{t['invh']} {t['inv_no']}.pdf")
        self.write(f, t['sol'], t['v7sol'].format(on=A(on), og=A(on + ov), inn=A(inn), ig=A(inn + iv), toner=it[1],
                                                  p1=A(D('89.90')), a1=A(D('359.60')), p2=A(D('98.90')), a2=A(D('395.60')), d=A(D('36.00')),
                                                  box=it[5], pb=A(D('3.20')), ab=A(D('64.00')), ship=t['ship'], sp=A(D('14.90')), diff=A(inn - on)))

    # ------------------------------------------------------------ V8
    def v8(self):
        t, A = self.t, self.amt
        f = os.path.join(self.out, t['v8dir'])
        src = [((15, 10), 'USD', '412.00'), ((15, 10), 'USD', '68.50'), ((16, 10), 'USD', '245.00'), ((16, 10), 'USD', '187.40'),
               ((17, 10), 'CHF', '39.00'), ((17, 10), 'CHF', '214.00'), ((18, 10), 'CHF', '46.80')]
        rows, tt, pt = [], D(0), D(0)
        for i, ((dd, mm), cur, a) in enumerate(src):
            a = D(a); e = r2(a * t['usd']) if cur == 'USD' else r2(a / t['chf'])
            ep = swap(e) if i == 2 else e                          # error: transposed digits
            tt += e; pt += ep
            rows.append((t['date'](dd, mm), t['v8items'][i], cur, a, t['usdk'] if cur == 'USD' else t['chfk'], e, ep))
        c = t['v8cols']
        body = ''.join(f"<tr><td>{d}</td><td>{x}</td><td class='r'>{cur} {A(a)}</td><td class='r'>{k}</td><td class='r'>{A(ep)}</td></tr>"
                       for d, x, cur, a, k, e, ep in rows)
        doc = fitz.open()
        self.page(doc, f"""<h1>{t['v8h']}</h1><div>{t['firm']}<br>{t['trip']}<br>{t['rates_note']}</div><br>
          <table><tr><th>{c[0]}</th><th>{c[1]}</th><th class='r'>{c[2]}</th><th class='r'>{c[3]}</th><th class='r'>{c[4]}</th></tr>{body}
          <tr class='tot'><td></td><td>{t['v8sum']}</td><td></td><td></td><td class='r'>{A(pt)}</td></tr></table>""", t['sample'])
        self.save(doc, f, t['v8file'])
        lines = '\n'.join(f"  {x:<30} {cur} {A(a):>8} -> {A(e):>8}" + (f"   {t['printed']} {A(ep)} ({t['swapped']})" if ep != e else '')
                          for d, x, cur, a, k, e, ep in rows)
        self.write(f, t['sol'], t['v8sol'].format(file=t['v8file'], lines=lines, tt=A(tt), pt=A(pt)))


    # ------------------------------------------------------------ V1 Invoice (video 1)
    def v1(self):
        """A plain supplier invoice: qty x price, discount, VAT, total due. One line total is
        misprinted to the customer's disadvantage, so the invoice asks for too much."""
        A = self.amt
        de = self.lang == 'de'
        L = dict(
            dir='V1 Rechnung' if de else 'V1 Invoice',
            file='Rechnung RE-2026-2041.pdf' if de else 'Invoice INV-2026-2041.pdf',
            title='Rechnung' if de else 'Invoice', no='RE-2026-2041' if de else 'INV-2026-2041',
            sup='Muster Büroausstattung GmbH' if de else 'Example Stationery Ltd',
            sup_addr='Gewerbepark 7, 8010 Graz' if de else '7 Trade Park, Sampleford SF2 7XX',
            vatid='UID ATU00000000 (Muster)' if de else 'VAT reg. GB 000 0000 00 (sample)',
            to='Rechnung an' if de else 'Bill to',
            meta=[('Rechnungsdatum', '02.11.2026'), ('Lieferdatum', '30.10.2026'), ('Kundennummer', 'K-10457'), ('Fällig', '16.11.2026')] if de else
                 [('Invoice date', '02/11/2026'), ('Delivery date', '30/10/2026'), ('Customer no.', 'C-10457'), ('Due', '16/11/2026')],
            cols=['Pos.', 'Artikel', 'Menge', 'Einzelpreis', 'Betrag'] if de else ['Item', 'Description', 'Qty', 'Unit price', 'Amount'],
            items=[('Kopierpapier A4 80 g, Karton 5x500', 8, '24.90'), ('Toner schwarz TX-200', 3, '89.90'),
                   ('Ordner breit, blau', 25, '2.35'), ('Haftnotizen 76x76, 12er-Pack', 12, '7.45'),
                   ('Whiteboard-Marker, 4er-Pack', 10, '5.95'), ('Versand', 1, '9.50')] if de else
                  [('Copy paper A4 80 gsm, box of 5 reams', 8, '24.90'), ('Toner cartridge black TX-200', 3, '89.90'),
                   ('Lever arch files, blue', 25, '2.35'), ('Sticky notes 76x76, pack of 12', 12, '7.45'),
                   ('Whiteboard markers, pack of 4', 10, '5.95'), ('Delivery', 1, '9.50')],
            sub='Zwischensumme' if de else 'Subtotal', disc='abzüglich 3 % Rabatt' if de else 'Less 3 % discount',
            net='Nettobetrag' if de else 'Net amount', vat='zuzüglich 20 % USt' if de else 'VAT 20 %',
            total='Rechnungsbetrag' if de else 'Total due', cur='EUR' if de else 'GBP',
            pay=('Zahlbar bis 16.11.2026 ohne Abzug. Musterbank AG, IBAN AT00 0000 0000 0000 0000 (Muster). Bitte Rechnungsnummer angeben.' if de else
                 'Payment due by 16/11/2026. Sample Bank plc, sort code 00-00-00, account 00000000 (sample). Please quote the invoice number.'),
            thanks='Vielen Dank für Ihren Auftrag.' if de else 'Thank you for your order.',
        )
        rows, printed = [], []
        for i, (n, q, pr) in enumerate(L['items']):
            pr = D(pr); amt = r2(q * pr)
            pa = D('98.40') if i == 3 else amt          # error: 12 x 7.45 = 89.40, printed 98.40
            rows.append((n, q, pr, amt, pa)); printed.append(pa)
        sub_p = sum(printed); disc_p = r2(sub_p * D('0.03')); net_p = sub_p - disc_p
        vat_p = r2(net_p * D('0.2')); tot_p = net_p + vat_p
        sub_t = sum(a for *_, a, _ in rows); disc_t = r2(sub_t * D('0.03')); net_t = sub_t - disc_t
        vat_t = r2(net_t * D('0.2')); tot_t = net_t + vat_t
        # Laid out with text at fixed positions: the HTML renderer shrinks tables to their content.
        f = os.path.join(self.out, L['dir'])
        doc = fitz.open(); pg = doc.new_page(width=A4.width, height=A4.height)
        W, X0, X1 = A4.width, 48, A4.width - 48
        INK, SOFT, BLUE, LINE = (0.13, 0.13, 0.13), (0.4, 0.4, 0.4), (0.12, 0.31, 0.47), (0.8, 0.8, 0.8)
        def txt(x, y, t, size=9.5, font='helv', color=INK, right=False):
            if right: x -= fitz.get_text_length(t, fontname=font, fontsize=size)
            pg.insert_text((x, y), t, fontsize=size, fontname=font, color=color)
        def line(y, w=0.6, color=LINE, x0=X0, x1=X1): pg.draw_line((x0, y), (x1, y), color=color, width=w)
        # header
        txt(X0, 72, L['sup'], 17, 'hebo', BLUE)
        txt(X0, 88, L['sup_addr'], 8.5, color=SOFT); txt(X0, 99, L['vatid'], 8.5, color=SOFT)
        txt(X1, 74, L['title'].upper(), 22, 'hebo', right=True); txt(X1, 92, L['no'], 10, 'hebo', right=True)
        line(114, 1.2, BLUE)
        # bill to + meta
        txt(X0, 136, L['to'], 8, color=SOFT)
        for i, part in enumerate(self.t['firm'].split(', ')): txt(X0, 150 + i * 13, part, 10)
        for i, (k, v) in enumerate(L['meta']):
            txt(330, 136 + i * 14, k, 8.5, color=SOFT); txt(X1, 136 + i * 14, v, 9.5, right=True)
        # table
        c = L['cols']
        cx = {'no': X0, 'desc': X0 + 34, 'qty': 360, 'price': 440, 'amt': X1}
        y = 215
        txt(cx['no'], y, c[0], 8.5, 'hebo'); txt(cx['desc'], y, c[1], 8.5, 'hebo')
        txt(cx['qty'], y, c[2], 8.5, 'hebo', right=True); txt(cx['price'], y, c[3], 8.5, 'hebo', right=True)
        txt(cx['amt'], y, f"{c[4]} {L['cur']}", 8.5, 'hebo', right=True)
        line(y + 6, 0.9, INK)
        y += 22
        for i, (n, q, pr, amt, pa) in enumerate(rows):
            txt(cx['no'], y, str(i + 1)); txt(cx['desc'], y, n)
            txt(cx['qty'], y, str(q), right=True); txt(cx['price'], y, A(pr), right=True); txt(cx['amt'], y, A(pa), right=True)
            line(y + 7); y += 20
        y += 6
        for label, v, bold in ((L['sub'], sub_p, False), (L['disc'], -disc_p, False), (L['net'], net_p, False), (L['vat'], vat_p, False)):
            txt(300, y, label); txt(cx['amt'], y, A(v), right=True); y += 17
        line(y - 10, 0.9, INK, 300); y += 6
        txt(300, y, L['total'], 11, 'hebo'); txt(cx['amt'], y, f"{L['cur']} {A(tot_p)}", 11, 'hebo', right=True)
        line(y + 6, 0.9, INK, 300); line(y + 8.5, 0.9, INK, 300)
        y += 50
        for i, part in enumerate(re.findall(r'.{1,95}(?:\s|$)', L['pay'])): txt(X0, y + i * 12, part.strip(), 8.5, color=SOFT)
        txt(X0, y + 40, L['thanks'], 9.5)
        txt(W / 2 - fitz.get_text_length(self.t['sample'], fontname='helv', fontsize=7.5) / 2, A4.height - 30, self.t['sample'], 7.5, color=SOFT)
        self.save(doc, f, L['file'])
        diff = tot_p - tot_t
        if de:
            sol = f"""V1 Rechnung prüfen - Musterlösung (für Video 1)

"{L['file']}" anhängen, Prompt "Check an invoice".
Erwartet: 6 Positionen Menge x Einzelpreis, 3 % Rabatt, 20 % USt, Rechnungsbetrag.

Fehler: Pos. 4 {L['items'][3][0]}: 12 x 7,45 = {A(D('89.40'))}, gedruckt {A(D('98.40'))} (Zahlendreher, +9,00).
Rabatt, USt und Rechnungsbetrag sind vom falschen Betrag aus richtig gerechnet - sie weichen nur deshalb ab.
  gedruckt: Zwischensumme {A(sub_p)}, Rabatt {A(disc_p)}, netto {A(net_p)}, USt {A(vat_p)}, Rechnungsbetrag {A(tot_p)}
  richtig:  Zwischensumme {A(sub_t)}, Rabatt {A(disc_t)}, netto {A(net_t)}, USt {A(vat_t)}, Rechnungsbetrag {A(tot_t)}
Die Rechnung verlangt {A(diff)} EUR zu viel."""
        else:
            sol = f"""V1 Check an invoice - solution (for video 1)

Attach "{L['file']}", prompt "Check an invoice".
Expected: 6 items qty x unit price, 3 % discount, VAT 20 %, total due.

Error: item 4 {L['items'][3][0]}: 12 x 7.45 = {A(D('89.40'))}, printed {A(D('98.40'))} (transposed digits, +9.00).
Discount, VAT and total are computed correctly from the wrong amount - they differ only because of it.
  printed: subtotal {A(sub_p)}, discount {A(disc_p)}, net {A(net_p)}, VAT {A(vat_p)}, total due {A(tot_p)}
  correct: subtotal {A(sub_t)}, discount {A(disc_t)}, net {A(net_t)}, VAT {A(vat_t)}, total due {A(tot_t)}
The invoice asks for {A(diff)} GBP too much."""
        self.write(f, self.t['sol'], sol)

    def all(self):
        for fn in (self.v1, self.v4, self.v5, self.v6, self.v7, self.v8): fn()
        self.write(self.out, self.t['readme'], self.t['readme_text'])


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    base = sys.argv[1] if len(sys.argv) > 1 else here
    names = {'de': 'de', 'en': 'en'} if len(sys.argv) == 1 else {'de': 'Musterbelege', 'en': 'Samples'}
    for lang, sub in names.items():
        Maker(lang, os.path.join(base, sub)).all()
        print('ok', os.path.join(base, sub))
