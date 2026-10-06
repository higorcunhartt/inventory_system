import { sql } from '../lib/db.ts';
import { HttpError, json, readJson, type Route } from '../lib/http.ts';
import { requireUser } from '../lib/auth.ts';
import { parseCsv } from '../lib/csv.ts';
import { isoDate, lineType, normalizeNumber, reqStr, str } from '../lib/validate.ts';

const toLine = (r: Record<string, any>) => ({
  id: r.id,
  number: r.number,
  carrier: r.carrier,
  lineType: r.line_type,
  assigneeName: r.assignee_name,
  project: r.project,
  deliveryDate: r.delivery_date,
  notes: r.notes,
  updatedAt: r.updated_at,
});

const OPERATOR_FIELDS = new Set(['assigneeName', 'deliveryDate']);
const ADMIN_FIELDS = new Set(['number', 'carrier', 'lineType', 'assigneeName', 'project', 'deliveryDate', 'notes']);

function requireNumber(v: unknown) {
  const n = normalizeNumber(reqStr(v, 'número', 30));
  if (!n) throw new HttpError(400, 'Número inválido (informe DDD + número, 10 ou 11 dígitos)');
  return n;
}

function parseDate(v: string): string | null {
  const br = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = br ? `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}` : v;
  return isoDate(iso, 'data de entrega');
}

const HEADERS: Array<[string, RegExp]> = [
  ['number', /^(numero|linha|telefone|celular)/],
  ['carrier', /operadora/],
  ['type', /^tipo/],
  ['assignee', /usuario|responsavel|colaborador/],
  ['project', /projeto|local/],
  ['delivery', /entrega/],
  ['notes', /obs/],
];
const normHeader = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

export const lineRoutes: Route[] = [
  [
    'GET',
    '/lines',
    async ({ req }) => {
      await requireUser(req);
      const rows = await sql`select id, number, carrier, line_type, assignee_name, project,
                                    to_char(delivery_date, 'YYYY-MM-DD') as delivery_date, notes, updated_at
                             from lines order by number`;
      return json({ lines: rows.map(toLine) });
    },
  ],

  [
    'POST',
    '/lines',
    async ({ req }) => {
      const user = await requireUser(req, { roles: ['admin'] });
      const b = await readJson(req);
      const number = requireNumber(b.number);
      const carrier = reqStr(b.carrier, 'operadora', 60);
      const type = lineType(b.lineType);
      const assignee = str(b.assigneeName, 'usuário', { max: 120 });
      const project = str(b.project, 'projeto', { max: 120 });
      const delivery = isoDate(b.deliveryDate, 'data de entrega');
      const notes = str(b.notes, 'observações', { max: 500 });
      const rows = await sql`
        with ins as (
          insert into lines (number, carrier, line_type, assignee_name, project, delivery_date, notes)
          values (${number}, ${carrier}, ${type}, ${assignee}, ${project}, ${delivery}::date, ${notes})
          on conflict (number) do nothing
          returning *
        ), h as (
          insert into line_history (line_id, action, assignee_name, project, delivery_date, changed_by_name)
          select id, 'create', assignee_name, project, delivery_date, ${user.name} from ins
        )
        select id, number, carrier, line_type, assignee_name, project,
               to_char(delivery_date, 'YYYY-MM-DD') as delivery_date, notes, updated_at from ins`;
      if (!rows.length) throw new HttpError(409, 'Já existe uma linha com este número');
      return json({ line: toLine(rows[0]) }, 201);
    },
  ],

  [
    'POST',
    '/lines/import',
    async ({ req }) => {
      const user = await requireUser(req, { roles: ['admin'] });
      const b = await readJson(req, 2_000_000);
      const csv = reqStr(b.csv, 'csv', 1_500_000);
      const rows = parseCsv(csv);
      if (rows.length < 2) throw new HttpError(400, 'O arquivo precisa ter cabeçalho e ao menos uma linha');
      const header = rows[0].map(normHeader);
      const col: Record<string, number> = {};
      for (const [key, re] of HEADERS) {
        const i = header.findIndex((h, idx) => re.test(h) && !Object.values(col).includes(idx));
        if (i >= 0) col[key] = i;
      }
      for (const need of ['number', 'carrier', 'type']) {
        if (col[need] === undefined) throw new HttpError(400, `Coluna obrigatória não encontrada: ${need === 'number' ? 'Número' : need === 'carrier' ? 'Operadora' : 'Tipo'}`);
      }
      if (rows.length - 1 > 2000) throw new HttpError(400, 'Máximo de 2000 linhas por importação');

      const errors: Array<{ row: number; message: string }> = [];
      const seen = new Set<string>();
      const valid: Array<Record<string, string | null>> = [];
      rows.slice(1).forEach((r, i) => {
        const rowNo = i + 2;
        const cell = (k: string) => (col[k] === undefined ? '' : (r[col[k]] ?? '').trim());
        const number = normalizeNumber(cell('number'));
        if (!number) return void errors.push({ row: rowNo, message: 'Número inválido' });
        if (seen.has(number)) return void errors.push({ row: rowNo, message: 'Número repetido no arquivo' });
        const carrier = cell('carrier');
        if (!carrier) return void errors.push({ row: rowNo, message: 'Operadora vazia' });
        let delivery: string | null = null;
        try {
          if (cell('delivery')) delivery = parseDate(cell('delivery'));
        } catch {
          return void errors.push({ row: rowNo, message: 'Data de entrega inválida (use DD/MM/AAAA)' });
        }
        seen.add(number);
        valid.push({
          number,
          carrier: carrier.slice(0, 60),
          line_type: /voz/i.test(cell('type')) ? 'DADOS_VOZ' : 'DADOS',
          assignee_name: cell('assignee').slice(0, 120) || null,
          project: cell('project').slice(0, 120) || null,
          delivery_date: delivery,
          notes: cell('notes').slice(0, 500) || null,
        });
      });

      let created = 0;
      if (valid.length) {
        const out = await sql`
          with ins as (
            insert into lines (number, carrier, line_type, assignee_name, project, delivery_date, notes)
            select x.number, x.carrier, x.line_type, x.assignee_name, x.project, x.delivery_date, x.notes
            from jsonb_to_recordset(${JSON.stringify(valid)}::jsonb)
              as x(number text, carrier text, line_type text, assignee_name text, project text, delivery_date date, notes text)
            on conflict (number) do nothing
            returning *
          ), h as (
            insert into line_history (line_id, action, assignee_name, project, delivery_date, changed_by_name)
            select id, 'import', assignee_name, project, delivery_date, ${user.name} from ins
          )
          select count(*)::int as n from ins`;
        created = out[0].n;
      }
      return json({ created, skipped: valid.length - created, errors });
    },
  ],

  [
    'PATCH',
    '/lines/:id',
    async ({ req, params }) => {
      const user = await requireUser(req);
      const b = await readJson(req);
      const allowed = user.role === 'admin' ? ADMIN_FIELDS : OPERATOR_FIELDS;
      for (const k of Object.keys(b)) {
        if (!ADMIN_FIELDS.has(k)) throw new HttpError(400, `Campo desconhecido: ${k}`);
        if (!allowed.has(k)) throw new HttpError(403, 'Seu perfil só pode alterar o usuário e a data de entrega da linha');
      }
      const has = (k: string) => b[k] !== undefined;
      const number = has('number') ? requireNumber(b.number) : null;
      const carrier = has('carrier') ? reqStr(b.carrier, 'operadora', 60) : null;
      const type = has('lineType') ? lineType(b.lineType) : null;
      const assignee = has('assigneeName') ? str(b.assigneeName, 'usuário', { max: 120 }) : null;
      const project = has('project') ? str(b.project, 'projeto', { max: 120 }) : null;
      const delivery = has('deliveryDate') ? isoDate(b.deliveryDate, 'data de entrega') : null;
      const notes = has('notes') ? str(b.notes, 'observações', { max: 500 }) : null;

      let rows;
      try {
        rows = await sql`
          with upd as (
            update lines set
              number = case when ${has('number')}::boolean then ${number}::text else number end,
              carrier = case when ${has('carrier')}::boolean then ${carrier}::text else carrier end,
              line_type = case when ${has('lineType')}::boolean then ${type}::text else line_type end,
              assignee_name = case when ${has('assigneeName')}::boolean then ${assignee}::text else assignee_name end,
              project = case when ${has('project')}::boolean then ${project}::text else project end,
              delivery_date = case when ${has('deliveryDate')}::boolean then ${delivery}::date else delivery_date end,
              notes = case when ${has('notes')}::boolean then ${notes}::text else notes end,
              updated_at = now()
            where id = ${params.id}
            returning *
          ), h as (
            insert into line_history (line_id, action, assignee_name, project, delivery_date, changed_by_name)
            select id, 'update', assignee_name, project, delivery_date, ${user.name} from upd
          )
          select id, number, carrier, line_type, assignee_name, project,
                 to_char(delivery_date, 'YYYY-MM-DD') as delivery_date, notes, updated_at from upd`;
      } catch (err: any) {
        if (err?.code === '23505') throw new HttpError(409, 'Já existe uma linha com este número');
        throw err;
      }
      if (!rows.length) throw new HttpError(404, 'Linha não encontrada');
      return json({ line: toLine(rows[0]) });
    },
  ],

  [
    'DELETE',
    '/lines/:id',
    async ({ req, params }) => {
      await requireUser(req, { roles: ['admin'] });
      const rows = await sql`delete from lines where id = ${params.id} returning id`;
      if (!rows.length) throw new HttpError(404, 'Linha não encontrada');
      return json({ ok: true });
    },
  ],

  [
    'GET',
    '/lines/:id/history',
    async ({ req, params }) => {
      await requireUser(req);
      const rows = await sql`select action, assignee_name, project, to_char(delivery_date, 'YYYY-MM-DD') as delivery_date,
                                    changed_by_name, changed_at
                             from line_history where line_id = ${params.id} order by changed_at desc, id desc limit 100`;
      return json({
        history: rows.map((r) => ({
          action: r.action,
          assigneeName: r.assignee_name,
          project: r.project,
          deliveryDate: r.delivery_date,
          changedBy: r.changed_by_name,
          changedAt: r.changed_at,
        })),
      });
    },
  ],
];
