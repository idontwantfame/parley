// test/oidc-flows.test.js — pending SSO login flows (bounded, expiring, single
// use) and the open-redirect guard for returnTo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixedWindowLimiter, createFlowStore, safeReturnTo } from '../src/web/oidc-flows.js';

test('a flow can be taken exactly once', () => {
  const flows = createFlowStore({ now: () => 0 });
  const id = flows.put({ state: 's' });
  assert.equal(typeof id, 'string');
  assert.ok(id.length >= 32);
  assert.deepEqual(flows.take(id), { state: 's' });
  assert.equal(flows.take(id), null); // replay
});

test('unknown, empty and expired flow ids yield null', () => {
  let t = 0;
  const flows = createFlowStore({ now: () => t, ttlMs: 1000 });
  const id = flows.put({ state: 's' });
  assert.equal(flows.take(null), null);
  assert.equal(flows.take(''), null);
  assert.equal(flows.take('nope'), null);
  t = 1001;
  assert.equal(flows.take(id), null);
});

test('the store is capped and evicts the oldest flow first', () => {
  const flows = createFlowStore({ now: () => 0, maxEntries: 3 });
  const ids = ['a', 'b', 'c', 'd'].map((state) => flows.put({ state }));
  assert.equal(flows.size(), 3);
  assert.equal(flows.take(ids[0]), null);
  assert.equal(flows.take(ids[3]).state, 'd');
});

test('expired flows are swept on insert', () => {
  let t = 0;
  const flows = createFlowStore({ now: () => t, ttlMs: 10 });
  flows.put({}); flows.put({});
  t = 100;
  flows.put({});
  assert.equal(flows.size(), 1);
});

test('safeReturnTo keeps same-origin relative paths', () => {
  for (const ok of ['/', '/meetings/12', '/search?q=a%20b#top', '/a/b/../c']) {
    assert.equal(safeReturnTo(ok), ok, ok);
  }
});

test('safeReturnTo falls back to "/" for anything that could leave the site', () => {
  const bad = [
    undefined, null, '', 'meetings', 'https://evil.example/', '//evil.example', '///evil.example',
    '/\\evil.example', '\\\\evil.example', '/\t/evil.example', '/\n/evil.example', ' /x',
    'javascript:alert(1)', '/%0d%0aSet-Cookie:x', ['/a'], { a: 1 }, `/${'x'.repeat(3000)}`,
  ];
  for (const value of bad) {
    assert.equal(safeReturnTo(value), '/', JSON.stringify(value));
  }
});

test('take with a predicate leaves a non-matching flow in place', () => {
  const flows = createFlowStore({ now: () => 0 });
  const id = flows.put({ state: 'right' });
  assert.equal(flows.take(id, (f) => f.state === 'wrong'), null);
  assert.equal(flows.size(), 1);
  assert.equal(flows.take(id, (f) => f.state === 'right').state, 'right');
  assert.equal(flows.size(), 0);
});

test('one owner keeps at most maxPerOwner live flows and cannot evict anyone else', () => {
  const flows = createFlowStore({ now: () => 0, maxPerOwner: 2, maxEntries: 100 });
  const victim = flows.put({ state: 'v' }, 'victim-ip');
  const mine = ['a', 'b', 'c', 'd'].map((state) => flows.put({ state }, 'attacker-ip'));
  assert.equal(flows.size(), 3);
  assert.equal(flows.take(mine[0]), null); // the attacker's own oldest flows went first
  assert.equal(flows.take(mine[1]), null);
  assert.equal(flows.take(mine[3]).state, 'd');
  assert.equal(flows.take(victim).state, 'v');
});

test('the fixed-window limiter allows `limit` hits per key per window', () => {
  let t = 0;
  const limiter = createFixedWindowLimiter({ limit: 3, windowMs: 1000, now: () => t });
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.hit('ip-a')), [true, true, true, false]);
  assert.equal(limiter.hit('ip-b'), true);
  assert.equal(limiter.retryAfterSec('ip-a'), 1);
  t = 1000;
  assert.equal(limiter.hit('ip-a'), true);
});

test('the limiter keeps a bounded number of keys', () => {
  const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1000, now: () => 0, maxKeys: 3 });
  for (const k of ['a', 'b', 'c', 'd', 'e']) limiter.hit(k);
  assert.equal(limiter.size(), 3);
});
