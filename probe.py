"""Measurements the model tuning rests on. (dev tool)

    python probe.py graph     what the subgraph can and cannot reach
    python probe.py sweep     synaptic gain x sensor drive: finds the cliff
    python probe.py ei        can scaling inhibition fix the cliff? (no)
    python probe.py brake     the global gain control, at a given setting
    python probe.py fru       how much fru drive the male can take
    python probe.py drift     does state carried across beats latch?
    python probe.py heading   does an asymmetric ring drive move the compass?

Findings, in short:

* The subgraph is bistable. Below ~100 Hz on the sensors it is sparse (about
  4% of cells firing) and the sugar -> MN9 feeding path grades cleanly. Above
  that it seizes: ~38% firing, every population pinned at its refractory
  ceiling, and sugar indistinguishable from bitter. The game used to run at
  200 Hz, i.e. inside the seizure, which is why PAM, PPL1 and DNa02 all read
  as busy and none of it meant anything.

* The cause is the cut, not the equations. Hop expansion from the sensors
  keeps excitatory paths much better than the local inhibitory surround, so
  the recurrent excitatory mass has no brake. Scaling all inhibition up does
  stop the runaway, but it also silences the feeding pathway, which was E/I
  balanced to begin with and is the part worth having. See `ei`.

* So: physiological drive plus one brain-wide divisive gain control that is
  exactly inert at physiological rates. See `brake`.

* EPG receives 2:1 net inhibition in here, because the ring attractor's
  recurrent excitation lives in cells that were not kept. Without a tonic it
  can never fire and the compass reads 0.00 forever; with one, the heading
  tracks an asymmetric drive linearly. See `heading`.

* PAM and PPL1 stay at whatever they are given, so they are not read.

* Every beat must start from rest. Carry membrane state across beats and after
  about six seconds of sugar the graph latches into a self-sustaining state
  that never releases, with MN9 dead for the rest of the session. See `drift`.
"""

from __future__ import annotations

import sys

import numpy as np

import app
import connectome as C

TONIC = {"epg": app.EPG_TONIC, "dna02": app.DNA02_TONIC, "dng13": app.DNG13_TONIC}
RECIPE = {**TONIC, "sugar_grn": app.SUGAR_HZ}
READ = ("feeding_mn", "pam", "ppl1", "npf", "dna02", "dng13", "epg", "pfl")


def stats(b: C.FlyBrain, r: C.TrialResult) -> dict[str, float]:
    rates = r.rates_hz
    out = {
        k: (float(rates[b.role_index[k]].mean()) if len(b.role_index.get(k, ())) else 0.0)
        for k in READ
    }
    out["mn9"] = b.mn9_hz()
    out["act"] = float((rates > 0.5).mean()) * 100
    out["pop"] = r.n_spikes / ((r.sim_ms / C.DT) * b.n)
    out["wall"] = r.elapsed_ms
    return out


def trial(b: C.FlyBrain, roles: dict[str, float], t_ms: float = 500.0) -> dict[str, float]:
    return stats(b, b.drive_roles(roles, t_ms=t_ms))


# --------------------------------------------------------------------------- #


def graph(pair: C.PairOfFlies) -> None:
    b = pair.female
    ri, n, ptr, post = b.role_index, b.n, b.ptr, b.post

    print("-- can the sensors reach each readout at all? (BFS)")
    dist = -np.ones(n, dtype=np.int32)
    frontier = list(ri["sugar_grn"])
    dist[frontier] = 0
    for d in range(1, 9):
        nxt = []
        for i in frontier:
            for e in range(ptr[i], ptr[i + 1]):
                if dist[post[e]] < 0:
                    dist[post[e]] = d
                    nxt.append(post[e])
        frontier = nxt
        if not frontier:
            break
    for role in READ:
        ds = dist[ri[role]]
        ok = ds[ds >= 0]
        print(f"  {role:<11} {len(ri[role]):>5} cells, reachable {len(ok):>5}"
              + (f", min {ok.min()} hops" if len(ok) else ""))

    print("\n-- and is what they receive in here excitatory or inhibitory?")
    for role in READ:
        ix = set(int(i) for i in ri[role])
        ww = b.w[np.fromiter((j in ix for j in post), bool, len(post))]
        print(f"  {role:<11} exc {float(ww[ww > 0].sum()):9.1f}  inh {float(ww[ww < 0].sum()):9.1f}"
              f"  net {float(ww.sum()):9.1f}")

    print("\n-- what actually fires on the shipped recipe")
    s = trial(b, RECIPE)
    print(f"  {s['act']:.2f}% active, mn9 {s['mn9']:.0f} Hz, "
          + ", ".join(f"{k} {s[k]:.1f}" for k in READ))


def sweep(pair: C.PairOfFlies) -> None:
    b = pair.female
    base = b.w.copy()
    print(f"{'W_SYN':>7} {'sugar':>6} | {'act%':>6} {'mn9':>6} {'MN':>6} {'PAM':>6} {'PPL1':>6} | {'wall':>6}")
    for scale in (1.0, 1.6, 2.2, 3.0, 4.0):
        b.w[:] = base * scale
        for hz in (40.0, 80.0, 120.0, 200.0):
            s = trial(b, {**TONIC, "sugar_grn": hz})
            print(f"{C.W_SYN * scale:7.3f} {hz:6.0f} | {s['act']:6.2f} {s['mn9']:6.1f} "
                  f"{s['feeding_mn']:6.1f} {s['pam']:6.1f} {s['ppl1']:6.1f} | {s['wall']:6.0f}")
        print()
    b.w[:] = base


def ei(pair: C.PairOfFlies) -> None:
    print(f"{'inh x':>6} {'sugar':>6} | {'act% over 5 runs':>26} {'mn9':>6} {'MN':>6} | {'MN|bitter':>10}")
    for b in (pair.female, pair.male):
        print(f"\n-- {b.sex}")
        base = b.w.copy()
        neg = base < 0
        for gain in (1.0, 1.5, 2.0, 3.0):
            b.w[:] = base
            b.w[neg] = base[neg] * gain
            for hz in (80.0, 120.0, 200.0):
                runs = [trial(b, {**TONIC, "sugar_grn": hz}) for _ in range(5)]
                both = trial(b, {**TONIC, "sugar_grn": hz, "bitter_grn": app.BITTER_HZ})
                print(f"{gain:6.1f} {hz:6.0f} | {' '.join(f'{r['act']:5.1f}' for r in runs):>26} "
                      f"{np.median([r['mn9'] for r in runs]):6.1f} "
                      f"{np.median([r['feeding_mn'] for r in runs]):6.1f} | {both['feeding_mn']:10.1f}")
            print()
        b.w[:] = base


def brake(pair: C.PairOfFlies) -> None:
    """probe.py brake [gain] [target] [decay]"""
    for i, name in enumerate(("BRAKE_GAIN", "BRAKE_TARGET", "BRAKE_DECAY"), start=2):
        if len(sys.argv) > i:
            setattr(C, name, float(sys.argv[i]))
    print(f"gain={C.BRAKE_GAIN} target={C.BRAKE_TARGET:.2e} decay={C.BRAKE_DECAY}\n"
          "the shipped recipe must read as inert here, and nothing may seize")
    cases = (
        ("silent    ", {}),
        ("tonic     ", TONIC),
        ("sugar 80  ", RECIPE),
        ("sugar 120 ", {**TONIC, "sugar_grn": 120.0}),
        ("sugar 200 ", {**TONIC, "sugar_grn": 200.0}),
        ("bitter    ", {**TONIC, "bitter_grn": app.BITTER_HZ}),
        ("both      ", {**RECIPE, "bitter_grn": app.BITTER_HZ}),
        ("fru 8     ", {**RECIPE, "fru": 8.0}),
        ("everything", {**TONIC, "sugar_grn": 200.0, "bitter_grn": 200.0, "fru": 20.0}),
    )
    for b in (pair.female, pair.male):
        print(f"\n-- {b.sex}")
        for label, roles in cases:
            runs = [trial(b, roles) for _ in range(4)]
            print(f"  {label} act {' '.join(f'{r['act']:5.2f}' for r in runs)}%  "
                  f"pop {np.median([r['pop'] for r in runs]):.2e}  "
                  f"mn9 {np.median([r['mn9'] for r in runs]):6.1f}  "
                  f"MN {np.median([r['feeding_mn'] for r in runs]):6.1f}  "
                  f"wall {np.median([r['wall'] for r in runs]):5.0f}ms")


def fru(pair: C.PairOfFlies) -> None:
    b = pair.male
    print(f"{len(b.role_index['fru'])} fru cells, so this is per-cell and adds up fast")
    for hz in (0.0, 0.5, 0.9, 2.0, 4.0, 8.0):
        s = trial(b, {**RECIPE, "fru": hz})
        print(f"  fru {hz:4.1f} Hz -> act {s['act']:5.2f}%  mn9 {s['mn9']:6.1f}  wall {s['wall']:5.0f}ms")


def drift(pair: C.PairOfFlies) -> None:
    b = pair.female
    b.reset_state()
    print("twenty back-to-back sugar beats; mn9 must not walk off")
    for i in range(20):
        s = trial(b, RECIPE, t_ms=app.T_MS)
        print(f"  beat {i:2d}  mn9 {s['mn9']:6.1f}  MN {s['feeding_mn']:6.1f}  "
              f"act {s['act']:5.2f}%  wall {s['wall']:5.0f}ms")


def heading(pair: C.PairOfFlies) -> None:
    b = pair.female
    ix = b.role_index["epg"]
    print(f"{int((b.side[ix] == 'left').sum())} left EPG, {int((b.side[ix] == 'right').sum())} right")
    for bias in (-0.6, -0.3, 0.0, 0.3, 0.6):
        b.drive_roles(RECIPE, t_ms=app.T_MS, side_bias={"epg": bias})
        h = b.hubs()
        el, er = b._side_hz("epg")
        print(f"  bias {bias:+.2f} -> EPG L {el:6.1f} R {er:6.1f}  "
              f"heading {h['epg_heading']:+.3f}  lean {h['cx_lean']:+.3f}")


CHECKS = {f.__name__: f for f in (graph, sweep, ei, brake, fru, drift, heading)}


def main() -> None:
    which = sys.argv[1] if len(sys.argv) > 1 else ""
    if which not in CHECKS:
        print(__doc__)
        return
    CHECKS[which](C.PairOfFlies())


if __name__ == "__main__":
    main()
