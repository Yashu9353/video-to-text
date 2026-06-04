"""
Video to Text — desktop launcher.
Starts the local FastAPI server, waits until it's ready, then opens the browser.
Bundled by PyInstaller into a single distributable app.
"""
import sys
import os
import time
import threading
import webbrowser
import urllib.request
from pathlib import Path


# ── Resolve paths whether running as PyInstaller bundle or plain Python ──────
if getattr(sys, 'frozen', False):
    # Running inside a PyInstaller bundle
    BASE_DIR = Path(sys._MEIPASS)          # temp extraction dir
    APP_DIR  = Path(sys.executable).parent # directory of the .exe / .app binary
else:
    BASE_DIR = Path(__file__).parent
    APP_DIR  = BASE_DIR

# Writable runtime dirs (sit next to the executable, not inside the bundle)
UPLOADS_DIR = APP_DIR / "uploads"
OUTPUTS_DIR = APP_DIR / "outputs"
UPLOADS_DIR.mkdir(exist_ok=True)
OUTPUTS_DIR.mkdir(exist_ok=True)

PORT = 8765
URL  = f"http://localhost:{PORT}"


def _patch_paths():
    """Override the path constants in main.py before importing it."""
    import src.main as m
    m.UPLOAD_DIR = UPLOADS_DIR
    m.OUTPUT_DIR = OUTPUTS_DIR
    m.STATIC_DIR = BASE_DIR / "static"


def _run_server():
    """Start uvicorn in the current thread (called from a daemon thread)."""
    # Add the bundle's src directory to sys.path so imports resolve
    src_path = str(BASE_DIR / "src")
    if src_path not in sys.path:
        sys.path.insert(0, src_path)
    if str(BASE_DIR) not in sys.path:
        sys.path.insert(0, str(BASE_DIR))

    _patch_paths()

    import uvicorn
    from src.main import app
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


def _wait_for_server(timeout: int = 60) -> bool:
    """Poll until the server responds or timeout expires."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(URL, timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def main():
    print("Starting Video to Text…")

    # Start server in background daemon thread
    t = threading.Thread(target=_run_server, daemon=True)
    t.start()

    print(f"Waiting for server on {URL}…")
    if not _wait_for_server():
        print("ERROR: server did not start within 60 seconds.", file=sys.stderr)
        sys.exit(1)

    print("Opening browser…")
    webbrowser.open(URL)

    print(f"Running at {URL}  —  close this window to quit.")
    try:
        # Keep main thread alive; server thread is daemon so it dies with us
        while t.is_alive():
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()
