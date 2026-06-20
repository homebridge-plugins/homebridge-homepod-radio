import { PlatformConfig } from 'homebridge';

import { PLUGIN_MODEL, DEFAULT_KEEP_CONNECTION_WARM } from './platformConstants.js';

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
    public readonly homepodId: string;
    public readonly serialNumber: string;
    public readonly verboseMode: boolean;
    public readonly radios: RadioConfig[];
    public readonly audioFiles: AudioConfig[];
    public readonly mediaPath: string;
    public readonly httpPort: number;

    public readonly enableVolumeControl: boolean;
    public readonly volume: number;
    public readonly keepConnectionWarm: boolean;

    constructor(private config: PlatformConfig) {
        this.name = config.name || 'HomePod Mini Radio';

        this.radios = [];
        this.audioFiles = [];
        if (!config.homepodId) {
            throw 'Missing "homepodId" setting!';
        }
        this.homepodId = config.homepodId;
        this.serialNumber = config.serialNumber || `HPD-${this.homepodId}`;
        this.enableVolumeControl = (config.enableVolumeControl ??= false);
        this.verboseMode = (config.verboseMode ??= false);

        this.httpPort = this.config.httpPort || 4567;
        this.mediaPath = this.config.mediaPath || '';

        this.enableVolumeControl = (this.config.enableVolumeControl ??= false);
        this.volume = this.config.volume || 25;
        // On by default; an explicit config value (true/false) still wins.
        this.keepConnectionWarm = this.config.keepConnectionWarm ?? DEFAULT_KEEP_CONNECTION_WARM;

        this.loadRadioConfigs();
        this.loadAudioConfigs();
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
                    serialNumber: this.serialNumber,
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
