import { HttpError } from './http.ts';

export function str(v: unknown, field: string, opts: { max?: number; required?: boolean } = {}): string | null {
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw new HttpError(400, `Campo obrigatório: ${field}`);
    return null;
  }
  if (typeof v !== 'string') throw new HttpError(400, `Campo inválido: ${field}`);
  const t = v.trim();
  if (!t) {
    if (opts.required) throw new HttpError(400, `Campo obrigatório: ${field}`);
    return null;
  }
  if (t.length > (opts.max ?? 200)) throw new HttpError(400, `Campo muito longo: ${field}`);
  return t;
}

export function reqStr(v: unknown, field: string, max?: number): string {
  return str(v, field, { required: true, max }) as string;
}

export function email(v: unknown): string {
  const e = reqStr(v, 'e-mail', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'E-mail inválido');
  return e;
}

export function password(v: unknown): string {
  if (typeof v !== 'string' || v.length < 10) throw new HttpError(400, 'A senha deve ter no mínimo 10 caracteres');
  if (v.length > 128) throw new HttpError(400, 'Senha muito longa');
  return v;
}

export function isoDate(v: unknown, field: string): string | null {
  const s = str(v, field, { max: 10 });
  if (s === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, `Data inválida: ${field}`);
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new HttpError(400, `Data inválida: ${field}`);
  return s;
}

export function month(v: unknown, field: string): string {
  const s = reqStr(v, field, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw new HttpError(400, `Mês inválido: ${field} (use AAAA-MM)`);
  return s + '-01';
}

export const LINE_TYPES = ['DADOS', 'DADOS_VOZ'] as const;
export type LineType = (typeof LINE_TYPES)[number];

export function lineType(v: unknown): LineType {
  if (!LINE_TYPES.includes(v as LineType)) throw new HttpError(400, 'Tipo de linha inválido (DADOS ou DADOS_VOZ)');
  return v as LineType;
}

/** Normaliza telefone brasileiro para apenas dígitos (DDD + número, 10 ou 11 dígitos). */
export function normalizeNumber(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  if (d.startsWith('0') && d.length >= 11) d = d.replace(/^0+/, '');
  return d.length === 10 || d.length === 11 ? d : null;
}
