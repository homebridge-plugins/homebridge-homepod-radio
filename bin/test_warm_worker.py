#!/usr/bin/env python3
"""Unit tests for the duration helpers in ``warm-worker.py``.

These cover the audio-length measurement that sizes the warm-play timeout — the
core of the issue #360 fix. They use only the standard library: a real ``.wav``
is generated with the stdlib ``wave`` module, so the exact-measurement path is
exercised without mutagen, ffmpeg, pyatv, or any committed audio fixture.

Run:  python3 -m unittest discover -s bin -p 'test_*.py'
"""
import importlib.util
import os
import tempfile
import unittest
import wave

# ``warm-worker.py`` is not an importable module name (hyphen), so load it by
# path. pyatv and mutagen imports inside it are guarded, so this succeeds with
# only the standard library installed.
_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "warm_worker", os.path.join(_HERE, "warm-worker.py"),
)
warm_worker = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(warm_worker)


def _write_wav(path, seconds, framerate=8000):
    """Write a silent mono 16-bit WAV of the given length."""
    frames = int(seconds * framerate)
    with wave.open(path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(framerate)
        wav.writeframes(b"\x00\x00" * frames)


class AudioDurationTests(unittest.TestCase):
    def test_wav_duration_is_measured_via_stdlib(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "clip.wav")
            _write_wav(path, 2.5)
            self.assertAlmostEqual(warm_worker._audio_duration(path), 2.5, places=2)

    def test_missing_file_reports_unknown(self):
        self.assertIsNone(warm_worker._audio_duration("/no/such/file.wav"))

    def test_unknown_format_without_mutagen_is_unknown(self):
        # With mutagen absent, a non-wav file must report None so the supervisor
        # uses its generous fallback instead of a too-short timeout.
        if warm_worker._MutagenFile is not None:
            self.skipTest("mutagen installed; unknown-format path not exercised")
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "clip.mp3")
            with open(path, "wb") as handle:
                handle.write(b"not really an mp3")
            self.assertIsNone(warm_worker._audio_duration(path))


class TotalDurationTests(unittest.TestCase):
    def test_sums_every_entry(self):
        with tempfile.TemporaryDirectory() as folder:
            first = os.path.join(folder, "a.wav")
            second = os.path.join(folder, "b.wav")
            _write_wav(first, 1.0)
            _write_wav(second, 2.0)
            self.assertAlmostEqual(warm_worker._total_duration([first, second]), 3.0, places=2)

    def test_one_unknown_entry_makes_the_total_unknown(self):
        # Deliberate: an underestimated total would re-introduce the premature
        # timeout, so any unreadable entry forces the generous fallback.
        with tempfile.TemporaryDirectory() as folder:
            good = os.path.join(folder, "good.wav")
            _write_wav(good, 1.0)
            self.assertIsNone(warm_worker._total_duration([good, "/no/such.wav"]))


class ExpandPlaylistTests(unittest.TestCase):
    def test_non_playlist_path_passes_through(self):
        self.assertEqual(warm_worker._expand_playlist("/tones/clip.wav"), ["/tones/clip.wav"])

    def test_playlist_entries_resolve_against_the_playlist_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            playlist = os.path.join(folder, "list.m3u")
            with open(playlist, "w", encoding="UTF-8") as handle:
                handle.write("# a comment\n")
                handle.write("song-one.mp3\n")
                handle.write("http://example.com/stream\n")
                handle.write("song-two.mp3\n")
            songs = warm_worker._expand_playlist(playlist)
            self.assertEqual(
                songs,
                [os.path.join(folder, "song-one.mp3"), os.path.join(folder, "song-two.mp3")],
            )


if __name__ == "__main__":
    unittest.main()
