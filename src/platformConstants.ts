export const PLATFORM_NAME = 'HomepodRadioPlatform';
export const PLUGIN_NAME = '@homebridge-plugins/homebridge-homepod-radio';

export const PLUGIN_MANUFACTURER = 'petro-kushchak';

export const PLUGIN_MODEL = 'Homepod Radio';

// Internal default for the warm-connection feature. The feature is on by
// default and only consumes resources when at least one audio button is
// configured (see platform.ts). It can still be opted out per-install by
// setting "keepConnectionWarm": false in config.json; flip this constant (or
// re-expose the option in config.schema.json) to change the default behavior.
export const DEFAULT_KEEP_CONNECTION_WARM = true;
