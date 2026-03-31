import { DynamicPlatformPlugin, PlatformAccessory, Logging, PlatformConfig, API, HAP, Characteristic, Service, Categories } from 'homebridge';

import { HomepodRadioPlatformAccessory } from './platformRadioAccessory.js';
import { AudioConfig, HomepodConfig, HomepodRadioPlatformConfig, RadioConfig } from './platformConfig.js';
import { HomepodRadioPlatformWebActions } from './platformWebActions.js';
import { PlaybackController } from './lib/playbackController.js';
import { HomepodRadioSwitchAccessory } from './platformRadioSwitchAccessory.js';
import { PLUGIN_NAME } from './platformConstants.js';
import { HomepodAudioSwitchAccessory } from './platformAudioSwitchAccessory.js';
import { HomepodVolumeAccessory } from './platformHomepodVolumeAccessory.js';

import { delay } from './lib/promises.js';
import { HttpService } from './lib/httpService.js';

let hap: HAP;

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class HomepodRadioPlatform implements DynamicPlatformPlugin {
    private readonly playbackControllers: Map<string, PlaybackController> = new Map();
    private readonly platformActions: Map<string, HomepodRadioPlatformWebActions> = new Map();

    private readonly httpService!: HttpService;

    public readonly Service: typeof Service;
    public readonly Characteristic: typeof Characteristic;

    public readonly platformConfig!: HomepodRadioPlatformConfig;

    constructor(
        public logger: Logging,
        private config: PlatformConfig,
        private api: API,
    ) {
        hap = api.hap;

        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;

        try {
            this.platformConfig = new HomepodRadioPlatformConfig(this.config);
        } catch (error) {
            this.logger.error(`Configuration error: ${error}`);
            this.logger.error('Please check your Homebridge config.json. The plugin will not start.');
            return;
        }

        this.platformConfig.homepods.forEach((homepod) => {
            const controller = new PlaybackController();
            this.playbackControllers.set(homepod.id, controller);

            const webActions = new HomepodRadioPlatformWebActions(
                this.platformConfig,
                homepod.id,
                controller,
                this.logger,
            );
            this.platformActions.set(homepod.id, webActions);
        });

        this.httpService = new HttpService(this.platformConfig.httpPort, this.logger);

        const loadedRadios = this.platformConfig.getRadioNames();
        this.logger.info(`Loaded ${loadedRadios.length} radios: ${loadedRadios}`);
        this.logger.info(`Loaded ${this.platformConfig.homepods.length} homepod(s): ${this.platformConfig.homepods.map((h) => h.name || h.id)}`);

        this.api.on('didFinishLaunching', async () => {
            this.logger.info('Finished initializing platform');

            this.platformConfig.homepods.forEach((homepod) => {
                const controller = this.playbackControllers.get(homepod.id)!;
                this.platformConfig.radios.forEach((radio) => this.addRadioAccessory(radio, homepod, controller));
                this.platformConfig.audioFiles.forEach((fileSwitch) => this.addFileSwitchAccessory(fileSwitch, homepod, controller));
                this.addHomepodVolumeAccessory(homepod, controller);
            });

            await delay(1000, 0);
            this.playbackControllers.forEach((controller) => controller.platformReady());

            if (this.platformConfig.httpPort > 0) {
                this.httpService.start(async (action) => await this.routeHttpAction(action));
            }
        });

        this.api.on('shutdown', () => {
            this.logger.info('Platform: shutdown...');
            this.playbackControllers.forEach((controller) => controller.shutdown());
            if (this.platformConfig.httpPort > 0) {
                this.httpService.stop();
            }
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

    private displayName(baseName: string, homepod: HomepodConfig): string {
        return this.platformConfig.isMultiHomepod ? `${baseName} ${homepod.name}` : baseName;
    }

    private uuidSeed(base: string, homepod: HomepodConfig): string {
        return this.platformConfig.isMultiHomepod ? `${base}:${homepod.id}` : base;
    }

    private addHomepodVolumeAccessory(homepod: HomepodConfig, controller: PlaybackController) {
        if (!homepod.enableVolumeControl) {
            this.logger.info(`Platform: volume control disabled for ${homepod.name || homepod.id}`);
            return;
        }
        const volumeAccessoryName = this.displayName(homepod.id, homepod);
        const volumeUuid = hap.uuid.generate(this.uuidSeed('homebridge:homepod:volume:' + homepod.id, homepod));
        const volumeAccessory = new this.api.platformAccessory(`${volumeAccessoryName} Volume`, volumeUuid);
        new HomepodVolumeAccessory(this, volumeAccessory, homepod.id, homepod.serialNumber, homepod.volume, controller);
        this.api.publishExternalAccessories(PLUGIN_NAME, [volumeAccessory]);
    }

    private addRadioAccessory(radio: RadioConfig, homepod: HomepodConfig, controller: PlaybackController) {
        const uuid = hap.uuid.generate(this.uuidSeed('homebridge:homepod:radio:' + radio.name, homepod));
        const displayName = this.displayName(radio.name, homepod);
        const accessory = new this.api.platformAccessory(displayName, uuid);

        // Adding Categories.SPEAKER as the category.
        // @see https://github.com/homebridge/homebridge/issues/2553#issuecomment-623675893
        accessory.category = Categories.SPEAKER;

        const radioAccessory = new HomepodRadioPlatformAccessory(this, accessory, radio, homepod.id, homepod.serialNumber, controller);

        // SmartSpeaker service must be added as an external accessory.
        // @see https://github.com/homebridge/homebridge/issues/2553#issuecomment-622961035
        // There a no collision issues when calling this multiple times on accessories that already exist.
        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
        if (radio.onSwitch) {
            const switchUuid = hap.uuid.generate(this.uuidSeed('homebridge:homepod:radio:switch:' + radio.name, homepod));
            const switchName = this.displayName(`${radio.name} Switch`, homepod);
            const switchAccessory = new this.api.platformAccessory(switchName, switchUuid);
            new HomepodRadioSwitchAccessory(this, switchAccessory, radioAccessory, homepod.serialNumber);
            this.api.publishExternalAccessories(PLUGIN_NAME, [switchAccessory]);
        }
    }

    private addFileSwitchAccessory(fileSwitch: AudioConfig, homepod: HomepodConfig, controller: PlaybackController) {
        const uuid = hap.uuid.generate(this.uuidSeed('homebridge:homepod:fileSwitch:' + fileSwitch.name, homepod));
        const displayName = this.displayName(fileSwitch.name, homepod);
        const accessory = new this.api.platformAccessory(displayName, uuid);

        // Adding Categories.SPEAKER as the category.
        // @see https://github.com/homebridge/homebridge/issues/2553#issuecomment-623675893
        accessory.category = Categories.SPEAKER;

        new HomepodAudioSwitchAccessory(this, accessory, fileSwitch, homepod.id, homepod.serialNumber, controller);

        // SmartSpeaker service must be added as an external accessory.
        // @see https://github.com/homebridge/homebridge/issues/2553#issuecomment-622961035
        // There a no collision issues when calling this multiple times on accessories that already exist.
        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    }

    private async routeHttpAction(actionUrl: string) {
        const parts = actionUrl.split('/');

        // URL formats:
        // /play/<filename>              → first homepod (backward compat)
        // /play/<filename>/<volume>     → first homepod with volume
        // /play/<homepodName>/<filename>         → specific homepod
        // /play/<homepodName>/<filename>/<volume> → specific homepod with volume
        if (parts.length >= 3 && parts[1] === 'play') {
            const segment = decodeURIComponent(parts[2]);
            const matchedHomepod = this.platformConfig.homepods.find((h) => h.name === segment);

            if (matchedHomepod && parts.length >= 4) {
                // Rewrite URL to remove homepod name segment: /play/<filename>[/<volume>]
                const rewrittenUrl = '/play/' + parts.slice(3).join('/');
                const actions = this.platformActions.get(matchedHomepod.id);
                if (actions) {
                    return await actions.handleAction(rewrittenUrl);
                }
            }
        }

        // Default: route to first homepod
        const firstHomepod = this.platformConfig.homepods[0];
        const actions = this.platformActions.get(firstHomepod.id)!;
        return await actions.handleAction(actionUrl);
    }
}
