import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, normalizePageSize, pageWindow, paginate } from '../src/pagination.ts';

const items = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

test('tamanhos oferecidos: 10, 20, 50 e 100; valor inválido volta ao padrão', () => {
  assert.deepEqual([...PAGE_SIZES], [10, 20, 50, 100]);
  for (const n of [10, 20, 50, 100]) assert.equal(normalizePageSize(n), n);
  assert.equal(normalizePageSize('50'), 50);
  for (const bad of [0, 7, 1000, -1, 'abc', null, undefined, NaN]) assert.equal(normalizePageSize(bad), DEFAULT_PAGE_SIZE);
});

test('paginate: 362 linhas em páginas de 20 → 19 páginas; a última tem 2 itens', () => {
  const first = paginate(items(362), 1, 20);
  assert.equal(first.pages, 19);
  assert.equal(first.items.length, 20);
  assert.deepEqual([first.start, first.end, first.total], [1, 20, 362]);
  const last = paginate(items(362), 19, 20);
  assert.deepEqual(last.items, [361, 362]);
  assert.deepEqual([last.start, last.end], [361, 362]);
});

test('paginate: cobre todos os itens sem repetir nem perder, em todos os tamanhos', () => {
  for (const size of PAGE_SIZES) {
    const all = items(362);
    const seen: number[] = [];
    const { pages } = paginate(all, 1, size);
    for (let p = 1; p <= pages; p++) seen.push(...paginate(all, p, size).items);
    assert.deepEqual(seen, all, `tamanho ${size}`);
  }
});

test('paginate: lista vazia, página fora da faixa e lista que encolheu', () => {
  const empty = paginate([], 1, 20);
  assert.deepEqual([empty.pages, empty.page, empty.start, empty.end, empty.items.length], [1, 1, 0, 0, 0]);
  assert.equal(paginate(items(30), 99, 10).page, 3); // além da última → última
  assert.equal(paginate(items(30), 0, 10).page, 1);
  assert.equal(paginate(items(30), -4, 10).page, 1);
  assert.equal(paginate(items(30), Number.NaN, 10).page, 1);
  // estava na página 19 e o filtro deixou só 15 itens: mostra a única página existente, não uma página vazia
  const shrunk = paginate(items(15), 19, 20);
  assert.deepEqual([shrunk.page, shrunk.pages, shrunk.items.length], [1, 1, 15]);
  // múltiplo exato do tamanho: 40 itens/20 = 2 páginas (sem página vazia extra)
  assert.equal(paginate(items(40), 2, 20).items.length, 20);
  assert.equal(paginate(items(40), 1, 20).pages, 2);
  assert.equal(paginate(items(41), 1, 20).pages, 3);
});

test('pageWindow: primeira, última e vizinhança com reticências só quando há salto', () => {
  assert.deepEqual(pageWindow(1, 1), [1]);
  assert.deepEqual(pageWindow(1, 5), [1, 2, '…', 5]);
  assert.deepEqual(pageWindow(3, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageWindow(1, 19), [1, 2, '…', 19]);
  assert.deepEqual(pageWindow(10, 19), [1, '…', 9, 10, 11, '…', 19]);
  assert.deepEqual(pageWindow(19, 19), [1, '…', 18, 19]);
  assert.deepEqual(pageWindow(4, 19), [1, 2, 3, 4, 5, '…', 19]); // salto de 1 número mostra o número, não "…"
  for (let pages = 1; pages <= 30; pages++) {
    for (let page = 1; page <= pages; page++) {
      const w = pageWindow(page, pages);
      const nums = w.filter((x): x is number => typeof x === 'number');
      assert.deepEqual(nums, [...new Set(nums)].sort((a, b) => a - b), `sem repetição/ordem: ${page}/${pages}`);
      assert.ok(nums.includes(1) && nums.includes(pages) && nums.includes(page));
      assert.ok(w.length <= 7, `janela curta: ${page}/${pages}`);
    }
  }
});
