#!/usr/bin/env python3
"""
Video to Text — CLI transcriber
Usage:  python transcribe.py <video_file> [--model base|small|medium|large]

Extracts audio with FFmpeg, transcribes with local Whisper, saves a .txt file
next to the video. Works completely offline, no API key needed.
"""
import sys
import argparse
import subprocess
import tempfile
import os
from pathlib import Path


MODELS = ["tiny", "base", "small", "medium", "large"]


def extract_audio(video_path: Path, tmp_dir: str) -> str:
    audio_path = os.path.join(tmp_dir, "audio.wav")
    print(f"  Extracting audio...")
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(video_path),
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", "16000",
            "-ac", "1",
            audio_path,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg failed:\n{result.stderr}")

    size = os.path.getsize(audio_path)
    if size < 1024:
        raise RuntimeError(
            "Audio extraction produced an empty file. "
            "The video may have no audio track."
        )
    print(f"  Audio extracted ({size / 1024 / 1024:.1f} MB)")
    return audio_path


def transcribe(audio_path: str, model_name: str) -> dict:
    import whisper
    import numpy as np

    print(f"  Loading Whisper '{model_name}' model...")
    model = whisper.load_model(model_name)

    audio = whisper.load_audio(audio_path)
    if len(audio) < 1600:
        raise RuntimeError("Audio is empty or under 0.1 s — nothing to transcribe.")

    duration_min = len(audio) / 16000 / 60
    print(f"  Transcribing {duration_min:.1f} min of audio (this may take a while)...")

    result = model.transcribe(audio, language="en", verbose=False, fp16=False)
    return result


def main():
    parser = argparse.ArgumentParser(
        description="Transcribe an English video to text using local Whisper."
    )
    parser.add_argument("video", help="Path to the video file")
    parser.add_argument(
        "--model", "-m",
        default="base",
        choices=MODELS,
        help="Whisper model quality (default: base)",
    )
    parser.add_argument(
        "--output", "-o",
        default=None,
        help="Output .txt file path (default: same folder as video)",
    )
    args = parser.parse_args()

    video_path = Path(args.video).expanduser().resolve()
    if not video_path.exists():
        print(f"Error: file not found — {video_path}", file=sys.stderr)
        sys.exit(1)

    # Default output: same directory as video, same name with .txt extension
    if args.output:
        out_path = Path(args.output).expanduser().resolve()
    else:
        out_path = video_path.with_suffix(".txt")

    print(f"\nVideo to Text")
    print(f"  File  : {video_path.name}  ({video_path.stat().st_size / 1024**3:.2f} GB)")
    print(f"  Model : {args.model}")
    print(f"  Output: {out_path}\n")

    with tempfile.TemporaryDirectory() as tmp:
        audio_path = extract_audio(video_path, tmp)
        result = transcribe(audio_path, args.model)

    text = result["text"].strip()
    word_count = len(text.split())

    out_path.write_text(text, encoding="utf-8")

    print(f"\nDone! {word_count:,} words → {out_path}")
    print("\n--- Preview (first 300 chars) ---")
    print(text[:300] + ("..." if len(text) > 300 else ""))
    print("---------------------------------\n")


if __name__ == "__main__":
    main()
