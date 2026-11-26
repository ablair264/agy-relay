// Harder benchmark tasks. Same rules as tasks.mjs: a visible test the worker sees, a hidden test
// it does not, a reference solution for --selftest, and a spec in the files that makes every
// hidden assertion derivable (no guessing at unstated behaviour).

const T = (s) => s.replace(/^\n/, '');
const PKG = '{"type":"module"}\n';

export const HARD = [
  {
    id: 'debug-pricing',
    task: 'The tests in test/ fail. The pricing rules are in README.md. Find and fix every bug in src/ so that all tests in test/ pass and the code follows README.md. Do not edit the tests.',
    files: {
      'package.json': PKG,
      'README.md': T(`
# Pricing rules
All amounts are integer cents.
1. subtotal = sum of qty * unit over the items.
2. Discount codes (case-insensitive): SAVE10 = 10% of the subtotal; FIVE = 500 off. An unknown or missing code gives no discount.
3. A discount never exceeds the subtotal.
4. Percentages round half up to the nearest cent (1005 at 10% is 101).
5. net = subtotal - discount. Tax is a percentage of net.
6. Shipping is 0 when net >= 5000, otherwise 499.
7. total = net + tax + shipping.
8. An empty cart costs nothing: every field is 0, including shipping.
`),
      'src/money.js': T(`
// Percentage of an amount of cents, rounded to whole cents.
export const percentOf = (cents, pct) => Math.trunc((cents * pct) / 100);
`),
      'src/cart.js': T(`
export const subtotal = (items) => items.reduce((sum, i) => sum + i.qty * i.unit, 0);
`),
      'src/discount.js': T(`
import { percentOf } from './money.js';
const CODES = { SAVE10: { pct: 10 }, FIVE: { off: 500 } };
export function discountFor(sub, code) {
  const c = CODES[code];
  if (!c) return 0;
  return c.pct ? percentOf(sub, c.pct) : c.off;
}
`),
      'src/order.js': T(`
import { subtotal } from './cart.js';
import { discountFor } from './discount.js';
import { percentOf } from './money.js';
export function total(items, code, taxPct) {
  const sub = subtotal(items);
  const discount = discountFor(sub, code);
  const tax = percentOf(sub, taxPct);
  const net = sub - discount;
  const shipping = sub >= 5000 ? 0 : 499;
  return { subtotal: sub, discount, tax, shipping, total: net + tax + shipping };
}
`),
      'test/order.test.js': T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/order.js';
test('percent discount rounds half up, tax on net', () => {
  assert.deepEqual(total([{ qty: 2, unit: 1999 }], 'SAVE10', 20), { subtotal: 3998, discount: 400, tax: 720, shipping: 499, total: 4817 });
});
test('code is case-insensitive', () => assert.equal(total([{ qty: 1, unit: 1000 }], 'save10', 0).discount, 100));
test('discount is capped at the subtotal', () => assert.equal(total([{ qty: 1, unit: 300 }], 'FIVE', 0).discount, 300));
`),
    },
    hidden: T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/order.js';
test('shipping threshold is judged on net, not subtotal', () => assert.equal(total([{ qty: 1, unit: 5200 }], 'SAVE10', 0).shipping, 499));
test('shipping is free at exactly 5000 net', () => assert.equal(total([{ qty: 1, unit: 5000 }], '', 0).shipping, 0));
test('half rounds up', () => assert.equal(total([{ qty: 1, unit: 1005 }], 'SAVE10', 0).discount, 101));
test('tax rounds half up on net', () => assert.equal(total([{ qty: 1, unit: 1005 }], '', 10).tax, 101));
test('empty cart is all zeros', () => assert.deepEqual(total([], 'SAVE10', 20), { subtotal: 0, discount: 0, tax: 0, shipping: 0, total: 0 }));
test('unknown and missing codes give no discount', () => { assert.equal(total([{ qty: 1, unit: 1000 }], 'NOPE', 0).discount, 0); assert.equal(total([{ qty: 1, unit: 1000 }], undefined, 0).discount, 0); });
test('a mixed code is matched case-insensitively', () => assert.equal(total([{ qty: 1, unit: 1000 }], 'FiVe', 0).discount, 500));
test('full example', () => assert.deepEqual(total([{ qty: 3, unit: 2500 }], 'FIVE', 8), { subtotal: 7500, discount: 500, tax: 560, shipping: 0, total: 7560 }));
`),
    solution: {
      'src/money.js': T(`
export const percentOf = (cents, pct) => Math.round((cents * pct) / 100);
`),
      'src/discount.js': T(`
import { percentOf } from './money.js';
const CODES = { SAVE10: { pct: 10 }, FIVE: { off: 500 } };
export function discountFor(sub, code) {
  const c = CODES[String(code ?? '').toUpperCase()];
  if (!c) return 0;
  return Math.min(sub, c.pct ? percentOf(sub, c.pct) : c.off);
}
`),
      'src/order.js': T(`
import { subtotal } from './cart.js';
import { discountFor } from './discount.js';
import { percentOf } from './money.js';
export function total(items, code, taxPct) {
  const sub = subtotal(items);
  if (sub === 0) return { subtotal: 0, discount: 0, tax: 0, shipping: 0, total: 0 };
  const discount = discountFor(sub, code);
  const net = sub - discount;
  const tax = percentOf(net, taxPct);
  const shipping = net >= 5000 ? 0 : 499;
  return { subtotal: sub, discount, tax, shipping, total: net + tax + shipping };
}
`),
    },
  },
  {
    id: 'async-limiter',
    task: 'Implement mapLimit(items, limit, fn) in src/map-limit.js as described in the comment at the top of that file. test/map-limit.test.js has examples. Make all tests in test/ pass. Do not edit the tests.',
    files: {
      'package.json': PKG,
      'src/map-limit.js': T(`
// mapLimit(items, limit, fn) -> Promise of an array of results
// - calls fn(item, index) for every item and resolves with the results in input order
// - never more than \`limit\` calls are in flight at once; a new call starts as soon as one finishes
// - fn may return a plain value or a promise, and may throw synchronously
// - if any call rejects or throws, the returned promise rejects with that error and NO further
//   calls are started (calls already in flight are left to finish)
// - an empty input resolves to []
// - limit must be a positive integer, otherwise the returned promise rejects with a RangeError
export function mapLimit(items, limit, fn) {
  throw new Error('not implemented');
}
`),
      'test/map-limit.test.js': T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../src/map-limit.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test('results keep input order', async () => {
  const out = await mapLimit([30, 10, 20], 2, async (ms, i) => { await sleep(ms); return i; });
  assert.deepEqual(out, [0, 1, 2]);
});
test('respects the limit', async () => {
  let active = 0, peak = 0;
  await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => { active++; peak = Math.max(peak, active); await sleep(5); active--; });
  assert.equal(peak, 2);
});
`),
    },
    hidden: T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../src/map-limit.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test('empty input', async () => assert.deepEqual(await mapLimit([], 3, async (x) => x), []));
test('limit larger than the list', async () => assert.deepEqual(await mapLimit([1, 2], 10, async (x) => x * 2), [2, 4]));
test('plain (non-promise) results work', async () => assert.deepEqual(await mapLimit([1, 2, 3], 2, (x) => x + 1), [2, 3, 4]));
test('a rejection rejects the whole call and starts nothing new', async () => {
  const started = [];
  await assert.rejects(mapLimit([0, 1, 2, 3, 4], 1, async (x) => { started.push(x); if (x === 1) throw new Error('boom'); }), /boom/);
  await sleep(20);
  assert.deepEqual(started, [0, 1]);
});
test('a synchronous throw rejects, not throws', async () => {
  const p = mapLimit([1], 1, () => { throw new Error('sync'); });
  assert.ok(p instanceof Promise);
  await assert.rejects(p, /sync/);
});
test('bad limits reject with RangeError', async () => {
  for (const l of [0, -1, 1.5, NaN, undefined]) await assert.rejects(mapLimit([1], l, async (x) => x), RangeError);
});
test('index is passed', async () => assert.deepEqual(await mapLimit(['a', 'b'], 2, async (x, i) => x + i), ['a0', 'b1']));
test('a new call starts as soon as one finishes', async () => {
  const log = [];
  await mapLimit([40, 5, 5], 2, async (ms, i) => { log.push('s' + i); await sleep(ms); log.push('e' + i); });
  assert.deepEqual(log.slice(0, 4), ['s0', 's1', 'e1', 's2']);
});
`),
    solution: {
      'src/map-limit.js': T(`
export function mapLimit(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) return Promise.reject(new RangeError('limit must be a positive integer'));
  const list = [...items];
  return new Promise((resolve, reject) => {
    const out = new Array(list.length);
    let next = 0, active = 0, done = 0, failed = false;
    if (!list.length) return resolve(out);
    const pump = () => {
      while (!failed && active < limit && next < list.length) {
        const i = next++;
        active++;
        Promise.resolve().then(() => fn(list[i], i)).then((v) => {
          out[i] = v; active--; done++;
          if (done === list.length) resolve(out); else pump();
        }, (e) => { if (!failed) { failed = true; reject(e); } });
      }
    };
    pump();
  });
}
`),
    },
  },
  {
    id: 'expr-parser',
    task: 'Implement evaluate(text) in src/expr.js as described in the comment at the top of that file. test/expr.test.js has examples. Make all tests in test/ pass. Do not edit the tests.',
    files: {
      'package.json': PKG,
      'src/expr.js': T(`
// evaluate(text) -> number
// Arithmetic with + - * / ^ , unary minus, parentheses and spaces.
// - a number is digits, optionally followed by "." and digits: "1", "1.5". ".5" and "5." are errors
// - precedence, high to low: ^ (right-associative), unary minus, * and / , + and -
//   so -2^2 is -4, 2^3^2 is 512, and -2*3 is -6
// - unary minus may repeat ("--3" is 3) and may follow an operator ("2*-3" is -6, "2^-1" is 0.5)
// - dividing by zero throws a RangeError
// - any other malformed input (empty text, a trailing operator, unbalanced parentheses, unknown
//   characters, two numbers in a row like "1 2") throws a SyntaxError
export function evaluate(text) {
  throw new Error('not implemented');
}
`),
      'test/expr.test.js': T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/expr.js';
test('precedence', () => assert.equal(evaluate('1 + 2 * 3'), 7));
test('parentheses', () => assert.equal(evaluate('(1 + 2) * 3'), 9));
test('left associative', () => assert.equal(evaluate('10 - 4 - 3'), 3));
test('decimals', () => assert.equal(evaluate('1.5 * 2'), 3));
test('division by zero', () => assert.throws(() => evaluate('1/0'), RangeError));
`),
    },
    hidden: T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/expr.js';
test('unary minus is looser than ^', () => assert.equal(evaluate('-2^2'), -4));
test('^ is right associative', () => assert.equal(evaluate('2^3^2'), 512));
test('unary minus binds tighter than *', () => assert.equal(evaluate('-2*3'), -6));
test('unary after an operator', () => { assert.equal(evaluate('2*-3'), -6); assert.equal(evaluate('2^-1'), 0.5); });
test('repeated unary minus', () => assert.equal(evaluate('--3'), 3));
test('parenthesised negative base', () => assert.equal(evaluate('(-2)^2'), 4));
test('zero divided by zero is a RangeError too', () => assert.throws(() => evaluate('0/0'), RangeError));
test('syntax errors', () => {
  for (const bad of ['', '   ', '1 +', '(1+2', '1+2)', '1 2', '.5+1', '5.+1', '2 $ 3', '()', '*3', '1..2'])
    assert.throws(() => evaluate(bad), SyntaxError, JSON.stringify(bad));
});
test('whitespace is free', () => assert.equal(evaluate('  ( 1+ 2 ) *  3 '), 9));
test('mixed', () => assert.equal(evaluate('2 + 3 * 4 ^ 2 / 8 - 1'), 7));
`),
    solution: {
      'src/expr.js': T(`
export function evaluate(text) {
  const s = String(text);
  let i = 0;
  const ws = () => { while (s[i] === ' ' || s[i] === '\\t') i++; };
  const peek = () => { ws(); return s[i]; };
  const fail = (m) => { throw new SyntaxError(m + ' at ' + i); };
  function expr() {
    let v = term();
    for (let c = peek(); c === '+' || c === '-'; c = peek()) { i++; const r = term(); v = c === '+' ? v + r : v - r; }
    return v;
  }
  function term() {
    let v = unary();
    for (let c = peek(); c === '*' || c === '/'; c = peek()) {
      i++; const r = unary();
      if (c === '/') { if (r === 0) throw new RangeError('division by zero'); v = v / r; } else v = v * r;
    }
    return v;
  }
  function unary() { if (peek() === '-') { i++; return -unary(); } return power(); }
  function power() { const b = atom(); if (peek() === '^') { i++; return Math.pow(b, unary()); } return b; }
  function atom() {
    const c = peek();
    if (c === '(') { i++; const v = expr(); if (peek() !== ')') fail('expected )'); i++; return v; }
    const m = /^\\d+(\\.\\d+)?/.exec(s.slice(i));
    if (!m) fail('unexpected input');
    i += m[0].length;
    return Number(m[0]);
  }
  const v = expr();
  if (peek() !== undefined) fail('unexpected input');
  return v;
}
`),
    },
  },
  {
    id: 'diff-lines',
    task: 'Implement diffLines(a, b) in src/diff.js as described in the comment at the top of that file. test/diff.test.js has examples. Make all tests in test/ pass. Do not edit the tests.',
    files: {
      'package.json': PKG,
      'src/diff.js': T(`
// diffLines(a, b) -> array of { op, line } turning the array of strings a into the array b
// - op is 'keep' (line is in both), 'del' (only in a) or 'add' (only in b)
// - the 'keep' and 'del' entries, in order, are exactly a; the 'keep' and 'add' entries, in order, are exactly b
// - the script is minimal: it has as few 'del' plus 'add' entries as possible
//   (equivalently, the kept lines are a longest common subsequence of a and b)
// - lines are compared with ===; the inputs are not modified
export function diffLines(a, b) {
  throw new Error('not implemented');
}
`),
      'test/diff.test.js': T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../src/diff.js';
test('one change', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'c', 'd']), [
    { op: 'keep', line: 'a' }, { op: 'del', line: 'b' }, { op: 'keep', line: 'c' }, { op: 'add', line: 'd' },
  ]);
});
test('identical', () => assert.deepEqual(diffLines(['x'], ['x']), [{ op: 'keep', line: 'x' }]));
test('from empty', () => assert.deepEqual(diffLines([], ['x']), [{ op: 'add', line: 'x' }]));
`),
    },
    hidden: T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../src/diff.js';
const lcs = (a, b) => {
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  return L[0][0];
};
let seed = 12345;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const arr = (n) => Array.from({ length: rnd(n + 1) }, () => 'abcd'[rnd(4)]);
test('valid and minimal on 300 random pairs', () => {
  for (let k = 0; k < 300; k++) {
    const a = arr(9), b = arr(9);
    const ops = diffLines(a, b);
    assert.deepEqual(ops.filter((o) => o.op !== 'add').map((o) => o.line), a, 'keep+del rebuilds a');
    assert.deepEqual(ops.filter((o) => o.op !== 'del').map((o) => o.line), b, 'keep+add rebuilds b');
    const edits = ops.filter((o) => o.op !== 'keep').length;
    assert.equal(edits, a.length + b.length - 2 * lcs(a, b), JSON.stringify([a, b]));
  }
});
test('does not modify its inputs', () => { const a = ['x', 'y'], b = ['y']; diffLines(a, b); assert.deepEqual(a, ['x', 'y']); assert.deepEqual(b, ['y']); });
test('both empty', () => assert.deepEqual(diffLines([], []), []));
test('all different', () => assert.equal(diffLines(['a', 'b'], ['c']).filter((o) => o.op !== 'keep').length, 3));
test('repeated lines', () => assert.equal(diffLines(['a', 'a', 'a'], ['a']).filter((o) => o.op === 'keep').length, 1));
`),
    solution: {
      'src/diff.js': T(`
export function diffLines(a, b) {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: 'keep', line: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: 'del', line: a[i++] });
    else out.push({ op: 'add', line: b[j++] });
  }
  while (i < n) out.push({ op: 'del', line: a[i++] });
  while (j < m) out.push({ op: 'add', line: b[j++] });
  return out;
}
`),
    },
  },
  {
    id: 'debug-emitter',
    task: 'The tests in test/ fail. The behaviour of Emitter is described in the comment at the top of src/emitter.js. Find and fix every bug in src/emitter.js so that all tests in test/ pass and it follows that comment. Do not edit the tests.',
    files: {
      'package.json': PKG,
      'src/emitter.js': T(`
// Emitter: a small event emitter.
// - on(event, fn) registers fn and returns an unsubscribe function that removes exactly that
//   registration (calling it again does nothing, and never removes another registration of fn)
// - once(event, fn) is like on but fn runs at most once
// - off(event, fn) removes the first registration of fn for the event, including one made with
//   once(event, fn); nothing happens if there is none
// - emit(event, ...args) calls the listeners in registration order and returns true if there were
//   any when emit started, otherwise false
// - emit uses the listeners registered when it started: ones added during the emit are not called
//   in it, and one removed during the emit is still called in it, except that a once listener
//   that has already run (for example in a nested emit) is not run again
// - an exception thrown by a listener propagates out of emit; later listeners are not called
export class Emitter {
  #m = new Map();
  on(evt, fn) {
    if (!this.#m.has(evt)) this.#m.set(evt, []);
    this.#m.get(evt).push(fn);
    return () => this.off(evt, fn);
  }
  once(evt, fn) {
    const wrapper = (...args) => { this.off(evt, wrapper); fn(...args); };
    return this.on(evt, wrapper);
  }
  off(evt, fn) {
    const list = this.#m.get(evt);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  emit(evt, ...args) {
    const list = this.#m.get(evt);
    if (!list || !list.length) return false;
    for (const fn of list) fn(...args);
    return true;
  }
}
`),
      'test/emitter.test.js': T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../src/emitter.js';
test('once runs once and does not skip the next listener', () => {
  const e = new Emitter(); const log = [];
  e.once('x', () => log.push('once'));
  e.on('x', () => log.push('on'));
  e.emit('x'); e.emit('x');
  assert.deepEqual(log, ['once', 'on', 'on']);
});
test('emit returns whether anyone was listening', () => {
  const e = new Emitter();
  assert.equal(e.emit('x'), false);
  e.on('x', () => {});
  assert.equal(e.emit('x'), true);
});
`),
    },
    hidden: T(`
import test from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../src/emitter.js';
test('off removes a once listener by its original fn', () => {
  const e = new Emitter(); let n = 0; const f = () => n++;
  e.once('x', f); e.off('x', f); e.emit('x');
  assert.equal(n, 0);
});
test('unsubscribe twice never removes another registration of the same fn', () => {
  const e = new Emitter(); let n = 0; const f = () => n++;
  const u1 = e.on('x', f); e.on('x', f);
  u1(); u1(); e.emit('x');
  assert.equal(n, 1);
});
test('unsubscribe removes its own registration, not the first one', () => {
  const e = new Emitter(); const log = []; const f = () => log.push('f');
  e.on('x', f); const u2 = e.on('x', () => log.push('g')); e.on('x', f);
  u2(); e.emit('x');
  assert.deepEqual(log, ['f', 'f']);
});
test('listeners added during emit are not called in it', () => {
  const e = new Emitter(); const log = [];
  e.on('x', () => { log.push('a'); e.on('x', () => log.push('late')); });
  e.emit('x'); assert.deepEqual(log, ['a']);
  e.emit('x'); assert.deepEqual(log, ['a', 'a', 'late']);
});
test('a listener removed during emit is still called in it', () => {
  const e = new Emitter(); const log = []; const g = () => log.push('g');
  e.on('x', () => { log.push('f'); e.off('x', g); }); e.on('x', g);
  e.emit('x'); assert.deepEqual(log, ['f', 'g']);
  e.emit('x'); assert.deepEqual(log, ['f', 'g', 'f']);
});
test('a once listener does not run twice through a nested emit', () => {
  const e = new Emitter(); let n = 0;
  e.once('x', () => { n++; e.emit('x'); });
  e.emit('x');
  assert.equal(n, 1);
});
test('an exception propagates and stops later listeners', () => {
  const e = new Emitter(); const log = [];
  e.on('x', () => { throw new Error('bad'); }); e.on('x', () => log.push('after'));
  assert.throws(() => e.emit('x'), /bad/);
  assert.deepEqual(log, []);
});
test('events are independent and args are passed', () => {
  const e = new Emitter(); const got = [];
  e.on('a', (...r) => got.push(r)); e.on('b', () => got.push('b'));
  e.emit('a', 1, 2);
  assert.deepEqual(got, [[1, 2]]);
});
test('off for an unknown event or fn does nothing', () => { const e = new Emitter(); e.off('nope', () => {}); e.on('x', () => {}); e.off('x', () => {}); assert.equal(e.emit('x'), true); });
`),
    solution: {
      'src/emitter.js': T(`
export class Emitter {
  #m = new Map();
  #add(evt, fn, once) {
    const entry = { fn, once, fired: false };
    if (!this.#m.has(evt)) this.#m.set(evt, []);
    this.#m.get(evt).push(entry);
    return () => this.#remove(evt, (x) => x === entry);
  }
  #remove(evt, pred) {
    const list = this.#m.get(evt);
    if (!list) return;
    const i = list.findIndex(pred);
    if (i >= 0) list.splice(i, 1);
  }
  on(evt, fn) { return this.#add(evt, fn, false); }
  once(evt, fn) { return this.#add(evt, fn, true); }
  off(evt, fn) { this.#remove(evt, (x) => x.fn === fn); }
  emit(evt, ...args) {
    const list = this.#m.get(evt);
    if (!list || !list.length) return false;
    for (const entry of [...list]) {
      if (entry.once) {
        if (entry.fired) continue;
        entry.fired = true;
        this.#remove(evt, (x) => x === entry);
      }
      entry.fn(...args);
    }
    return true;
  }
}
`),
    },
  },
];
