import subprocess
import os
import tempfile
from pathlib import Path


def extract_audio(video_path: str, output_dir: str) -> str:
    """Extract audio from video file as 16kHz mono WAV (optimal for Whisper)."""
    video_path = Path(video_path)
    audio_path = Path(output_dir) / f"{video_path.stem}_audio.wav"

    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", "16000",
            "-ac", "1",
            str(audio_path),
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg audio extraction failed: {result.stderr}")

    # Guard: if the output file is missing or empty the video has no audio track
    if not audio_path.exists() or audio_path.stat().st_size == 0:
        raise RuntimeError(
            "No audio track found in this video. "
            "The file may be video-only, or the audio codec is unsupported by FFmpeg."
        )

    return str(audio_path)


def get_video_duration(video_path: str) -> float:
    """Return video duration in seconds using ffprobe."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            video_path,
        ],
        capture_output=True,
        text=True,
    )
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0
