/**
 * Pure helper for sizing the warm-play watchdog timeout.
 *
 * Kept dependency-free (no homebridge / child_process imports) so the timeout
 * logic that protects long tracks from a premature cut-off — the heart of the
 * issue #360 fix — can be unit-tested in isolation.
 */

export interface WatchdogDecision {
    /** Milliseconds to wait before the play is treated as timed out. */
    timeoutMs: number;
    /** True when the worker reported a usable (finite, positive) track length. */
    known: boolean;
}

/**
 * Size the warm-play watchdog for a track whose length the worker just reported.
 *
 * When the length is known the watchdog is that length plus headroom; otherwise
 * it falls back to a deliberately generous cap so a legitimately long track is
 * never cut off mid-playback (which previously also triggered a doubled play via
 * the spawn fallback).
 *
 * @param seconds   Track length reported by the worker. Accepts any type; only a
 *                  finite, positive number is treated as a known duration.
 * @param paddingMs Headroom added on top of a known length.
 * @param unknownMs Fallback timeout used when the length is unknown.
 */
export function computeWatchdog(seconds: unknown, paddingMs: number, unknownMs: number): WatchdogDecision {
    const numeric = typeof seconds === 'number' ? seconds : NaN;
    const known = Number.isFinite(numeric) && numeric > 0;
    const timeoutMs = known ? Math.ceil(numeric * 1000) + paddingMs : unknownMs;
    return { timeoutMs, known };
}
