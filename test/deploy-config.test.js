// Supply-chain and container hardening in the deployment files (plain-text
// checks: no YAML parser needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('every third-party action is pinned to a full commit SHA', () => {
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/publish-images.yml']) {
    const uses = [...read(file).matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
    for (const ref of uses.filter((u) => !u.startsWith('./'))) {
      assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${file}: ${ref}`);
    }
  }
});

test('images are published only after the tests pass', () => {
  const publish = read('.github/workflows/publish-images.yml');
  assert.match(publish, /uses:\s*\.\/\.github\/workflows\/ci\.yml/);
  assert.match(publish, /needs:\s*\[?\s*tests/);
  assert.match(read('.github/workflows/ci.yml'), /workflow_call:/);
});

test('the Dockerfile pins its base image to an exact Node version', () => {
  const froms = [...read('Dockerfile').matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
  assert.ok(froms.length >= 3);
  for (const image of froms) assert.match(image, /^node:\d+\.\d+\.\d+-bookworm-slim$/, image);
});

test('compose drops privileges for both services and passes the optional sidecar key', () => {
  const compose = read('docker-compose.yml');
  assert.equal(compose.match(/no-new-privileges:true/g)?.length, 2);
  assert.equal(compose.match(/cap_drop:\s*\n\s*- ALL/g)?.length, 2);
  for (const cap of ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID']) assert.match(compose, new RegExp(`- ${cap}\\b`));
  assert.match(compose, /STT_API_KEY: \$\{STT_API_KEY:-\}/);
});
