"""Print the pose stream the game produces, so animation bugs are visible
without watching the 3D. (dev tool)

    python trace.py [n_ticks]
"""

from __future__ import annotations

import sys

import app


def main(n: int = 60) -> None:
    bar = app.Bar()
    prev = {"female": "", "male": ""}
    for i in range(n):
        st = bar.tick()
        beat = st["beat"]
        row = []
        for sex in ("female", "male"):
            p = st[sex]
            mark = "" if p["pose"] == prev[sex] else " *"
            prev[sex] = p["pose"]
            row.append(
                f"{sex[0]}:{p['pose']:<6}{mark:<2}"
                f"{'DOWN' if p['fallen'] else '    '} c={p['credits']:<3}"
                f" a={bar.players[sex].alcohol:.2f}"
            )
        h = bar.players[beat["sex"] or "female"].hubs
        print(
            f"{i:3d} {' | '.join(row)}  <- {beat['sex'][:1]} {beat['do']}\n"
            f"      mn9 {h.get('mn9_hz'):>6} MN {h.get('sez_mn_hz'):>6} "
            f"DA {h.get('da'):>5} OA {h.get('oa'):>5} cx {h.get('cx_instability'):.2f} "
            f"lean {h.get('cx_lean'):>6} head {h.get('epg_heading'):>6} "
            f"act {h.get('n_active')} wall {h.get('trial_wall_ms')}ms/{h.get('trial_sim_ms')}ms"
        )


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 60)
