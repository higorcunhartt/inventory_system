import { createHash } from 'node:crypto';
import { sql } from '../lib/db.ts';
import { HttpError, json, readJson, type Route } from '../lib/http.ts';
import { requireUser } from '../lib/auth.ts';
import { audit } from '../lib/audit.ts';
import { parseInvoice, UserFacingParseError, type Mapping } from '../lib/invoice-parser.ts';
import { month, phoneParam, reqStr, str, uuid } from '../lib/validate.ts';

const MAX_FILE_BYTES = 4_300_000; // limite de ~6 MB do corpo da função, já considerando o base64

function readMapping(v: unknown): Mapping | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  const col = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 500 ? x : null);
  return { number: col(m.number), voice: col(m.voice), data: col(m.data), amount: col(m.amount) };
}

async function readFile(body: Record<string, any>) {
  const filename = reqStr(body.filename, 'arquivo', 255);
  const b64 = reqStr(body.contentBase64, 'conteúdo', 8_000_000);
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'Arquivo muito grande (máximo ~4 MB)');
  if (!bytes.length) throw new HttpError(400, 'Arquivo vazio');
  try {
    const parsed = await parseInvoice(filename, bytes, readMapping(body.mapping));
    return { filename, bytes, parsed };
  } catch (err: any) {
    // Mensagens internas das bibliotecas ficam só no log do servidor; o cliente recebe texto seguro.
    if (err instanceof UserFacingParseError) throw new HttpError(422, err.message);
    console.error('Falha ao ler fatura:', err);
    throw new HttpError(422, 'Não foi possível ler o arquivo. Verifique se é um PDF, CSV ou XLSX válido e não corrompido.');
  }
}

const num = (v: unknown) => Number(v ?? 0);

function periodFilters(url: URL) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  return {
    from: month(from, 'from'),
    to: month(to, 'to'),
    carrier: str(url.searchParams.get('carrier'), 'operadora', { max: 60 }),
    project: str(url.searchParams.get('project'), 'projeto', { max: 120 }),
  };
}

export const consumptionRoutes: Route[] = [
  // Lê o arquivo e devolve a prévia (nada é gravado).
  [
    'POST',
    '/consumption/parse',
    async ({ req }) => {
      await requireUser(req, { roles: ['admin'] });
      const { parsed } = await readFile(await readJson(req));
      const numbers = parsed.records.map((r) => r.number);
      const known = numbers.length ? await sql`select number from lines where number = any(${numbers}::text[])` : [];
      const knownSet = new Set(known.map((k) => k.number));
      return json({
        format: parsed.format,
        headers: parsed.headers,
        mapping: parsed.mapping,
        detectedMonth: parsed.detectedMonth,
        detectedCarrier: parsed.detectedCarrier,
        warnings: parsed.warnings,
        invalidCount: parsed.invalidCount,
        totals: {
          lines: parsed.records.length,
          registered: parsed.records.filter((r) => knownSet.has(r.number)).length,
          voiceMinutes: parsed.records.reduce((s, r) => s + r.voiceMinutes, 0),
          dataMb: parsed.records.reduce((s, r) => s + r.dataMb, 0),
          amount: parsed.records.reduce((s, r) => s + r.amount, 0),
        },
        records: parsed.records.slice(0, 500).map((r) => ({ ...r, registered: knownSet.has(r.number) })),
      });
    },
  ],

  // Reprocessa o arquivo no servidor e grava a fatura + consumo por linha.
  [
    'POST',
    '/consumption/invoices',
    async ({ req }) => {
      const user = await requireUser(req, { roles: ['admin'] });
      const body = await readJson(req);
      const { filename, bytes, parsed } = await readFile(body);
      const carrier = reqStr(body.carrier, 'operadora', 60);
      const reference = month(body.referenceMonth, 'mês de referência');
      if (!parsed.records.length) throw new HttpError(422, 'Nenhuma linha com consumo foi encontrada no arquivo');
      if (parsed.invalidCount > 0) {
        throw new HttpError(422, `${parsed.invalidCount} valor(es) numérico(s) do arquivo estão ilegíveis ou fora de faixa. Corrija o arquivo e envie novamente.`);
      }
      const hash = createHash('sha256').update(bytes).digest('hex');
      const total = parsed.records.reduce((s, r) => s + r.amount, 0);
      const rows = parsed.records.map((r) => ({ number: r.number, voice: r.voiceMinutes, data: r.dataMb, amount: r.amount }));

      const out = await sql`
        with inv as (
          insert into invoices (carrier, reference_month, filename, file_hash, total_amount, uploaded_by)
          values (${carrier}, ${reference}::date, ${filename}, ${hash}, ${Math.round(total * 100) / 100}, ${user.name})
          on conflict (file_hash) do nothing
          returning id
        ), ins as (
          insert into consumption (invoice_id, number, voice_minutes, data_mb, amount, assignee_name, project)
          select inv.id, r.number, r.voice, r.data, r.amount, l.assignee_name, l.project
          from inv
          cross join jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as r(number text, voice numeric, data numeric, amount numeric)
          left join lines l on l.number = r.number
          returning 1
        )
        select (select id from inv) as id, (select count(*)::int from ins) as n`;
      if (!out[0].id) throw new HttpError(409, 'Esta fatura (mesmo arquivo) já foi enviada anteriormente');
      await audit(req, user, 'invoice_saved', { target: filename, detail: { invoiceId: out[0].id, carrier, month: reference.slice(0, 7), lines: out[0].n } });
      return json({ id: out[0].id, lines: out[0].n }, 201);
    },
  ],

  [
    'GET',
    '/consumption/invoices',
    async ({ req }) => {
      await requireUser(req, { roles: ['admin'] });
      const rows = await sql`
        select i.id, i.carrier, to_char(i.reference_month, 'YYYY-MM') as month, i.filename, i.total_amount,
               i.uploaded_by, i.uploaded_at, count(c.id)::int as lines
        from invoices i left join consumption c on c.invoice_id = i.id
        group by i.id order by i.reference_month desc, i.uploaded_at desc limit 200`;
      return json({
        invoices: rows.map((r) => ({
          id: r.id,
          carrier: r.carrier,
          month: r.month,
          filename: r.filename,
          totalAmount: num(r.total_amount),
          uploadedBy: r.uploaded_by,
          uploadedAt: r.uploaded_at,
          lines: r.lines,
        })),
      });
    },
  ],

  [
    'DELETE',
    '/consumption/invoices/:id',
    async ({ req, params }) => {
      const user = await requireUser(req, { roles: ['admin'] });
      const rows = await sql`delete from invoices where id = ${uuid(params.id)} returning id, filename, carrier, to_char(reference_month, 'YYYY-MM') as month`;
      if (!rows.length) throw new HttpError(404, 'Fatura não encontrada');
      await audit(req, user, 'invoice_deleted', { target: rows[0].filename, detail: { invoiceId: rows[0].id, carrier: rows[0].carrier, month: rows[0].month } });
      return json({ ok: true });
    },
  ],

  // Consumo agregado por mês e por linha dentro do período.
  [
    'GET',
    '/consumption/summary',
    async ({ req, url }) => {
      await requireUser(req, { roles: ['admin'] });
      const f = periodFilters(url);
      const months = await sql`
        select to_char(i.reference_month, 'YYYY-MM') as month, sum(c.voice_minutes) as voice, sum(c.data_mb) as data,
               sum(c.amount) as amount, count(distinct c.number)::int as lines
        from consumption c join invoices i on i.id = c.invoice_id
        where i.reference_month between ${f.from}::date and ${f.to}::date
          and (${f.carrier}::text is null or i.carrier = ${f.carrier})
          and (${f.project}::text is null or c.project = ${f.project})
        group by 1 order by 1`;
      const lines = await sql`
        select c.number,
               max(i.carrier) as carrier,
               (array_agg(c.assignee_name order by i.reference_month desc))[1] as assignee_name,
               (array_agg(c.project order by i.reference_month desc))[1] as project,
               max(l.line_type) as line_type,
               bool_or(l.id is not null) as registered,
               sum(c.voice_minutes) as voice, sum(c.data_mb) as data, sum(c.amount) as amount
        from consumption c
          join invoices i on i.id = c.invoice_id
          left join lines l on l.number = c.number
        where i.reference_month between ${f.from}::date and ${f.to}::date
          and (${f.carrier}::text is null or i.carrier = ${f.carrier})
          and (${f.project}::text is null or c.project = ${f.project})
        group by c.number order by sum(c.data_mb) desc, c.number`;
      const projects = await sql`select distinct project from consumption where project is not null order by 1`;
      const carriers = await sql`select distinct carrier from invoices order by 1`;
      return json({
        months: months.map((m) => ({ month: m.month, voiceMinutes: num(m.voice), dataMb: num(m.data), amount: num(m.amount), lines: m.lines })),
        lines: lines.map((l) => ({
          number: l.number,
          carrier: l.carrier,
          assigneeName: l.assignee_name,
          project: l.project,
          lineType: l.line_type,
          registered: l.registered,
          voiceMinutes: num(l.voice),
          dataMb: num(l.data),
          amount: num(l.amount),
        })),
        projects: projects.map((p) => p.project),
        carriers: carriers.map((c) => c.carrier),
      });
    },
  ],

  // Histórico mensal de uma linha.
  [
    'GET',
    '/consumption/lines/:number',
    async ({ req, params, url }) => {
      await requireUser(req, { roles: ['admin'] });
      const from = month(url.searchParams.get('from'), 'from');
      const to = month(url.searchParams.get('to'), 'to');
      const rows = await sql`
        select to_char(i.reference_month, 'YYYY-MM') as month, sum(c.voice_minutes) as voice, sum(c.data_mb) as data,
               sum(c.amount) as amount, max(c.assignee_name) as assignee_name, max(c.project) as project
        from consumption c join invoices i on i.id = c.invoice_id
        where c.number = ${phoneParam(params.number)} and i.reference_month between ${from}::date and ${to}::date
        group by 1 order by 1`;
      return json({
        months: rows.map((m) => ({
          month: m.month,
          voiceMinutes: num(m.voice),
          dataMb: num(m.data),
          amount: num(m.amount),
          assigneeName: m.assignee_name,
          project: m.project,
        })),
      });
    },
  ],
];
