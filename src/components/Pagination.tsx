import { PAGE_SIZES, pageWindow, type Paged } from '../pagination';

type Props = {
  paged: Paged<unknown>;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
  label?: string; // usado para diferenciar as duas barras (acima e abaixo da tabela) em leitores de tela
};

export function Pagination({ paged, onPage, onSize, label = 'Paginação' }: Props) {
  const { page, pages, total, start, end, size } = paged;
  return (
    <nav className="pager" aria-label={label}>
      <span className="pager-info" aria-live="polite">
        {total === 0 ? 'Nenhum item' : `Mostrando ${start}–${end} de ${total}`}
      </span>

      <label className="pager-size">
        Itens por página
        <select value={size} onChange={(e) => onSize(Number(e.target.value))}>
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      {pages > 1 && (
        <div className="pager-pages">
          <button className="btn small" onClick={() => onPage(1)} disabled={page === 1} aria-label="Primeira página">
            «
          </button>
          <button className="btn small" onClick={() => onPage(page - 1)} disabled={page === 1} aria-label="Página anterior">
            ‹
          </button>
          {pageWindow(page, pages).map((p, i) =>
            p === '…' ? (
              <span key={`gap-${i}`} className="pager-gap" aria-hidden="true">
                …
              </span>
            ) : (
              <button key={p} className={`btn small${p === page ? ' primary' : ''}`} onClick={() => onPage(p)} aria-current={p === page ? 'page' : undefined} aria-label={`Página ${p}`}>
                {p}
              </button>
            ),
          )}
          <button className="btn small" onClick={() => onPage(page + 1)} disabled={page === pages} aria-label="Próxima página">
            ›
          </button>
          <button className="btn small" onClick={() => onPage(pages)} disabled={page === pages} aria-label="Última página">
            »
          </button>
        </div>
      )}
    </nav>
  );
}
