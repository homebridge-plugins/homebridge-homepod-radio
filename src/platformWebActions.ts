import { Logger } from 'homebridge';

import { HomepodRadioPlatformConfig } from './platformConfig.js';

import { AirPlayDevice } from './lib/airplayDevice.js';
import { AutomationReturn } from './lib/httpService.js';
import { PlaybackController, PlaybackStreamer } from './lib/playbackController.js';

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const fileExists = async (path) => !!(await fs.promises.stat(path).catch((e) => false));

export enum WebActionType {
    PlayFile,
    Unsupported,
}

export interface WebAction {
    action: WebActionType;
    data: string;
    extra?: number;
}

export class HomepodRadioPlatformWebActions implements PlaybackStreamer {
    private readonly device: AirPlayDevice;

    constructor(
        private readonly config: HomepodRadioPlatformConfig,
        private readonly homepodId: string,
        private readonly playbackController: PlaybackController,
        private readonly logger: Logger,
    ) {
        this.playbackController.addStreamer(this);
        this.device = new AirPlayDevice(
            this.homepodId,
            this.logger,
            this.config.verboseMode,
            this.streamerName(),
        );
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async volumeUpdated(homepodId: string, volume: number): Promise<void> {
        return await Promise.resolve();
    }

    isPlaying(): boolean {
        return false;
    }

    async startPlaying(): Promise<void> {
        return Promise.resolve();
    }

    async stopPlaying(): Promise<void> {
        return Promise.resolve();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async stopRequested(source: PlaybackStreamer): Promise<void> {
        return Promise.resolve();
    }

    async shutdownRequested(): Promise<void> {
        return Promise.resolve();
    }

    async platformLaunched(): Promise<void> {
        return Promise.resolve();
    }

    streamerName(): string {
        return 'PlatformWebActions';
    }

    public parseAction(actionUri: string): WebAction {
        const parts: string[] = actionUri.split('/');

        if (parts.length < 2) {
            return {
                action: WebActionType.Unsupported,
                data: 'Unsupported request',
            };
        }
        if (parts[1] === 'play') {
            // play mp3/wav from mediaPath by name
            // uri example: /play/<mp3/wav-file>
            // uri example: /play/<mp3/wav-file>/25
            const fileName = parts[2];

            const mediaPath = this.config.mediaPath || os.homedir();
            const filePath = path.join(mediaPath, fileName);

            let volume: number = 0;
            if (parts.length > 3) {
                if (isNaN(Number(parts[3]))) {
                    return {
                        action: WebActionType.Unsupported,
                        data: 'Unsupported request',
                    };
                } else {
                    volume = Number(parts[3]);
                    volume = Math.max(volume, 0);
                    volume = Math.min(volume, 100);
                }
            }

            return {
                action: WebActionType.PlayFile,
                data: filePath,
                extra: volume,
            };
        }
        return {
            action: WebActionType.Unsupported,
            data: 'Unsupported request',
        };
    }

    public async handleAction(actionUrl: string): Promise<AutomationReturn> {
        this.logger.info('Received request: %s', actionUrl);
        const webAction: WebAction = this.parseAction(actionUrl);

        switch (webAction.action) {
        case WebActionType.PlayFile: {
            const filePath: string = webAction.data;
            const fileFound = await fileExists(filePath);

            if (!fileFound) {
                return {
                    error: false,
                    message: `File does not exist: ${filePath}`,
                };
            }

            const volume: number = (webAction.extra) ? webAction.extra : 0;

            const message = `Started playing file: ${filePath}`;
            this.logger.info(message);
            await this.playbackController.requestStop(this);
            await this.device.playFile(filePath, volume);
            return {
                error: false,
                message: message,
            };
        }
        // falls through
        case WebActionType.Unsupported:
        default:
            return {
                error: true,
                message: webAction.data,
            };
        }
    }
}
