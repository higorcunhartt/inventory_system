import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseData, parseVoice, parseTable, parseInvoiceText, detectMonth, detectCarrier, parseInvoice } from '../netlify/lib/invoice-parser.ts';
import { parseCsv } from '../netlify/lib/csv.ts';
import { normalizeNumber } from '../netlify/lib/validate.ts';

test('normalizeNumber', () => {
  assert.equal(normalizeNumber('(11) 98765-4321'), '11987654321');
  assert.equal(normalizeNumber('+55 11 98765-4321'), '11987654321');
  assert.equal(normalizeNumber('1133334444'), '1133334444');
  assert.equal(normalizeNumber('12345'), null);
});

test('parseAmount aceita formato BR e US', () => {
  assert.equal(parseAmount('R$ 1.234,56'), 1234.56);
  assert.equal(parseAmount('49,90'), 49.9);
  assert.equal(parseAmount('1234.56'), 1234.56);
  assert.equal(parseAmount(''), 0);
});

test('parseVoice e parseData', () => {
  assert.equal(parseVoice('01:30:00'), 90);
  assert.equal(parseVoice('10:30'), 10.5);
  assert.equal(parseVoice('120', 'sec'), 2);
  assert.equal(parseVoice('45'), 45);
  assert.equal(parseData('1,5 GB'), 1536);
  assert.equal(parseData('2048 KB'), 2);
  assert.equal(parseData('500'), 500);
  assert.equal(parseData('2', 'gb'), 2048);
});

test('parseCsv com ; e aspas', () => {
  const rows = parseCsv('a;b\n"x;1";"he said ""hi"""\n');
  assert.deepEqual(rows, [['a', 'b'], ['x;1', 'he said "hi"']]);
});

test('parseTable mapeia colunas e soma por número (detalhado)', () => {
  const rows = parseCsv(
    'Relatório de consumo\nLinha;Minutos;Dados (MB);Valor\n(11) 98765-4321;10;100,5;R$ 10,00\n11987654321;5;50;R$ 5,50\n(21) 99999-0000;0;1024;49,90\nTotal;15;1174,5;65,40\n',
  );
  const { records, mapping } = parseTable(rows);
  assert.deepEqual(mapping, { number: 0, voice: 1, data: 2, amount: 3 });
  assert.equal(records.length, 2);
  const a = records.find((r) => r.number === '11987654321')!;
  assert.deepEqual(a, { number: '11987654321', voiceMinutes: 15, dataMb: 150.5, amount: 15.5 });
});

test('parseInvoiceText agrega blocos por número', () => {
  const text = `Fatura referência 09/2026 Vivo
(11) 98765-4321 Plano Controle
Chamada 00:10:30 R$ 1,00
Internet 1,5 GB
Total da linha R$ 59,90
(11) 91234-5678
Chamada 00:02:00
Navegação 512 MB
Total R$ 20,00`;
  const { records } = parseInvoiceText(text);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], { number: '11987654321', voiceMinutes: 10.5, dataMb: 1536, amount: 59.9 });
  assert.deepEqual(records[1], { number: '11912345678', voiceMinutes: 2, dataMb: 512, amount: 20 });
  assert.equal(detectMonth(text), '2026-09');
  assert.equal(detectCarrier(text), 'Vivo');
});

test('parseInvoice lê CSV em latin1', async () => {
  const csv = 'Número;Minutos;Dados (MB);Valor\n11987654321;10;100;10,00\n';
  const bytes = new Uint8Array(Buffer.from(csv, 'latin1'));
  const r = await parseInvoice('claro_2026-08.csv', bytes);
  assert.equal(r.format, 'csv');
  assert.equal(r.records.length, 1);
  assert.equal(r.detectedCarrier, 'Claro');
});

// ---------- AUD-010 / AUD-016: limites e validação numérica ----------
import { toNumber, checkZipLimits, UserFacingParseError, LIMITS } from '../netlify/lib/invoice-parser.ts';

test('AUD-016: notação científica e valores fora de faixa não viram números errados', () => {
  assert.equal(toNumber('1.5e3'), 1500);
  assert.equal(toNumber('1e+21'), null);
  assert.equal(toNumber('9'.repeat(400)), null);
  assert.equal(toNumber('R$ 1.234,56'), 1234.56);
  assert.equal(toNumber(''), 0);
  assert.equal(toNumber('-'), 0);
});

test('AUD-016: parseTable conta valores inválidos e não os soma', () => {
  const rows = parseCsv(`Linha;Minutos;Valor\n11987654321;10;${'9'.repeat(400)}\n11987654322;5;1e+21\n11987654323;1;10,00\n`);
  const r = parseTable(rows);
  assert.equal(r.invalidCount, 2);
  assert.equal(r.records.find((x) => x.number === '11987654323')!.amount, 10);
  assert.equal(r.records.find((x) => x.number === '11987654321')!.amount, 0);
  assert.ok(r.warnings.some((w) => /ilegíveis/.test(w)));
});

test('AUD-010: sequência gigante de dígitos em PDF é processada em tempo curto', () => {
  for (const n of [20_000, 80_000, 200_000]) {
    const t0 = performance.now();
    const { records } = parseInvoiceText(`(11) 98765-4321\n${'1'.repeat(n)}x\nChamada 00:01:00\nInternet 2 GB\n`);
    const ms = performance.now() - t0;
    assert.ok(ms < 300, `${n} dígitos levou ${ms.toFixed(0)} ms`);
    assert.equal(records[0].voiceMinutes, 1);
    assert.equal(records[0].dataMb, 2048);
  }
});

function fakeZip(entries: Array<[string, number]>, eocdOnly = false): Uint8Array {
  const parts: Buffer[] = [];
  let cdSize = 0;
  for (const [name, size] of entries) {
    const h = Buffer.alloc(46 + name.length);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt32LE(size, 24);
    h.writeUInt16LE(name.length, 28);
    h.write(name, 46);
    parts.push(h);
    cdSize += h.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(0, 16);
  return new Uint8Array(Buffer.concat(eocdOnly ? [eocd] : [...parts, eocd]));
}

test('AUD-010: checkZipLimits bloqueia bomba de compressão e arquivos que não são ZIP', () => {
  checkZipLimits(fakeZip([['xl/workbook.xml', 1000], ['xl/worksheets/sheet1.xml', 5_000_000]]));
  assert.throws(() => checkZipLimits(fakeZip([['xl/worksheets/sheet1.xml', 2 * 1024 * 1024 * 1024]])), UserFacingParseError);
  assert.throws(() => checkZipLimits(fakeZip([['a', LIMITS.MAX_ZIP_UNCOMPRESSED], ['b', 10]])), /descompactada/);
  assert.throws(() => checkZipLimits(fakeZip(Array.from({ length: LIMITS.MAX_ZIP_ENTRIES + 1 }, (_, i) => [`f${i}`, 1] as [string, number]))), /estrutura interna/);
  assert.throws(() => checkZipLimits(new Uint8Array(Buffer.from('isto não é um zip nem de longe, é só texto comum aqui'))), UserFacingParseError);
  assert.throws(() => checkZipLimits(new Uint8Array(5)), UserFacingParseError);
});
