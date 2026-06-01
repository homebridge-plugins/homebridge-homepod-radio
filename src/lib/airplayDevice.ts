import { Logger } from 'homebridge';

import { delay } from './promises.js';
import { WarmPlayer } from './warmPlayer.js';

import * as child from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(child.exec);

const __filename = fileURLToPath(import.meta.url);

/**
 * AirPlay device
 */

export class AirPlayDevice {
    private readonly STREAMING_RESTART_TIMEOUT = 500;
    private readonly HEARTBEAT_TIMEOUT = 5000;
    private readonly LAST_SEEN_THRESHOLD_MS = 10000;

    private readonly DEFAULT_ARTWORK_URL =
        'https://www.apple.com/v/apple-music/q/images/shared/og__ckjrh2mu8b2a_image.png';

    private streaming: child.ChildProcess | undefined;
    private warmPlaying = false;
    private lastSeen!: number;
    private heartbeat: ReturnType<typeof setInterval> | undefined;
    private streamingRetries = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly debug: (message: string, ...parameters: any[]) => void;
    private readonly pluginPath: string;

    constructor(
        private readonly homepodId: string,
        private readonly logger: Logger,
        private readonly verboseMode: boolean,
        private readonly streamerName: string,
        private readonly streamMetadataUrl?: string,
        private readonly streamArtworkUrl?: string,
        private readonly warmPlayer?: WarmPlayer,
    ) {
        this.debug = this.verboseMode ? this.logger.info.bind(this.logger) : this.logger.debug.bind(this.logger);
        this.pluginPath = path.resolve(path.dirname(__filename), '..', '..');
    }

    private async killProcess(procId: number): Promise<void> {
        const cmd = `kill -9 ${procId}`;
        const result = await execAsync(cmd);
        this.debug(`[${this.streamerName}] Executing "${result}" result: ${JSON.stringify(result)}`);
    }

    public async getPlaybackTitle(): Promise<string> {
        const currentTitleCmd = `atvremote --id ${this.homepodId} title`;
        const result = await execAsync(currentTitleCmd);
        return result.stdout.replace(/\r?\n|\r/g, ' ');
    }

    public async setVolume(volume: number): Promise<void> {
        const scriptPath = path.resolve(path.dirname(__filename), '..', 'stream.py');
        const setVolumeCmd = `python3 ${scriptPath} --id ${this.homepodId} --volume ${volume}`;
        await execAsync(setVolumeCmd);
    }

    public async playFile(filePath: string, volume: number): Promise<boolean> {
        // Prefer the shared warm worker (held pyatv connection) when available,
        // falling back to the per-press spawn path below if it is down or fails.
        if (this.warmPlayer && this.warmPlayer.isReady()) {
            this.warmPlaying = true;
            this.logger.info(`[${this.streamerName}] Started file streaming ${filePath} (warm)`);
            try {
                const ok = await this.warmPlayer.playFile(filePath, volume, this.streamerName);
                this.warmPlaying = false;
                if (ok) {
                    this.debug(`[${this.streamerName}] Finished file streaming ${filePath} (warm)`);
                    return true;
                }
                this.logger.warn(`[${this.streamerName}] Warm play failed, falling back to spawn`);
            } catch (err) {
                this.warmPlaying = false;
                this.logger.warn(`[${this.streamerName}] Warm play error, falling back to spawn: ${err}`);
            }
        }

        // create pipe for the command:
        const scriptPath = path.resolve(path.dirname(__filename), '..', 'stream.py');

        const streamParams: string[] = [
            scriptPath,
            '--id',
            this.homepodId,
            '--title',
            this.streamerName,
            '--album',
            this.streamerName,
            '--file',
            filePath,
            '--verbose',
            '--volume',
            '' + volume,
        ];

        this.logger.debug(`[${this.streamerName}] Child: python3 ${streamParams.join(' ')}`);

        this.streaming = child.spawn(
            'python3',
            streamParams,
            { cwd: this.pluginPath, env: { ...process.env } },
        );

        this.streaming.stdout!.on('data', (data) => {
            this.debug(`[${this.streamerName}] Streaming data: ${data}`);
        });

        this.streaming.on('exit', async (code, signal) => {
            this.debug(`[${this.streamerName}] Streaming exit: code ${code} signal ${signal}`);
            const streamExited = true;
            await this.endStreaming(streamExited);
        });

        this.streaming.stderr!.on('data', (data) => {
            this.debug(`[${this.streamerName}] Streaming data: ${data}`);
        });

        this.debug(`[${this.streamerName}] Started hearbeat ${this.heartbeat}`);

        this.debug(`[${this.streamerName}] Spawn streaming: ${this.streaming.pid}`);
        this.logger.info(`[${this.streamerName}] Started file streaming ${filePath}`);
        return true;
    }

    public async playStream(streamUrl: string, streamName: string, volume: number): Promise<boolean> {
        this.streamingRetries = 0;
        const heartbeat = this.handleHearbeat.bind(this);
        const heartbeatFailed = async (): Promise<void> => {
            //identify reason and restart streaming...
            const title = await this.getPlaybackTitle();
            this.debug(`[${this.streamerName}] Received from device: ${this.homepodId}; Title: ${title}`);
            const restartStreaming = false;
            if (restartStreaming) {
                //need to restart streaming, after some delay
                await delay(this.STREAMING_RESTART_TIMEOUT * this.streamingRetries, 0);
                await this.startStreaming(streamUrl, streamName, volume, heartbeat, heartbeatFailed);
            } else {
                //device is used to play something else, need to change state to "STOPPED"
                await this.endStreaming();
                this.logger.info(`[${this.streamerName}] Streaming finished - restart canceled`);
            }
        };

        if (this.isPlaying()) {
            await this.endStreaming();
            this.logger.info(`[${this.streamerName}] Previous streaming finished`);
            return await this.startStreaming(streamUrl, streamName, volume, heartbeat, heartbeatFailed);
        } else {
            return await this.startStreaming(streamUrl, streamName, volume, heartbeat, heartbeatFailed);
        }
    }

    /**
     * Streaming crash monitoring/prevention
     */
    private async handleHearbeat(heatbeatType: string, heartbeatFailed: () => Promise<void>): Promise<void> {
        this.debug(`[${this.streamerName}] Playback heartbeat, source: ${heatbeatType}`);
        if (!this.isPlaying()) {
            this.logger.info(
                `[${this.streamerName}] Playback heartbeat ignored (${heatbeatType}) - streaming stopped`,
            );
            this.logger.info(`[${this.streamerName}] Cleared hearbeat ${this.heartbeat} - streaming stopped`);
            clearInterval(this.heartbeat);
            this.heartbeat = undefined;
            return;
        }
        if (heatbeatType !== 'heartbeat') {
            this.lastSeen = Date.now();
            this.streamingRetries = 0;
        } else {
            const diffMs = Date.now() - this.lastSeen;
            this.debug(`[${this.streamerName}] Playback heartbeat, diff: ${diffMs}ms`);
            if (diffMs > this.LAST_SEEN_THRESHOLD_MS) {
                this.debug(`[${this.streamerName}] Playback heartbeat failed`);
                await heartbeatFailed();
            }
        }
    }

    private async startStreaming(
        streamUrl: string,
        streamName: string,
        volume: number,
        heartbeat: (source: string, heartbeatFailed: () => Promise<void>) => Promise<void>,
        heartbeatFailed: () => Promise<void>,
    ): Promise<boolean> {
        // create pipe for the command:
        const scriptPath = path.resolve(path.dirname(__filename), '..', 'stream.py');

        const streamParams: string[] = [
            scriptPath,
            '--id',
            this.homepodId,
            '--title',
            streamName,
            '--album',
            this.streamerName,
            '--stream_url',
            streamUrl,
            '--stream_timeout',
            '30',
            '--stream_metadata',
            this.streamMetadataUrl ? this.streamMetadataUrl : '-1',
            '--stream_artwork',
            this.streamArtworkUrl ? this.streamArtworkUrl : this.DEFAULT_ARTWORK_URL,
            '--volume',
            '' + volume,
            '--verbose',
        ];

        this.logger.debug(`[${this.streamerName}] Child: python3 ${streamParams.join(' ')}`);

        this.streaming = child.spawn(
            'python3',
            streamParams,
            { cwd: this.pluginPath, env: { ...process.env } },
        );

        this.streaming.stdout!.on('data', (data) => {
            this.debug(`[${this.streamerName}] Streaming data: ${data}`);
            heartbeat('streaming', heartbeatFailed);
        });

        this.streaming.on('exit', async (code, signal) => {
            this.debug(`[${this.streamerName}] Streaming exit: code ${code} signal ${signal}`);
            const streamExited = true;
            await this.endStreaming(streamExited);
        });

        this.streaming.stderr!.on('data', (data) => {
            this.debug(`[${this.streamerName}] Streaming data: ${data}`);
            heartbeat('streaming', heartbeatFailed);
        });

        if (this.heartbeat !== undefined) {
            this.debug(`[${this.streamerName}] Cleared hearbeat ${this.heartbeat} - previous timer`);
            clearInterval(this.heartbeat);
            this.heartbeat = undefined;
        }

        this.heartbeat = setInterval(() => {
            heartbeat('heartbeat', heartbeatFailed);
        }, this.HEARTBEAT_TIMEOUT);

        this.debug(`[${this.streamerName}] Started hearbeat ${this.heartbeat}`);

        this.debug(`[${this.streamerName}] Spawn streaming: ${this.streaming.pid}`);
        this.logger.info(`[${this.streamerName}] Started streaming ${streamUrl}`);
        return true;
    }

    private async endStreaming(streamExited: boolean = false): Promise<boolean> {
        try {
            this.warmPlaying = false;
            if (this.streaming === undefined) {
                this.debug(`[${this.streamerName}] End streaming: streaming: ${this.streaming}`);
                return Promise.resolve(true);
            }
            this.debug(`[${this.streamerName}] Killing process: streaming: ${this.streaming.pid}`);

            this.debug(`[${this.streamerName}] Cleared hearbeat ${this.heartbeat} - stop requested`);
            clearInterval(this.heartbeat);
            this.heartbeat = undefined;

            if (!streamExited) {
                await this.killProcess(this.streaming.pid!);
            }
            this.streaming = undefined;
        } catch (err) {
            this.logger.error(`[${this.streamerName}] Error while trying to stop: ${err}`);
            this.streaming = undefined;
        }
        return Promise.resolve(true);
    }

    public async stop(): Promise<boolean> {
        if (!this.isPlaying()) {
            this.debug(`[${this.streamerName}] Trying to stop stopped process!`);
            return true;
        }

        await this.endStreaming();
        this.logger.info(`[${this.streamerName}] Streaming finished - stop requested`);
        return true;
    }

    public isPlaying(): boolean {
        return !!this.streaming || this.warmPlaying;
    }
}
