import os
import uuid
import tempfile
import asyncio
import json
from pathlib import Path
from contextlib import asynccontextmanager

import aiofiles
from fastapi import FastAPI, File, UploadFile, HTTPException, Form
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from processor import extract_audio, get_video_duration
from transcriber import transcribe, load_model

UPLOAD_DIR = Path(__file__).parent.parent / "uploads"
OUTPUT_DIR = Path(__file__).parent.parent / "outputs"
STATIC_DIR = Path(__file__).parent.parent / "static"
CHUNK_SIZE = 1024 * 1024  # 1 MB streaming chunks

# Track job status in memory (sufficient for personal use)
jobs: dict[str, dict] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Pre-load the base model on startup so first request is fast
    print("Loading Whisper base model...")
    load_model("base")
    print("Model ready.")
    yield


app = FastAPI(title="Video to Text Transcriber", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    html_path = STATIC_DIR / "index.html"
    async with aiofiles.open(html_path) as f:
        return await f.read()


@app.post("/upload")
async def upload_video(
    file: UploadFile = File(...),
    model: str = Form(default="base"),
):
    """Accept a video upload and start background transcription."""
    allowed_extensions = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".flv", ".wmv"}
    suffix = Path(file.filename).suffix.lower()
    if suffix not in allowed_extensions:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {suffix}")

    job_id = str(uuid.uuid4())
    video_path = UPLOAD_DIR / f"{job_id}{suffix}"

    # Stream large file to disk without loading it all into memory
    async with aiofiles.open(video_path, "wb") as out:
        while chunk := await file.read(CHUNK_SIZE):
            await out.write(chunk)

    jobs[job_id] = {"status": "processing", "filename": file.filename, "model": model}

    # Run transcription in background so the HTTP response returns immediately
    asyncio.create_task(_run_transcription(job_id, str(video_path), model))

    return {"job_id": job_id}


async def _run_transcription(job_id: str, video_path: str, model: str):
    """Background task: extract audio, transcribe, save result."""
    tmp_audio = None
    try:
        duration = get_video_duration(video_path)
        jobs[job_id]["duration"] = duration

        # Audio extraction is CPU-bound — run in thread pool
        loop = asyncio.get_event_loop()
        tmp_audio = await loop.run_in_executor(
            None, extract_audio, video_path, str(UPLOAD_DIR)
        )

        result = await loop.run_in_executor(
            None, transcribe, tmp_audio, model
        )

        # Save transcript
        output_path = OUTPUT_DIR / f"{job_id}.json"
        async with aiofiles.open(output_path, "w") as f:
            await f.write(json.dumps(result, indent=2))

        txt_path = OUTPUT_DIR / f"{job_id}.txt"
        async with aiofiles.open(txt_path, "w") as f:
            await f.write(result["text"])

        jobs[job_id].update({"status": "done", "text": result["text"], "segments": result["segments"]})

    except Exception as e:
        jobs[job_id].update({"status": "error", "error": str(e)})
    finally:
        # Clean up temp audio file (keep original video for re-processing)
        if tmp_audio and os.path.exists(tmp_audio):
            os.remove(tmp_audio)


@app.get("/status/{job_id}")
async def get_status(job_id: str):
    """Poll transcription job status."""
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/download/{job_id}")
async def download_transcript(job_id: str, fmt: str = "txt"):
    """Download the transcript as .txt or .json."""
    job = jobs.get(job_id)
    if not job or job["status"] != "done":
        raise HTTPException(status_code=404, detail="Transcript not ready")

    ext = "json" if fmt == "json" else "txt"
    path = OUTPUT_DIR / f"{job_id}.{ext}"
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    original_name = Path(job["filename"]).stem
    return FileResponse(
        path=str(path),
        media_type="text/plain",
        filename=f"{original_name}_transcript.{ext}",
    )
