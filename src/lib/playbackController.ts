export interface PlaybackStreamer {
    stopRequested(source: PlaybackStreamer): Promise<void>;
    shutdownRequested(): Promise<void>;
    platformLaunched(): Promise<void>;

    volumeUpdated(homepodId: string, volume: number): Promise<void>;

    streamerName(): string;
    isPlaying(): boolean;
    startPlaying(): Promise<void>;
    stopPlaying(): Promise<void>;
  }

export class PlaybackController {
    private readonly streamers: PlaybackStreamer[];
    public constructor() {
        this.streamers = [];
    }

    public addStreamer(streamer: PlaybackStreamer) {
        this.streamers.push(streamer);
    }

    public async requestStop(source: PlaybackStreamer): Promise<void> {
        await Promise.all(this.streamers.map(async (streamer) => {
            if (streamer !== source) {
                await streamer.stopRequested(source);
            }
        }));
    }

    public async shutdown(): Promise<void> {
        await Promise.all(this.streamers.map(async (streamer) => {
            await streamer.shutdownRequested();
        }));
    }

    public async platformReady(): Promise<void> {
        await Promise.all(this.streamers.map(async (streamer) => {
            await streamer.platformLaunched
            ();
        }));
    }

    public async updateVolume(homepodId: string, value: number): Promise<void> {
        await Promise.all(this.streamers.map(async (streamer) => {
            await streamer.volumeUpdated(homepodId, value);
        }));
    }
}
