import { Logger } from 'homebridge';

import * as child from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

interface PendingRequest {
    resolve: (ok: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
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

    private restartDelay = 1000;
    private readonly MAX_RESTART_DELAY = 30000;
    private readonly PLAY_TIMEOUT_MS = 60000;

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
        if (this.stopped || this.worker) {
            return;
        }

        const args = ['-u', this.scriptPath, '--id', this.homepodId];
        if (this.verboseMode) {
            args.push('--verbose');
        }
        this.logger.info(`[warm] starting worker: python3 ${args.join(' ')}`);

        this.worker = child.spawn('python3', args, { env: { ...process.env } });

        this.rl = readline.createInterface({ input: this.worker.stdout! });
        this.rl.on('line', (line) => this.handleLine(line));

        this.worker.stderr!.on('data', (data) => {
            this.debug(`[warm worker] ${data.toString().trim()}`);
        });

        this.worker.on('error', (err) => {
            this.logger.error(`[warm] worker spawn error: ${err}`);
        });

        this.worker.on('exit', (code, signal) => {
            this.logger.warn(`[warm] worker exited code=${code} signal=${signal}`);
            this.ready = false;
            this.rl?.close();
            this.rl = undefined;
            this.worker = undefined;
            this.failAllPending();
            this.scheduleRestart();
        });
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
            this.debug(`[warm] non-JSON from worker: ${trimmed}`);
            return;
        }

        if (msg.event === 'ready') {
            this.ready = true;
            this.restartDelay = 1000; // healthy start resets backoff
            this.logger.info('[warm] worker ready (connection held warm)');
            return;
        }

        if (msg.id !== undefined && msg.id !== null) {
            const key = String(msg.id);
            const pending = this.pending.get(key);
            if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(key);
                if (msg.ok === false && msg.error) {
                    this.logger.warn(`[warm] play failed: ${msg.error}`);
                }
                pending.resolve(msg.ok === true);
            }
        }
    }

    private scheduleRestart(): void {
        if (this.stopped) {
            return;
        }
        const delay = this.restartDelay;
        this.restartDelay = Math.min(this.restartDelay * 2, this.MAX_RESTART_DELAY);
        this.logger.info(`[warm] restarting worker in ${delay}ms`);
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
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.logger.warn(`[warm] play timed out for ${filePath}`);
                resolve(false);
            }, this.PLAY_TIMEOUT_MS);

            this.pending.set(id, { resolve, timer });

            try {
                this.worker!.stdin!.write(payload);
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                this.logger.warn(`[warm] failed to write to worker: ${err}`);
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
