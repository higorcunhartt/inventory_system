import { parseCsv, decodeText } from './csv.ts';
import { normalizeNumber } from './validate.ts';

export type Record_ = { number: string; voiceMinutes: number; dataMb: number; amount: number };
export type Mapping = { number: number | null; voice: number | null; data: number | null; amount: number | null };

export type ParseResult = {
  format: 'csv' | 'xlsx' | 'pdf';
  records: Record_[];
  headers: string[] | null;
  mapping: Mapping | null;
  detectedMonth: string | null; // AAAA-MM
  detectedCarrier: string | null;
  warnings: string[];
};

const CARRIERS: Array<[string, RegExp]> = [
  ['Vivo', /\bvivo\b|telef[oô]nica brasil/i],
  ['Claro', /\bclaro\b|claro s\.?a/i],
  ['TIM', /\btim\b|tim s\.?a/i],
  ['Oi', /\boi\b|oi s\.?a/i],
  ['Algar', /\balgar\b/i],
];

export function detectCarrier(raw: string): string | null {
  const text = raw.replace(/[_\-.]+/g, ' ');
  const hits = CARRIERS.map(([name, re]) => [name, (text.match(new RegExp(re.source, 'gi')) || []).length] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return hits[0]?.[0] ?? null;
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export function detectMonth(text: string): string | null {
  const labeled = text.match(/(?:refer[eê]ncia|compet[eê]ncia|per[ií]odo|vencimento)[^\d\n]{0,25}(?:\d{1,2}\/)?(\d{2})\/(\d{4})/i);
  if (labeled) return `${labeled[2]}-${labeled[1]}`;
  const named = text.match(new RegExp(`(${MONTHS.join('|')})\\s*(?:de|\\/)?\\s*(\\d{4})`, 'i'));
  if (named) return `${named[2]}-${String(MONTHS.indexOf(named[1].toLowerCase()) + 1).padStart(2, '0')}`;
  const plain = text.match(/\b(0[1-9]|1[0-2])\/(20\d{2})\b/);
  return plain ? `${plain[2]}-${plain[1]}` : null;
}

// ---------- conversão de valores ----------

export function parseAmount(raw: string): number {
  let s = raw.replace(/[^\d.,-]/g, '');
  if (!s || s === '-') return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Converte duração para minutos: "hh:mm:ss", "mm:ss", "12 min", ou número (usa dica da unidade). */
export function parseVoice(raw: string, unitHint: 'min' | 'sec' = 'min'): number {
  const s = raw.trim().toLowerCase();
  if (!s) return 0;
  const hms = s.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (hms) return Number(hms[1]) * 60 + Number(hms[2]) + Number(hms[3]) / 60;
  const ms = s.match(/^(\d+):(\d{2})$/);
  if (ms) return Number(ms[1]) + Number(ms[2]) / 60;
  const n = parseAmount(s);
  if (/\bseg|\bs\b/.test(s)) return n / 60;
  if (/\bh\b|hora/.test(s)) return n * 60;
  return unitHint === 'sec' ? n / 60 : n;
}

/** Converte volume de dados para MB. Aceita "1,5 GB", "500MB", "2048 KB" ou número (usa dica da unidade). */
export function parseData(raw: string, unitHint: 'kb' | 'mb' | 'gb' = 'mb'): number {
  const s = raw.trim().toLowerCase();
  if (!s) return 0;
  const n = parseAmount(s.replace(/[a-z]+/g, ''));
  const unit = s.match(/(kb|mb|gb|tb)/)?.[1] ?? unitHint;
  return unit === 'kb' ? n / 1024 : unit === 'gb' ? n * 1024 : unit === 'tb' ? n * 1024 * 1024 : n;
}

// ---------- tabelas (CSV / XLSX) ----------

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

const HEADER_PATTERNS: Record<keyof Mapping, RegExp> = {
  number: /^(numero|linha|telefone|acesso|msisdn|celular|terminal|n[o°º]? ?linha|designacao)/,
  voice: /minut|voz|duracao|chamada|ligac/,
  data: /dados|\bmb\b|\bgb\b|\bkb\b|volume|internet|trafego|navegacao/,
  amount: /valor|total|custo|r\$|cobrado|preco/,
};

export function autoMapping(headers: string[]): Mapping {
  const h = headers.map(norm);
  const pick = (key: keyof Mapping, exclude: Array<number | null> = []) => {
    const i = h.findIndex((x, idx) => !exclude.includes(idx) && HEADER_PATTERNS[key].test(x));
    return i >= 0 ? i : null;
  };
  const number = pick('number');
  const data = pick('data', [number]);
  const voice = pick('voice', [number, data]);
  const amount = pick('amount', [number, data, voice]);
  return { number, voice, data, amount };
}

function findHeaderRow(rows: string[][]): number {
  let best = 0;
  let bestScore = -1;
  rows.slice(0, 25).forEach((row, i) => {
    const m = autoMapping(row);
    const score = Object.values(m).filter((v) => v !== null).length;
    if (m.number !== null && score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

export function parseTable(rows: string[][], mappingOverride?: Mapping | null) {
  const warnings: string[] = [];
  const headerIdx = findHeaderRow(rows);
  const headers = rows[headerIdx] ?? [];
  const mapping = mappingOverride ?? autoMapping(headers);
  if (mapping.number === null) warnings.push('Coluna do número da linha não identificada. Selecione-a manualmente.');
  if (mapping.voice === null && mapping.data === null) warnings.push('Nenhuma coluna de voz ou dados identificada. Selecione manualmente.');

  const hdr = (i: number | null) => (i === null ? '' : norm(headers[i] ?? ''));
  const voiceHint = /\bseg|\(s\)/.test(hdr(mapping.voice)) ? 'sec' : 'min';
  const dataH = hdr(mapping.data);
  const dataHint = /\bkb\b|\(kb\)/.test(dataH) ? 'kb' : /\bgb\b|\(gb\)/.test(dataH) ? 'gb' : 'mb';

  const byNumber = new Map<string, Record_>();
  let skipped = 0;
  if (mapping.number !== null) {
    for (const row of rows.slice(headerIdx + 1)) {
      const number = normalizeNumber(row[mapping.number] ?? '');
      if (!number) {
        skipped++;
        continue;
      }
      const rec = byNumber.get(number) ?? { number, voiceMinutes: 0, dataMb: 0, amount: 0 };
      if (mapping.voice !== null) rec.voiceMinutes += parseVoice(row[mapping.voice] ?? '', voiceHint);
      if (mapping.data !== null) rec.dataMb += parseData(row[mapping.data] ?? '', dataHint);
      if (mapping.amount !== null) rec.amount += parseAmount(row[mapping.amount] ?? '');
      byNumber.set(number, rec);
    }
  }
  if (skipped > 0) warnings.push(`${skipped} linha(s) da planilha ignoradas por não terem um número de telefone válido (totais, cabeçalhos etc.).`);
  return { headers, mapping, records: [...byNumber.values()].map(round), warnings };
}

// ---------- PDF (heurística sobre o texto) ----------

const PHONE_RE = /\(?\b(\d{2})\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})\b/;

export function parseInvoiceText(text: string) {
  const warnings = ['Leitura de PDF é heurística: confira a prévia antes de salvar.'];
  const lines = text.split(/\r?\n/);
  const blocks = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines) {
    const m = line.match(PHONE_RE);
    const number = m ? normalizeNumber(`${m[1]}${m[2]}${m[3]}`) : null;
    if (number) current = number;
    if (current) {
      const arr = blocks.get(current) ?? [];
      arr.push(line);
      blocks.set(current, arr);
    }
  }

  const records: Record_[] = [];
  for (const [number, blockLines] of blocks) {
    const block = blockLines.join('\n');
    let voice = 0;
    const durations = [...block.matchAll(/\b(\d{1,4}):(\d{2}):(\d{2})\b/g)];
    for (const d of durations) voice += Number(d[1]) * 60 + Number(d[2]) + Number(d[3]) / 60;
    if (!durations.length) for (const m of block.matchAll(/(\d+(?:[.,]\d+)?)\s*min(?:utos?)?\b/gi)) voice += parseAmount(m[1]);

    let data = 0;
    for (const m of block.matchAll(/(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:[.,]\d+)?)\s*(KB|MB|GB)\b/gi)) data += parseData(`${m[1]} ${m[2]}`);

    const total = block.match(/total[^\n]*?R\$\s*([\d.]+,\d{2})/i);
    let amount = 0;
    if (total) amount = parseAmount(total[1]);
    else for (const m of block.matchAll(/R\$\s*(-?[\d.]+,\d{2})/g)) amount += parseAmount(m[1]);

    records.push(round({ number, voiceMinutes: voice, dataMb: data, amount }));
  }
  if (!records.length) warnings.push('Nenhum número de telefone foi encontrado no PDF. Se a fatura for escaneada (imagem), exporte o detalhamento em CSV/XLSX na área do cliente da operadora.');
  return { records, warnings };
}

const round = (r: Record_): Record_ => ({
  number: r.number,
  voiceMinutes: Math.round(r.voiceMinutes * 100) / 100,
  dataMb: Math.round(r.dataMb * 100) / 100,
  amount: Math.round(r.amount * 100) / 100,
});

// ---------- entrada principal ----------

export async function parseInvoice(filename: string, bytes: Uint8Array, mappingOverride?: Mapping | null): Promise<ParseResult> {
  const ext = filename.toLowerCase().split('.').pop() ?? '';

  if (ext === 'pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    const { records, warnings } = parseInvoiceText(text);
    return { format: 'pdf', records, headers: null, mapping: null, detectedMonth: detectMonth(text), detectedCarrier: detectCarrier(text), warnings };
  }

  let rows: string[][];
  let format: 'csv' | 'xlsx';
  let sampleText: string;
  if (ext === 'xlsx') {
    const { default: readXlsx } = await import('read-excel-file/node');
    const buf = Buffer.from(bytes);
    const sheets = (await readXlsx(buf)) as unknown as Array<{ sheet: string; data: unknown[][] }> | unknown[][];
    const data = Array.isArray(sheets) && sheets.length && !Array.isArray(sheets[0]) ? (sheets as Array<{ data: unknown[][] }>)[0].data : (sheets as unknown[][]);
    rows = data.map((r) => r.map((c) => (c === null || c === undefined ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))));
    format = 'xlsx';
    sampleText = rows.slice(0, 30).map((r) => r.join(' ')).join('\n') + ' ' + filename;
  } else if (ext === 'csv' || ext === 'txt') {
    const text = decodeText(bytes);
    rows = parseCsv(text);
    format = 'csv';
    sampleText = text.slice(0, 5000) + ' ' + filename;
  } else {
    throw new Error('Formato não suportado. Envie PDF, CSV ou XLSX.');
  }

  const { headers, mapping, records, warnings } = parseTable(rows, mappingOverride);
  return { format, records, headers, mapping, detectedMonth: detectMonth(sampleText), detectedCarrier: detectCarrier(sampleText), warnings };
}
