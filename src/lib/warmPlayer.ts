import { Logger } from 'homebridge';

import * as child from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

interface PendingRequest {
    resolve: (ok: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
    filePath: string;
}

/**
 * Supervises a single resident `warm-worker.py` process that holds one warm
 * pyatv connection to the HomePod and replays audio files on it. Shared by all
 * audio-button accessories for a given homepodId.
 *
 * The worker is spawned once and kept alive; if it crashes it is restarted with
 * exponential backoff. Each play is a newline-delimited JSON request/response on
 * the worker's stdin/stdout (logs come back on stderr). When the worker is not
 * ready, `playFile()` resolves `false` so the caller can fall back to the
 * original per-press spawn path — behavior degrades gracefully.
 */
export class WarmPlayer {
    private worker: child.ChildProcess | undefined;
    private rl: readline.Interface | undefined;
    private ready = false;
    private stopped = false;
    private restartDisabled = false;

    private restartDelay = 1000;
    private readonly MAX_RESTART_DELAY = 30000;
    private startAttempts = 0;
    private readonly MAX_START_ATTEMPTS = 3;
    // How long to wait for the worker to even acknowledge a play request (with a
    // duration estimate) before assuming it is wedged and falling back to spawn.
    private readonly INITIAL_ACK_TIMEOUT_MS = 60000;
    // Headroom added on top of the worker-reported track length before the
    // watchdog fires, to absorb network jitter and AirPlay buffering.
    private readonly PLAY_TIMEOUT_PADDING_MS = 30000;
    // Fallback watchdog used when the worker cannot determine the audio length
    // (e.g. mutagen is not installed for a non-wav file). Deliberately generous
    // so a legitimately long track is never cut off mid-playback.
    private readonly UNKNOWN_DURATION_TIMEOUT_MS = 30 * 60 * 1000;

    private nextId = 1;
    private readonly pending = new Map<string, PendingRequest>();

    private readonly scriptPath: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly debug: (message: string, ...parameters: any[]) => void;

    constructor(
        private readonly homepodId: string,
        private readonly logger: Logger,
        private readonly verboseMode: boolean,
    ) {
        this.debug = this.verboseMode ? this.logger.info.bind(this.logger) : this.logger.debug.bind(this.logger);
        // dist/lib/warmPlayer.js -> ../warm-worker.py == dist/warm-worker.py
        this.scriptPath = path.resolve(path.dirname(__filename), '..', 'warm-worker.py');
    }

    public start(): void {
        if (this.stopped || this.restartDisabled || this.worker) {
            return;
        }

        this.startAttempts += 1;

        const args = ['-u', this.scriptPath, '--id', this.homepodId];
        if (this.verboseMode) {
            args.push('--verbose');
        }
        this.logger.info(
            `Starting warm worker (attempt ${this.startAttempts}/${this.MAX_START_ATTEMPTS}): python3 ${args.join(' ')}`,
        );

        this.worker = child.spawn('python3', args, { env: { ...process.env } });

        this.rl = readline.createInterface({ input: this.worker.stdout! });
        this.rl.on('line', (line) => this.handleLine(line));

        this.worker.stderr!.on('data', (data) => {
            this.logWorkerStderr(data.toString());
        });

        this.worker.on('error', (err) => {
            this.logger.error(`Warm worker spawn error: ${err}`);
        });

        this.worker.on('exit', (code, signal) => {
            this.logger.warn(`Warm worker exited code=${code} signal=${signal}`);
            this.ready = false;
            this.rl?.close();
            this.rl = undefined;
            this.worker = undefined;
            this.failAllPending();
            this.scheduleRestart();
        });
    }

    private logWorkerStderr(output: string): void {
        const lines = output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

        // The worker logs to stderr as "<date> <time> <LEVEL> [warm-worker]: <message>".
        // Strip that prefix so Homebridge doesn't double-stamp it, and route by the
        // worker's own level instead of guessing from keywords.
        const prefix =
            /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+\[[^\]]*\]:\s*(.*)$/;

        for (const line of lines) {
            const match = prefix.exec(line);
            if (match) {
                const [, level, message] = match;
                if (level === 'ERROR' || level === 'CRITICAL') {
                    this.logger.error(`Warm worker: ${message}`);
                } else if (level === 'WARNING') {
                    this.logger.warn(`Warm worker: ${message}`);
                } else {
                    this.debug(`Warm worker: ${message}`);
                }
                continue;
            }

            // Lines without the worker's standard prefix (e.g. raw traceback
            // continuation lines): fall back to a keyword heuristic.
            if (/traceback|error|exception|module not found/i.test(line)) {
                this.logger.error(`Warm worker: ${line}`);
            } else {
                this.logger.warn(`Warm worker: ${line}`);
            }
        }
    }

    private handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let msg: any;
        try {
            msg = JSON.parse(trimmed);
        } catch {
            this.debug(`Warm worker non-JSON output: ${trimmed}`);
            return;
        }

        if (msg.event === 'ready') {
            this.ready = true;
            this.restartDelay = 1000; // healthy start resets backoff
            this.startAttempts = 0;
            this.logger.info('Warm worker ready (connection held warm)');
            return;
        }

        // The worker reports the track length once it actually starts streaming,
        // so re-arm the watchdog to match instead of leaving the fixed start guard.
        if (msg.event === 'duration' && msg.id !== undefined && msg.id !== null) {
            this.applyPlayTimeout(String(msg.id), msg.seconds);
            return;
        }

        if (msg.id !== undefined && msg.id !== null) {
            const key = String(msg.id);
            const pending = this.pending.get(key);
            if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(key);
                if (msg.ok === false && msg.error) {
                    // The warm worker started successfully, so a stream failure is a
                    // genuine error (not just a warning) even though we fall back.
                    this.logger.error(`Warm play failed: ${msg.error}`);
                }
                pending.resolve(msg.ok === true);
            }
        }
    }

    /**
     * Re-arm a pending play's watchdog once the worker reports how long the audio
     * actually is. A fixed timeout would cut off — and then double-play via the
     * spawn fallback — any track longer than the old 60s limit, so we size the
     * timeout to the real duration plus headroom. When the length is unknown we
     * fall back to a generous cap rather than a too-short fixed value.
     */
    private applyPlayTimeout(id: string, seconds: unknown): void {
        const pending = this.pending.get(id);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        const numeric = typeof seconds === 'number' ? seconds : NaN;
        const known = Number.isFinite(numeric) && numeric > 0;
        const timeoutMs = known
            ? Math.ceil(numeric * 1000) + this.PLAY_TIMEOUT_PADDING_MS
            : this.UNKNOWN_DURATION_TIMEOUT_MS;
        pending.timer = setTimeout(() => this.firePlayTimeout(id), timeoutMs);
        const watchdogS = Math.round(timeoutMs / 1000);
        if (known) {
            this.debug(`Warm play watchdog set to ${watchdogS}s for ${pending.filePath} (track ~${Math.round(numeric)}s)`);
        } else {
            this.debug(`Warm play length unknown for ${pending.filePath}; using ${watchdogS}s fallback (install mutagen for exact timing)`);
        }
    }

    private firePlayTimeout(id: string): void {
        const pending = this.pending.get(id);
        if (!pending) {
            return;
        }
        this.pending.delete(id);
        this.logger.error(`Warm play timed out for ${pending.filePath}`);
        pending.resolve(false);
    }

    private scheduleRestart(): void {
        if (this.stopped) {
            return;
        }
        const nextAttempt = this.startAttempts + 1;
        if (nextAttempt > this.MAX_START_ATTEMPTS) {
            this.restartDisabled = true;
            this.logger.error(
                `Warm worker failed to start after ${this.MAX_START_ATTEMPTS} attempts; disabling warm connection until Homebridge restarts`,
            );
            return;
        }
        const delay = this.restartDelay;
        this.restartDelay = Math.min(this.restartDelay * 2, this.MAX_RESTART_DELAY);
        this.logger.info(
            `Restarting warm worker in ${delay}ms (attempt ${nextAttempt}/${this.MAX_START_ATTEMPTS})`,
        );
        setTimeout(() => this.start(), delay);
    }

    private failAllPending(): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.resolve(false);
        }
        this.pending.clear();
    }

    public isReady(): boolean {
        return this.ready && !!this.worker;
    }

    /**
     * Ask the warm worker to play a file. Resolves `true` on success, or `false`
     * if the worker is unavailable or the play failed, so the caller can fall
     * back to spawning stream.py.
     */
    public playFile(filePath: string, volume: number, title: string): Promise<boolean> {
        if (!this.isReady()) {
            return Promise.resolve(false);
        }

        const id = String(this.nextId++);
        const payload = JSON.stringify({ id, cmd: 'play', file: filePath, volume, title }) + '\n';

        return new Promise<boolean>((resolve) => {
            // Initial guard: the worker must acknowledge with a duration estimate
            // within this window. Once it does, applyPlayTimeout() re-arms this
            // timer to the actual track length so long tracks are not cut off.
            const timer = setTimeout(() => this.firePlayTimeout(id), this.INITIAL_ACK_TIMEOUT_MS);

            this.pending.set(id, { resolve, timer, filePath });

            try {
                this.worker!.stdin!.write(payload);
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                this.logger.warn(`Failed to write to warm worker: ${err}`);
                resolve(false);
            }
        });
    }

    public stop(): void {
        this.stopped = true;
        this.ready = false;
        this.failAllPending();
        if (this.worker) {
            try {
                this.worker.stdin?.end();
            } catch {
                // ignore
            }
            try {
                this.worker.kill('SIGTERM');
            } catch {
                // ignore
            }
            this.worker = undefined;
        }
        this.rl?.close();
        this.rl = undefined;
    }
}
