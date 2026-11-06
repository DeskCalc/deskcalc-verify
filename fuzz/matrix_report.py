"""Overview of a matrix run with screenshots, to trace each result by hand.

    python fuzz/matrix_report.py <matrix-json> [<matrix-json> ...]
Writes fuzz/shots/Auswertung-<date>.html (local file, images linked relatively; not committed).
Per sample: expected finding (Lösung.txt / Solution.txt / notes), the failing checks
(document vs DeskCalc), Claude's answer, and the screenshots of every DeskCalc check.
"""
import glob, html, io, json, os, sys, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SHOTS = os.path.join(HERE, 'shots')

def expectation(name, lang):
    """The written solution / note for a sample, if there is one."""
    if name.startswith('X-'):
        p = json.load(open(os.path.join(HERE, 'public', 'practice', 'practice.json'), encoding='utf-8')).get(name, {})
        return p.get('note', '')
    if name.startswith('P-'):
        t = json.load(open(os.path.join(HERE, 'public', 'ferd', 'truth.json'), encoding='utf-8')).get(name[2:], {})
        return (f"FeRD-Muster, laut eingebettetem XML: netto {t.get('net')}, Steuer {t.get('tax')}, brutto {t.get('grand')}, "
                f"Zahlbetrag {t.get('due')}" + (' - Zahlbetrag weicht von brutto ab (im Beleg selbst)' if t.get('due') != t.get('grand') and t.get('allowances') == '0.00' else ''))
    more = os.path.join(ROOT, 'samples', lang, 'more.json')
    files = []
    if os.path.exists(more) and name in json.load(open(more, encoding='utf-8')):
        files = json.load(open(more, encoding='utf-8'))[name]['files']
    else:
        prefix = name.split('-')[0] + ' '
        files = [os.path.relpath(d, os.path.join(ROOT, 'samples', lang)) + '/x' for d in glob.glob(os.path.join(ROOT, 'samples', lang, prefix + '*'))]
    for f in files[:1]:
        d = os.path.join(ROOT, 'samples', lang, os.path.dirname(f))
        for sol in ('Lösung.txt', 'Solution.txt'):
            if os.path.exists(os.path.join(d, sol)): return io.open(os.path.join(d, sol), encoding='utf-8').read()
    return ''

def main(paths):
    out = []
    for p in paths:
        base = os.path.basename(p)
        lang = 'de' if '-de' in base else 'en'
        stamp = base[7:17]
        model = next((m for m in ('sonnet', 'haiku', 'opus') if f'-{m}' in base), '')
        for name, runs in json.load(open(p, encoding='utf-8')).items():
            for i, r in enumerate(runs):
                folder = os.path.join(SHOTS, f"{stamp}-{lang}{'-' + model if model else ''}", name)
                imgs = sorted(glob.glob(os.path.join(folder, f'run{i + 1}-*.png')))
                out.append((lang, name, i + 1, r, imgs))
    if not out: sys.exit('nothing to report')
    stamp = os.path.basename(paths[0])[7:17]
    css = """body{font:14px/1.45 Segoe UI,Arial,sans-serif;margin:24px;color:#222;max-width:1400px}
h1{font-size:22px} h2{font-size:17px;margin:28px 0 6px;border-top:2px solid #ccc;padding-top:14px}
.ok{color:#176b2c;font-weight:600}.bad{color:#b00020;font-weight:600}
table{border-collapse:collapse;margin:6px 0}td,th{border:1px solid #ccc;padding:3px 8px;text-align:left;font-size:13px}
th{background:#f3f3f3} pre{white-space:pre-wrap;background:#f7f7f7;padding:8px;font-size:12.5px;max-height:340px;overflow:auto}
.shots img{max-height:520px;border:1px solid #999;margin:4px 8px 4px 0;vertical-align:top}
details{margin:4px 0} summary{cursor:pointer;color:#0a4a8a}"""
    h = [f'<!doctype html><meta charset="utf-8"><title>Prüfmatrix {stamp}</title><style>{css}</style>',
         f'<h1>Prüfmatrix {stamp} – Auswertung mit Bildschirmfotos</h1>',
         '<p>Je Lauf: was erwartet war, welche gedruckten Zahlen DeskCalc NICHT bestätigt hat (Beleg gegen DeskCalc), '
         'die Antwort von Claude und die Fotos vor dem Bestätigen (links Belegstreifen: rot = Fehler, gelb = Folgefehler; '
         'rechts der DeskCalc-Streifen). „top“ = Anfang, „end“ = Ende des Streifens.</p>',
         '<table><tr><th>Sprache</th><th>Beleg</th><th>Lauf</th><th>Fehler gefunden</th><th>Fehlalarm</th><th>Aufrufe</th></tr>']
    for lang, name, n, r, imgs in out:
        h.append(f"<tr><td>{lang}</td><td><a href='#{lang}-{name}-{n}'>{html.escape(name)}</a></td><td>{n}</td>"
                 f"<td class='{'ok' if r['found'] else 'bad'}'>{'ja' if r['found'] else 'nein'}</td>"
                 f"<td class='{'bad' if r['false'] else 'ok'}'>{html.escape(', '.join(r['false'])) or '–'}</td><td>{r['calls']}</td></tr>")
    h.append('</table>')
    for lang, name, n, r, imgs in out:
        h.append(f"<h2 id='{lang}-{name}-{n}'>{html.escape(name)} ({lang}), Lauf {n}: "
                 f"<span class='{'ok' if r['found'] else 'bad'}'>{'gefunden' if r['found'] else 'NICHT gefunden'}</span>"
                 f"{' – <span class=bad>Fehlalarm: ' + html.escape(', '.join(r['false'])) + '</span>' if r['false'] else ''}</h2>")
        exp = expectation(name, lang)
        if exp: h.append(f'<details open><summary>Erwartet (Lösung)</summary><pre>{html.escape(exp)}</pre></details>')
        fl = r.get('failing')
        if fl is not None:
            if fl:
                h.append('<table><tr><th>Prüfung</th><th>Beleg</th><th>DeskCalc</th><th>Differenz</th><th>Folgefehler</th></tr>' +
                         ''.join(f"<tr><td>{html.escape(str(c.get('check')))}</td><td>{c.get('document')}</td><td>{c.get('deskcalc')}</td>"
                                 f"<td>{c.get('difference')}</td><td>{'ja' if c.get('follows') else ''}</td></tr>" for c in fl) + '</table>')
            else:
                h.append('<p class="ok">Alle gedruckten Zahlen stimmen mit dem bestätigten Streifen überein.</p>')
        h.append(f"<details open><summary>Antwort von Claude</summary><pre>{html.escape(r.get('answer', ''))}</pre></details>")
        if r.get('sent'):
            h.append(f"<details><summary>An DeskCalc geschickt ({len(r['sent'])} Aufruf(e))</summary><pre>{html.escape(json.dumps(r['sent'], indent=1, ensure_ascii=False))}</pre></details>")
        if imgs:
            h.append('<div class="shots">' + ''.join(f"<a href='{os.path.relpath(x, SHOTS).replace(os.sep, '/')}'><img src='{os.path.relpath(x, SHOTS).replace(os.sep, '/')}' "
                                                     f"title='{os.path.basename(x)}'></a>" for x in imgs) + '</div>')
        else:
            h.append('<p><i>Keine Fotos für diesen Lauf.</i></p>')
    target = os.path.join(SHOTS, f'Auswertung-{stamp}.html')
    os.makedirs(SHOTS, exist_ok=True)
    io.open(target, 'w', encoding='utf-8').write('\n'.join(h))
    print(target)

if __name__ == '__main__':
    main(sys.argv[1:])
