import { AccessoryPlugin, Service, CharacteristicEventTypes, PlatformAccessory } from 'homebridge';
import { CharacteristicGetCallback, CharacteristicValue, CharacteristicSetCallback } from 'homebridge';

import { HomepodRadioPlatform } from './platform.js';
import { AudioConfig } from './platformConfig.js';
import { PLUGIN_MANUFACTURER, PLUGIN_MODEL } from './platformConstants.js';

import { AirPlayDevice } from './lib/airplayDevice.js';
import { PlaybackController, PlaybackStreamer } from './lib/playbackController.js';
import { WarmPlayer } from './lib/warmPlayer.js';

import * as os from 'os';
import * as path from 'path';

export class HomepodAudioSwitchAccessory implements AccessoryPlugin, PlaybackStreamer {
    private readonly device: AirPlayDevice;
    private readonly service: Service;
    private readonly informationService: Service;

    constructor(
        private readonly platform: HomepodRadioPlatform,
        private readonly accessory: PlatformAccessory,
        private readonly audioConfig: AudioConfig,
        private readonly homepodId: string,
        private readonly serialNumber: string,
        private readonly playbackController: PlaybackController,
        private readonly warmPlayer?: WarmPlayer,
    ) {
        this.device = new AirPlayDevice(
            this.homepodId,
            platform.logger,
            platform.platformConfig.verboseMode,
            this.streamerName(),
            '',
            '',
            this.warmPlayer,
        );

        this.service =
            this.accessory.getService(this.platform.Service.Switch) ||
            this.accessory.addService(this.platform.Service.Switch);

        this.service
            .getCharacteristic(this.platform.Characteristic.On)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                this.platform.logger.debug(`[${this.streamerName()}] Getting State On: ${this.isPlaying()}`);
                callback(undefined, this.isPlaying());
            })
            .on(
                CharacteristicEventTypes.SET,
                (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    this.platform.logger.info(`[${this.streamerName()}] Setting State On: ${value}`);
                    if (value) {
                        this.startPlaying();
                    } else {
                        this.stopPlaying();
                    }
                    callback();
                },
            );

        this.informationService =
            this.accessory.getService(this.platform.Service.AccessoryInformation) ||
            this.accessory.addService(this.platform.Service.AccessoryInformation);

        this.informationService
            .setCharacteristic(this.platform.Characteristic.Manufacturer, PLUGIN_MANUFACTURER)
            .setCharacteristic(this.platform.Characteristic.Model, PLUGIN_MODEL)
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.serialNumber)
            .setCharacteristic(this.platform.Characteristic.Name, this.audioConfig.name);

        // This will do its best to keep the actual outputs status up to date with Homekit.
        setInterval(async () => {
            this.service.getCharacteristic(this.platform.Characteristic.On).updateValue(this.isPlaying());
        }, 3000);

        this.playbackController.addStreamer(this);

        this.platform.logger.info(`[${this.streamerName()}] Finished initializing`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async volumeUpdated(homepodId: string, volume: number): Promise<void> {
        return await Promise.resolve();
    }

    async stopRequested(source: PlaybackStreamer): Promise<void> {
        this.platform.logger.info(
            `[${this.streamerName()}] Stopping playback - received stop request from ${source.streamerName()} `,
        );
        await this.device.stop();
    }

    async shutdownRequested(): Promise<void> {
        return await Promise.resolve();
    }

    async platformLaunched(): Promise<void> {
        return await Promise.resolve();
    }

    streamerName(): string {
        return this.audioConfig.name;
    }

    isPlaying(): boolean {
        return this.device.isPlaying();
    }

    async startPlaying(): Promise<void> {
        await this.playbackController.requestStop(this);
        const mediaPath = this.platform.platformConfig.mediaPath || os.homedir();
        const filePath = path.join(mediaPath, this.audioConfig.fileName);
        await this.device.playFile(filePath, this.audioConfig.volume);
        await this.playbackController.updateVolume(this.homepodId, this.audioConfig.volume);
    }

    async stopPlaying(): Promise<void> {
        await this.device.stop();
    }

    /*
     * This method is called directly after creation of this instance.
     * It should return all services which should be added to the accessory.
     */
    getServices(): Service[] {
        return [this.informationService, this.service];
    }
}
