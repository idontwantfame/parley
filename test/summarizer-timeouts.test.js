import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAISummarizer } from '../src/adapters/summarizer/openai.js';
import { OpenCodeSummarizer } from '../src/adapters/summarizer/opencode.js';
import { OpenRouterSummarizer } from '../src/adapters/summarizer/openrouter.js';

// An OpenAI-compatible server that, like any stream:false completion, sends
// headers only once the whole generation is finished.
async function chatServer(delayMs) {
  const timers = [];
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      timers.push(setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"tldr":"done"}' } }] }));
      }, delayMs));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    seen,
    close: () => {
      timers.forEach(clearTimeout);
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

const adapters = [
  ['OpenAI', (url, opts) => new OpenAISummarizer('gpt-x', url, 'k', undefined, opts)],
  ['OpenCode', (url, opts) => new OpenCodeSummarizer('glm', url, 'k', undefined, opts)],
  ['OpenRouter', (url, opts) => new OpenRouterSummarizer('a/b', url, 'k', undefined, opts)],
];

for (const [name, make] of adapters) {
  test(`${name} uses its own timeout for the whole generation and does not retry it`, async () => {
    const srv = await chatServer(2500);
    try {
      const started = Date.now();
      await assert.rejects(make(srv.url, { timeoutMs: 300 }).summarize('t', {}), new RegExp(`${name} did not answer within`));
      assert.ok(Date.now() - started < 2400);
      assert.equal(srv.seen.length, 1);
    } finally { await srv.close(); }
  });

  test(`${name} default HTTP client posts the chat completion and reads the reply`, async () => {
    const srv = await chatServer(10);
    try {
      const notes = await make(srv.url).summarize('hello transcript', {});
      assert.equal(notes.tldr, 'done');
      assert.equal(srv.seen[0].url, '/v1/chat/completions');
      assert.equal(srv.seen[0].auth, 'Bearer k');
      assert.match(srv.seen[0].body.messages[0].content, /hello transcript/);
      assert.equal(await make(srv.url).ask('q'), '{"tldr":"done"}');
    } finally { await srv.close(); }
  });
}
