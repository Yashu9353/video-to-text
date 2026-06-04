#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Create a virtual environment if it doesn't exist
if [ ! -d ".venv" ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate

echo "Installing dependencies (first run may take a few minutes)..."
pip install -q "fastapi==0.115.5" "uvicorn[standard]==0.32.1" "python-multipart==0.0.12" "aiofiles==24.1.0" "openai-whisper==20250625" "ffmpeg-python==0.2.0"

echo ""
echo "Starting Video to Text Transcriber..."
echo "Open your browser at: http://localhost:8000"
echo "Press Ctrl+C to stop."
echo ""

cd src
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
