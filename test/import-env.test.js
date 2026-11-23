// Import limits read from the environment (upload size cap, STT timeout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveImportLimits, DEFAULT_IMPORT_MAX_BYTES, DEFAULT_IMPORT_STT_TIMEOUT_MS } from '../src/config/env.js';

test('import limits default to 2 GiB uploads and a 3 hour transcription timeout', () => {
  assert.equal(DEFAULT_IMPORT_MAX_BYTES, 2 * 1024 ** 3);
  assert.equal(DEFAULT_IMPORT_STT_TIMEOUT_MS, 3 * 60 * 60 * 1000);
  assert.deepEqual(resolveImportLimits({}), {
    importMaxBytes: DEFAULT_IMPORT_MAX_BYTES, importSttTimeoutMs: DEFAULT_IMPORT_STT_TIMEOUT_MS,
  });
});

test('import limits accept positive whole numbers from the environment', () => {
  assert.deepEqual(resolveImportLimits({ IMPORT_MAX_BYTES: ' 1048576 ', IMPORT_STT_TIMEOUT_MS: '60000' }), {
    importMaxBytes: 1_048_576, importSttTimeoutMs: 60_000,
  });
});

test('malformed or non-positive import limits fall back to the defaults', () => {
  for (const bad of ['0', '-5', '1.5', 'abc', '', '99999999999999999999']) {
    const limits = resolveImportLimits({ IMPORT_MAX_BYTES: bad, IMPORT_STT_TIMEOUT_MS: bad });
    assert.equal(limits.importMaxBytes, DEFAULT_IMPORT_MAX_BYTES, `IMPORT_MAX_BYTES=${bad}`);
    assert.equal(limits.importSttTimeoutMs, DEFAULT_IMPORT_STT_TIMEOUT_MS, `IMPORT_STT_TIMEOUT_MS=${bad}`);
  }
});
