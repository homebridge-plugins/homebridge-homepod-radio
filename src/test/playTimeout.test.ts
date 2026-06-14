import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { computeWatchdog } from '../lib/playTimeout.js';

// Same constants the WarmPlayer uses, mirrored here so the test pins the real
// behaviour rather than re-deriving it.
const PADDING_MS = 30000;
const UNKNOWN_MS = 30 * 60 * 1000;

test('a known duration is sized to length + padding', () => {
    const { timeoutMs, known } = computeWatchdog(73, PADDING_MS, UNKNOWN_MS);
    assert.equal(known, true);
    assert.equal(timeoutMs, 73000 + PADDING_MS);
});

test('fractional seconds round up to whole milliseconds before padding', () => {
    const { timeoutMs, known } = computeWatchdog(73.13, PADDING_MS, UNKNOWN_MS);
    assert.equal(known, true);
    assert.equal(timeoutMs, Math.ceil(73.13 * 1000) + PADDING_MS);
});

test('a long (playlist-sized) total is never capped at the old 60s limit', () => {
    const { timeoutMs } = computeWatchdog(600, PADDING_MS, UNKNOWN_MS);
    assert.ok(timeoutMs > 60000, 'watchdog must exceed the old fixed 60s timeout');
    assert.equal(timeoutMs, 600000 + PADDING_MS);
});

test('a 1s clip still uses the known path, not the fallback', () => {
    const { timeoutMs, known } = computeWatchdog(1, PADDING_MS, UNKNOWN_MS);
    assert.equal(known, true);
    assert.equal(timeoutMs, 1000 + PADDING_MS);
});

// Anything that is not a finite, positive number must fall back to the generous
// cap — an underestimate would re-introduce the premature-timeout bug (#360).
for (const bad of [null, undefined, NaN, 0, -5, Infinity, '73', {}]) {
    test(`unknown/invalid duration (${String(bad)}) uses the generous fallback`, () => {
        const { timeoutMs, known } = computeWatchdog(bad, PADDING_MS, UNKNOWN_MS);
        assert.equal(known, false);
        assert.equal(timeoutMs, UNKNOWN_MS);
    });
}
