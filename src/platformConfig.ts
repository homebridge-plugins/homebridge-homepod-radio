import { PlatformConfig } from 'homebridge';

import { PLUGIN_MODEL, DEFAULT_KEEP_CONNECTION_WARM } from './platformConstants.js';

export interface HomepodConfig {
    id: string;
    name: string;
    serialNumber: string;
    volume: number;
    enableVolumeControl: boolean;
}

export interface RadioConfig {
    name: string;
    model: string;
    radioUrl: string;
    trackName: string;
    autoResume: boolean;
    metadataUrl: string;
    artworkUrl: string;
    onSwitch: boolean;
    volume: number;
}

export interface AudioConfig {
    name: string;
    fileName: string;
    volume: number;
}

export class HomepodRadioPlatformConfig {
    public readonly name: string;
    public readonly verboseMode: boolean;
    public readonly radios: RadioConfig[];
    public readonly audioFiles: AudioConfig[];
    public readonly mediaPath: string;
    public readonly httpPort: number;

    public readonly homepods: HomepodConfig[];

    // Backward compat: populated from first homepod
    public readonly homepodId: string;
    public readonly serialNumber: string;
    public readonly enableVolumeControl: boolean;
    public readonly volume: number;
    public readonly keepConnectionWarm: boolean;

    constructor(private config: PlatformConfig) {
        this.name = config.name || 'HomePod Mini Radio';

        this.radios = [];
        this.audioFiles = [];

        this.homepods = this.loadHomepodConfigs();
        if (this.homepods.length === 0) {
            throw 'Missing "homepods" or "homepodId" setting!';
        }

        // Backward compat: expose first homepod's values at top level
        this.homepodId = this.homepods[0].id;
        this.serialNumber = this.homepods[0].serialNumber;
        this.enableVolumeControl = this.homepods[0].enableVolumeControl;
        this.volume = this.homepods[0].volume;

        this.verboseMode = (config.verboseMode ??= false);

        this.httpPort = this.config.httpPort || 4567;
        this.mediaPath = this.config.mediaPath || '';

        // On by default; an explicit config value (true/false) still wins.
        this.keepConnectionWarm = this.config.keepConnectionWarm ?? DEFAULT_KEEP_CONNECTION_WARM;

        this.loadRadioConfigs();
        this.loadAudioConfigs();
    }

    private loadHomepodConfigs(): HomepodConfig[] {
        if (this.config.homepods && Array.isArray(this.config.homepods) && this.config.homepods.length > 0) {
            return this.config.homepods.map((hp) => ({
                id: hp.id,
                name: hp.name || '',
                serialNumber: hp.serialNumber || `HPD-${hp.id}`,
                volume: hp.volume || 25,
                enableVolumeControl: hp.enableVolumeControl ?? false,
            }));
        }

        if (this.config.homepodId) {
            return [{
                id: this.config.homepodId,
                name: '',
                serialNumber: this.config.serialNumber || `HPD-${this.config.homepodId}`,
                volume: this.config.volume || 25,
                enableVolumeControl: this.config.enableVolumeControl ?? false,
            }];
        }

        return [];
    }

    public get isMultiHomepod(): boolean {
        return this.homepods.length > 1;
    }

    private loadAudioConfigs() {
        if (this.config.audioFiles) {
            this.config.audioFiles.forEach((audioConfig) => {
                const audioFile = {
                    name: audioConfig.name,
                    fileName: audioConfig.fileName,
                    volume: audioConfig.volume || 0,
                } as AudioConfig;

                this.audioFiles.push(audioFile);
            });
        }
    }

    private loadRadioConfigs() {
        if (this.config.radios) {
            this.config.radios.forEach((radioConfig) => {
                const radio = {
                    name: radioConfig.name,
                    model: radioConfig.model || PLUGIN_MODEL,
                    radioUrl: radioConfig.radioUrl,
                    trackName: radioConfig.trackName || radioConfig.name,
                    autoResume: radioConfig.autoResume || false,
                    metadataUrl: radioConfig.metadataUrl || '',
                    artworkUrl: radioConfig.artworkUrl || '',
                    onSwitch: radioConfig.onSwitch || false,
                    volume: radioConfig.volume || 0,
                } as RadioConfig;

                this.radios.push(radio);
            });
        }
    }

    public getRadioNames(): string[] {
        return this.radios.map((r) => r.name);
    }
}
