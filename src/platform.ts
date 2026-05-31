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
    private readonly playbackController: PlaybackController = new PlaybackController();

    private readonly httpService: HttpService;
    private readonly platformActions: HomepodRadioPlatformWebActions;
    private warmPlayer: WarmPlayer | undefined;

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
        this.platformActions = new HomepodRadioPlatformWebActions(
            this.platformConfig,
            this.playbackController,
            this.logger,
        );
        this.httpService = new HttpService(this.platformConfig.httpPort, this.logger);

        const loadedRadios = this.platformConfig.getRadioNames();
        this.logger.info(`Loaded ${loadedRadios.length} radios: ${loadedRadios}`);

        this.api.on('didFinishLaunching', async () => {
            this.logger.info('Finished initializing platform');

            // Start one shared warm worker (held pyatv connection) before adding
            // audio buttons, so the first press can already use it.
            if (this.platformConfig.keepConnectionWarm && this.platformConfig.audioFiles.length > 0) {
                this.logger.info('Platform: keepConnectionWarm enabled - starting warm worker');
                this.warmPlayer = new WarmPlayer(
                    this.platformConfig.homepodId,
                    this.logger,
                    this.platformConfig.verboseMode,
                );
                this.warmPlayer.start();
            }

            this.platformConfig.radios.forEach((radio) => this.addRadioAccessory(radio));
            this.platformConfig.audioFiles.forEach((fileSwitch) => this.addFileSwitchAccessory(fileSwitch));
            await delay(1000, 0);
            this.playbackController.platformReady();

            if (this.platformConfig.httpPort > 0) {
                this.httpService.start(async (action) => await this.platformActions.handleAction(action));
            }

            this.addHomepodVolumeAccessory();
        });

        this.api.on('shutdown', () => {
            this.logger.info('Platform: shutdown...');
            this.playbackController.shutdown();
            if (this.platformConfig.httpPort > 0) {
                this.httpService.stop();
            }
            this.warmPlayer?.stop();
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

    private addHomepodVolumeAccessory() {
        if(!this.platformConfig.enableVolumeControl) {
            this.logger.info('Platform: volume control disabled');
            return;
        }
        const volumeAccessoryName = this.platformConfig.homepodId;
        const volumeUuid = hap.uuid.generate('homebridge:homepod:volume:' + volumeAccessoryName);
        const volumeAccessory = new this.api.platformAccessory(`${volumeAccessoryName} Volume`, volumeUuid);
        new HomepodVolumeAccessory(this, volumeAccessory);
        this.api.publishExternalAccessories(PLUGIN_NAME, [volumeAccessory]);
    }

    private addRadioAccessory(radio: RadioConfig) {
        const uuid = hap.uuid.generate('homebridge:homepod:radio:' + radio.name);
        const accessory = new this.api.platformAccessory(radio.name, uuid);

        // Adding Categories.SPEAKER as the category.
        // @see https://github.com/homebridge/homebridge/issues/2553#issuecomment-623675893
        accessory.category = Categories.SPEAKER;

        const radioAccessory = new HomepodRadioPlatformAccessory(this, accessory, radio, this.playbackController);

        // SmartSpeaker service must be added as an external accessory.
        // @see https://github.com/homebridge/homebridge/issues/2553#issuecomment-622961035
        // There a no collision issues when calling this multiple times on accessories that already exist.
        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
        if (radio.onSwitch) {
            const switchUuid = hap.uuid.generate('homebridge:homepod:radio:switch:' + radio.name);
            const switchAccessory = new this.api.platformAccessory(`${radio.name} Switch`, switchUuid);
            new HomepodRadioSwitchAccessory(this, switchAccessory, radioAccessory);
            this.api.publishExternalAccessories(PLUGIN_NAME, [switchAccessory]);
        }
    }

    private addFileSwitchAccessory(fileSwitch: AudioConfig) {
        const uuid = hap.uuid.generate('homebridge:homepod:fileSwitch:' + fileSwitch.name);
        const accessory = new this.api.platformAccessory(fileSwitch.name, uuid);

        // Adding Categories.SPEAKER as the category.
        // @see https://github.com/homebridge/homebridge/issues/2553#issuecomment-623675893
        accessory.category = Categories.SPEAKER;

        new HomepodAudioSwitchAccessory(this, accessory, fileSwitch, this.playbackController, this.warmPlayer);

        // SmartSpeaker service must be added as an external accessory.
        // @see https://github.com/homebridge/homebridge/issues/2553#issuecomment-622961035
        // There a no collision issues when calling this multiple times on accessories that already exist.
        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    }
}
