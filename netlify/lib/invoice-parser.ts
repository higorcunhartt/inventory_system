import { parseCsv, decodeText } from './csv.ts';
import { normalizeNumber } from './validate.ts';

/** Erro com mensagem segura para exibir ao usuário (limites, formato não suportado). */
export class UserFacingParseError extends Error {}

// Limites de recursos para arquivos de terceiros (evita travar a função com arquivos patológicos)
export const LIMITS = {
  MAX_PDF_PAGES: 500,
  MAX_TEXT_CHARS: 4_000_000,
  MAX_LINE_CHARS: 2000,
  MAX_ROWS: 100_000,
  MAX_ZIP_UNCOMPRESSED: 100 * 1024 * 1024,
  MAX_ZIP_ENTRIES: 3000,
  MAX_VALUE: 1e12,
};
const BAD_FILE = 'Arquivo inválido ou corrompido. Envie um PDF, CSV ou XLSX válido.';

/**
 * Confere, pelo diretório central do ZIP (sem descompactar), o tamanho total descompactado e o número de
 * entradas de um XLSX: bloqueia "bombas de compressão" antes de entregar o arquivo à biblioteca.
 */
export function checkZipLimits(bytes: Uint8Array, maxUncompressed = LIMITS.MAX_ZIP_UNCOMPRESSED, maxEntries = LIMITS.MAX_ZIP_ENTRIES): void {
  if (bytes.length < 22) throw new UserFacingParseError(BAD_FILE);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UserFacingParseError(BAD_FILE);
  const entries = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  if (entries > maxEntries) throw new UserFacingParseError('A planilha tem estrutura interna grande demais.');
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (off + 46 > bytes.length || dv.getUint32(off, true) !== 0x02014b50) throw new UserFacingParseError(BAD_FILE);
    total += dv.getUint32(off + 24, true);
    if (total > maxUncompressed) throw new UserFacingParseError('A planilha é grande demais depois de descompactada.');
    off += 46 + dv.getUint16(off + 28, true) + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
  }
}

export type Record_ = { number: string; voiceMinutes: number; dataMb: number; amount: number };
export type Mapping = { number: number | null; voice: number | null; data: number | null; amount: number | null };

export type ParseResult = {
  format: 'csv' | 'xlsx' | 'pdf';
  records: Record_[];
  headers: string[] | null;
  mapping: Mapping | null;
  detectedMonth: string | null; // AAAA-MM
  detectedCarrier: string | null;
  detectedAccount: string | null;
  warnings: string[];
  invalidCount: number; // células numéricas ilegíveis ou fora de faixa (viram 0 e bloqueiam o salvamento)
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

/** Número da conta, quando o texto o informa ("Número da Conta: 0371235565"). */
export function detectAccount(text: string): string | null {
  const m = text.match(/(?:n[úu]mero da conta|n[º°o] da conta|\bconta)\s{0,3}:?\s{0,3}(\d{8,12})\b/i);
  return m ? m[1] : null;
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

/**
 * Converte texto numérico (formato BR, US ou notação científica) em número.
 * Devolve null quando ilegível ou fora de faixa; texto vazio vale 0.
 */
export function toNumber(raw: string): number | null {
  const t = raw.trim();
  if (!t) return 0;
  const ok = (n: number) => (Number.isFinite(n) && Math.abs(n) <= LIMITS.MAX_VALUE ? n : null);
  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(t)) return ok(Number(t));
  let s = t.replace(/[^\d.,-]/g, '');
  if (!s || s === '-') return 0;
  if (s.length > 20) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  return ok(Number(s));
}

export function parseAmount(raw: string): number {
  return toNumber(raw) ?? 0;
}

/** Converte duração para minutos: "hh:mm:ss", "mm:ss", "12 min", ou número (usa dica da unidade). */
export function parseVoice(raw: string, unitHint: 'min' | 'sec' = 'min'): number {
  const s = raw.trim().toLowerCase();
  if (!s) return 0;
  const hms = s.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (hms) return Number(hms[1]) * 60 + Number(hms[2]) + Number(hms[3]) / 60;
  const ms = s.match(/^(\d+):(\d{2})$/);
  if (ms) return Number(ms[1]) + Number(ms[2]) / 60;
  const n = toNumber(s) ?? NaN; // NaN = ilegível (contado como inválido pelo chamador)
  if (/\bseg|\bs\b/.test(s)) return n / 60;
  if (/\bh\b|hora/.test(s)) return n * 60;
  return unitHint === 'sec' ? n / 60 : n;
}

/** Converte volume de dados para MB. Aceita "1,5 GB", "500MB", "2048 KB" ou número (usa dica da unidade). */
export function parseData(raw: string, unitHint: 'kb' | 'mb' | 'gb' = 'mb'): number {
  const s = raw.trim().toLowerCase();
  if (!s) return 0;
  const n = toNumber(s.replace(/[a-z]+/g, '')) ?? NaN;
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
  let invalid = 0;
  const take = (v: number) => {
    if (!Number.isFinite(v) || Math.abs(v) > LIMITS.MAX_VALUE) {
      invalid++;
      return 0;
    }
    return v;
  };
  if (rows.length > LIMITS.MAX_ROWS) throw new UserFacingParseError(`A planilha tem linhas demais (máximo ${LIMITS.MAX_ROWS.toLocaleString('pt-BR')}).`);
  if (mapping.number !== null) {
    for (const row of rows.slice(headerIdx + 1)) {
      const number = normalizeNumber(row[mapping.number] ?? '');
      if (!number) {
        skipped++;
        continue;
      }
      const rec = byNumber.get(number) ?? { number, voiceMinutes: 0, dataMb: 0, amount: 0 };
      if (mapping.voice !== null) rec.voiceMinutes += take(parseVoice(row[mapping.voice] ?? '', voiceHint));
      if (mapping.data !== null) rec.dataMb += take(parseData(row[mapping.data] ?? '', dataHint));
      if (mapping.amount !== null) rec.amount += take(toNumber(row[mapping.amount] ?? '') ?? NaN);
      byNumber.set(number, rec);
    }
  }
  if (skipped > 0) warnings.push(`${skipped} linha(s) da planilha ignoradas por não terem um número de telefone válido (totais, cabeçalhos etc.).`);
  if (invalid > 0) warnings.push(`${invalid} valor(es) numérico(s) ilegíveis ou fora de faixa foram tratados como zero. Corrija o arquivo antes de salvar.`);
  return { headers, mapping, records: [...byNumber.values()].map(round), warnings, invalidCount: invalid };
}

// ---------- PDF (heurística sobre o texto) ----------

const PHONE_RE = /\(?\b(\d{2})\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})\b/;

export function parseInvoiceText(text: string) {
  const warnings = ['Leitura de PDF é heurística: confira a prévia antes de salvar.'];
  const lines = text.split(/\r?\n/).map((l) => (l.length > LIMITS.MAX_LINE_CHARS ? l.slice(0, LIMITS.MAX_LINE_CHARS) : l));
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
    if (!durations.length) for (const m of block.matchAll(/(\d{1,9}(?:[.,]\d{1,6})?)\s{0,3}min(?:utos?)?\b/gi)) voice += parseAmount(m[1]);

    let data = 0;
    for (const m of block.matchAll(/(\d{1,3}(?:\.\d{3}){0,4}(?:,\d{1,6})?|\d{1,12}(?:[.,]\d{1,6})?)\s{0,3}(KB|MB|GB)\b/gi)) data += parseData(`${m[1]} ${m[2]}`);

    const total = block.match(/total[^\n]{0,80}?R\$\s{0,3}([\d.]{1,15},\d{2})/i);
    let amount = 0;
    if (total) amount = parseAmount(total[1]);
    else for (const m of block.matchAll(/R\$\s{0,3}(-?[\d.]{1,15},\d{2})/g)) amount += parseAmount(m[1]);

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
    if (pdf.numPages > LIMITS.MAX_PDF_PAGES) {
      throw new UserFacingParseError(
        `A fatura tem ${pdf.numPages} páginas (máximo ${LIMITS.MAX_PDF_PAGES}). Para faturas desse tamanho, exporte o detalhamento em CSV/XLSX no portal da operadora.`,
      );
    }
    const { text } = await extractText(pdf, { mergePages: true });
    if (text.length > LIMITS.MAX_TEXT_CHARS) throw new UserFacingParseError('O texto da fatura é grande demais para ser processado. Use o CSV/XLSX da operadora.');
    const { records, warnings } = parseInvoiceText(text);
    return { format: 'pdf', records, headers: null, mapping: null, detectedMonth: detectMonth(text), detectedCarrier: detectCarrier(text), detectedAccount: detectAccount(text), warnings, invalidCount: 0 };
  }

  let rows: string[][];
  let format: 'csv' | 'xlsx';
  let sampleText: string;
  if (ext === 'xlsx') {
    checkZipLimits(bytes);
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
    if (rows.length > LIMITS.MAX_ROWS) throw new UserFacingParseError(`O arquivo tem linhas demais (máximo ${LIMITS.MAX_ROWS.toLocaleString('pt-BR')}).`);
    format = 'csv';
    sampleText = text.slice(0, 5000) + ' ' + filename;
  } else {
    throw new UserFacingParseError('Formato não suportado. Envie PDF, CSV ou XLSX.');
  }

  const { headers, mapping, records, warnings, invalidCount } = parseTable(rows, mappingOverride);
  return { format, records, headers, mapping, detectedMonth: detectMonth(sampleText), detectedCarrier: detectCarrier(sampleText), detectedAccount: detectAccount(sampleText), warnings, invalidCount };
}
