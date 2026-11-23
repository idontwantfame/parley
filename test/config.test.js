import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.js';
import { getGuildConfig, setGuildConfig, DEFAULTS } from '../src/store/config.js';

test('getGuildConfig returns defaults for unknown guild', () => {
  const db = openDb(':memory:');
  assert.deepEqual(getGuildConfig(db, 'g'), { guildId: 'g', ...DEFAULTS });
});

test('setGuildConfig merges and persists partial updates', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { summarizerProvider: 'ollama', whisperModel: 'medium' });
  const c = getGuildConfig(db, 'g');
  assert.equal(c.summarizerProvider, 'ollama');
  assert.equal(c.whisperModel, 'medium');
  assert.equal(c.autoJoin, DEFAULTS.autoJoin); // untouched default
});

test('setGuildConfig second update keeps prior values', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { summarizerProvider: 'ollama' });
  setGuildConfig(db, 'g', { language: 'es' });
  const c = getGuildConfig(db, 'g');
  assert.equal(c.summarizerProvider, 'ollama');
  assert.equal(c.language, 'es');
});

test('setGuildConfig round-trips boolean false', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { useThread: false, autoJoin: false });
  const c = getGuildConfig(db, 'g');
  assert.equal(c.useThread, false);
  assert.equal(c.autoJoin, false);
});

test('the auto-join minimum defaults to two for old rows and persists independently of the toggle', () => {
  const db = openDb(':memory:');
  db.sql.prepare('INSERT INTO guild_config (guild_id, auto_join) VALUES (?, 1)').run('g');
  assert.equal(getGuildConfig(db, 'g').autoJoinMinPeople, 2);
  setGuildConfig(db, 'g', { autoJoinMinPeople: 4 });
  setGuildConfig(db, 'g', { autoJoin: false });
  assert.equal(getGuildConfig(db, 'g').autoJoinMinPeople, 4);
});

test('setGuildConfig ignores undefined patch values and pins guildId', () => {
  const db = openDb(':memory:');
  assert.doesNotThrow(() => setGuildConfig(db, 'g', { summarizerModel: undefined, language: 'es', guildId: 'evil' }));
  const c = getGuildConfig(db, 'g');
  assert.equal(c.language, 'es');
  assert.equal(c.guildId, 'g');               // not 'evil'
  assert.equal(c.summarizerModel, DEFAULTS.summarizerModel); // undefined patch ignored
});

test('setGuildConfig can reset notesChannelId back to null', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { notesChannelId: '123' });
  setGuildConfig(db, 'g', { notesChannelId: null });
  assert.equal(getGuildConfig(db, 'g').notesChannelId, null);
});

test('summaryLanguage defaults to en', () => {
  const db = openDb(':memory:');
  assert.equal(getGuildConfig(db, 'g').summaryLanguage, 'en');
});

test('setGuildConfig persists summaryLanguage', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { summaryLanguage: 'de' });
  assert.equal(getGuildConfig(db, 'g').summaryLanguage, 'de');
});

test('summary prompt stays NULL (built-in) until a guild writes its own', () => {
  const db = openDb(':memory:');
  const stored = (g) => db.sql.prepare(`SELECT summary_prompt FROM guild_config WHERE guild_id = ?`).get(g).summary_prompt;
  assert.equal(getGuildConfig(db, 'g1').summaryPrompt, null);
  // Saving an unrelated setting must not snapshot the built-in prompt into the row.
  setGuildConfig(db, 'g1', { language: 'de' });
  assert.equal(stored('g1'), null);
  setGuildConfig(db, 'g1', { summaryPrompt: 'Return concise JSON notes.' });
  setGuildConfig(db, 'g1', { language: 'fr' });
  assert.equal(getGuildConfig(db, 'g1').summaryPrompt, 'Return concise JSON notes.');
  setGuildConfig(db, 'g1', { summaryPrompt: null });
  assert.equal(stored('g1'), null);
});

test('sttProvider defaults to sidecar', () => {
  const db = openDb(':memory:');
  assert.equal(getGuildConfig(db, 'g').sttProvider, 'sidecar');
  assert.equal(getGuildConfig(db, 'g').sttModel, null);
});

test('setGuildConfig persists sttProvider + sttModel', () => {
  const db = openDb(':memory:');
  setGuildConfig(db, 'g', { sttProvider: 'openai', sttModel: 'whisper-1' });
  const c = getGuildConfig(db, 'g');
  assert.equal(c.sttProvider, 'openai');
  assert.equal(c.sttModel, 'whisper-1');
  assert.equal(c.whisperModel, DEFAULTS.whisperModel); // sidecar model untouched
});

test('setGuildConfig persists the bot name and defaults it to null', () => {
  const db = openDb(':memory:');
  assert.equal(DEFAULTS.botNickname, null);
  assert.equal(getGuildConfig(db, 'g').botNickname, null);
  setGuildConfig(db, 'g', { botNickname: 'Scribe' });
  assert.equal(getGuildConfig(db, 'g').botNickname, 'Scribe');
  setGuildConfig(db, 'g', { autoJoin: false }); // unrelated update keeps it
  assert.equal(getGuildConfig(db, 'g').botNickname, 'Scribe');
  setGuildConfig(db, 'g', { botNickname: null });
  assert.equal(getGuildConfig(db, 'g').botNickname, null);
});

test('openDb adds bot_nickname to an existing guild_config without losing its rows', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'parley-botname-'));
  const path = join(dir, 'meetings.db');
  let db;
  try {
    const raw = new DatabaseSync(path);
    // The original guild_config: every column the migrations don't add.
    raw.exec(`CREATE TABLE guild_config (
      guild_id TEXT PRIMARY KEY, summarizer_provider TEXT, summarizer_model TEXT,
      whisper_model TEXT, notes_channel_id TEXT, use_thread INTEGER, auto_join INTEGER, language TEXT
    );`);
    raw.prepare(`INSERT INTO guild_config (guild_id, summarizer_provider, use_thread) VALUES ('g', 'ollama', 0)`).run();
    raw.close();

    db = openDb(path);
    assert.ok(db.sql.prepare(`PRAGMA table_info(guild_config)`).all().some((c) => c.name === 'bot_nickname'));
    const before = getGuildConfig(db, 'g');
    assert.equal(before.summarizerProvider, 'ollama');
    assert.equal(before.botNickname, null);
    setGuildConfig(db, 'g', { botNickname: 'Scribe' });
    assert.equal(getGuildConfig(db, 'g').botNickname, 'Scribe');
  } finally {
    db?.sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
