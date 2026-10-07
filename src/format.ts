export function formatPhone(n: string): string {
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return n;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

export function formatMonth(m: string): string {
  const [y, mm] = m.split('-');
  return `${mm}/${y}`;
}

export function formatMinutes(min: number): string {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  return h > 0 ? `${h}h ${String(total % 60).padStart(2, '0')}min` : `${total} min`;
}

export function formatData(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} GB` : `${mb.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}

export function formatMoney(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function currentMonth(offset = 0): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Célula de CSV segura: texto que começa com = + - @ (ou tab/CR) seria executado como fórmula pelo Excel,
 * então recebe um apóstrofo na frente. Números e valores numéricos como "-12,50" não são alterados.
 */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (typeof v === 'string') {
    const numeric = /^[-+]?\d+([.,]\d+)?$/.test(s);
    if (/^[=@\t\r]/.test(s) || (/^[-+]/.test(s) && !numeric)) s = "'" + s;
  }
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const blob = new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
