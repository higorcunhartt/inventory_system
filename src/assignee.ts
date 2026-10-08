/** Nome padrão das linhas livres (sem pessoa nem local/projeto). */
export const SPARE = 'Spare';

/** "Spare", "SPARE", " spare " etc. */
export function isSpare(name: string | null | undefined): boolean {
  return (name ?? '').trim().toLowerCase() === 'spare';
}
