#!/usr/bin/env bash
# Build script — creates VideoToText.app (Mac) or VideoToText/ folder (Windows)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "======================================"
echo "  Video to Text — App Builder"
echo "======================================"

# ── Activate venv ──────────────────────────────────────────────────────────
if [ ! -d ".venv" ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
fi
source .venv/bin/activate

# ── Install build dependencies ─────────────────────────────────────────────
echo "Installing dependencies..."
pip install -q pyinstaller
pip install -q "fastapi==0.115.5" "uvicorn[standard]==0.32.1" \
               "python-multipart==0.0.12" "aiofiles==24.1.0" \
               "openai-whisper==20250625" "ffmpeg-python==0.2.0"

# ── Verify FFmpeg is on PATH (will be bundled into the app) ───────────────
if ! command -v ffmpeg &>/dev/null; then
  echo ""
  echo "ERROR: ffmpeg is not installed."
  echo "Install it first:  brew install ffmpeg"
  echo ""
  exit 1
fi
echo "FFmpeg found: $(which ffmpeg)"

# ── Pre-download Whisper 'base' model so the build bundles it ─────────────
echo ""
echo "Pre-downloading Whisper 'base' model (~145 MB, one-time)..."
python3 -c "import whisper; whisper.load_model('base'); print('Model ready.')"

# ── Run PyInstaller ────────────────────────────────────────────────────────
echo ""
echo "Building app with PyInstaller..."
rm -rf dist/VideoToText dist/VideoToText.app build/VideoToText

pyinstaller app.spec --noconfirm

# ── Summarise ─────────────────────────────────────────────────────────────
echo ""
echo "======================================"
if [ -d "dist/VideoToText.app" ]; then
  SIZE=$(du -sh dist/VideoToText.app | cut -f1)
  echo "  Built:  dist/VideoToText.app  ($SIZE)"
  echo "  → Drag to /Applications or double-click to run"
elif [ -d "dist/VideoToText" ]; then
  SIZE=$(du -sh dist/VideoToText | cut -f1)
  echo "  Built:  dist/VideoToText/  ($SIZE)"
  echo "  → Run: dist/VideoToText/VideoToText"
fi
echo "======================================"
