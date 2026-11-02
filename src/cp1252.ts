// Windows-1252 encoding. DeskCalc is an ANSI (MBCS) application; job and result
// files use windows-1252 so that €, umlauts and typographic quotes survive.
// Node can decode windows-1252 (TextDecoder) but not encode it, hence this table.

const HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

export interface Encoded {
  bytes: Buffer;
  replaced: number; // characters that have no windows-1252 form and became '?'
}

export function encodeCp1252(text: string): Encoded {
  const out: number[] = [];
  let replaced = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) out.push(cp);
    else if (HIGH[cp] !== undefined) out.push(HIGH[cp]);
    else { out.push(0x3f); replaced++; }
  }
  return { bytes: Buffer.from(out), replaced };
}

export function decodeCp1252(bytes: Uint8Array): string {
  return new TextDecoder('windows-1252').decode(bytes);
}
