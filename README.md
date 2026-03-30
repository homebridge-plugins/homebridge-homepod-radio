<div>
    <a href="https://www.npmjs.com/package/@homebridge-plugins/homebridge-homepod-radio"><img src="https://img.shields.io/github/package-json/v/homebridge-plugins/homebridge-homepod-radio?color=F99211" /></a>
    <a href="https://www.npmjs.com/package/@homebridge-plugins/homebridge-homepod-radio"><img src="https://img.shields.io/github/v/release/homebridge-plugins/homebridge-homepod-radio?color=FFd461" /></a>
        <a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img src="https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat" /></a>
    <a href="https://github.com/homebridge-plugins/homebridge-homepod-radio"><img src="https://img.shields.io/badge/_homebridge_v2.0_-_ready_-4CAF50" /></a>
    <a href="https://discord.gg/Z8jmyvb"><img src="https://img.shields.io/badge/discord-%23homepod--radio-737CF8" /></a>
</div>

<br/><br/>
<p align="center" vertical-align="middle">
    <a href="https://github.com/homebridge-plugins/homebridge-homepod-radio"><img src="homepod-radio.png" height="140"></a>
    <a href="https://github.com/homebridge/homebridge"><img src="https://raw.githubusercontent.com/homebridge/branding/master/logos/homebridge-wordmark-logo-vertical.png" height="140"></a>
</p>

<span align="center">

# HomePod Radio

</span>

### HomePod Radio is a Homebridge plugin for streaming radio urls and audio files to a Homepod (Mini or OG) or an Apple TV.

## <!-- Thin separator line -->

## Streaming radio to HomePod

The main idea is to stream audio to the HomePod or Apple TV using the `pyatv` AirPlay library.

- Automatically stops streaming when HomePod is used by another app
- Sometimes audio streaming stops, so plugin automatically restarts it

> [!NOTE]
> As the plugin is streaming via AirPlay, it should work with any AirPlay enabled speakers. YMMV.

## Requirements
- NodeJS (>=8.9.3) with NPM (>=6.4.1)
- pyatv (>=0.13) which require python (>= 3.8)

For the HomePod you can specify device MAC address or device name.

## Usage Example:

### Multiple radio accessories support

> [!IMPORTANT]
> Each radio speaker must be added to Home app separately with Homebridge pin pairing

Config example with a single HomePod (legacy format):

```json
{
    "platform": "HomepodRadioPlatform",
    "serialNumber": "20020105:00",
    "homepodId": "<homepod id or name>",
    "httpPort": 7654,
    "mediaPath": "/media/homepod",
    "enableVolumeControl": true,
    "radios": [
        {
            "name": "BBC - Radio 1",
            "radioUrl": "http://stream.live.vc.bbcmedia.co.uk/bbc_radio_one",
            "artworkUrl": "https://ichef.bbci.co.uk/images/ic/1920x1080/p05d68tx.jpg",
            "autoResume": true,
            "onSwitch": true
        }
    ],
    "audioFiles": [
        {
            "name": "Alert",
            "fileName": "police.mp3",
            "volume": 85
        }
    ]
}
```

### Multiple HomePod support

You can configure multiple HomePods (or Apple TVs) in a single platform instance using the `homepods` array. Each HomePod gets its own independent set of radio and audio file accessories. Playback is independent per HomePod — different HomePods can play different streams at the same time.

When multiple HomePods are configured, accessory names include the HomePod name for identification, e.g. "BBC - Radio 1 (Living Room)".

Config example with multiple HomePods:

```json
{
    "platform": "HomepodRadioPlatform",
    "homepods": [
        {
            "id": "F4:22:F0:10:33:71",
            "name": "Living Room",
            "enableVolumeControl": true,
            "volume": 25
        },
        {
            "id": "Kitchen HomePod",
            "name": "Kitchen",
            "enableVolumeControl": true,
            "volume": 30
        }
    ],
    "httpPort": 7654,
    "mediaPath": "/media/homepod",
    "radios": [
        {
            "name": "BBC - Radio 1",
            "radioUrl": "http://stream.live.vc.bbcmedia.co.uk/bbc_radio_one",
            "artworkUrl": "https://ichef.bbci.co.uk/images/ic/1920x1080/p05d68tx.jpg",
            "autoResume": true,
            "onSwitch": true
        }
    ],
    "audioFiles": [
        {
            "name": "Alert",
            "fileName": "police.mp3",
            "volume": 85
        }
    ]
}
```

Each entry in `homepods` supports these properties:

| Property | Required | Description |
|---|---|---|
| `id` | Yes | HomePod identifier — MAC address (e.g. `F4:22:F0:10:33:71`), identifier without separators (e.g. `F422F0103371`), or device name (e.g. `Kitchen HomePod`). Found via `atvremote scan`. |
| `name` | Yes | Friendly name used in accessory names and HTTP webhook URLs. |
| `serialNumber` | No | Serial number for the accessories. Defaults to `HPD-<id>`. |
| `enableVolumeControl` | No | Enable volume control accessory for this HomePod. Default: `false`. |
| `volume` | No | Default volume level (0–100). Default: `25`. |

> [!NOTE]
> When upgrading from a single-HomePod config (`homepodId`) to the new `homepods` array, your existing accessories will get new UUIDs and need to be re-paired in the Home app.

### Radio metadata support

Some radios provide metadata about currently played tracks. The plugin supports an optional `metadataUrl` parameter and tries to fetch JSON in the following format (example: https://o.tavrmedia.ua/rokscla):
```
[
      {
            "stime": "15:29:21",
            "time": "15:29",
            "singer": "Billy Joel",
            "song": "Honesty",
            "cover": "https://www.radioroks.ua/static/img/content/cover/0/38/500x500.jpg"
      },
      {
            "stime": "15:25:38",
            "time": "15:25",
            "singer": "Fleetwood Mac",
            "song": "Everywhere",
            "cover": ""
      },
      ...
  ]
```

The plugin then
- Enriches the radio stream with `singer` and `song` values from the retrieved metadata
- Enriches the radio artwork with the image downloaded using the `cover` metadata URL

> [!NOTE]
> Due to some bugs/limitations in tvOS 16/17, HomePods are not showing this info.

## Audio file playback

The plugin allows to start file playback either through a add switch accessory (see below) or it can be triggered from a webhook.

Make sure your audio files are available to the Homebridge server, for example by downloading them to the server:
```
$ mkdir -r /home/pi/media
$ <downlaod files to /home/pi/media>
$ ls /home/pi/media
-rw-r--r-- 1 pi   pi     94622 Jan 10 16:46 hello.wav
```
Configure the plugin to play files from `/home/pi/media` by setting the `mediaPath` property:
```
  "mediaPath": "/home/pi/media",
```

### Switch accessory for audio file playback

This feature adds a switch accessory in the `audioFiles` section for each audio file you want to stream
```
    "audioFiles": [
        {
            "name": "Alert",
            "fileName": "police.mp3",
            "volume": 85
        }
    ]
```
Supported audio file formats are `mp3`, `wav`, `flac`, and `ogg`.

You can also specify an `.m3u` playlist file to stream multiple files:
```
    "audioFiles": [
        {
            "name": "Relaxing Mood",
            "fileName": "death_metal.m3u",
            "volume": 85
        }
    ]
```

The `.m3u` file format is just a list of audio files:
```
# My playlist

# Metallica, 1991
Nothing Else Matters.mp3

# Master Of Puppets, 1986
Master Of Puppets.mp3

# Ride The Lightning, 1984
For Whom The Bell Tolls.mp3
```
> [!NOTE]
> Comments starting with `#` and empty lines are ignored.

### Webhook for audio file playback

You should use the Homebridge server name (default for Homebridge server is homebridge.local) or IP to invoke playback via URL

Example:
- Homebridge is running on host "homebridge.local"
- `hello.mp3` file is on the same server on `/var/www/media`
- Plugin's "httpPort" is set to `4567`
- Plugin's "mediaPath" is set to `/var/www/media`

Then you can trigger playback of `hello.mp3` even from browser by navigating to: `http://homebridge.local:4567/play/hello.mp3`

You can specify the playback volume level, by adding it to the end of the playback URL: `http://homebridge.local:4567/play/hello.mp3/75`

#### Webhooks with multiple HomePods

When using the `homepods` array, you can target a specific HomePod by including its name in the URL:

```
http://homebridge.local:4567/play/Living Room/hello.mp3
http://homebridge.local:4567/play/Kitchen/hello.mp3/75
```

If no HomePod name is specified, the first configured HomePod is used (backward compatible).

### Audio file playback automation example

- Configure automation to play file
   - Select/Create automation in Home app
   - Tap "Select Accessories and Scenes..."
   - At the botton tap "Convert to Shortcut"
   - Create shortcut:
![Screenshot](images/play-file-shortcut.jpeg)
   - Test shortcut

## HomePod access setup

In the Home app settings:

- Tap the Homes and Home Settings button.
- Tap Home Settings > Allow Speaker & TV Access, then choose "allow everyone"
- *Important!* Reboot the HomePod

## Siri support (works on iPhone/iPad)

- Create shortcut with name (for example) "Start Radio"
- Select "Control Home" action, check corresponding speaker and in "Media" section select "Resume Audio")
![Screenshot](images/bbc-radio-shortcut.png)
- Say "Hey Siri, start radio" on iPhone/iPad (on HomePod Mini Siri does not run it properly)

## Dependencies

### PyATV lib

For streaming to the HomePod the plugin uses pyatv (https://pyatv.dev).
Follow these setup instructions for RaspberryPi/Linux. If installing on a different platform, adjust as needed.

Install python3:
```
sudo apt-get install python3
```
Install pip3:
```
sudo apt-get install python3-pip
```
Install pyatv:
```
pip3 install pyatv
```
If the installation fails with this error:
```
error: externally-managed-environment

× This environment is externally managed
```
Then install pyatv with the `break-system-packages` option:
```
pip3 install --break-system-packages
```
Make atvremote available for homebridge:
```
sudo ln -s /home/pi/.local/bin/atvremote /usr/local/bin/atvremote
```

### Installing the PyATV lib in the Homebridge Docker container

The Homebridge Docker image comes with the latest version of `python` pre-installed. At the time of writing, the image is based on `Ubuntu 22.04`, with `Python 3.10.12` included.

To avoid having to reinstall `pyatv` every time the container is recreated (for example when updating the Homebridge image), Homebridge provides the `startup.sh` script, which is executed after the Docker container is finished starting up. Add the following line to the end of `startup.sh`:
```
pip3 install --break-system-packages
```
You can do this from the command line (using your favorite editor) and finding the script in the Homebridge `config` folder. Alternatively you can edit it from the Homebridge UI, by going to `Settings`, `Startup & Environment`, `Startup Script`. If you edit the script from the UI or after the container has started, you will need to restart the container.

## Setup steps

Starting with various OS versions, Apple devices have started generating, by default, a new random MAC address for each wireless network they connect to. The HomePod Identifiers are based on the MAC address and while it will not change every time the HomePod reconnects to your home wifi, resetting a HomePod will indeed generate a new randomized MAC address and therefore new HomePod Identifiers. If this happens, you will have to update the plugin configuration.

Due to Apple's use of MAC address randomization and simply to make it easier to setup and read the plugin configuration, you can use the HomePod name (as displayed in the Home app) in the `HomePod Id` field, as well as any of the HomePod Identifiers. If you use the HomePod name, you will have to update the plugin configuration if you change it in the Home app.

### Find HomePod Identifiers:

Scan for devices:
```
atvremote scan
```
Select one of `Identifiers` values from the chosen device (or the `Name` value):
```
       Name: HomePod
   Model/SW: HomePod Mini, tvOS 15.2
    Address: 192.168.1.7
        MAC: F4:22:F0:10:33:71
 Deep Sleep: False
Identifiers:
 - F4:22:F0:10:33:71
 - F422F0103371
```

### Stream URL format

The easieast path would be to get the streaming url from your favorite radio playlist (usually .m3u file).
Example for BBC Radio: https://gist.github.com/bpsib/67089b959e4fa898af69fea59ad74bc3

## Known issues

### 1. Pairing setting for the HomePod (fixed by *[HomePod access setup](#homepod-access-setup)* step):

Make sure your HomePod has ```Pairing: NotNeeded``` set for RAOP protocol.

Scan for devices:
```
atvremote scan
```
Select for your device:
```
Services:
 - Protocol: Companion, Port: 49152, Credentials: None, Requires Password: False, Password: None, Pairing: Unsupported
 - Protocol: AirPlay, Port: 7000, Credentials: None, Requires Password: False, Password: None, Pairing: NotNeeded
 - Protocol: RAOP, Port: 7000, Credentials: None, Requires Password: False, Password: None, Pairing: NotNeeded
```

> [!IMPORTANT]
> Streaming will not work if you get `Pairing: Disabled` or `Pairing: Unsupported`

### 2. HomePod playback errors

Sometimes (quite rarely) playback fails and in the logs there are errors like:
```
  pyatv.exceptions.HttpError: RTSP/1.0 method SETUP failed with code 500: Internal Server Error
```

Typically this error disappears after HomePod restart.

### 3. Streaming to stereo pair

Looks like this is not supported at the moment by pyatv

### 4. Speaker accessory controls

With iOS 15 Homekit does not support `volume control` and `start/stop` for speaker accessory (at least for speakers exposed by Homebridge). So I'd suggest to enable switch accessory for each radio.
