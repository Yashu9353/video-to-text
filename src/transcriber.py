import whisper


_model_cache: dict[str, whisper.Whisper] = {}


def load_model(model_name: str = "base") -> whisper.Whisper:
    """Load and cache a Whisper model by name."""
    if model_name not in _model_cache:
        _model_cache[model_name] = whisper.load_model(model_name)
    return _model_cache[model_name]


def transcribe(audio_path: str, model_name: str = "base") -> dict:
    """
    Transcribe audio file to text.
    Returns dict with 'text' (full transcript) and 'segments' (timestamped chunks).
    """
    # Load audio first so we can check its length before handing it to Whisper.
    # Passing 0-sample audio causes a cryptic tensor reshape crash inside Whisper.
    audio = whisper.load_audio(audio_path)  # returns float32 numpy array at 16 kHz
    if len(audio) < 1600:                  # less than 0.1 seconds of audio
        raise RuntimeError(
            "Audio is empty or too short to transcribe (< 0.1 s). "
            "The video may have no audio track, or the file was not fully uploaded."
        )

    model = load_model(model_name)
    result = model.transcribe(
        audio,          # pass the pre-loaded numpy array directly
        language="en",
        verbose=False,
        fp16=False,     # CPU-safe
    )
    return {
        "text": result["text"].strip(),
        "segments": [
            {
                "start": round(seg["start"], 2),
                "end": round(seg["end"], 2),
                "text": seg["text"].strip(),
            }
            for seg in result["segments"]
        ],
    }
