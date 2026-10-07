/** Divide um script SQL em instruções, respeitando blocos $$ ... $$ (corpos de funções). */
export function splitSql(text) {
  const out = [];
  let cur = '';
  let inDollar = false;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('$$', i)) {
      inDollar = !inDollar;
      cur += '$$';
      i++;
      continue;
    }
    const c = text[i];
    if (c === ';' && !inDollar) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
