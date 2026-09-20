"""
Shiu-style leaky integrate-and-fire on the local FlyWire subgraph.

Equations (Shiu et al., Nature 2024 Methods):

    dv/dt = (v_0 - v + g) / T_mbr
    dg/dt = -g / tau
    on spike: v <- v_rst; g <- 0; refractory T_rfc
    delayed synapse: g_post += (Excitatory x Connectivity) * W_syn

Slow dopamine / octopamine-like pools (Aso/Waddell-style) sit *next to*
the LIF: sugar GRN spikes charge DA; bitter / PPL1 charge OA. We do not
Poisson-clamp PAM to fake joy.

The inner loop is Numba. Same constants, just not a Python `for` over spikes.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from paths import bundle_root, prepare_numba

prepare_numba()
from numba import njit

DATA = bundle_root() / "data" / "brains.npz"

V_REST = -52.0
V_THRESH = -45.0
V_RESET = -52.0
T_MBR = 20.0
TAU_SYN = 5.0
T_RFC = 2.2
T_DELAY = 1.8
W_SYN = 0.275
F_POI = 250.0
DT = 0.1
DEFAULT_HZ = 200.0
DEFAULT_T = 450.0
TAU_DA = 900.0
TAU_OA = 1100.0

# What the stimulus is, versus what stands in for circuitry outside the
# subgraph. EPG needs it most: in here it receives 2:1 net inhibition, because
# the ring attractor's recurrent excitation lives in cells we did not keep, so
# without a tonic it can never fire and the compass reads 0.00 forever.
SENSOR_ROLES = ("sugar_grn", "bitter_grn")
TONIC_ROLES = ("epg", "dna02", "dng13")

# Brain-wide gain control. Hop expansion from the sensors keeps excitatory
# paths much better than it keeps the local inhibitory surround, which leaves
# this subgraph bistable: identical settings land on 2% of cells firing or 40%
# depending on the random seed, and in the 40% case every population pins at
# its refractory ceiling and sugar stops being distinguishable from bitter.
# Scaling all inhibition up fixes the runaway but also silences the feeding
# pathway, which is E/I balanced already and is the part we actually want
# (probe.py ei). So instead: one global term that is exactly zero while
# the population rate is physiological and clamps hard above it.
# BRAKE_TARGET is in spikes per neuron per 0.1 ms step — 5e-4 is ~5 Hz mean,
# an order of magnitude above the sparse regime and an order below a seizure.
BRAKE_GAIN = 20000.0
BRAKE_TARGET = 2.0e-4
BRAKE_DECAY = 0.96


def _csr(pre: np.ndarray, post: np.ndarray, w: np.ndarray, n: int):
    order = np.argsort(pre, kind="mergesort")
    pre, post, w = pre[order], post[order], w[order]
    counts = np.bincount(pre, minlength=n)
    ptr = np.zeros(n + 1, dtype=np.int32)
    np.cumsum(counts, out=ptr[1:])
    return ptr, post.astype(np.int32), (w.astype(np.float32) * W_SYN)


@njit(cache=True, fastmath=True, nogil=True)
def _lif_loop(
    steps: int,
    n: int,
    v: np.ndarray,
    g: np.ndarray,
    rfc: np.ndarray,
    delay: np.ndarray,
    dslot: int,
    ptr: np.ndarray,
    post: np.ndarray,
    w: np.ndarray,
    p_spike: np.ndarray,
    spikes: np.ndarray,
    fired: np.ndarray,
    v_rest: float,
    v_thresh: float,
    v_reset: float,
    leak: float,
    gdec: float,
    kick: float,
    t_rfc: float,
    dt: float,
    brake_gain: float,
    brake_target: float,
    brake_decay: float,
) -> int:
    """nogil so the two flies can be stepped on two cores at once.

    One pass per step, not two: draining the delay slot into `g` and
    integrating `v` touch the same cache lines, and every neuron is
    independent within a step, so splitting them just doubled the traffic
    over a 26k-element array 3000 times per trial.
    """
    delay_n = delay.shape[0]
    act = 0.0        # population rate estimate, spikes per neuron per step
    inv_n = 1.0 / n
    for _ in range(steps):
        slot = dslot
        nf = 0
        # Divisive, not subtractive: in a runaway the summed synaptic input on
        # a hub neuron is hundreds of mV, so any fixed offset is noise. This
        # is exactly 1.0 while the population rate is physiological.
        excess = act - brake_target
        gscale = 1.0 if excess <= 0.0 else 1.0 / (1.0 + brake_gain * excess)
        for i in range(n):
            g[i] += delay[slot, i]
            delay[slot, i] = 0.0
            if rfc[i] <= 0.0:
                v[i] += leak * (v_rest - v[i] + g[i] * gscale)
                g[i] *= gdec
            else:
                rfc[i] -= dt
            if p_spike[i] > 0.0 and np.random.random() < p_spike[i]:
                v[i] += kick
                rfc[i] = 0.0
            if v[i] > v_thresh:
                spikes[i] += 1
                v[i] = v_reset
                g[i] = 0.0
                rfc[i] = t_rfc
                fired[nf] = i
                nf += 1
        # Scatter after the sweep, so a spike never reaches a neuron that has
        # not been integrated yet this step. T_DELAY puts it in a later slot
        # anyway; doing it here just keeps the hot loop branch-light.
        for k in range(nf):
            i = fired[k]
            for e in range(ptr[i], ptr[i + 1]):
                delay[slot, post[e]] += w[e]
        act = act * brake_decay + (1.0 - brake_decay) * (nf * inv_n)
        dslot = (slot + 1) % delay_n
    return dslot


@dataclass
class TrialResult:
    rates_hz: np.ndarray
    n_spikes: int
    elapsed_ms: float
    sim_ms: float


class FlyBrain:
    def __init__(
        self,
        ids: np.ndarray,
        ptr: np.ndarray,
        post: np.ndarray,
        w: np.ndarray,
        role_index: dict[str, np.ndarray],
        names: np.ndarray,
        dimorphism: np.ndarray,
        side: np.ndarray,
        sex: str,
        mn9_id: int = 0,
    ) -> None:
        self.sex = sex
        self.ids = ids
        self.n = len(ids)
        self.ptr, self.post, self.w = ptr, post, w
        self.role_index = role_index
        self.names = names
        self.dimorphism = dimorphism
        self.side = side
        self.v = np.full(self.n, V_REST, dtype=np.float32)
        self.g = np.zeros(self.n, dtype=np.float32)
        self.rfc = np.zeros(self.n, dtype=np.float32)
        delay_steps = max(1, int(round(T_DELAY / DT)))
        self._delay = np.zeros((delay_steps, self.n), dtype=np.float32)
        self._dslot = 0
        self.last: TrialResult | None = None
        self.da = 0.0
        self.oa = 0.0
        self.feed_ceiling = 0.0
        self.feed_block = 0.0
        self.last_drive: dict[str, float] = {}
        try:
            self.mn9_i = int(np.where(ids == mn9_id)[0][0])
        except IndexError:
            self.mn9_i = -1

    def reset_lif(self) -> None:
        """Back to rest, keeping the slow pools.

        Every beat is an independent trial, which is how the Shiu protocol is
        run and, here, the only way it stays honest: carry membrane state from
        one beat to the next and after about six seconds of sugar the subgraph
        latches into a self-sustaining state that never lets go, with the
        feeding motor neuron dead for the rest of the session (probe.py drift). The
        latch is real recurrence in the graph, not stale buffers. Continuity
        across beats belongs to the DA/OA pools, which are slow by design.
        """
        self.v.fill(V_REST)
        self.g.fill(0.0)
        self.rfc.fill(0.0)
        self._delay.fill(0.0)
        self._dslot = 0

    def reset_state(self) -> None:
        self.reset_lif()
        self.da = 0.0
        self.oa = 0.0
        self.feed_ceiling = 0.0
        self.feed_block = 0.0
        self.last_drive = {}

    def drive_roles(
        self,
        rates: dict[str, float],
        t_ms: float = DEFAULT_T,
        side_bias: dict[str, float] | None = None,
    ) -> TrialResult:
        """Drive named populations. `side_bias[role]` in -1..1 tilts a role's
        rate toward the right hemisphere, which is how a heading command is
        handed to the EPG ring."""
        hz = np.zeros(self.n, dtype=np.float32)
        self.last_drive = {k: float(v) for k, v in rates.items() if v}
        bias = side_bias or {}
        for role, rate in rates.items():
            ix = self.role_index.get(role)
            if ix is None or not len(ix) or not rate:
                continue
            b = float(bias.get(role, 0.0))
            if b:
                sides = self.side[ix]
                hz[ix[sides == "left"]] = float(rate) * (1.0 - b)
                hz[ix[sides == "right"]] = float(rate) * (1.0 + b)
                hz[ix[(sides != "left") & (sides != "right")]] = float(rate)
            else:
                hz[ix] = float(rate)
        return self.run(drive_hz=hz, t_ms=t_ms)

    def run(
        self,
        drive: np.ndarray | None = None,
        hz: float = DEFAULT_HZ,
        t_ms: float = DEFAULT_T,
        rng: np.random.Generator | None = None,
        drive_hz: np.ndarray | None = None,
    ) -> TrialResult:
        self.reset_lif()
        steps = int(round(t_ms / DT))
        spikes = np.zeros(self.n, dtype=np.int32)
        fired = np.empty(self.n, dtype=np.int32)
        if drive_hz is None:
            drive_hz = np.zeros(self.n, dtype=np.float32)
            if drive is not None:
                drive_hz[np.asarray(drive, dtype=bool)] = float(hz)
        p_spike = (drive_hz.astype(np.float32) * np.float32(DT / 1000.0)).astype(np.float32)
        t0 = time.perf_counter()
        self._dslot = _lif_loop(
            steps, self.n, self.v, self.g, self.rfc, self._delay, self._dslot,
            self.ptr, self.post, self.w, p_spike, spikes, fired,
            np.float32(V_REST), np.float32(V_THRESH), np.float32(V_RESET),
            np.float32(DT / T_MBR), np.float32(np.exp(-DT / TAU_SYN)),
            np.float32(W_SYN * F_POI), np.float32(T_RFC), np.float32(DT),
            np.float32(BRAKE_GAIN), np.float32(BRAKE_TARGET), np.float32(BRAKE_DECAY),
        )
        elapsed = (time.perf_counter() - t0) * 1000.0
        rates = spikes.astype(np.float32) * (1000.0 / max(t_ms, 1.0))
        self.last = TrialResult(rates, int(spikes.sum()), elapsed, t_ms)
        return self.last

    def step_modulators(self, t_ms: float, da_boost: float = 0.0, oa_boost: float = 0.0) -> None:
        """Slow DA/OA, charged by what the subgraph actually computes.

        Not by the DANs. PAM and PPL1 are in the graph, but the recurrence
        that sustains them is not, so they only ever echo back whatever is
        injected into them (measured in probe.py graph). The feeding output and the
        bitter GRNs are genuinely simulated, so reward rides on the feeding
        output and aversion on bitter plus the measured suppression of feeding.
        """
        mn9 = self.mn9_hz()
        mn = self._mean_hz("feeding_mn")
        bitter = self._mean_hz("bitter_grn")
        if bitter < 1.0:
            # a clean sugar trial: remember how hard this fly can feed
            self.feed_ceiling = max(self.feed_ceiling * 0.985, mn9)
            self.feed_block = 0.0
        else:
            self.feed_block = max(0.0, self.feed_ceiling - mn9)
        dt = t_ms / 1000.0
        self.da += dt * (0.0075 * mn9 + 0.006 * mn) + da_boost
        self.oa += dt * (0.010 * bitter + 0.006 * self.feed_block) + oa_boost
        self.da *= math.exp(-t_ms / TAU_DA)
        self.oa *= math.exp(-t_ms / TAU_OA)
        self.da = float(min(1.4, max(0.0, self.da)))
        self.oa = float(min(1.4, max(0.0, self.oa)))

    def mn9_hz(self) -> float:
        rates = self.last.rates_hz if self.last is not None else np.zeros(self.n)
        return float(rates[self.mn9_i]) if self.mn9_i >= 0 else self._mean_hz("feeding_mn")

    def _mean_hz(self, role: str) -> float:
        ix = self.role_index.get(role)
        if ix is None or len(ix) == 0:
            return 0.0
        rates = self.last.rates_hz if self.last is not None else np.zeros(self.n)
        return float(rates[ix].mean())

    def _side_hz(self, role: str) -> tuple[float, float]:
        ix = self.role_index.get(role, np.array([], dtype=np.int32))
        rates = self.last.rates_hz if self.last is not None else np.zeros(self.n)
        if len(ix) < 2:
            return 0.0, 0.0
        sides = self.side[ix]
        left = float(rates[ix[sides == "left"]].mean()) if np.any(sides == "left") else 0.0
        right = float(rates[ix[sides == "right"]].mean()) if np.any(sides == "right") else 0.0
        return left, right

    def hubs(self) -> dict[str, float]:
        def nrm(hz: float, cap: float = 80.0) -> float:
            return float(max(0.0, min(1.0, hz / cap)))

        sugar = self._mean_hz("sugar_grn")
        bitter = self._mean_hz("bitter_grn")
        mn = self._mean_hz("feeding_mn")
        pam = self._mean_hz("pam")
        ppl = self._mean_hz("ppl1")
        npf = self._mean_hz("npf")
        dna = self._mean_hz("dna02")
        dng = self._mean_hz("dng13")
        epg = self._mean_hz("epg")
        fru = self._mean_hz("fru")
        rates = self.last.rates_hz if self.last is not None else np.zeros(self.n)
        mn9 = self.mn9_hz()

        dna_l, dna_r = self._side_hz("dna02")
        epg_l, epg_r = self._side_hz("epg")
        see_saw = abs(dna_r - dna_l) if (dna_l + dna_r) > 0 else dna
        lean = (dna_r - dna_l) / (abs(dna_l) + abs(dna_r) + 1e-3)
        heading = (epg_r - epg_l) / (abs(epg_l) + abs(epg_r) + 1e-3)

        sez = nrm(0.35 * sugar + 0.90 * mn + 0.40 * mn9, cap=50.0)
        cx = nrm(0.55 * see_saw + 0.25 * dng + 0.25 * abs(heading) * 40 + 0.15 * mn, cap=40.0)
        joy = min(1.0, self.da / 1.15)
        ouch = min(1.0, self.oa / 1.15)

        # Keep the two kinds of input apart in the readout. Sensors are the
        # real stimulus; the tonic entries stand in for loops that live
        # outside the subgraph, and saying so is the honest thing to show.
        sens = ", ".join(f"{k} {v:.0f} Гц" for k, v in self.last_drive.items() if k in SENSOR_ROLES)
        tonic = ", ".join(f"{k} {v:.0f} Гц" for k, v in self.last_drive.items() if k in TONIC_ROLES)
        driven = sens or "тишина"
        return {
            "in_sensors": sens or "тишина",
            "in_tonic": tonic,
            "active_frac": round(float((rates > 0.5).mean()), 4),
            "n_active": int((rates > 0.5).sum()),
            "feed_ceiling_hz": round(self.feed_ceiling, 2),
            "feed_block_hz": round(self.feed_block, 2),
            "sez_potential": sez,
            "sez_sugar_hz": round(sugar, 2),
            "sez_mn_hz": round(mn, 2),
            "mn9_hz": round(mn9, 2),
            "mb_reward": joy,
            "mb_reward_hz": round(pam, 2),
            "mb_aversion": ouch,
            "mb_aversion_hz": round(ppl, 2),
            "da": round(self.da, 3),
            "oa": round(self.oa, 3),
            "cx_instability": float(max(0.0, min(1.0, cx))),
            "cx_dna02_hz": round(dna, 2),
            "cx_dng13_hz": round(dng, 2),
            "cx_see_saw_hz": round(float(see_saw), 2),
            "cx_lean": round(float(lean), 3),
            "epg_hz": round(epg, 2),
            "epg_heading": round(float(heading), 3),
            "npf_stress": nrm(npf, cap=30.0),
            "npf_hz": round(npf, 2),
            "bitter_hz": round(bitter, 2),
            "fru_hz": round(fru, 2),
            "n_spikes": int(self.last.n_spikes) if self.last else 0,
            "trial_wall_ms": round(self.last.elapsed_ms, 1) if self.last else 0.0,
            "trial_sim_ms": round(self.last.sim_ms, 1) if self.last else 0.0,
            "in_drive": driven,
        }

    def drive_mask(self, role: str) -> np.ndarray:
        m = np.zeros(self.n, dtype=bool)
        ix = self.role_index.get(role)
        if ix is not None and len(ix):
            m[ix] = True
        return m


class PairOfFlies:
    def __init__(self, path: Path = DATA) -> None:
        if not path.is_file():
            raise FileNotFoundError(f"{path} missing. Run: python build_brains.py")
        z = np.load(path, allow_pickle=True)
        self.ids = z["ids"]
        self.names = z["names"]
        self.dimorphism = z["dimorphism"]
        self.side = z["side"]
        self.role_names = [str(x) for x in z["role_names"].tolist()]
        role_mat = z["role_mat"]
        self.role_index_full = {
            name: np.flatnonzero(role_mat[:, j]) for j, name in enumerate(self.role_names)
        }
        ptr, post, w = _csr(z["pre"], z["post"], z["w_signed"], len(self.ids))
        mn9 = int(z["shiu_mn9"])
        self.female = FlyBrain(
            self.ids, ptr, post, w, self.role_index_full,
            self.names, self.dimorphism, self.side, sex="female", mn9_id=mn9,
        )
        male_mask = z["male_mask"].astype(bool)
        self.male = self._slice(male_mask, ptr, post, w, z, mn9)
        hops = str(z["hops"]) if "hops" in z.files else "sugar×2"
        self.meta = {
            "n_female": int(self.female.n),
            "n_male": int(self.male.n),
            "n_edges": int(z["n_edges"]),
            "shiu_mn9": mn9,
            "mn9_in_graph": mn9 in set(map(int, self.ids)),
            "roles": {k: int(len(v)) for k, v in self.role_index_full.items()},
            "source": "FlyWire v783 / Shiu Connectivity_783.parquet",
            "engine": "numba Shiu LIF + slow DA/OA",
            "hops": hops,
            "male_rule": "FlyWire motif minus female-specific; MaleCNS 1.1GB edges not mapped (different IDs). fru cells in-graph get a male alcohol gain.",
        }
        # Compile the Numba kernel once at boot so the first sip isn't a freeze.
        self.female.drive_roles({}, t_ms=8.0)
        self.male.drive_roles({}, t_ms=8.0)

    def _slice(self, mask: np.ndarray, ptr, post, w, z, mn9: int) -> FlyBrain:
        old_to_new = -np.ones(len(mask), dtype=np.int32)
        old_to_new[mask] = np.arange(int(mask.sum()), dtype=np.int32)
        pre_ids = np.repeat(np.arange(len(mask)), np.diff(ptr))
        keep_e = mask[pre_ids] & mask[post]
        new_pre = old_to_new[pre_ids[keep_e]]
        new_post = old_to_new[post[keep_e]]
        new_w_raw = w[keep_e] / W_SYN
        n = int(mask.sum())
        nptr, npost, nw = _csr(new_pre.astype(np.int32), new_post.astype(np.int32), new_w_raw.astype(np.int16), n)
        roles = {}
        for name, ix in self.role_index_full.items():
            mapped = old_to_new[ix]
            roles[name] = mapped[mapped >= 0]
        return FlyBrain(
            z["ids"][mask], nptr, npost, nw, roles,
            z["names"][mask], z["dimorphism"][mask], z["side"][mask],
            sex="male", mn9_id=mn9,
        )

    def get(self, sex: str) -> FlyBrain:
        return self.female if sex == "female" else self.male


def _demo() -> None:
    pair = PairOfFlies()
    print(pair.meta)
    r = pair.female.drive_roles({"sugar_grn": 200}, t_ms=400)
    pair.female.step_modulators(400)
    print("sugar-only", pair.female.hubs(), "wall_ms", r.elapsed_ms)


if __name__ == "__main__":
    _demo()
