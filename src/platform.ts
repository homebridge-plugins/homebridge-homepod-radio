import { DynamicPlatformPlugin, PlatformAccessory, Logging, PlatformConfig, API, HAP, Characteristic, Service, Categories } from 'homebridge';

import { HomepodRadioPlatformAccessory } from './platformRadioAccessory.js';
import { AudioConfig, HomepodRadioPlatformConfig, RadioConfig } from './platformConfig.js';
import { HomepodRadioPlatformWebActions } from './platformWebActions.js';
import { PlaybackController } from './lib/playbackController.js';
import { HomepodRadioSwitchAccessory } from './platformRadioSwitchAccessory.js';
import { PLUGIN_NAME } from './platformConstants.js';
import { HomepodAudioSwitchAccessory } from './platformAudioSwitchAccessory.js';
import { HomepodVolumeAccessory } from './platformHomepodVolumeAccessory.js';

import { delay } from './lib/promises.js';
import { HttpService } from './lib/httpService.js';
import { WarmPlayer } from './lib/warmPlayer.js';

let hap: HAP;

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class HomepodRadioPlatform implements DynamicPlatformPlugin {
    private readonly playbackControllers = new Map<string, PlaybackController>();

    private readonly httpService: HttpService;
    private readonly platformActions?: HomepodRadioPlatformWebActions;
    private readonly warmPlayers = new Map<string, WarmPlayer>();

    public readonly Service: typeof Service;
    public readonly Characteristic: typeof Characteristic;

    public readonly platformConfig: HomepodRadioPlatformConfig;

    constructor(
        public logger: Logging,
        private config: PlatformConfig,
        private api: API,
    ) {
        hap = api.hap;

        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;

        this.platformConfig = new HomepodRadioPlatformConfig(this.config);
        if (this.platformConfig.homepodId) {
            this.platformActions = new HomepodRadioPlatformWebActions(
                this.platformConfig,
                this.getPlaybackController(this.platformConfig.homepodId),
                this.logger,
            );
        }
        this.httpService = new HttpService(this.platformConfig.httpPort, this.logger);

        const loadedRadios = this.platformConfig.getRadioNames();
        this.logger.info(`Loaded ${loadedRadios.length} radios: ${loadedRadios}`);

        this.api.on('didFinishLaunching', async () => {
            this.logger.info('Finished initializing platform');

            // Share one warm connection among audio buttons targeting the same HomePod.
            if (this.platformConfig.keepConnectionWarm) {
                const audioHomepodIds = new Set(this.platformConfig.audioFiles.flatMap((file) => file.homepodIds));
                for (const homepodId of audioHomepodIds) {
                    const player = new WarmPlayer(homepodId, this.logger, this.platformConfig.verboseMode);
                    this.warmPlayers.set(homepodId, player);
                    player.start();
                }
            }

            this.platformConfig.radios.forEach((radio) => {
                radio.homepodIds.forEach((id) => this.addRadioAccessory(radio, id));
            });
            this.platformConfig.audioFiles.forEach((file) => {
                file.homepodIds.forEach((id) => this.addFileSwitchAccessory(file, id));
            });
            const homepodIds = new Set([
                ...(this.platformConfig.homepodId ? [this.platformConfig.homepodId] : []),
                ...this.platformConfig.radios.flatMap((radio) => radio.homepodIds),
                ...this.platformConfig.audioFiles.flatMap((file) => file.homepodIds),
            ]);
            homepodIds.forEach((id) => this.addHomepodVolumeAccessory(id));
            await delay(1000, 0);
            await Promise.all([...this.playbackControllers.values()].map((controller) => controller.platformReady()));

            if (this.platformConfig.httpPort > 0) {
                this.httpService.start(async (action) => this.platformActions
                    ? await this.platformActions.handleAction(action)
                    : { error: true, message: 'HTTP playback requires homepodId.' });
            }
        });

        this.api.on('shutdown', () => {
            this.logger.info('Platform: shutdown...');
            this.playbackControllers.forEach((controller) => controller.shutdown());
            if (this.platformConfig.httpPort > 0) {
                this.httpService.stop();
            }
            this.warmPlayers.forEach((player) => player.stop());
        });
    }

    /**
     * This function is invoked when homebridge restores cached accessories from disk at startup.
     * It should be used to set up event handlers for characteristics and update respective values.
     */
    configureAccessory(accessory: PlatformAccessory) {
        this.logger.info(`Loading accessory from cache: ${accessory.displayName}`);

        // add the restored accessory to the accessories cache, so we can track if it has already been registered
        // this.accessories.push(accessory);
    }

    private getPlaybackController(homepodId: string): PlaybackController {
        let controller = this.playbackControllers.get(homepodId);
        if (!controller) {
            controller = new PlaybackController();
            this.playbackControllers.set(homepodId, controller);
        }
        return controller;
    }

    private accessoryKey(name: string, homepodId: string): string {
        // Keep existing default-HomePod UUIDs and radio state files intact.
        return homepodId === this.platformConfig.homepodId ? name : JSON.stringify([name, homepodId]);
    }

    private accessoryName(name: string, homepodId: string): string {
        return homepodId === this.platformConfig.homepodId ? name : `${name} (${homepodId})`;
    }

    private addHomepodVolumeAccessory(homepodId: string) {
        if(!this.platformConfig.enableVolumeControl) {
            this.logger.info('Platform: volume control disabled');
            return;
        }
        const volumeAccessoryName = homepodId;
        const volumeUuid = hap.uuid.generate('homebridge:homepod:volume:' + volumeAccessoryName);
        const volumeAccessory = new this.api.platformAccessory(`${volumeAccessoryName} Volume`, volumeUuid);
        const volumeAccessoryHandler = new HomepodVolumeAccessory(this, volumeAccessory, homepodId);
        this.getPlaybackController(homepodId).addStreamer(volumeAccessoryHandler);
        this.api.publishExternalAccessories(PLUGIN_NAME, [volumeAccessory]);
    }

    private addRadioAccessory(radio: RadioConfig, homepodId: string) {
        const uuid = hap.uuid.generate('homebridge:homepod:radio:' + this.accessoryKey(radio.name, homepodId));
        const accessory = new this.api.platformAccessory(this.accessoryName(radio.name, homepodId), uuid);

        // Adding Categories.SPEAKER as the category.
        // @see https://github.com/homebridge/homebridge/issues/2553#issuecomment-623675893
        accessory.category = Categories.SPEAKER;

        const radioAccessory = new HomepodRadioPlatformAccessory(this, accessory, radio, this.getPlaybackController(homepodId), homepodId);

        // SmartSpeaker service must be added as an external accessory.
        // @see https://github.com/homebridge/homebridge/issues/2553#issuecomment-622961035
        // There a no collision issues when calling this multiple times on accessories that already exist.
        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
        if (radio.onSwitch) {
            const switchUuid = hap.uuid.generate('homebridge:homepod:radio:switch:' + this.accessoryKey(radio.name, homepodId));
            const switchAccessory = new this.api.platformAccessory(`${this.accessoryName(radio.name, homepodId)} Switch`, switchUuid);
            new HomepodRadioSwitchAccessory(this, switchAccessory, radioAccessory);
            this.api.publishExternalAccessories(PLUGIN_NAME, [switchAccessory]);
        }
    }

    private addFileSwitchAccessory(fileSwitch: AudioConfig, homepodId: string) {
        const uuid = hap.uuid.generate('homebridge:homepod:fileSwitch:' + this.accessoryKey(fileSwitch.name, homepodId));
        const accessory = new this.api.platformAccessory(this.accessoryName(fileSwitch.name, homepodId), uuid);

        // Adding Categories.SPEAKER as the category.
        // @see https://github.com/homebridge/homebridge/issues/2553#issuecomment-623675893
        accessory.category = Categories.SPEAKER;

        new HomepodAudioSwitchAccessory(
            this, accessory, fileSwitch, this.getPlaybackController(homepodId), homepodId, this.warmPlayers.get(homepodId),
        );

        // SmartSpeaker service must be added as an external accessory.
        // @see https://github.com/homebridge/homebridge/issues/2553#issuecomment-622961035
        // There a no collision issues when calling this multiple times on accessories that already exist.
        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    }
}
