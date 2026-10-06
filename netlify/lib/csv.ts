/** Parser CSV mínimo (aspas, delimitador automático ; , tab). */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  let best = ',';
  let bestScore = -1;
  for (const d of [';', ',', '\t']) {
    const score = sample.reduce((n, l) => n + (l.split(d).length - 1), 0);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  const flush = () => {
    row.push(cell);
    cell = '';
    if (row.some((x) => x.trim() !== '')) rows.push(row.map((x) => x.trim()));
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      flush();
    } else cell += c;
  }
  flush();
  return rows;
}

/** Decodifica bytes de CSV/TXT: UTF-8, com fallback para Windows-1252. */
export function decodeText(buf: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
}
