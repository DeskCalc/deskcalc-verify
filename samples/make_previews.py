"""Preview images of the English samples for the README (cropped to the content)."""
import os
import fitz

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, 'images')
os.makedirs(out, exist_ok=True)
pick = [('V1 Invoice/Invoice INV-2026-2041.pdf', 0, 'v1-invoice.png'),
        ('V4 Expenses/30 expense receipts October 2026.pdf', 0, 'v4-receipts.png'),
        ('V5 Bank statement/Bank statement 10-2026 Sample Bank.pdf', 1, 'v5-statement-page2.png'),
        ('V6 Cross-footing/Sales day book Q3 2026.pdf', 0, 'v6-sales-day-book.png'),
        ('V7 Reconcile/Invoice INV-2026-1189.pdf', 0, 'v7-invoice.png'),
        ('V8 Foreign currency/Travel expenses New York Zurich.pdf', 0, 'v8-travel-expenses.png')]
for src, pno, name in pick:
    page = fitz.open(os.path.join(here, 'en', src))[pno]
    r = fitz.Rect()
    for b in page.get_text('blocks'):
        if 'Sample document' not in b[4]: r |= fitz.Rect(b[:4])
    for d in page.get_drawings(): r |= d['rect']
    clip = (r + (-12, -12, 12, 12)) & page.rect
    page.get_pixmap(dpi=110, clip=clip).save(os.path.join(out, name))
    print(name)
