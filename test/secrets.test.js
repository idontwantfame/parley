// test/secrets.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { parseEnv } from 'node:util';
import dotenv from 'dotenv';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertEnvLine, setProviderKey, secretStatus, isSecretProvider, connectionStatus, setConnection, redactUrl } from '../src/store/secrets.js';

test('upsertEnvLine replaces an existing key in place', () => {
  const text = 'A=1\nGEMINI_API_KEY=old\nB=2\n';
  const out = upsertEnvLine(text, 'GEMINI_API_KEY', 'new');
  assert.equal(out, 'A=1\nGEMINI_API_KEY=new\nB=2\n');
});

test('upsertEnvLine replaces an empty/commented-style key', () => {
  const text = 'GEMINI_API_KEY=\nB=2\n';
  assert.equal(upsertEnvLine(text, 'GEMINI_API_KEY', 'abc'), 'GEMINI_API_KEY=abc\nB=2\n');
});

test('upsertEnvLine appends a missing key with a trailing newline', () => {
  assert.equal(upsertEnvLine('A=1', 'OPENAI_API_KEY', 'sk'), 'A=1\nOPENAI_API_KEY=sk\n');
  assert.equal(upsertEnvLine('', 'OPENAI_API_KEY', 'sk'), 'OPENAI_API_KEY=sk\n');
});

test('isSecretProvider only true for keyed providers', () => {
  assert.equal(isSecretProvider('gemini'), true);
  assert.equal(isSecretProvider('openai'), true);
  assert.equal(isSecretProvider('opencode'), true);
  assert.equal(isSecretProvider('openrouter'), true);
  assert.equal(isSecretProvider('ollama'), false);
  assert.equal(isSecretProvider('fake'), false);
});

test('setProviderKey updates live config + persists to .env, and clears it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-secrets-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'DISCORD_TOKEN=x\nGEMINI_API_KEY=\n');
  // Fake in-memory config mirroring src/config/env.js shape.
  const env = { gemini: { apiKey: undefined }, openai: {}, opencode: {}, openrouter: {} };

  let status = await setProviderKey('gemini', '  my-key  ', { env, envPath });
  assert.equal(env.gemini.apiKey, 'my-key'); // trimmed + applied live
  assert.equal(status.gemini, true);
  assert.match(readFileSync(envPath, 'utf8'), /GEMINI_API_KEY=my-key/);

  status = await setProviderKey('gemini', '', { env, envPath });
  assert.equal(env.gemini.apiKey, undefined); // cleared live
  assert.equal(status.gemini, false);
  assert.doesNotMatch(readFileSync(envPath, 'utf8'), /GEMINI_API_KEY/); // removed, not KEY=

  rmSync(dir, { recursive: true, force: true });
});

test('setProviderKey rejects a non-keyed provider', async () => {
  await assert.rejects(() => setProviderKey('ollama', 'x', { env: {}, envPath: '/tmp/none' }),
    /no editable API key/);
});

test('connectionStatus reports presence for the token and values for the rest', () => {
  const env = { discordToken: 'abc', discordClientId: '123', sttUrl: 'http://x:8000' };
  const s = connectionStatus(env);
  assert.equal(s.discordToken.set, true);
  assert.equal('value' in s.discordToken, false); // never leaks the token value
  assert.equal(s.discordClientId.value, '123');
  assert.equal(s.sttUrl.value, 'http://x:8000');
});

test('setConnection applies live + persists, ignoring unknown keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-conn-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'DISCORD_TOKEN=\nDISCORD_CLIENT_ID=\n');
  const env = { discordToken: undefined, discordClientId: undefined, sttUrl: undefined };

  const status = await setConnection(
    { discordToken: '  tok  ', discordClientId: '999', sttUrl: 'http://sidecar:8000', bogus: 'nope' },
    { env, envPath },
  );
  assert.equal(env.discordToken, 'tok');          // trimmed + live
  assert.equal(env.discordClientId, '999');
  assert.equal(env.sttUrl, 'http://sidecar:8000');
  assert.equal(status.discordClientId.value, '999');
  const text = readFileSync(envPath, 'utf8');
  assert.match(text, /DISCORD_TOKEN=tok/);
  assert.match(text, /DISCORD_CLIENT_ID=999/);
  assert.match(text, /STT_URL=http:\/\/sidecar:8000/);
  assert.doesNotMatch(text, /bogus/);

  rmSync(dir, { recursive: true, force: true });
});

test('setConnection clearing the STT url falls back to the default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-conn2-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, '');
  const env = { sttUrl: 'http://old:8000' };
  await setConnection({ sttUrl: '' }, { env, envPath });
  assert.equal(env.sttUrl, 'http://127.0.0.1:8000');
  rmSync(dir, { recursive: true, force: true });
});

test('Ollama URL updates live and persists a normalized LAN base URL', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-ollama-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envPath = join(dir, '.env');
  const env = { ollama: { url: 'http://127.0.0.1:11434' } };
  await assert.rejects(() => setConnection({ ollamaUrl: 'http://user:password@ollama:11434' }, { env, envPath }), /without credentials/);
  const next = await setConnection({ ollamaUrl: 'http://ollama:11434/' }, { env, envPath });
  assert.equal(next.ollamaUrl.value, 'http://ollama:11434');
  assert.equal(env.ollama.url, 'http://ollama:11434');
  assert.match(readFileSync(envPath, 'utf8'), /^OLLAMA_URL=http:\/\/ollama:11434$/m);
});

// ── Injection / SSRF hardening ────────────────────────────────────────────────

test('setProviderKey rejects a value with embedded newlines (.env injection)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-inject-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'OPENAI_API_KEY=\n');
  const env = { gemini: {}, openai: { apiKey: 'safe' }, opencode: {}, openrouter: {} };
  await assert.rejects(
    () => setProviderKey('openai', 'x\nOPENAI_BASE_URL=https://evil.example/v1', { env, envPath }),
    /control characters/,
  );
  // Neither the live config nor the file was mutated by the rejected write.
  assert.equal(env.openai.apiKey, 'safe');
  assert.doesNotMatch(readFileSync(envPath, 'utf8'), /evil\.example/);
  rmSync(dir, { recursive: true, force: true });
});

test('setConnection rejects an STT url pointing at cloud metadata (SSRF)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-ssrf-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, '');
  const env = { sttUrl: 'http://127.0.0.1:8000' };
  await assert.rejects(
    () => setConnection({ sttUrl: 'http://169.254.169.254/latest/meta-data' }, { env, envPath }),
    /blocked address/,
  );
  assert.equal(env.sttUrl, 'http://127.0.0.1:8000'); // unchanged
  rmSync(dir, { recursive: true, force: true });
});

test('setConnection rejects a non-http STT url', async () => {
  const env = { sttUrl: 'http://127.0.0.1:8000' };
  await assert.rejects(
    () => setConnection({ sttUrl: 'file:///etc/passwd' }, { env, envPath: '/tmp/none-xyz' }),
    /http or https/,
  );
});

test('setConnection allows a normal LAN sidecar url', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-lan-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, '');
  const env = { sttUrl: undefined };
  await setConnection({ sttUrl: 'http://192.168.1.50:8000' }, { env, envPath });
  assert.equal(env.sttUrl, 'http://192.168.1.50:8000'); // private ranges are fine
  rmSync(dir, { recursive: true, force: true });
});

test('upsertEnvLine escapes regex metacharacters in the key', () => {
  // A key with regex-special chars must match literally, not as a pattern.
  const text = 'A.B=old\nC=2\n';
  assert.equal(upsertEnvLine(text, 'A.B', 'new'), 'A.B=new\nC=2\n');
});

// ── Atomic validation, .env round-trips, SSRF edge cases ─────────────────────

function tmpEnv(t, initial = '') {
  const dir = mkdtempSync(join(tmpdir(), 'parley-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, initial);
  return { dir, envPath };
}

test('setConnection validates every key before persisting or applying any', async (t) => {
  const { envPath } = tmpEnv(t, 'DISCORD_TOKEN=old\n');
  const env = { discordToken: 'old', sttUrl: 'http://127.0.0.1:8000' };
  await assert.rejects(() => setConnection({ discordToken: 'NEW', sttUrl: 'ftp://x' }, { env, envPath }), /http or https/);
  assert.equal(env.discordToken, 'old');
  assert.equal(readFileSync(envPath, 'utf8'), 'DISCORD_TOKEN=old\n');
});

test('setConnection writes several keys in one go', async (t) => {
  const { envPath } = tmpEnv(t);
  const env = {};
  await setConnection({ discordToken: 'tok', discordClientId: '42' }, { env, envPath });
  assert.deepEqual(parseEnv(readFileSync(envPath, 'utf8')), { DISCORD_TOKEN: 'tok', DISCORD_CLIENT_ID: '42' });
});

test('saved values round-trip through Node and dotenv parsers', async (t) => {
  const { envPath } = tmpEnv(t, '# keep me\nOTHER=1\n');
  const env = { gemini: {}, openai: {}, opencode: {}, openrouter: {} };
  const values = ['key#with#hash', '"leading-quote', "it's", 'all\'three"`quotes-no', 'back\\slash\\n', ' spaced  out ', 'plain-key_1.2'];
  for (const value of values) {
    if (value.includes("'") && value.includes('"') && value.includes('`')) {
      await assert.rejects(() => setProviderKey('gemini', value, { env, envPath }), /quote/);
      continue;
    }
    await setProviderKey('gemini', value, { env, envPath });
    const text = readFileSync(envPath, 'utf8');
    for (const parse of [parseEnv, dotenv.parse]) {
      const parsed = parse(text);
      assert.equal(parsed.GEMINI_API_KEY, value.trim(), `${JSON.stringify(value)} via ${parse === parseEnv ? 'node' : 'dotenv'}`);
      assert.equal(parsed.OTHER, '1');
    }
  }
});

test('an empty value removes the key instead of writing KEY=', async (t) => {
  const { envPath } = tmpEnv(t, 'STT_URL=http://lan:8000\nOTHER=1\n');
  const env = { sttUrl: 'http://lan:8000' };
  await setConnection({ sttUrl: '' }, { env, envPath });
  assert.equal(readFileSync(envPath, 'utf8'), 'OTHER=1\n');
});

test('.env writes are atomic renames and always leave mode 0600', async (t) => {
  const { dir, envPath } = tmpEnv(t, 'A=1\n');
  chmodSync(envPath, 0o644);
  const env = { gemini: {}, openai: {}, opencode: {}, openrouter: {} };
  const before = statSync(envPath).ino;
  await setProviderKey('gemini', 'k', { env, envPath });
  const after = statSync(envPath);
  assert.equal(after.mode & 0o777, 0o600);
  assert.notEqual(after.ino, before);
  assert.deepEqual(readdirSync(dir), ['.env']);
});

test('STT URL guard covers bracketed IPv6 link-local, IPv4-mapped metadata and credentials', async () => {
  const env = { sttUrl: 'http://127.0.0.1:8000' };
  for (const sttUrl of ['http://[fe80::1]:8000', 'http://[::ffff:169.254.169.254]/', 'http://[::ffff:a9fe:a9fe]/',
    'http://[::]:8000', 'http://user:secret@sidecar:8000']) {
    await assert.rejects(() => setConnection({ sttUrl }, { env, envPath: '/nonexistent/parley.env' }), /blocked|credentials/, sttUrl);
  }
  assert.equal(env.sttUrl, 'http://127.0.0.1:8000');
});

test('connectionStatus redacts credentials in a legacy STT URL', () => {
  const s = connectionStatus({ sttUrl: 'http://user:secret@sidecar:8000/' });
  assert.equal(s.sttUrl.value.includes('secret'), false);
  assert.equal(redactUrl('http://user:secret@sidecar:8000/'), 'http://sidecar:8000/');
  assert.equal(redactUrl('not a url'), 'not a url');
});
