import { neon } from '@neondatabase/serverless';

export type Row = Record<string, any>;
export type Sql = (strings: TemplateStringsArray, ...values: any[]) => Promise<Row[]>;

let impl: Sql | undefined;

/** Permite trocar o driver (usado nos testes com PGlite). */
export function setSql(s: Sql) {
  impl = s;
}

export const sql: Sql = (strings, ...values) => {
  if (!impl) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL não configurada');
    impl = neon(url) as unknown as Sql;
  }
  return impl(strings, ...values);
};
