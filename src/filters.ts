/** Há algum filtro ou busca aplicado na lista de linhas? (habilita o botão "Limpar filtros") */
export function hasActiveFilters(f: { q: string; carrier: string; project: string; type: string; onlySpare: boolean }): boolean {
  return f.q.trim() !== '' || f.carrier !== '' || f.project !== '' || f.type !== '' || f.onlySpare;
}
