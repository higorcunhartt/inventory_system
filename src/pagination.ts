export const PAGE_SIZES = [10, 20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;

/** Aceita só os tamanhos oferecidos (protege contra valor antigo/inválido guardado no navegador). */
export function normalizePageSize(v: unknown): number {
  const n = Number(v);
  return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
}

export type Paged<T> = {
  items: T[];
  page: number; // página efetiva (1..pages), já ajustada se a lista encolheu
  pages: number;
  total: number;
  start: number; // posição (1-based) do primeiro item exibido; 0 se a lista está vazia
  end: number; // posição (1-based) do último item exibido
  size: number;
};

export function paginate<T>(items: T[], page: number, size: number): Paged<T> {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const from = (current - 1) * size;
  const slice = items.slice(from, from + size);
  return { items: slice, page: current, pages, total, start: total ? from + 1 : 0, end: from + slice.length, size };
}

/** Números de página a exibir: sempre a primeira, a última e a vizinhança da atual, com "…" nos saltos. */
export function pageWindow(page: number, pages: number, around = 1): Array<number | '…'> {
  const wanted = new Set<number>([1, pages]);
  for (let p = page - around; p <= page + around; p++) if (p >= 1 && p <= pages) wanted.add(p);
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push(p - sorted[i - 1] === 2 ? p - 1 : '…');
    out.push(p);
  });
  return out;
}
