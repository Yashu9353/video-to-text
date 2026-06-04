# PyInstaller spec file — builds "Video to Text" as a one-folder app
# Run:  pyinstaller app.spec

import sys
import os
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

ROOT = Path(SPECPATH)   # project root (where this .spec lives)

# ── Collect all data files needed at runtime ─────────────────────────────────
datas = [
    # Web UI
    (str(ROOT / "static"),  "static"),
    # Python source modules
    (str(ROOT / "src"),     "src"),
]

# whisper ships its own mel filterbank + multilingual model assets
datas += collect_data_files("whisper")

# tiktoken needs its encoding files
datas += collect_data_files("tiktoken", includes=["**/*.tiktoken"])

# ── Hidden imports that PyInstaller misses ────────────────────────────────────
hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "fastapi",
    "fastapi.middleware",
    "aiofiles",
    "multipart",
    "whisper",
    "torch",
    "tiktoken",
    "tiktoken_ext",
    "tiktoken_ext.openai_public",
    "numba",
    "llvmlite",
]

# ── Binary: bundle the system FFmpeg so the app works without it installed ────
import shutil
ffmpeg_bin = shutil.which("ffmpeg")
ffprobe_bin = shutil.which("ffprobe")
binaries = []
if ffmpeg_bin:
    binaries.append((ffmpeg_bin,  "."))   # place in bundle root
if ffprobe_bin:
    binaries.append((ffprobe_bin, "."))

a = Analysis(
    [str(ROOT / "launcher.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["matplotlib", "PIL", "cv2", "scipy", "sklearn", "pandas"],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="VideoToText",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,       # keep console so user can see progress / errors
    icon=None,          # add an .icns / .ico here if you have one
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="VideoToText",
)

# ── macOS: wrap in a .app bundle ─────────────────────────────────────────────
if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="VideoToText.app",
        bundle_identifier="com.yashu.videototext",
        info_plist={
            "CFBundleShortVersionString": "1.0.0",
            "CFBundleName": "Video to Text",
            "NSHighResolutionCapable": True,
        },
    )
