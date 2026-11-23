import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BotController, createShutdown, FINALIZE_DRAIN_MS, SHUTDOWN_LIMIT_MS } from '../src/bot-controller.js';

const quietLog = { log() {}, warn() {}, error() {} };

// What startBot() returns, minus Discord: an EventEmitter client and a manager
// whose finalize pipelines the test controls.
function fakeBot({ finalize = async () => ({ timedOut: false, pending: 0 }) } = {}) {
  const calls = [];
  const client = new EventEmitter();
  client.on('error', () => {}); // bot.js logs client errors itself, so an emit never throws
  client.destroy = async () => { calls.push('destroy'); };
  const active = new Map();
  const manager = {
    listActive: () => [...active.values()],
    listProcessing: () => [],
    isActive: (g, c) => active.has(`${g}:${c}`),
    waitForFinalize: async (ms) => { calls.push(`wait:${ms}`); return finalize(ms); },
  };
  const bot = {
    client, manager, calls, active,
    stopAndLeave: async (g, c) => { calls.push(`stop:${g}:${c}`); active.delete(`${g}:${c}`); },
    cancelJoin: (g, c) => { calls.push(`cancel:${g}:${c}`); return c === 'joining'; },
    quiesce: () => calls.push('quiesce'),
  };
  return bot;
}

function controller(bots) {
  const queue = [...bots];
  return new BotController({ db: {}, audioRoot: '/x', startBot: () => queue.shift(), hasCreds: () => true, log: quietLog });
}

test('the finalize wait for stop/restart is a few minutes', () => {
  assert.ok(FINALIZE_DRAIN_MS >= 60_000 && FINALIZE_DRAIN_MS <= 10 * 60_000);
});

test('stop() quiesces, stops live meetings, and waits for pipelines BEFORE destroying the client', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const bot = fakeBot({ finalize: async () => { await gate; return { timedOut: false, pending: 0 }; } });
  bot.active.set('g:c', { guildId: 'g', channelId: 'c' });
  const ctl = controller([bot]);
  await ctl.start();
  const stopping = ctl.stop();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(bot.calls, ['quiesce', 'stop:g:c', `wait:${FINALIZE_DRAIN_MS}`]);
  assert.equal(bot.calls.includes('destroy'), false, 'notes are still being delivered through this client');
  release();
  await stopping;
  assert.equal(bot.calls.at(-1), 'destroy');
  assert.equal(ctl.state, 'stopped');
});

test('a pipeline that outlasts the bound is logged and the client destroyed anyway', async () => {
  const warnings = [];
  const bot = fakeBot({ finalize: async () => ({ timedOut: true, pending: 2 }) });
  const ctl = new BotController({ db: {}, audioRoot: '/x', startBot: () => bot, hasCreds: () => true, log: { ...quietLog, warn: (m) => warnings.push(m) } });
  await ctl.start();
  await ctl.stop({ drainTimeoutMs: 10 });
  assert.ok(bot.calls.includes('destroy'));
  assert.match(warnings.join('\n'), /2 meeting pipeline/);
});

test('clientReady marks the bot ready', async () => {
  const bot = fakeBot();
  const ctl = controller([bot]);
  await ctl.start();
  assert.equal(ctl.state, 'starting');
  bot.client.emit('clientReady', bot.client);
  assert.equal(ctl.state, 'ready');
});

test('a stale client\'s late error cannot flip the restarted controller to error', async () => {
  const oldBot = fakeBot();
  const newBot = fakeBot();
  const ctl = controller([oldBot, newBot]);
  await ctl.start();
  await ctl.restart();
  newBot.client.emit('clientReady', newBot.client);
  oldBot.client.emit('error', new Error('An invalid token was provided.'));
  assert.equal(ctl.state, 'ready');
  assert.equal(ctl.error, null);
  assert.equal(oldBot.client.listenerCount('error'), 1, 'only bot.js\'s own logger remains on the old client');
});

test('start() during a stop waits for it, so two clients never run at once', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = fakeBot({ finalize: async () => { await gate; return { timedOut: false, pending: 0 }; } });
  const second = fakeBot();
  const ctl = controller([first, second]);
  await ctl.start();
  const stopping = ctl.stop();
  const starting = ctl.start();
  await new Promise((r) => setImmediate(r));
  assert.notEqual(ctl.client, second.client);
  release();
  await stopping;
  await starting;
  assert.ok(first.calls.includes('destroy'));
  assert.equal(ctl.client, second.client);
});

test('a dashboard stop during the join window cancels the pending recording', async () => {
  const bot = fakeBot();
  const ctl = controller([bot]);
  await ctl.start();
  assert.deepEqual(await ctl.stopMeeting('g', 'joining'), { ok: true, cancelled: true });
  assert.equal((await ctl.stopMeeting('g', 'nothing')).ok, false);
});

// ── graceful shutdown on SIGTERM / SIGINT ─────────────────────────────────────
function shutdownHarness({ botStop = async () => {}, limitMs = 1_000 } = {}) {
  const order = [];
  const exits = [];
  const shutdown = createShutdown({
    bot: { stop: async (opts) => { order.push(['bot', opts]); await botStop(); } },
    sidecar: { stop: async () => { order.push(['sidecar']); } },
    closeServer: async () => { order.push(['server']); },
    exit: (code) => exits.push(code),
    log: quietLog, drainMs: 123, limitMs,
  });
  return { shutdown, order, exits };
}

test('shutdown stays under Docker\'s 10 s grace period', () => {
  assert.ok(SHUTDOWN_LIMIT_MS < 10_000);
});

test('shutdown stops the bot (bounded drain), then the sidecar and web server, then exits 0', async () => {
  const { shutdown, order, exits } = shutdownHarness();
  await shutdown('SIGTERM');
  assert.deepEqual(order, [['bot', { drainTimeoutMs: 123 }], ['sidecar'], ['server']]);
  assert.deepEqual(exits, [0]);
});

test('a failing step does not block the rest of shutdown', async () => {
  const { shutdown, order, exits } = shutdownHarness({ botStop: async () => { throw new Error('boom'); } });
  await shutdown('SIGTERM');
  assert.deepEqual(order.map(([name]) => name), ['bot', 'sidecar', 'server']);
  assert.deepEqual(exits, [0]);
});

test('a second signal forces an immediate exit', async () => {
  let release;
  const { shutdown, exits } = shutdownHarness({ botStop: () => new Promise((r) => { release = r; }) });
  const first = shutdown('SIGTERM');
  await shutdown('SIGINT');
  assert.deepEqual(exits, [1]);
  release();
  await first;
});

test('a hung shutdown is cut off at the limit', async () => {
  const { shutdown, exits } = shutdownHarness({ botStop: () => new Promise(() => {}), limitMs: 20 });
  shutdown('SIGTERM');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(exits, [1]);
});

test('applyNickname forwards to the running bot; offline it defers to the next connect', async () => {
  const bot = fakeBot();
  bot.applyNickname = async (guildId) => { bot.calls.push(`nick:${guildId}`); };
  const ctl = controller([bot]);
  // Not an error: the bot applies configured names when it connects.
  assert.equal(await ctl.applyNickname('g'), false);
  await ctl.start();
  // Still logging in: the guild cache is empty, so defer to the ready handler.
  assert.equal(await ctl.applyNickname('g'), false);
  bot.client.emit('clientReady', bot.client);
  assert.equal(await ctl.applyNickname('g'), true);
  assert.ok(bot.calls.includes('nick:g'));
  // Discord refusing the change is surfaced to the caller.
  bot.applyNickname = async () => { throw new Error('Missing Permissions'); };
  await assert.rejects(ctl.applyNickname('g'), /Missing Permissions/);
});
