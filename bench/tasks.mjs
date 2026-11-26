// Benchmark tasks. Each: files the worker starts with (incl. a visible test), a hidden test
// the worker never sees (catches overfitting to the visible one), and a reference solution
// that `node bench/run.mjs --selftest` checks passes both, so a task is known to be solvable.
// All use node's built-in test runner: no dependencies, same gate for every model.

const T = (s) => s.replace(/^\n/, '');

export const TASKS = [
  {
    id: 'bugfix-paginate',
    task: 'src/paginate.js has bugs: `node --test` fails. Fix src/paginate.js so all tests in test/ pass. Do not edit the tests.',
    files: {
      'package.json': '{"type":"module"}\n',
      'src/paginate.js': T(`
// paginate(items, page, perPage) -> { items, page, perPage, totalPages, hasNext, hasPrev }
// page is 1-based. totalPages is at least 1 (an empty list is one empty page).
// A page below 1 or past the last page is clamped into 1..totalPages, and the result's
// page is the clamped value.
export function paginate(items, page, perPage) {
  const totalPages = Math.floor(items.length / perPage);
  const start = page * perPage;
  return { items: items.slice(start, start + perPage), page, perPage, totalPages, hasNext: page < totalPages, hasPrev: page > 0 };
}
`),
      'test/paginate.test.js': T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/paginate.js';
const a = [1, 2, 3, 4, 5, 6, 7];
test('first page', () => {
  const p = paginate(a, 1, 3);
  assert.deepEqual(p.items, [1, 2, 3]);
  assert.equal(p.totalPages, 3);
  assert.equal(p.hasNext, true);
  assert.equal(p.hasPrev, false);
});
test('last page is partial', () => {
  const p = paginate(a, 3, 3);
  assert.deepEqual(p.items, [7]);
  assert.equal(p.hasNext, false);
  assert.equal(p.hasPrev, true);
});
`),
    },
    hidden: T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/paginate.js';
test('exact multiple has no extra page', () => assert.equal(paginate([1, 2, 3, 4], 1, 2).totalPages, 2));
test('empty list is one empty page', () => { const p = paginate([], 1, 5); assert.equal(p.totalPages, 1); assert.deepEqual(p.items, []); assert.equal(p.hasNext, false); });
test('page past the end clamps to the last page', () => { const p = paginate([1, 2, 3], 9, 2); assert.equal(p.page, 2); assert.deepEqual(p.items, [3]); });
test('page below 1 clamps to 1', () => assert.equal(paginate([1, 2, 3], 0, 2).page, 1));
`),
    solution: {
      'src/paginate.js': T(`
export function paginate(items, page, perPage) {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  page = Math.min(Math.max(1, page), totalPages);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), page, perPage, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
}
`),
    },
  },
  {
    id: 'feature-slugify',
    task: 'Implement slugify(text, maxLength) in src/slugify.js as described in the comment at the top of that file. test/slugify.test.js has examples. Make all tests in test/ pass. Do not edit the tests.',
    files: {
      'package.json': '{"type":"module"}\n',
      'src/slugify.js': T(`
// slugify(text, maxLength = Infinity) -> URL slug
// - lowercase; accents removed (é -> e); any run of non-alphanumeric characters becomes ONE "-"
// - no leading or trailing "-"
// - if maxLength is given, cut to at most maxLength characters, then drop a trailing "-"
//   (cut at a word boundary only when the cut lands inside a word and a "-" exists before it;
//    otherwise hard-cut)
export function slugify(text, maxLength = Infinity) {
  throw new Error('not implemented');
}
`),
      'test/slugify.test.js': T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';
test('basic', () => assert.equal(slugify('Hello, World!'), 'hello-world'));
test('accents', () => assert.equal(slugify('Café Crème'), 'cafe-creme'));
test('collapses and trims', () => assert.equal(slugify('  --a   b--  '), 'a-b'));
test('max length at a word boundary', () => assert.equal(slugify('one two three', 9), 'one-two'));
`),
    },
    hidden: T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';
test('cut exactly on a boundary keeps the whole word', () => assert.equal(slugify('one two three', 7), 'one-two'));
test('single long word is hard-cut', () => assert.equal(slugify('abcdefghij', 4), 'abcd'));
test('digits are kept', () => assert.equal(slugify('Top 10 Tips'), 'top-10-tips'));
test('empty and symbol-only give empty string', () => { assert.equal(slugify(''), ''); assert.equal(slugify('!!!'), ''); });
test('ligature-free decomposition: ñ and ü', () => assert.equal(slugify('Niño Über'), 'nino-uber'));
test('max length when a hyphen falls right at the cut', () => assert.equal(slugify('ab cd ef', 3), 'ab'));
`),
    solution: {
      'src/slugify.js': T(`
export function slugify(text, maxLength = Infinity) {
  let s = String(text).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > maxLength) {
    const cut = s.slice(0, maxLength);
    if (s[maxLength] === '-') s = cut;
    else { const i = cut.lastIndexOf('-'); s = i > 0 ? cut.slice(0, i) : cut; }
    s = s.replace(/-+$/, '');
  }
  return s;
}
`),
    },
  },
  {
    id: 'parse-csv',
    task: 'Implement parseCsv(text) in src/csv.js as described in the comment at the top of that file. test/csv.test.js has examples. Make all tests in test/ pass. Do not edit the tests.',
    files: {
      'package.json': '{"type":"module"}\n',
      'src/csv.js': T(`
// parseCsv(text) -> string[][]  (array of rows, each an array of field strings)
// RFC 4180 style: fields separated by ",", rows by "\\n" or "\\r\\n".
// A field may be wrapped in double quotes; inside quotes "," and line breaks are literal
// and "" is one literal quote. A final line break does not create an extra empty row.
// Empty input gives [].
export function parseCsv(text) {
  throw new Error('not implemented');
}
`),
      'test/csv.test.js': T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.js';
test('simple', () => assert.deepEqual(parseCsv('a,b\\n1,2\\n'), [['a', 'b'], ['1', '2']]));
test('quoted comma', () => assert.deepEqual(parseCsv('"a,b",c'), [['a,b', 'c']]));
test('escaped quote', () => assert.deepEqual(parseCsv('"say ""hi""",x'), [['say "hi"', 'x']]));
test('crlf', () => assert.deepEqual(parseCsv('a,b\\r\\n1,2'), [['a', 'b'], ['1', '2']]));
`),
    },
    hidden: T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.js';
test('newline inside quotes', () => assert.deepEqual(parseCsv('"a\\nb",c\\n1,2'), [['a\\nb', 'c'], ['1', '2']]));
test('empty fields', () => assert.deepEqual(parseCsv('a,,c\\n,,'), [['a', '', 'c'], ['', '', '']]));
test('empty input', () => assert.deepEqual(parseCsv(''), []));
test('quoted empty field', () => assert.deepEqual(parseCsv('"",a'), [['', 'a']]));
test('crlf inside quotes is kept', () => assert.deepEqual(parseCsv('"a\\r\\nb"'), [['a\\r\\nb']]));
test('no trailing newline and trailing crlf agree', () => assert.deepEqual(parseCsv('a\\r\\n'), parseCsv('a')));
`),
    solution: {
      'src/csv.js': T(`
export function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]; any = true;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\\n' || c === '\\r') { if (c === '\\r' && text[i + 1] === '\\n') i++; row.push(f); rows.push(row); row = []; f = ''; any = false; }
    else f += c;
  }
  if (any || row.length) { row.push(f); rows.push(row); }
  return rows;
}
`),
    },
  },
  {
    id: 'rename-across-files',
    task: 'Rename the function getUser to fetchUser everywhere: its definition, every import and call in src/, and mentions in README.md. Keep behaviour identical. Make all tests in test/ pass. Do not edit the tests.',
    files: {
      'package.json': '{"type":"module"}\n',
      'src/users.js': T(`
const DB = new Map([[1, { id: 1, name: 'Ada' }], [2, { id: 2, name: 'Linus' }]]);
// getUser(id) returns the user or null.
export function getUser(id) { return DB.get(id) ?? null; }
`),
      'src/greet.js': T(`
import { getUser } from './users.js';
export function greet(id) { const u = getUser(id); return u ? \`Hello, \${u.name}\` : 'Hello, stranger'; }
`),
      'src/admin.js': T(`
import { getUser as lookup } from './users.js';
export const isKnown = (id) => lookup(id) !== null;
export function describe(id) { return lookup(id)?.name ?? 'unknown'; }
`),
      'src/index.js': T(`
export * from './users.js';
export * from './greet.js';
export * from './admin.js';
`),
      'README.md': '# users\n\nUse `getUser(id)` to load a user. `greet` calls getUser internally.\n',
      'test/users.test.js': T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchUser, greet, isKnown, describe } from '../src/index.js';
test('fetchUser', () => assert.equal(fetchUser(1).name, 'Ada'));
test('greet', () => assert.equal(greet(2), 'Hello, Linus'));
test('admin', () => { assert.equal(isKnown(3), false); assert.equal(describe(1), 'Ada'); });
`),
    },
    hidden: T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const all = ['src/users.js', 'src/greet.js', 'src/admin.js', 'src/index.js', 'README.md'].map((f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\\n');
test('no getUser left anywhere', () => assert.equal(/getUser/.test(all), false));
test('fetchUser still returns null for unknown ids', async () => { const m = await import('../src/index.js'); assert.equal(m.fetchUser(99), null); });
test('README mentions fetchUser', () => assert.match(fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /fetchUser/));
test('the aliased import in admin.js still aliases the new name', () => assert.match(fs.readFileSync(new URL('../src/admin.js', import.meta.url), 'utf8'), /fetchUser as lookup/));
`),
    solution: null, // produced by sed in the selftest: see solve() in run.mjs
  },
  {
    id: 'lru-cache',
    task: 'Implement the LRUCache class in src/lru.js as described in the comment at the top of that file. test/lru.test.js has examples. Make all tests in test/ pass. Do not edit the tests.',
    files: {
      'package.json': '{"type":"module"}\n',
      'src/lru.js': T(`
// LRUCache(capacity): least-recently-used cache.
// - get(key): value or undefined; a hit makes the key most recently used
// - set(key, value): inserts or updates; either way the key becomes most recently used;
//   when size would exceed capacity, the least recently used key is evicted
// - has(key): boolean; does NOT change recency
// - delete(key): true if it existed, else false
// - size: number of entries (a getter)
// - keys(): array of keys from least to most recently used
// capacity must be a positive integer, otherwise the constructor throws a RangeError.
export class LRUCache {
  constructor(capacity) {
    throw new Error('not implemented');
  }
}
`),
      'test/lru.test.js': T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '../src/lru.js';
test('evicts the least recently used', () => {
  const c = new LRUCache(2); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
  assert.equal(c.has('b'), false); assert.deepEqual(c.keys(), ['a', 'c']);
});
test('size and delete', () => {
  const c = new LRUCache(3); c.set('a', 1); c.set('b', 2);
  assert.equal(c.size, 2); assert.equal(c.delete('a'), true); assert.equal(c.delete('a'), false); assert.equal(c.size, 1);
});
`),
    },
    hidden: T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '../src/lru.js';
test('has does not refresh', () => { const c = new LRUCache(2); c.set('a', 1); c.set('b', 2); c.has('a'); c.set('c', 3); assert.equal(c.has('a'), false); });
test('updating refreshes and keeps size', () => { const c = new LRUCache(2); c.set('a', 1); c.set('b', 2); c.set('a', 9); assert.equal(c.size, 2); assert.deepEqual(c.keys(), ['b', 'a']); assert.equal(c.get('a'), 9); });
test('falsy values are real hits', () => { const c = new LRUCache(2); c.set('z', 0); assert.equal(c.get('z'), 0); assert.equal(c.has('z'), true); });
test('bad capacity throws RangeError', () => { for (const n of [0, -1, 1.5, NaN, '3']) assert.throws(() => new LRUCache(n), RangeError); });
test('miss returns undefined and does not insert', () => { const c = new LRUCache(1); assert.equal(c.get('x'), undefined); assert.equal(c.size, 0); });
test('capacity 1 evicts immediately', () => { const c = new LRUCache(1); c.set('a', 1); c.set('b', 2); assert.deepEqual(c.keys(), ['b']); });
`),
    solution: {
      'src/lru.js': T(`
export class LRUCache {
  #m = new Map(); #cap;
  constructor(capacity) { if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer'); this.#cap = capacity; }
  get(k) { if (!this.#m.has(k)) return undefined; const v = this.#m.get(k); this.#m.delete(k); this.#m.set(k, v); return v; }
  set(k, v) { this.#m.delete(k); this.#m.set(k, v); if (this.#m.size > this.#cap) this.#m.delete(this.#m.keys().next().value); }
  has(k) { return this.#m.has(k); }
  delete(k) { return this.#m.delete(k); }
  get size() { return this.#m.size; }
  keys() { return [...this.#m.keys()]; }
}
`),
    },
  },
];

// Solution for the rename task: a mechanical rewrite of the starting files.
export function solve(task) {
  if (task.solution) return task.solution;
  const out = {};
  for (const [f, c] of Object.entries(task.files)) if (!f.startsWith('test/')) out[f] = c.replace(/getUser/g, 'fetchUser');
  return out;
}
