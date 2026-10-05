import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaybackController } from '../dist/lib/playbackController.js';
import { createHash } from 'node:crypto';
import { HomepodRadioPlatformConfig } from '../dist/platformConfig.js';
import { HomepodRadioPlatform } from '../dist/platform.js';
import { HomepodVolumeAccessory } from '../dist/platformHomepodVolumeAccessory.js';
import { AirPlayDevice } from '../dist/lib/airplayDevice.js';
import { WarmPlayer } from '../dist/lib/warmPlayer.js';
import { HttpService } from '../dist/lib/httpService.js';

const config = (extra) => ({ platform: 'HomepodRadioPlatform', ...extra });
const radio = { name: 'News', radioUrl: 'https://example.com/live', onSwitch: true };
const audio = { name: 'Podcast', fileName: 'podcast.mp3' };

test('homepodId fallback, explicit targets, and validation', () => {
    const fallback = new HomepodRadioPlatformConfig(config({ homepodId: 'A', radios: [radio], audioFiles: [audio] }));
    assert.deepEqual(fallback.radios[0].homepodIds, ['A']);
    assert.deepEqual(fallback.audioFiles[0].homepodIds, ['A']);
    assert.equal(fallback.serialNumber, 'HPD-A');
    const parsed = new HomepodRadioPlatformConfig(config({
        homepodId: 'A', radios: [radio],
        audioFiles: [{ ...audio, homepodIds: ['B', 'C', 'B'] }],
    }));
    assert.deepEqual(parsed.radios[0].homepodIds, ['A']);
    assert.deepEqual(parsed.audioFiles[0].homepodIds, ['B', 'C']);
    for (const homepodIds of [[], null, 'A', [' '], [12]]) {
        assert.throws(() => new HomepodRadioPlatformConfig(config({
            homepodId: 'A', audioFiles: [{ ...audio, homepodIds }],
        })), /requires non-empty homepodIds/);
    }
    assert.throws(() => new HomepodRadioPlatformConfig(config({ radios: [radio] })), /homepodId/);
    assert.deepEqual(new HomepodRadioPlatformConfig(config({
        radios: [{ ...radio, homepodIds: ['B'] }],
    })).radios[0].homepodIds, ['B']);
});

// Minimal Homebridge surface; no network, physical device, or persistent storage.
class Service {
    setCharacteristic() { return this; }
    getCharacteristic() { return this; }
    on() { return this; }
    updateValue() { return this; }
}
class Accessory {
    constructor(displayName, UUID) { this.displayName = displayName; this.UUID = UUID; }
    getService() { return new Service(); }
    addService() { return new Service(); }
}
const uuid = (key) => createHash('sha1').update(key).digest('hex');
const logger = Object.fromEntries(['info', 'debug', 'warn', 'error'].map((key) => [key, () => {}]));

async function launch(t, settings) {
    t.mock.method(globalThis, 'setInterval', () => 0);
    t.mock.method(WarmPlayer.prototype, 'start', () => {});
    t.mock.method(WarmPlayer.prototype, 'stop', () => {});
    t.mock.method(HttpService.prototype, 'start', function (handler) { this.handler = handler; });
    t.mock.method(HttpService.prototype, 'stop', () => {});
    const events = {};
    const published = [];
    const api = {
        hap: {
            uuid: { generate: uuid },
            Service: {},
            Characteristic: { CurrentMediaState: { PLAY: 0, STOP: 2 } },
        },
        platformAccessory: Accessory,
        on: (event, handler) => { events[event] = handler; },
        publishExternalAccessories: (_, accessories) => published.push(...accessories),
    };
    const platform = new HomepodRadioPlatform(logger, config(settings), api);
    await events.didFinishLaunching();
    return { platform, published, shutdown: events.shutdown };
}

test('only selected pairings are published; playback and warm workers are isolated by target', async (t) => {
    const plays = [];
    const stops = [];
    const volumes = [];
    t.mock.method(AirPlayDevice.prototype, 'playFile', async function () { plays.push(this.homepodId); return true; });
    t.mock.method(AirPlayDevice.prototype, 'playStream', async function () { plays.push(this.homepodId); });
    t.mock.method(AirPlayDevice.prototype, 'stop', async function () { stops.push(this.homepodId); });
    t.mock.method(AirPlayDevice.prototype, 'setVolume', async function () { volumes.push(this.homepodId); });
    const { platform, published, shutdown } = await launch(t, {
        homepodId: 'A', enableVolumeControl: true,
        radios: [radio, { ...radio, name: 'Music', homepodIds: ['B', 'C'] }],
        audioFiles: [{ ...audio, homepodIds: ['A', 'B', 'B'] }, { ...audio, name: 'Alert', homepodIds: ['B'] }],
    });
    assert.deepEqual(published.map((a) => a.displayName), [
        'News', 'News Switch', 'Music (B)', 'Music (B) Switch', 'Music (C)', 'Music (C) Switch',
        'Podcast', 'Podcast (B)', 'Alert (B)', 'A Volume', 'B Volume', 'C Volume',
    ]);
    assert.equal(new Set(published.map((a) => a.UUID)).size, published.length);
    assert.equal(published[0].UUID, uuid('homebridge:homepod:radio:News'));
    assert.equal(published[1].UUID, uuid('homebridge:homepod:radio:switch:News'));
    assert.equal(published[6].UUID, uuid('homebridge:homepod:fileSwitch:Podcast'));
    assert.deepEqual([...platform.warmPlayers.keys()], ['A', 'B']);
    const a = platform.playbackControllers.get('A');
    const b = platform.playbackControllers.get('B');
    const bAudio = b.streamers.filter((s) => s.audioConfig);
    assert.ok(bAudio.every((s) => s.device.warmPlayer === platform.warmPlayers.get('B')));
    await bAudio[0].startPlaying();
    assert.deepEqual(plays, ['B']);
    assert.ok(stops.length > 0 && stops.every((id) => id === 'B'));
    stops.length = 0;
    await a.streamers.find((s) => s.radio).startPlaying();
    assert.deepEqual(plays, ['B', 'A']);
    assert.deepEqual(stops, ['A']);
    const volume = new HomepodVolumeAccessory(platform, new Accessory('B Volume', 'volume'), 'B');
    await volume.setCurrentVolume(40);
    await volume.volumeUpdated('A', 60);
    assert.deepEqual(volumes, ['B']);
    assert.equal(await volume.getCurrentVolume(), 40);
    assert.equal(platform.platformActions.device.homepodId, 'A');
    assert.ok(a.streamers.includes(platform.platformActions));
    assert.ok(!b.streamers.includes(platform.platformActions));
    shutdown();
    assert.equal(WarmPlayer.prototype.stop.mock.callCount(), 2);
});

test('explicit targets work without a default; HTTP gives a clear error; warm opt-out works', async (t) => {
    const { platform, published, shutdown } = await launch(t, {
        keepConnectionWarm: false,
        radios: [{ ...radio, homepodIds: ['B'] }],
        audioFiles: [{ ...audio, homepodIds: ['C'] }],
    });
    assert.equal(published.length, 3);
    assert.equal(platform.warmPlayers.size, 0);
    assert.deepEqual(await platform.httpService.handler('/play/podcast.mp3'), {
        error: true, message: 'HTTP playback requires homepodId.',
    });
    shutdown();
});

test('implicit and explicit default targets preserve accessory identities', async (t) => {
    const settings = { homepodId: 'A', keepConnectionWarm: false };
    const implicit = await launch(t, { ...settings, radios: [radio], audioFiles: [audio] });
    const explicit = await launch(t, {
        ...settings,
        radios: [{ ...radio, homepodIds: ['A'] }],
        audioFiles: [{ ...audio, homepodIds: ['A'] }],
    });
    assert.deepEqual(implicit.published, explicit.published);
    implicit.shutdown();
    explicit.shutdown();
});


test('volume notifications reach only the target, preserve zero-as-unchanged, and do not set device volume again', async (t) => {
    const setVolume = t.mock.method(AirPlayDevice.prototype, 'setVolume', async () => {});
    const { platform, shutdown } = await launch(t, {
        homepodId: 'A', enableVolumeControl: true, keepConnectionWarm: false,
        radios: [{ ...radio, homepodIds: ['A', 'B'] }],
    });
    const a = platform.playbackControllers.get('A');
    const b = platform.playbackControllers.get('B');
    const volumeA = a.streamers.find((s) => s instanceof HomepodVolumeAccessory);
    const volumeB = b.streamers.find((s) => s instanceof HomepodVolumeAccessory);
    await b.updateVolume('B', 65);
    assert.equal(await volumeB.getCurrentVolume(), 65);
    assert.equal(await volumeA.getCurrentVolume(), 25);
    await b.updateVolume('B', 0);
    assert.equal(await volumeB.getCurrentVolume(), 65);
    assert.equal(setVolume.mock.callCount(), 0);
    shutdown();
});

test('HTTP playback targets the default and stops only its content; HTTP can be disabled', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'homepod-routing-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, 'podcast.mp3'), 'test');
    const plays = [];
    const stops = [];
    t.mock.method(AirPlayDevice.prototype, 'playFile', async function () { plays.push(this.homepodId); return true; });
    t.mock.method(AirPlayDevice.prototype, 'stop', async function () { stops.push(this.homepodId); });
    const { platform, shutdown } = await launch(t, {
        homepodId: 'A', mediaPath: dir, keepConnectionWarm: false,
        radios: [{ ...radio, homepodIds: ['A', 'B'] }],
    });
    const result = await platform.httpService.handler('/play/podcast.mp3/40');
    assert.equal(result.error, false);
    assert.deepEqual(plays, ['A']);
    assert.deepEqual(stops, ['A']);
    shutdown();
    const disabled = await launch(t, { httpPort: 0, radios: [{ ...radio, homepodIds: ['B'] }] });
    assert.equal(disabled.platform.httpService.handler, undefined);
    disabled.shutdown();
});

test('playback controller waits for asynchronous stop operations', async () => {
    const controller = new PlaybackController();
    let release;
    let complete = false;
    const pending = new Promise((resolve) => { release = resolve; });
    controller.addStreamer({ stopRequested: () => pending });
    const stop = controller.requestStop({}).then(() => { complete = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(complete, false);
    release();
    await stop;
    assert.equal(complete, true);
});

test('invalid defaults are rejected and explicit pairing identities survive target reordering', async (t) => {
    for (const value of [12, null, {}, '  ']) {
        assert.throws(() => new HomepodRadioPlatformConfig(config({ homepodId: value })), /non-blank string/);
    }
    const settings = { keepConnectionWarm: false, enableVolumeControl: true };
    const first = await launch(t, { ...settings, radios: [{ ...radio, homepodIds: ['B', 'C'] }] });
    const reordered = await launch(t, { ...settings, radios: [{ ...radio, homepodIds: ['C', 'B'] }] });
    const identities = (published) => published.map((a) => [a.displayName, a.UUID]).sort();
    assert.deepEqual(identities(first.published), identities(reordered.published));
    first.shutdown();
    reordered.shutdown();
});
