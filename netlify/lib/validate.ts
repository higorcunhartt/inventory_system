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

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd123', 'senha', 'senha123', 'senha1234', 'senha12345', 'senha123456',
  'mudar123', 'mudar1234', 'mudar12345', 'admin', 'admin123', 'admin1234', 'admin12345', 'administrador', 'qwerty', 'qwerty123',
  'qwertyuiop', 'qwerty12345', 'brasil', 'brasil123', 'brasil1234', 'brasil12345', 'inventario', 'inventario123', 'inventario1234',
  'rtt', 'rtt123', 'rtt1234', 'rtt12345', 'rttshop', 'rttshop123', 'rttadmin', 'rttadmin123', 'abc123', 'abc1234567', 'abcdefghij',
  '1234567890', '12345678910', '123456789012', '0123456789', '1q2w3e4r5t', '1q2w3e4r5t6y', 'iloveyou123', 'welcome123', 'letmein123',
  'trocar123', 'trocar1234', 'trocar12345', 'temporaria', 'temporaria1', 'temporaria123', 'novasenha', 'novasenha1', 'novasenha123',
]);
const COMMON_ROOTS = ['password', 'senha', 'admin', 'qwerty', 'mudar', 'trocar', 'brasil', 'inventario', 'welcome', 'letmein', 'temporaria', 'novasenha', 'rttshop', 'rtt'];

/** Senha digitada no login: tratada exatamente como foi informada (sem trim). */
export function loginPassword(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) throw new HttpError(400, 'Campo obrigatório: senha');
  if (v.length > 128) throw new HttpError(400, 'Senha inválida');
  return v;
}

/** Política de definição de senha: tamanho (em bytes, por causa do limite de 72 do bcrypt) e bloqueio de senhas triviais. */
export function password(v: unknown): string {
  if (typeof v !== 'string' || v.length < 10) throw new HttpError(400, 'A senha deve ter no mínimo 10 caracteres');
  if (Buffer.byteLength(v, 'utf8') > 72) throw new HttpError(400, 'A senha deve ter no máximo 72 bytes (cerca de 72 caracteres comuns)');
  const lower = v.toLowerCase();
  const stripped = lower.replace(/[\d\W_]+$/g, '');
  if (
    COMMON_PASSWORDS.has(lower) ||
    COMMON_ROOTS.includes(stripped) ||
    /^(.)\1+$/.test(v) ||
    new Set(v).size < 4
  ) {
    throw new HttpError(400, 'Senha muito comum ou previsível. Escolha uma frase mais longa e única.');
  }
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

/** E-mail de usuário do sistema: precisa ser de um domínio permitido (ALLOWED_EMAIL_DOMAINS; padrão rttshop.com.br). */
export function corporateEmail(v: unknown): string {
  const e = email(v);
  const allowed = (process.env.ALLOWED_EMAIL_DOMAINS || 'rttshop.com.br')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(e.split('@')[1])) {
    throw new HttpError(400, `Use um e-mail corporativo (${allowed.map((d) => '@' + d).join(', ')})`);
  }
  return e;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identificador de rota: precisa ser um UUID, senão 400 (e não um erro 500 do banco). */
export function uuid(v: unknown, field = 'identificador'): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new HttpError(400, `Identificador inválido: ${field}`);
  return v.toLowerCase();
}

/** Número de telefone em dígitos (DDD + número) vindo da rota. */
export function phoneParam(v: unknown): string {
  if (typeof v !== 'string' || !/^\d{10,11}$/.test(v)) throw new HttpError(400, 'Número inválido');
  return v;
}
