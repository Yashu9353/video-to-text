#!/usr/bin/env bash
# Video to Text — one-command setup
# Installs all dependencies automatically, including FFmpeg and Homebrew if needed.
# Run: bash setup.sh
set -e

echo ""
echo "======================================"
echo "  Video to Text — Setup"
echo "======================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Detect OS ─────────────────────────────────────────────────────────────
OS="$(uname -s)"

# ── Check Python ──────────────────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo "ERROR: Python 3 is not installed."
  echo ""
  if [ "$OS" = "Darwin" ]; then
    echo "Install it by running:  brew install python"
    echo "Or download from:       https://www.python.org/downloads/"
  else
    echo "Install it:  sudo apt install python3 python3-venv python3-pip"
  fi
  exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "✓ Python $PYTHON_VERSION found"

# ── Install FFmpeg automatically if missing ───────────────────────────────
if ! command -v ffmpeg &>/dev/null; then
  echo ""
  echo "FFmpeg not found — installing automatically..."
  echo ""

  if [ "$OS" = "Darwin" ]; then
    # macOS — use Homebrew (install Homebrew first if also missing)
    if ! command -v brew &>/dev/null; then
      echo "Installing Homebrew (package manager for Mac)..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

      # Add brew to PATH for Apple Silicon Macs
      if [ -f "/opt/homebrew/bin/brew" ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
      fi
    fi

    echo "Installing FFmpeg via Homebrew..."
    brew install ffmpeg

  elif command -v apt-get &>/dev/null; then
    # Debian / Ubuntu
    echo "Installing FFmpeg via apt..."
    sudo apt-get update -qq && sudo apt-get install -y ffmpeg

  elif command -v yum &>/dev/null; then
    # CentOS / RHEL / Fedora (older)
    echo "Installing FFmpeg via yum..."
    sudo yum install -y epel-release
    sudo yum install -y ffmpeg

  elif command -v dnf &>/dev/null; then
    # Fedora (newer)
    echo "Installing FFmpeg via dnf..."
    sudo dnf install -y ffmpeg

  else
    echo "Could not auto-install FFmpeg on this system."
    echo ""
    echo "Please install it manually:"
    echo "  Mac:    brew install ffmpeg"
    echo "  Ubuntu: sudo apt install ffmpeg"
    echo "  Other:  https://ffmpeg.org/download.html"
    exit 1
  fi
fi

echo "✓ FFmpeg $(ffmpeg -version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) found"

# ── Virtual environment ────────────────────────────────────────────────────
echo ""
if [ ! -d ".venv" ]; then
  echo "Creating Python virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate
echo "✓ Virtual environment ready"

# ── Install Python packages ────────────────────────────────────────────────
echo ""
echo "Installing Python packages (first time: 2–5 min, ~2 GB with PyTorch)..."
pip install -q --upgrade pip setuptools
pip install -q \
  "fastapi==0.115.5" \
  "uvicorn[standard]==0.32.1" \
  "python-multipart==0.0.12" \
  "aiofiles==24.1.0" \
  "openai-whisper==20250625" \
  "ffmpeg-python==0.2.0"
echo "✓ Python packages installed"

# ── Download Whisper model ─────────────────────────────────────────────────
echo ""
echo "Downloading Whisper 'base' model (~145 MB, one-time)..."
python3 -c "import whisper; whisper.load_model('base'); print('✓ Whisper model ready')"

# ── Create easy-run shortcut ───────────────────────────────────────────────
cat > transcribe_video.sh << 'EOF'
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/.venv/bin/activate"
python3 "$SCRIPT_DIR/transcribe.py" "$@"
EOF
chmod +x transcribe_video.sh

# ── Done ──────────────────────────────────────────────────────────────────
echo ""
echo "======================================"
echo "  All done! Ready to use."
echo "======================================"
echo ""
echo "Transcribe a video:"
echo ""
echo "  ./transcribe_video.sh /path/to/video.mp4"
echo ""
echo "Choose a model (better quality = slower):"
echo ""
echo "  ./transcribe_video.sh /path/to/video.mp4 --model small"
echo "  ./transcribe_video.sh /path/to/video.mp4 --model medium"
echo ""
echo "Models:  tiny · base (default) · small · medium · large"
echo "Output:  .txt file saved next to the video"
echo ""
