# Муха выбрала быть счастливой

Two flies at a bar. Their feelings come from a real FlyWire subgraph; the jokes are the policy on top.

Works fully offline. The 3D, fonts, and CSS are bundled. The only thing it opens is your browser, on localhost.

## Frozen app (no Python)

GitHub Actions builds:

- **Windows x64** — unzip, double-click `DegenerateFly.exe`. A console stays open; close it to stop the server.
- **Apple Silicon macOS** — unzip, right-click `DegenerateFly.app` → Open (unsigned). Quit from the Dock.

Download the zips from the latest [Actions run](https://github.com/damnbrush/DegenerateFly/actions) or from a [Release](https://github.com/damnbrush/DegenerateFly/releases) if a `v*` tag was pushed.

Windows SmartScreen will complain (unsigned). *More info → Run anyway.* macOS Gatekeeper: right-click → Open the first time.

First launch compiles the Numba brain. Give it a minute; the browser opens when the bar is ready.

## From source (Windows)

```
install.bat
start.bat
```

`install.bat` makes `.venv` and installs `requirements.txt`. `start.bat` runs `launch.py` and opens http://127.0.0.1:8000

macOS / Linux from source:

```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python launch.py
```

Rebuilding the connectome subgraph (not needed to play) wants `requirements-dev.txt` and the parquet files in `data/`, then `python build_brains.py`.
