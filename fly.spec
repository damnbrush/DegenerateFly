# -*- mode: python ; coding: utf-8 -*-
"""Frozen bar: Windows onedir exe, macOS .app. Built on each OS in CI."""
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = Path(SPECPATH)

numba_d, numba_b, numba_h = collect_all("numba")
llvm_d, llvm_b, llvm_h = collect_all("llvmlite")

hidden = (
    collect_submodules("uvicorn")
    + numba_h
    + llvm_h
    + [
        "app",
        "connectome",
        "paths",
        "anyio._backends._asyncio",
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
    ]
)

datas = [
    (str(ROOT / "index.html"), "."),
    (str(ROOT / "stage.js"), "."),
    (str(ROOT / "fly.js"), "."),
    (str(ROOT / "preview.html"), "."),
    (str(ROOT / "data" / "brains.npz"), "data"),
    (str(ROOT / "vendor"), "vendor"),
] + numba_d + llvm_d

a = Analysis(
    [str(ROOT / "launch.py")],
    pathex=[str(ROOT)],
    binaries=numba_b + llvm_b,
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pandas", "pyarrow", "tkinter", "matplotlib", "IPython", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="DegenerateFly",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # Windows: a console you can close to stop the bar. macOS keeps a
    # windowed .app; quit from the Dock.
    console=sys.platform != "darwin",
    disable_windowed_traceback=False,
    argv_emulation=sys.platform == "darwin",
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="DegenerateFly",
)

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="DegenerateFly.app",
        icon=None,
        bundle_identifier="com.damnbrush.degeneratefly",
        info_plist={
            "CFBundleName": "Degenerate Fly",
            "CFBundleDisplayName": "Degenerate Fly",
            "CFBundleShortVersionString": "1.0.0",
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "12.0",
        },
    )
