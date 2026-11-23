// The Gemini adapter talks to the generateContent REST endpoint through the
// same long-generation HTTP client as the other providers (Node's own fetch
// gives up waiting for headers after 300 s, whatever the deadline).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { GeminiSummarizer } from '../src/adapters/summarizer/gemini.js';
import { describeSummarizerError } from '../src/adapters/summarizer/errors.js';

const NOTES = { tldr: 'done', topics: [], decisions: [], openQuestions: [], actionItems: [] };

async function geminiServer({ delayMs = 0, status = 200, reply } = {}) {
  const seen = [];
  const timers = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(body) });
      timers.push(setTimeout(() => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(reply ?? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(NOTES) }] } }] }));
      }, delayMs));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => { timers.forEach(clearTimeout); server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

test('Gemini posts generateContent with the key header and the notes schema, and reads the reply', async () => {
  const srv = await geminiServer();
  try {
    const notes = await new GeminiSummarizer('gemini-x', 'gk', { baseUrl: srv.baseUrl }).summarize('hello transcript', { channelName: 'standup' });
    assert.equal(notes.tldr, 'done');
    const [call] = srv.seen;
    assert.equal(call.url, '/v1beta/models/gemini-x:generateContent');
    assert.equal(call.key, 'gk');
    assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
    assert.ok(call.body.generationConfig.responseSchema.properties.tldr);
    assert.equal(call.body.contents[0].role, 'user');
    assert.match(call.body.contents[0].parts[0].text, /hello transcript/);
  } finally { await srv.close(); }
});

test('Gemini uses its own timeout for the whole generation and does not retry it', async () => {
  const srv = await geminiServer({ delayMs: 2500 });
  try {
    const started = Date.now();
    await assert.rejects(new GeminiSummarizer('gemini-x', 'gk', { baseUrl: srv.baseUrl, timeoutMs: 300 }).summarize('t', {}),
      /Gemini did not answer within/);
    assert.ok(Date.now() - started < 2400);
    assert.equal(srv.seen.length, 1);
  } finally { await srv.close(); }
});

test('Gemini errors keep their HTTP status for the user-facing reason', async () => {
  const srv = await geminiServer({ status: 401, reply: { error: { code: 401, message: 'API key not valid.' } } });
  try {
    const err = await new GeminiSummarizer('gemini-x', 'bad', { baseUrl: srv.baseUrl }).summarize('t', {}).catch((e) => e);
    assert.equal(err.status, 401);
    assert.match(describeSummarizerError(err, 'gemini'), /Authentication failed \(401\)/);
    assert.match(err.message, /API key not valid/);
  } finally { await srv.close(); }
});

test('Gemini stopping at its output limit, or blocking the answer, is a clear error', async () => {
  const limit = await geminiServer({ reply: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"tl' }] } }] } });
  try {
    await assert.rejects(new GeminiSummarizer('gemini-x', 'gk', { baseUrl: limit.baseUrl }).summarize('t', {}), /output limit/);
  } finally { await limit.close(); }
  const blocked = await geminiServer({ reply: { promptFeedback: { blockReason: 'SAFETY' } } });
  try {
    await assert.rejects(new GeminiSummarizer('gemini-x', 'gk', { baseUrl: blocked.baseUrl }).ask('q'), /blocked.*SAFETY/i);
  } finally { await blocked.close(); }
});

test('Gemini ask() asks for free text (no notes schema)', async () => {
  const srv = await geminiServer({ reply: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'An ' }, { text: 'answer.' }] } }] } });
  try {
    assert.equal(await new GeminiSummarizer('gemini-x', 'gk', { baseUrl: srv.baseUrl }).ask('why?'), 'An answer.');
    assert.equal(srv.seen[0].body.generationConfig, undefined);
    assert.equal(srv.seen[0].body.contents[0].parts[0].text, 'why?');
  } finally { await srv.close(); }
});
