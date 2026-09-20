"""Open the bar. Frozen builds and start.bat both enter here."""
from __future__ import annotations

import logging
import socket
import sys
import threading
import time
import webbrowser

from paths import cache_root, prepare_numba

prepare_numba()


def attach_stdio(logf) -> None:
    """Frozen --noconsole builds leave stdout/stderr as None. Uvicorn's
    colour formatter then dies on sys.stdout.isatty()."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    stream = open(logf, "a", encoding="utf-8", buffering=1)
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream


def pick_port(start: int = 8000) -> int:
    for p in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return start


def wait_then_open(url: str) -> None:
    import urllib.request

    for _ in range(90):
        try:
            urllib.request.urlopen(url, timeout=1)
            webbrowser.open(url)
            return
        except Exception:
            time.sleep(0.5)


def main() -> None:
    logf = cache_root() / "server.log"
    attach_stdio(logf)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(logf, encoding="utf-8"),
            logging.StreamHandler(sys.stdout),
        ],
    )
    logging.info("Loading brains (first launch compiles the Numba kernel)…")
    from app import app
    import uvicorn

    port = pick_port()
    url = f"http://127.0.0.1:{port}/"
    logging.info("The bar is at %s", url)
    print()
    print(f"  The bar is at  {url}")
    print("  Close this window to stop.")
    print()
    threading.Thread(target=wait_then_open, args=(url,), daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info", use_colors=False)


if __name__ == "__main__":
    main()
