"""Where the game lives — source tree, or a frozen PyInstaller bundle."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def bundle_root() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


def cache_root() -> Path:
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches" / "DegenerateFly"
    elif os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        base = Path(local) / "DegenerateFly" if local else Path.home() / "AppData" / "Local" / "DegenerateFly"
    else:
        xdg = os.environ.get("XDG_CACHE_HOME")
        base = Path(xdg) / "DegenerateFly" if xdg else Path.home() / ".cache" / "DegenerateFly"
    base.mkdir(parents=True, exist_ok=True)
    return base


def prepare_numba() -> Path:
    """Numba JIT-writes a cache. Frozen bundles are often read-only, so park
    it in a writable user folder before `import numba`."""
    dest = cache_root() / "numba"
    dest.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("NUMBA_CACHE_DIR", str(dest))
    return dest
