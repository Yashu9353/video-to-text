#!/usr/bin/env bash
# Video to Text — one-command setup
# Run: bash setup.sh
set -e

echo ""
echo "======================================"
echo "  Video to Text — Setup"
echo "======================================"
echo ""

# ── Check Python ──────────────────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo "ERROR: Python 3 is not installed."
  echo ""
  echo "Install it from: https://www.python.org/downloads/"
  exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "✓ Python $PYTHON_VERSION found"

# ── Check FFmpeg ───────────────────────────────────────────────────────────
if ! command -v ffmpeg &>/dev/null; then
  echo ""
  echo "ERROR: FFmpeg is not installed."
  echo ""
  echo "Install it:"
  echo "  Mac:    brew install ffmpeg"
  echo "  Ubuntu: sudo apt install ffmpeg"
  echo "  Windows: https://ffmpeg.org/download.html"
  exit 1
fi
echo "✓ FFmpeg found: $(ffmpeg -version 2>&1 | head -1 | cut -d' ' -f3)"

# ── Virtual environment ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d ".venv" ]; then
  echo ""
  echo "Creating virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate

# ── Install dependencies ───────────────────────────────────────────────────
echo "Installing dependencies (first time takes 2–5 min)..."
pip install -q setuptools
pip install -q "fastapi==0.115.5" "uvicorn[standard]==0.32.1" \
               "python-multipart==0.0.12" "aiofiles==24.1.0" \
               "openai-whisper==20250625" "ffmpeg-python==0.2.0"

# ── Pre-download Whisper base model ───────────────────────────────────────
echo "Downloading Whisper 'base' model (~145 MB, one-time)..."
python3 -c "import whisper; whisper.load_model('base'); print('✓ Model ready')"

# ── Create shortcut script ─────────────────────────────────────────────────
cat > transcribe_video.sh << 'EOF'
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/.venv/bin/activate"
python3 "$SCRIPT_DIR/transcribe.py" "$@"
EOF
chmod +x transcribe_video.sh

echo ""
echo "======================================"
echo "  Setup complete!"
echo "======================================"
echo ""
echo "Usage:"
echo ""
echo "  ./transcribe_video.sh /path/to/video.mp4"
echo ""
echo "  ./transcribe_video.sh /path/to/video.mp4 --model small"
echo ""
echo "Models: tiny · base (default) · small · medium · large"
echo "Output: .txt file saved next to the video"
echo ""
