import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {redact} from './pty-diagnostics.mjs';

export function assertNativeStatus(expected, response, states, diagnostic) {
  const actual = response?.data?.apps?.[0]?.auth?.state;
  if (actual !== expected) {
    // Preserve the entire JSON, including unknown reason/detail fields, before asserting.
    diagnostic(redact(`[STATUS MISMATCH] expected=${expected}\n${JSON.stringify(response, null, 2)}`, states).text);
  }
  assert.equal(actual, expected, 'Native credential state mismatch; see redacted ctl list response');
}
export function cleanupTemporaryRoot(root, {platform = process.platform, remove = rmSync, warn = console.warn} = {}) {
  try { remove(root, {recursive:true, force:true, ...(platform === 'win32' ? {maxRetries:8, retryDelay:200} : {})}); }
  catch (error) {
    if (platform !== 'win32') throw error;
    const code = /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'CLEANUP_FAILED';
    warn(`[CLEANUP WARNING] temporary directory removal failed after retries (${code}); preserving the original result`);
  }
}
