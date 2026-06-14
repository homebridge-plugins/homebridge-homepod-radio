# !/usr/bin/python3
"""Resident pyatv worker for homebridge-homepod-radio (warm-connection mode).

Spawned once by the plugin when ``keepConnectionWarm`` is enabled. It imports
pyatv a single time, scans for and connects to the HomePod once, and then holds
that connection warm, reusing it for every audio-button press. This eliminates
the ~5 s per-press cost (``import pyatv`` cold start + device scan + connect)
that ``stream.py`` pays each time it is spawned fresh.

Protocol (newline-delimited JSON; one object per line):

    stdin   {"id": "<id>", "cmd": "play", "file": "<abs path>",
             "volume": <0-100>, "title": "<text>"}
            {"id": "<id>", "cmd": "ping"}

    stdout  {"event": "ready"}                       (once, after startup)
            {"id": "<id>", "event": "duration", "seconds": <float|null>}
            {"id": "<id>", "ok": true}
            {"id": "<id>", "ok": false, "error": "..."}

All human-readable logging goes to **stderr** so that stdout stays a clean
protocol channel. ``volume`` of 0 (or missing) means "do not change volume",
matching the existing ``stream.py`` semantics.
"""
import argparse
import asyncio
import json
import logging
import os
import re
import sys

try:
    import pyatv
    from pyatv.const import Protocol
    from pyatv.interface import MediaMetadata
    _PYATV_IMPORT_ERROR = None
except ImportError as ex:
    pyatv = None
    Protocol = None
    MediaMetadata = None
    _PYATV_IMPORT_ERROR = ex

try:
    # Pure-Python audio metadata reader (no ffmpeg) used to size the play timeout
    # to the real track length. Optional: when it is missing we still read .wav
    # durations via the stdlib ``wave`` module and fall back to a generous timeout
    # for other formats.
    from mutagen import File as _MutagenFile
except ImportError:
    _MutagenFile = None


_LOGGER = logging.getLogger("warm-worker")


def _out(obj) -> None:
    """Write one protocol message to stdout and flush immediately."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _expand_playlist(file_path: str):
    """Expand an .m3u/.m3u8 playlist into a list of song paths (mirrors stream.py).

    A non-playlist path is returned unchanged as a single-element list.
    """
    if file_path.endswith(".m3u") or file_path.endswith(".m3u8"):
        folder = os.path.dirname(file_path)
        with open(file_path, "r", encoding="UTF-8") as playlist:
            lines = [ln.strip() for ln in playlist if ln.strip()]
        return [
            os.path.join(folder, ln)
            for ln in lines
            if re.match(r"^[A-Za-z0-9]", ln)
            and not re.match(r"^[A-Za-z]:\\", ln)
            and not re.match(r"^http[s]?://", ln)
        ]
    return [file_path]


def _audio_duration(path: str):
    """Best-effort duration in seconds of one audio file, or ``None`` if unknown.

    Uses the stdlib ``wave`` module for ``.wav`` (always available) and
    ``mutagen`` for mp3/flac/ogg and friends. ``mutagen`` is pure Python and does
    not need ffmpeg; when it is not installed, non-wav files report ``None`` and
    the supervisor falls back to a generous timeout.
    """
    try:
        ext = os.path.splitext(path)[1].lower()
        if ext == ".wav":
            import wave

            with wave.open(path, "rb") as wav:
                rate = wav.getframerate()
                if rate > 0:
                    return wav.getnframes() / float(rate)
            return None
        if _MutagenFile is not None:
            audio = _MutagenFile(path)
            info = getattr(audio, "info", None) if audio is not None else None
            length = getattr(info, "length", None) if info is not None else None
            if length and length > 0:
                return float(length)
    except Exception as ex:  # noqa: BLE001 - duration is best-effort only
        _LOGGER.debug("could not read duration of %s: %s", path, ex)
    return None


def _total_duration(songs):
    """Total seconds across an expanded playlist, or ``None`` if any are unknown.

    Returning ``None`` when even one file's length is unreadable is deliberate:
    an underestimated total would re-introduce the premature-timeout bug, so we
    prefer the supervisor's generous fallback in that case.
    """
    total = 0.0
    for song in songs:
        seconds = _audio_duration(song)
        if seconds is None:
            return None
        total += seconds
    return total


class WarmConnection:
    """Owns a single, reused pyatv connection to the target device."""

    def __init__(self, identifier: str, loop: asyncio.AbstractEventLoop) -> None:
        self.identifier = identifier
        self.loop = loop
        self.atv = None
        self._lock = asyncio.Lock()

    async def _scan(self):
        # Mirror stream.py: scan by 12-hex id / MAC first, else by RAOP name.
        ident_regex = re.compile(r"^[0-9A-Fa-f]{12}$")
        mac_regex = re.compile(r"^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$")
        atvs = []
        if (len(self.identifier) == 12 and ident_regex.match(self.identifier)) or mac_regex.match(
            self.identifier
        ):
            _LOGGER.info("scanning by id/MAC: %s", self.identifier)
            atvs = await pyatv.scan(self.loop, identifier=self.identifier, timeout=5)
        if not atvs:
            _LOGGER.info("scanning by name: %s", self.identifier)
            found = await pyatv.scan(self.loop, protocol=Protocol.RAOP, timeout=5)
            atvs = [a for a in found if a.name == self.identifier]
        if not atvs:
            raise RuntimeError("device not found: %s" % self.identifier)
        return atvs[0]

    async def ensure_connected(self):
        if self.atv is not None:
            return self.atv
        conf = await self._scan()
        _LOGGER.info("connecting to %s", conf.address)
        self.atv = await pyatv.connect(conf, self.loop)
        _LOGGER.info("connected; holding connection warm")
        return self.atv

    def close(self) -> None:
        if self.atv is not None:
            try:
                self.atv.close()
            except Exception:  # noqa: BLE001 - best-effort teardown
                pass
            self.atv = None

    async def play(self, req_id, songs, volume, title: str) -> None:
        """Stream pre-expanded songs on the warm connection, reconnecting once on error."""
        async with self._lock:
            # Now that we hold the playback lock and are about to stream, tell the
            # supervisor how long this will take. It sizes its watchdog timeout to
            # the real audio length instead of a fixed 60s, which previously cut
            # off (and then double-played via the spawn fallback) any longer track.
            _out({"id": req_id, "event": "duration", "seconds": _total_duration(songs)})
            last_err = None
            for attempt in (1, 2):
                try:
                    atv = await self.ensure_connected()
                    if volume and int(volume) > 0:
                        try:
                            await atv.audio.set_volume(float(volume))
                        except Exception as ex:  # noqa: BLE001
                            _LOGGER.warning("set_volume(%s) failed: %s", volume, ex)
                    metadata = MediaMetadata(title=title, album=title, artist=None, artwork=None)
                    for song in songs:
                        _LOGGER.info("streaming %s (attempt %d)", song, attempt)
                        await atv.stream.stream_file(song, metadata)
                    _LOGGER.info("finished streaming %d file(s)", len(songs))
                    return
                except Exception as ex:  # noqa: BLE001
                    last_err = ex
                    _LOGGER.error("stream attempt %d failed: %s", attempt, ex)
                    self.close()  # force a fresh connect on retry
            raise last_err if last_err is not None else RuntimeError("play failed")


async def _read_line(loop: asyncio.AbstractEventLoop) -> str:
    # Blocking stdin read offloaded to a thread so the asyncio loop stays free.
    return await loop.run_in_executor(None, sys.stdin.readline)


async def main_async(identifier: str) -> None:
    loop = asyncio.get_running_loop()
    conn = WarmConnection(identifier, loop)

    # Best-effort warmup; a failure here is non-fatal because the first play
    # will retry the scan/connect itself.
    try:
        await conn.ensure_connected()
    except Exception as ex:  # noqa: BLE001
        _LOGGER.warning("initial warmup failed (will retry on first play): %s", ex)

    _out({"event": "ready"})

    while True:
        line = await _read_line(loop)
        if line == "":  # EOF: parent closed our stdin
            _LOGGER.info("stdin closed, exiting")
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:  # noqa: BLE001
            _LOGGER.warning("ignoring non-JSON line: %s", line)
            continue

        req_id = msg.get("id")
        cmd = msg.get("cmd")

        if cmd == "ping":
            _out({"id": req_id, "ok": True, "pong": True})
            continue

        if cmd == "play":
            file_path = msg.get("file")
            volume = msg.get("volume", 0)
            title = msg.get("title") or (os.path.basename(file_path) if file_path else "")
            if not file_path:
                _out({"id": req_id, "ok": False, "error": "missing file"})
                continue
            try:
                await conn.play(req_id, _expand_playlist(file_path), volume, title)
                _out({"id": req_id, "ok": True})
            except Exception as ex:  # noqa: BLE001
                _out({"id": req_id, "ok": False, "error": str(ex)})
            continue

        _out({"id": req_id, "ok": False, "error": "unknown cmd: %s" % cmd})

    conn.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("-i", "--id", dest="id", required=True, help="device identifier")
    parser.add_argument("-v", "--verbose", action="store_true", dest="verbose")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        stream=sys.stderr,
        datefmt="%Y-%m-%d %H:%M:%S",
        format="%(asctime)s %(levelname)s [%(name)s]: %(message)s",
    )

    if _PYATV_IMPORT_ERROR is not None:
        _LOGGER.error("Required dependency 'pyatv' was not found. Install it with: pip3 install pyatv")
        _LOGGER.error("Import error: %s", _PYATV_IMPORT_ERROR)
        sys.exit(1)

    try:
        asyncio.run(main_async(args.id))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
