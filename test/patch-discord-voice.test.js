import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../scripts/patch-discord-voice.mjs', import.meta.url).pathname;
const ORIGINAL = '    if (packet.channel_id) this.joinConfig.channelId = packet.channel_id;';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function fakeVoice(version, source = `a\n${ORIGINAL}\nb\n`) {
  const root = mkdtempSync(join(tmpdir(), 'parley-voice-'));
  const dir = join(root, 'node_modules', '@discordjs', 'voice');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  for (const f of ['index.mjs', 'index.js']) writeFileSync(join(dir, 'dist', f), source);
  return { root, dir };
}
const run = (args, env = {}, cwd = undefined) =>
  spawnSync(process.execPath, args, { encoding: 'utf8', cwd, env: { ...process.env, npm_lifecycle_event: '', ...env } });

test('package.json runs the patch on install', () => {
  assert.match(pkg.scripts.postinstall || '', /patch-discord-voice\.mjs/);
});

test('exits 0 without touching anything when @discordjs/voice is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'parley-voice-none-'));
  try {
    const r = run([SCRIPT, join(root, 'missing')]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /not installed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('other versions are left alone', () => {
  const { root, dir } = fakeVoice('0.19.3');
  try {
    assert.equal(run([SCRIPT, dir]).status, 0);
    assert.equal(readFileSync(join(dir, 'dist', 'index.mjs'), 'utf8'), `a\n${ORIGINAL}\nb\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('0.19.2 is patched once and re-running is a no-op', () => {
  const { root, dir } = fakeVoice('0.19.2');
  try {
    assert.equal(run([SCRIPT, dir]).status, 0);
    const once = readFileSync(join(dir, 'dist', 'index.js'), 'utf8');
    assert.match(once, /this\.state\.status === "signalling"\) this\.configureNetworking\(\)/);
    assert.equal(run([SCRIPT, dir]).status, 0);
    assert.equal(readFileSync(join(dir, 'dist', 'index.js'), 'utf8'), once);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unexpected source fails an explicit run but never breaks npm install', () => {
  const { root, dir } = fakeVoice('0.19.2', 'something else entirely\n');
  try {
    assert.equal(run([SCRIPT, dir]).status, 1);
    const asPostinstall = run([SCRIPT, dir], { npm_lifecycle_event: 'postinstall' });
    assert.equal(asPostinstall.status, 0);
    assert.match(asPostinstall.stderr, /Unexpected voice library source/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The Docker deps stage runs `npm ci` before scripts/ is copied in.
test('the postinstall command tolerates the script not being present yet', () => {
  const root = mkdtempSync(join(tmpdir(), 'parley-voice-noscript-'));
  try {
    const command = pkg.scripts.postinstall;
    const code = /^node -e "(.*)"$/.exec(command)?.[1]?.replace(/\\"/g, '"');
    assert.ok(code, 'postinstall is a node -e one-liner');
    assert.equal(run(['-e', code], { npm_lifecycle_event: 'postinstall' }, root).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the postinstall command patches the project-local @discordjs/voice', () => {
  const { root, dir } = fakeVoice('0.19.2');
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(SCRIPT, join(root, 'scripts', 'patch-discord-voice.mjs'));
    const code = /^node -e "(.*)"$/.exec(pkg.scripts.postinstall)[1].replace(/\\"/g, '"');
    const r = run(['-e', code], { npm_lifecycle_event: 'postinstall' }, root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(dir, 'dist', 'index.mjs'), 'utf8'), /configureNetworking/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
