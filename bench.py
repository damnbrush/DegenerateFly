"""How fast is the LIF on this machine, and is it doing anything? (dev tool)

    python bench.py
"""

from __future__ import annotations

import os
import time

import numpy as np

import connectome as C


def main() -> None:
    print(f"cores={os.cpu_count()}  numba threads={__import__('numba').config.NUMBA_NUM_THREADS}")
    t0 = time.perf_counter()
    pair = C.PairOfFlies()
    print(f"load+compile {1000 * (time.perf_counter() - t0):.0f} ms")
    for k, v in pair.meta.items():
        print(f"  {k}: {v}")

    # the recipe the game actually runs, so this is a smoke test and not a
    # measurement of a regime we deliberately left behind
    import app

    recipe = {
        "sugar_grn": app.SUGAR_HZ, "epg": app.EPG_TONIC,
        "dna02": app.DNA02_TONIC, "dng13": app.DNG13_TONIC,
    }
    for sex in ("female", "male"):
        b = pair.get(sex)
        print(f"\n-- {sex}: n={b.n} edges={len(b.post)}")
        for t_ms in (app.AMBIENT_MS, app.T_MS):
            walls = []
            for _ in range(5):
                r = b.drive_roles(recipe, t_ms=t_ms)
                walls.append(r.elapsed_ms)
            b.step_modulators(t_ms)
            h = b.hubs()
            print(
                f"  t_sim={t_ms:.0f}ms  wall={np.median(walls):.0f}ms "
                f"({t_ms / np.median(walls):.2f}x realtime)  spikes={r.n_spikes}"
            )
            print(
                f"     active={int((r.rates_hz > 0.5).sum())}/{b.n}  "
                f"sugar={h['sez_sugar_hz']}Hz mn9={h['mn9_hz']}Hz pam={h['mb_reward_hz']}Hz "
                f"ppl1={h['mb_aversion_hz']}Hz dna02={h['cx_dna02_hz']}Hz epg={h['epg_hz']}Hz "
                f"da={h['da']} oa={h['oa']}"
            )

    # silence check: with no drive the network must not invent its own spikes
    b = pair.female
    b.reset_state()
    r = b.drive_roles({}, t_ms=300.0)
    print(f"\nsilence: spikes={r.n_spikes} (should be 0)")

    # sugar should feed and charge DA; bitter should cut the feeding and charge OA
    b.reset_state()
    b.drive_roles({**recipe}, t_ms=app.T_MS)
    b.step_modulators(app.T_MS)
    sweet = b.hubs()
    b.drive_roles({**recipe, "bitter_grn": app.BITTER_HZ}, t_ms=app.T_MS)
    b.step_modulators(app.T_MS)
    sour = b.hubs()
    print(
        f"sugar : mn9 {sweet['mn9_hz']:6.1f} Hz  da {sweet['da']:.2f}  oa {sweet['oa']:.2f}\n"
        f"bitter: mn9 {sour['mn9_hz']:6.1f} Hz  da {sour['da']:.2f}  oa {sour['oa']:.2f}  "
        f"feeding cut by {sour['feed_block_hz']:.0f} Hz"
    )


if __name__ == "__main__":
    main()
