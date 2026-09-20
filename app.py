# -*- coding: utf-8 -*-
"""Two autonomous flies at a bar. Feelings come from the FlyWire LIF; choices do not.

Ceiling of autonomy (honest):
  The subgraph can say HOW they feel — sugar/MN (sip), PAM (joy), PPL1 (ouch),
  NPF (itch to seek), DNa02 (wobble). It cannot know what a slot machine is.
  A tiny policy maps those feelings onto bar actions. That policy is the joke,
  not the connectome.

Sugar as joy: a slow DA pool charges from sugar GRN spikes (Aso/Waddell),
not a Poisson hose into PAM. We drive sensors. We read MN9, EPG, DA, OA.
"""

from __future__ import annotations

import math
import random
from collections import deque
from dataclasses import dataclass, field
from threading import Lock, Thread
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from connectome import PairOfFlies
from paths import bundle_root

ROOT = bundle_root()
WHO = {"female": "Самка", "male": "Самец"}


def ru(sex: str, fem: str, masc: str) -> str:
    return fem if sex == "female" else masc


STARTING = 50
SHOT = 10
SPIN = 5
WIN_CHANCE = 0.30
WIN_PAY = 15
LOAN_CASH = 100
LOAN_DEBT = 150
MAX_DEBT = 150  # one loan. After that they steal, beg, or sulk — not a second shark.
WORK_PAY = 8    # wiping the counter. The bar's only source of honest chips.
# 500 ms of fly per beat: the sparse regime runs at ~1.2x realtime on this
# machine, so a longer trial costs nothing and halves the rate quantisation.
T_MS = 500.0
# Physiological GRN rates. At 120 Hz and up this subgraph tips into runaway
# excitation — 37% of cells firing, PPL1 pinned at its refractory ceiling, and
# sugar and bitter become indistinguishable. See probe.py sweep.
SUGAR_HZ = 80.0
BITTER_HZ = 75.0
# the bystander's beat, run on the other core while the actor's trial runs
AMBIENT_MS = 260.0
EPG_TONIC = 55.0
DNA02_TONIC = 30.0
DNG13_TONIC = 22.0
ALCOHOL_SHOT = 0.28

HOLD_MS = {
    "drink": 3800, "shot": 3800, "spin": 4200, "win": 5000, "lose": 3600,
    "steal": 3400, "fall": 4800, "down": 3000, "climb": 3600, "borrow": 3400,
    "beg": 3000, "nap": 2800, "idle": 2400,
    # The travelling moves get the longer beats: a shove crosses three metres
    # there and back, and the ceiling walk leaves the bar entirely. They are
    # also the ones worth watching, so the extra second is not a tax.
    "groom": 4200, "work": 4600, "scrounge": 4600, "lamp": 4800, "ceiling": 5600,
    "sing": 4600, "toast": 4600, "shove": 4800, "bubble": 4200,
}
DO_RU = {
    "drink": "пьёт", "shot": "наливает", "spin": "крутит барабан",
    "win": "куш", "lose": "мимо", "steal": "тырит фишку",
    "fall": "падает с табуретки", "down": "лежит на полу",
    "climb": "лезет обратно", "borrow": "берёт в долг",
    "beg": "просит глазами", "nap": "дремлет", "idle": "сидит",
    "groom": "умывается", "work": "протирает стойку", "scrounge": "шарит по полу",
    "lamp": "летит на свет", "ceiling": "гуляет по потолку",
    "sing": "поёт крылом", "toast": "чокается", "shove": "толкается",
    "bubble": "пускает пузырь",
}


# Beats a move has to sit out before it can be picked again. Without these the
# weighted choice re-picks its favourite every beat and the evening stops being
# an evening. Costly, dramatic moves wait longer than idle fidgets.
ALL_MOVES = (
    "spin", "shot", "steal", "shove", "groom", "work", "scrounge", "lamp",
    "ceiling", "sing", "toast", "bubble", "borrow", "wait", "get_up", "fall",
)

COOLDOWN = {
    "steal": 5, "shove": 6, "toast": 8, "ceiling": 14, "sing": 7,
    "lamp": 6, "work": 4, "scrounge": 4, "groom": 5, "bubble": 6, "borrow": 12,
}

# Why a fly did it, in Russian, quoting the number that tipped the choice —
# and which meter on the panel to flash while it says so.
WHY: dict[str, Any] = {
    "spin": lambda p, o, s: (
        (f"DA {s['da']:.2f} ещё держит. Ещё раз.", "mb_reward") if s["da"] >= 0.25
        else (f"MN9 {s['mn9']:.0f} Гц — хоботок сладкий, рука на ручке.", "sez_potential") if s["mn9"] >= 8
        else ("просто крутит. Так устроен вечер.", "mb_reward")),
    "shot": lambda p, o, s: (
        (f"OA {s['oa']:.2f}. Нальёт «для храбрости».", "mb_aversion") if s["oa"] >= 0.2
        else ("сухо во рту, а рюмка рядом.", "sez_potential")),
    "steal": lambda p, o, s: (
        f"курс {s['head']:+.2f}, DNa02 lean {s['lean']:.2f}. Навигация сказала «туда».", "cx_instability"),
    "shove": lambda p, o, s: (
        f"OA {s['oa']:.2f} и крен {s['lean']:.2f}. Локоть пошёл раньше мысли.", "mb_aversion"),
    "groom": lambda p, o, s: (
        f"OA {s['oa']:.2f}, DA {s['da']:.2f}. Надо привести себя в порядок.", "mb_aversion"),
    "work": lambda p, o, s: (
        f"фишек {p.credits}. Бармену нужна тряпка, {ru(p.sex, 'ей', 'ему')} — фишки.", "sez_potential"),
    "scrounge": lambda p, o, s: (
        f"фишек {p.credits}. На полу тоже бывают деньги.", "cx_instability"),
    "lamp": lambda p, o, s: (
        f"курс {s['head']:+.2f} упёрся в лампу. Компас не спрашивает зачем.", "cx_instability"),
    "ceiling": lambda p, o, s: (
        f"качка {s['wob']:.2f}. Вверх ногами устойчивее — так кажется.", "cx_instability"),
    "sing": lambda p, o, s: (
        f"fru {s['fru']:.0f} Гц, DA {s['da']:.2f}. Крыло само разводится.", "mb_reward"),
    "toast": lambda p, o, s: (
        f"DA {s['da']:.2f} у обоих. Редкий случай — никто ничего не тырит.", "mb_reward"),
    "bubble": lambda p, o, s: (
        f"MN9 {s['mn9']:.0f} Гц. Хоботок работает сам по себе.", "sez_potential"),
    "wait": lambda p, o, s: ("сидит. Пока так.", "mb_reward"),
    "get_up": lambda p, o, s: ("качка отпустила — можно лезть.", "cx_instability"),
    "fall": lambda p, o, s: ("потолок кончился.", "cx_instability"),
    "borrow": lambda p, o, s: (f"OA {s['oa']:.2f}, фишек ноль.", "npf_stress"),
}


class SexBody(BaseModel):
    sex: str = "female"


class AutoBody(BaseModel):
    on: bool = True


def _blank() -> dict[str, float]:
    return {
        "sez_potential": 0.0, "sez_sugar_hz": 0.0, "sez_mn_hz": 0.0,
        "mb_reward": 0.0, "mb_reward_hz": 0.0,
        "mb_aversion": 0.0, "mb_aversion_hz": 0.0,
        "cx_instability": 0.0, "cx_dna02_hz": 0.0, "cx_dng13_hz": 0.0,
        "cx_see_saw_hz": 0.0, "cx_lean": 0.0, "npf_stress": 0.0, "npf_hz": 0.0,
        "da": 0.0, "oa": 0.0, "mn9_hz": 0.0, "epg_hz": 0.0, "epg_heading": 0.0,
        "bitter_hz": 0.0, "fru_hz": 0.0, "trial_sim_ms": 0.0, "in_drive": "",
        "n_spikes": 0, "trial_wall_ms": 0.0, "alcohol": 0.0,
        "max_motor_stability": 1.0, "motor_floor": 0.0,
    }


@dataclass
class Player:
    sex: str
    credits: int = STARTING
    debt: int = 0
    has_loan: bool = False
    synaptic_snaps: int = 0
    fallen: bool = False
    alcohol: float = 0.0
    max_motor_stability: float = 1.0
    hubs: dict[str, float] = field(default_factory=_blank)
    pose: str = "idle"
    biggest_win: int = 0
    cooldown: int = 0
    last_event: str = ""
    flavor: str = ""
    why: str = ""
    drive: str = ""
    ring_bias: float = 0.0     # where this fly's CX heading bump has drifted to
    on_ceiling: bool = False
    since: dict[str, int] = field(default_factory=dict)   # beats since each move

    def stale(self, choice: str, gap: int) -> bool:
        """True while `choice` is still on cooldown. Without this the softmax
        happily picks the same winner every beat forever."""
        return self.since.get(choice, 99) < gap

    def floor(self) -> float:
        return max(0.0, min(1.0, 1.0 - self.max_motor_stability))

    def mix_cx(self) -> float:
        """How close this fly is to going over.

        Built from the two things the subgraph genuinely computes about
        posture: how lopsided the DNa02 steering command is, and how far the
        EPG heading bump has drifted off centre. The old version leaned on
        sez_potential and cx_instability, both of which were pinned at 1.0 by
        the runaway the network used to sit in, so it carried no information.
        """
        h = self.hubs
        lean = abs(float(h.get("cx_lean") or 0))
        head = abs(float(h.get("epg_heading") or 0))
        raw = 0.50 * self.alcohol + 0.30 * lean + 0.20 * head + 0.25 * self.alcohol * (lean + head)
        return max(self.floor(), min(1.0, raw))

    def hz(self, key: str) -> float:
        return float(self.hubs.get(key) or 0)

    def snapshot(self) -> dict[str, Any]:
        hubs = dict(self.hubs)
        hubs["alcohol"] = round(self.alcohol, 4)
        hubs["cx_instability"] = round(self.mix_cx(), 4)
        hubs["max_motor_stability"] = round(self.max_motor_stability, 4)
        hubs["motor_floor"] = round(self.floor(), 4)
        return {
            "sex": self.sex,
            "name": WHO[self.sex],
            "credits": self.credits,
            "debt": self.debt,
            "fallen": self.fallen,
            "has_loan": self.has_loan,
            "synaptic_snaps": self.synaptic_snaps,
            "pose": self.pose,
            "biggest_win": self.biggest_win,
            "can_borrow": self.credits == 0 and not self.fallen and self.debt < MAX_DEBT,
            "can_shot": self.credits >= SHOT and not self.fallen,
            "can_spin": self.credits >= SPIN and not self.fallen,
            "last_event": self.last_event,
            "flavor": self.flavor,
            "why": self.why,
            "drive": self.drive,
            "brain": hubs,
        }


class Bar:
    def __init__(self) -> None:
        self.lock = Lock()
        self.brains = PairOfFlies()
        self.players = {"female": Player("female"), "male": Player("male")}
        self.players["female"].cooldown = 0
        self.players["male"].cooldown = 1
        self.autopilot = True
        self.lines: deque[str] = deque(maxlen=8)
        self.fx: dict[str, Any] | None = None
        self.fx_id = 0
        self.last_sex: str = "male"
        self.beat: dict[str, Any] = {
            "sex": "", "who": "", "do": "сидят", "why": "ещё ничего не случилось",
            "drive": "", "hold_ms": 2800, "line": "",
        }
        self._run("female", {"sugar_grn": SUGAR_HZ * 0.4}, t_ms=300)
        self._run("male", {"sugar_grn": SUGAR_HZ * 0.4}, t_ms=300)
        self._say(
            "Две мухи, один автомат. На вход — только сахарные нейроны. "
            "Радость — медленный дофамин, не скрипт. Пусть сами."
        )

    def other(self, sex: str) -> str:
        return "male" if sex == "female" else "female"

    def _say(self, text: str, sex: str | None = None) -> None:
        self.lines.appendleft(text)
        if sex:
            self.players[sex].last_event = text

    def _state(self) -> dict[str, Any]:
        f, m = self.players["female"], self.players["male"]
        lead = "Нос к носу"
        if f.credits > m.credits + 4:
            lead = "Красная лента впереди"
        elif m.credits > f.credits + 4:
            lead = "Синяя шляпа вырвалась"
        elif f.credits > m.credits:
            lead = "Самка на фишку впереди"
        elif m.credits > f.credits:
            lead = "Самец на фишку впереди"
        return {
            "meta": self.brains.meta,
            "autopilot": self.autopilot,
            "log": "\n".join(self.lines),
            "headline": lead,
            "female": f.snapshot(),
            "male": m.snapshot(),
            "fx": self.fx,
            "beat": self.beat,
        }

    def state(self) -> dict[str, Any]:
        with self.lock:
            return self._state()

    def _fx(self, **kwargs: Any) -> None:
        self.fx_id += 1
        self.fx = {"id": self.fx_id, **kwargs}

    def _set_beat(self, sex: str, choice: str, why: str, drive: str, extra: dict[str, Any] | None = None) -> None:
        p = self.players[sex]
        pose = p.pose or choice
        hold = HOLD_MS.get(pose, HOLD_MS.get(choice, 3000))
        extra = extra or {}
        if extra.get("jackpot"):
            hold = 5600
        if extra.get("free_drink"):
            why = "бармен моргнул — рюмка сама."
            drive = "sez_potential"
        elif extra.get("take") and choice != "steal":
            why = "фишка как будто сама перешла. Курс качнуло."
            drive = "cx_instability"
        elif extra.get("court"):
            why = "шагнул ближе, чем просили."
            drive = "cx_instability"
        verb = DO_RU.get(pose, DO_RU.get(choice, "делает что-то"))
        if pose == "fall":
            verb = ru(sex, "упала", "упал")
        elif pose == "win" and extra.get("jackpot"):
            verb = "джекпот"
        p.why = why
        p.drive = drive
        h = p.hubs
        self.beat = {
            "sex": sex,
            "who": WHO[sex],
            "do": verb,
            "why": why,
            "drive": drive,
            "hold_ms": hold,
            "line": p.last_event,
            "pose": pose,
            "choice": choice,
            "io_in": (
                str(h.get("in_sensors") or "тишина")
                + (f" + тонус {h['in_tonic']}" if h.get("in_tonic") else "")
            ),
            "io_out": (
                f"MN9 {float(h.get('mn9_hz') or 0):.0f} Гц · "
                f"DA {float(h.get('da') or 0):.2f} · OA {float(h.get('oa') or 0):.2f} · "
                f"курс {float(h.get('epg_heading') or 0):+.2f} · "
                f"{int(h.get('n_active') or 0)} клеток в деле"
                + (f" · горечь срезала глоток на {float(h['feed_block_hz']):.0f} Гц"
                   if float(h.get("feed_block_hz") or 0) > 4 else "")
            ),
            "wall_ms": float(h.get("trial_wall_ms") or 0),
            "sim_ms": float(h.get("trial_sim_ms") or 0),
        }

    def _run(
        self,
        sex: str,
        roles: dict[str, float] | None = None,
        t_ms: float = T_MS,
        da_boost: float = 0.0,
        oa_boost: float = 0.0,
    ) -> dict[str, float]:
        p = self.players[sex]
        brain = self.brains.get(sex)
        driven = dict(roles or {})
        # The tonic boundary condition: the CX ring and the descending steering
        # cells sit in the subgraph but their sustaining loops do not, so they
        # get a standing input. Alcohol rides on top of it.
        driven["epg"] = EPG_TONIC
        driven["dna02"] = driven.get("dna02", 0.0) + DNA02_TONIC + 26.0 * p.alcohol
        driven["dng13"] = driven.get("dng13", 0.0) + DNG13_TONIC + 14.0 * p.alcohol
        if p.sex == "male" and p.alcohol > 0.12:
            # 1533 fru cells, so this is per-cell and stays under 1 Hz: a few Hz
            # across a population that size is enough on its own to push the
            # graph into the runaway the brake then has to mop up (probe.py fru).
            driven["fru"] = driven.get("fru", 0.0) + 0.9 * p.alcohol
        # A drunk fly's ring bump is pushed off-centre; which way is its own
        # slow wander, so the two flies do not list identically.
        p.ring_bias = max(-0.75, min(0.75, p.ring_bias * 0.82 + random.uniform(-1.0, 1.0) * p.alcohol * 0.5))
        brain.drive_roles(driven, t_ms=t_ms, side_bias={"epg": p.ring_bias})
        brain.step_modulators(t_ms, da_boost=da_boost, oa_boost=oa_boost)
        hubs = brain.hubs()
        p.hubs = hubs
        return hubs

    def _pick(self, *lines: str) -> str:
        return random.choice(lines)

    def _maybe_fall(self, p: Player) -> None:
        if p.fallen:
            return                      # already down; nothing left to topple off
        if p.mix_cx() >= 0.72:
            p.fallen = True
            p.pose = "fall"
            self._say(self._pick(
                f"И — бах. {WHO[p.sex]} уже на полу. Шляпа отдельно, достоинство тоже.",
                f"{WHO[p.sex]} {ru(p.sex, 'промахнулась', 'промахнулся')} мимо табуретки. Классика.",
                f"Ноги сказали «нет». {WHO[p.sex]} лежит и смотрит в потолок, как будто там джекпот.",
            ), p.sex)

    def _get_up(self, p: Player) -> None:
        p.fallen = False
        p.pose = "climb"
        p.alcohol = max(0.15, p.alcohol * 0.5)
        stood = ru(p.sex, "Встала", "Встал")
        whose = ru(p.sex, "её", "его")
        self._say(self._pick(
            f"{WHO[p.sex]} карабкается обратно. Никто не аплодирует — и правильно.",
            f"{stood}. Почти. Шляпа набекрень — и пусть.",
            f"{WHO[p.sex]} решает, что пол — это не {whose} уровень.",
        ), p.sex)

    def _twist(self, sex: str) -> dict[str, Any]:
        """Side gags biased by the last trial, not a timer."""
        p = self.players[sex]
        o = self.players[self.other(sex)]
        extra: dict[str, Any] = {}
        if p.fallen:
            return extra
        dna, npf = p.hz("cx_see_saw_hz"), p.hz("npf_hz")
        da = float(p.hubs.get("da") or 0)
        neighbour = "соседки" if o.sex == "female" else "соседа"
        # DNa02 see-saw: the body already leaned that way — sometimes a chip follows.
        if dna > 14 and o.credits >= 5 and not o.fallen and random.random() < min(0.5, 0.08 + dna / 90):
            take = min(5, o.credits)
            o.credits -= take
            p.credits += take
            p.pose = "steal"
            extra["take"] = take
            extra["from"] = o.sex
            self._say(self._pick(
                f"Фишка как будто сама перешла к {WHO[p.sex].lower()}. Никто не видел. Все видели.",
                f"{WHO[p.sex]} «{ru(p.sex, 'поправила', 'поправил')} шляпу» — и у {neighbour} минус фишка.",
            ), sex)
            return extra
        if npf > 16 and random.random() < min(0.45, 0.1 + npf / 80):
            self._say(self._pick(
                f"В дверь дунуло. {WHO[p.sex]} вдруг хочет всего и сразу.",
                "Мимо прошла оса. Или показалось. Настроение — в минус, без причины.",
            ), sex)
            return extra
        if da > 0.45 and random.random() < 0.12:
            p.credits += 5
            p.pose = "drink"
            extra["free_drink"] = True
            self._say(self._pick(
                "Бармен моргнул — и рюмка сама. Сегодня вселенная добрая.",
                "«За счёт заведения», — бурчит бармен. Муха не спорит.",
            ), sex)
            self._run(sex, {"sugar_grn": SUGAR_HZ}, t_ms=T_MS)
            return extra
        if p.sex == "male" and o.mix_cx() > 0.28 and p.mix_cx() > 0.28 and random.random() < 0.1:
            p.pose = "steal"
            extra["court"] = True
            o.alcohol = min(1.0, o.alcohol + 0.1)
            self._say("Самец шагнул ближе, чем просили. Самка качнула шляпой — оба ещё пьянее.")
        return extra

    def shot(self, sex: str, free: bool = False) -> None:
        p = self.players[sex]
        if p.fallen:
            return
        if not free:
            if p.credits < SHOT:
                return
            p.credits -= SHOT
        hubs = self._run(sex, {"sugar_grn": SUGAR_HZ})
        p.alcohol = min(1.0, p.alcohol + ALCOHOL_SHOT)
        p.pose = "drink"
        p.flavor = "сладко"
        sweet = hubs["da"] >= 0.22 or hubs["mn9_hz"] >= 6 or hubs["sez_mn_hz"] >= 8
        if sweet:
            line = self._pick(
                f"{WHO[p.sex]} тянется к рюмке. Сахар на входе, DA {hubs['da']:.2f} — хоботок уже знает.",
                f"Глоток. MN9 {hubs['mn9_hz']:.0f} Гц. Это не куш, это сахар. Но {ru(p.sex, 'ей', 'ему')} всё равно.",
                f"Рюмка ушла. На душе DA {hubs['da']:.2f}, в кармане минус десять.",
            )
        else:
            line = f"{WHO[p.sex]} {ru(p.sex, 'выпила', 'выпил')}, а DA почти не качнулся ({hubs['da']:.2f}). Горькая какая-то, эта жизнь."
        self._say(line, sex)
        self._maybe_fall(p)

    def spin(self, sex: str) -> dict[str, Any]:
        p = self.players[sex]
        extra: dict[str, Any] = {"won": False}
        if p.fallen or p.credits < SPIN:
            return extra
        p.credits -= SPIN
        p.pose = "spin"
        won = random.random() < WIN_CHANCE
        jackpot = won and random.random() < 0.08
        extra["won"] = won
        extra["jackpot"] = jackpot
        extra["pay"] = 0
        if won:
            pay = 40 if jackpot else WIN_PAY
            extra["pay"] = pay
            p.credits += pay
            p.biggest_win = max(p.biggest_win, pay)
            self._run(sex, {}, da_boost=0.62 if jackpot else 0.40)
            p.pose = "win"
            if jackpot:
                self._say(f"Джекпот. Автомата в коннектоме нет — капнули DA {self.players[sex].hubs['da']:.2f}. +{pay}.", sex)
            else:
                self._say(self._pick(
                    f"Есть! +{pay}. DA {self.players[sex].hubs['da']:.2f} — как сахар, только без рюмки.",
                    f"Куш. Глаза горят. Сосед по табуретке это видит.",
                    f"+{pay}. Маленькая победа, большая жажда следующей.",
                ), sex)
            other = self.players[self.other(sex)]
            if not other.fallen:
                self._run(self.other(sex), {}, oa_boost=0.22, t_ms=220)
                other.pose = "lose"
                extra["rival"] = other.sex
                self._say(self._pick(
                    f"{WHO[other.sex]} смотрит на чужие фишки. Молча. Это хуже, чем ругань.",
                    f"Зависть села рядом с {WHO[other.sex].lower()} и заказала ничего.",
                ))
        else:
            self._run(sex, {"sugar_grn": SUGAR_HZ * 0.25, "bitter_grn": BITTER_HZ})
            p.pose = "lose"
            self._say(self._pick(
                f"Пусто. Горечь на входе, OA {self.players[sex].hubs['oa']:.2f}. Смотрит в автомат как в бывшего.",
                f"Снова мимо. Сейчас или нальёт, или полезет ва-банк. Третьего не дано.",
                "Фишки ушли. Обида такая, что хочется выпить. Или украсть. Или оба.",
            ), sex)
        if p.has_loan and random.random() < 0.10:
            p.synaptic_snaps += 1
            p.max_motor_stability = max(0.15, p.max_motor_stability - 0.18)
            extra["snap"] = True
            self._say("Что-то внутри щёлкнуло. Курс с тех пор чуть врёт. Ростовщик делает вид, что не при чём.", sex)
        self._maybe_fall(p)
        extra.update(self._twist(sex))
        extra["sex"] = sex
        return extra

    def steal(self, sex: str) -> dict[str, Any]:
        p, o = self.players[sex], self.players[self.other(sex)]
        extra: dict[str, Any] = {}
        if p.fallen or o.fallen or o.credits < SPIN:
            p.pose = "beg" if p.credits == 0 else "nap"
            self._say(self._pick(
                f"{WHO[p.sex]} без фишек и без жертвы. Дремлет на краю бокала.",
                f"Воровать не у кого. {WHO[p.sex]} делает вид, что так и задумано.",
            ), sex)
            return extra
        take = min(10, o.credits)
        o.credits -= take
        p.credits += take
        p.pose = "steal"
        extra["take"] = take
        extra["from"] = o.sex
        self._run(sex, {})
        self._run(self.other(sex), {}, oa_boost=0.16, t_ms=220)
        self._say(self._pick(
            f"{WHO[p.sex]} бочком, бочком — и {take} фишек уже не там. Руки как будто сами.",
            "Шаг в сторону. Навигация сказала «туда». Совесть не успела.",
        ), sex)
        return extra

    def borrow(self, sex: str) -> None:
        p = self.players[sex]
        if p.fallen or p.credits != 0 or p.debt >= MAX_DEBT:
            if p.debt >= MAX_DEBT:
                self._say("Ростовщик качает головой: «Одного долга хватит. Дальше — как умеешь».", sex)
            return
        p.credits += LOAN_CASH
        p.debt += LOAN_DEBT
        p.has_loan = True
        p.pose = "borrow"
        self._run(sex, {})
        self._say(
            f"{WHO[p.sex]} берёт сотню. Отдать придётся полторы. Больше не дадут — и это, может, к лучшему.",
            sex,
        )

    # ------------------------------------------------------------------ #
    # The rest of the evening. None of these touch the slot machine, which
    # is the point: with only spin, shot and steal on the menu, two broke
    # flies would pass the same ten chips back and forth until morning.
    # ------------------------------------------------------------------ #

    def groom(self, sex: str) -> dict[str, Any]:
        """Front legs over the eyes, hind legs over the wings. Costs nothing,
        and a fly that has had a minute to itself is measurably less sour."""
        p = self.players[sex]
        p.pose = "groom"
        self._run(sex, {}, oa_boost=-0.18)
        self._say(self._pick(
            f"{WHO[p.sex]} умывается. Передние лапки по глазам, задние по крыльям — и мир чуть терпимее.",
            f"Пауза на туалет. {WHO[p.sex]} трёт глаза так, будто это поможет с картами.",
            f"Лапка за лапкой. Единственное, что у {ru(p.sex, 'неё', 'него')} сегодня выходит аккуратно.",
        ), sex)
        return {}

    def work(self, sex: str) -> dict[str, Any]:
        """Wipe the counter for the barman. The only honest money in the bar,
        and the reason the pair cannot end up broke forever."""
        p = self.players[sex]
        pay = WORK_PAY + (2 if p.alcohol < 0.3 else 0)
        p.credits += pay
        p.pose = "work"
        self._run(sex, {}, da_boost=0.10)
        self._say(self._pick(
            f"{WHO[p.sex]} протирает стойку. Бармен кидает {pay} фишек и ничего не говорит.",
            f"Работа. Настоящая. {pay} фишек, и {ru(p.sex, 'она', 'он')} держит их как чужие.",
            f"Круг тряпкой, второй круг тряпкой. +{pay}. Достоинство котируется дёшево, но котируется.",
        ), sex)
        return {"pay": pay}

    def scrounge(self, sex: str) -> dict[str, Any]:
        """Comb the floor. Sometimes there is a chip down there. A fly that is
        already lying on the floor is, for once, well placed."""
        p = self.players[sex]
        p.pose = "scrounge"
        found = random.random() < (0.75 if p.fallen else 0.45)
        take = random.choice([1, 2, 5]) if found else 0
        p.credits += take
        self._run(sex, {"sugar_grn": SUGAR_HZ * 0.3}, da_boost=0.06 if found else 0.0)
        if found:
            self._say(self._pick(
                f"Под табуреткой что-то блеснуло. {take} фишки. Сегодня пол платит лучше автомата.",
                f"{WHO[p.sex]} шарит по полу и находит {take}. Чьи — вопрос философский.",
            ), sex)
        else:
            self._say(self._pick(
                f"{WHO[p.sex]} обшарила пол. Крошка, пробка, ничего.",
                "Под стойкой только пыль и чужая соломинка. Ладно.",
            ), sex)
        # not "take": that key means a chip came off the other fly's stack, and
        # the stage flies one across the bar when it sees it.
        return {"found": take}

    def lamp(self, sex: str) -> dict[str, Any]:
        """Straight at the light. The compass has locked onto the brightest
        thing in the room, which is what a fly's compass is for."""
        p = self.players[sex]
        p.pose = "lamp"
        head = abs(float(p.hubs.get("epg_heading") or 0))
        p.alcohol = min(1.0, p.alcohol + 0.06)
        self._run(sex, {}, oa_boost=0.12)
        self._say(self._pick(
            f"Лампа. {WHO[p.sex]} идёт на свет, курс {head:+.2f}, и бьётся лбом. Свет не виноват.",
            f"Что-то яркое. Мушиный компас говорит «туда» и никогда не говорит «зачем».",
            f"Бум. {WHO[p.sex]} отскакивает от абажура и делает вид, что так и хотела.",
        ), sex)
        self._maybe_fall(p)
        return {}

    def ceiling(self, sex: str) -> dict[str, Any]:
        """Up the wall and onto the ceiling, upside down. Ends the only way it
        can end. This is the alternative to falling off the stool, not an
        escape from it."""
        p = self.players[sex]
        p.pose = "ceiling"
        p.on_ceiling = True
        self._run(sex, {}, da_boost=0.16)
        self._say(self._pick(
            f"{WHO[p.sex]} уходит по стене на потолок. Вверх ногами мир наконец стоит ровно.",
            f"Потолок. {WHO[p.sex]} гуляет там вниз головой и смотрит на нас сверху вниз в обоих смыслах.",
            f"Гравитация — это предложение, а не приказ. {WHO[p.sex]} на потолке.",
        ), sex)
        return {}

    def sing(self, sex: str) -> dict[str, Any]:
        """One wing out, vibrating. The courtship song, performed at a fly who
        did not ask for it."""
        p, o = self.players[sex], self.players[self.other(sex)]
        p.pose = "sing"
        fru = p.hz("fru_hz")
        self._run(sex, {}, da_boost=0.18)
        warm = random.random() < 0.35
        if not o.fallen:
            self._run(self.other(sex), {}, da_boost=0.14 if warm else 0.0,
                      oa_boost=0.0 if warm else 0.16, t_ms=AMBIENT_MS)
            o.pose = "groom" if warm else "lose"
        if warm:
            self._say(self._pick(
                f"{WHO[p.sex]} разводит крыло и поёт. {WHO[o.sex]} делает вид, что не слушает, и слушает.",
                f"Серенада на одном крыле, fru {fru:.0f} Гц. Сработало — редкий вечер.",
            ), sex)
        else:
            self._say(self._pick(
                f"{WHO[p.sex]} поёт крылом. {WHO[o.sex]} отворачивается к автомату. Песня продолжается в пустоту.",
                f"Крыло дрожит, fru {fru:.0f} Гц, ответа ноль. Классика жанра.",
            ), sex)
        return {"warm": warm, "at": o.sex}

    def toast(self, sex: str) -> dict[str, Any]:
        """Two flies, two glasses, one moment where nobody is stealing."""
        p, o = self.players[sex], self.players[self.other(sex)]
        if p.credits < SHOT or o.credits < SHOT or o.fallen:
            return {}
        p.credits -= SHOT
        o.credits -= SHOT
        p.pose = o.pose = "toast"
        for who in (sex, self.other(sex)):
            self._run(who, {"sugar_grn": SUGAR_HZ}, da_boost=0.24)
            self.players[who].alcohol = min(1.0, self.players[who].alcohol + ALCOHOL_SHOT * 0.8)
        self._say(self._pick(
            "Чокнулись. На секунду это не притон, а компания.",
            "Две рюмки, один звон. Долги на месте, но сейчас не про них.",
            "За что пьют мухи — неизвестно. Но чокаются они всерьёз.",
        ), sex)
        self._maybe_fall(p)
        self._maybe_fall(o)
        return {"with": o.sex}

    def shove(self, sex: str) -> dict[str, Any]:
        """A headbutt instead of a pickpocketing. Same bad intent, better
        theatre, and it can put the other one on the floor."""
        p, o = self.players[sex], self.players[self.other(sex)]
        if o.fallen:
            return {}
        p.pose = "shove"
        lean = abs(float(p.hubs.get("cx_lean") or 0))
        self._run(sex, {}, oa_boost=0.10)
        self._run(self.other(sex), {}, oa_boost=0.26, t_ms=AMBIENT_MS)
        o.alcohol = min(1.0, o.alcohol + 0.12)
        toppled = o.mix_cx() >= 0.62 or random.random() < 0.2
        if toppled:
            o.fallen = True
            o.pose = "fall"
            self._say(self._pick(
                f"{WHO[p.sex]} двинула плечом — и {WHO[o.sex].lower()} уже изучает пол.",
                f"Толчок, табуретка, пол. В таком порядке. DNa02 lean {lean:.2f}.",
            ), sex)
        else:
            o.pose = "lose"
            self._say(self._pick(
                f"{WHO[p.sex]} толкается. {WHO[o.sex]} качнулся, устоял и запомнил.",
                f"Плечом в плечо. Никто не упал, но вечер стал холоднее.",
            ), sex)
        return {"toppled": toppled, "at": o.sex}

    def bubble(self, sex: str) -> dict[str, Any]:
        """Regurgitate a droplet, hold it on the proboscis, swallow it again.
        Flies really do this to concentrate what they drank. It looks exactly
        as dignified as it sounds."""
        p = self.players[sex]
        p.pose = "bubble"
        hubs = self._run(sex, {"sugar_grn": SUGAR_HZ * 0.7}, da_boost=0.12)
        p.alcohol = max(0.0, p.alcohol - 0.07)
        self._say(self._pick(
            f"{WHO[p.sex]} выкатывает каплю на хоботок и втягивает обратно. MN9 {hubs['mn9_hz']:.0f} Гц. Так мухи и трезвеют.",
            f"Пузырь. Висит, блестит, исчезает. {WHO[p.sex]} выглядит задумчиво и омерзительно.",
            f"Капля туда, капля обратно. Это не тошнота, это концентрирование. Легче не выглядит.",
        ), sex)
        return {}

    # choice name -> the method that performs it. spin and steal stay out of
    # this table because they return outcome payloads the stage reads.
    MOVES = {
        "shot": shot, "borrow": borrow, "groom": groom, "work": work,
        "scrounge": scrounge, "lamp": lamp, "ceiling": ceiling,
        "sing": sing, "toast": toast, "shove": shove, "bubble": bubble,
    }

    def decide(self, sex: str) -> tuple[str, str, str]:
        """Sample the next move from the last trial's real rates. Also say why, in Russian."""
        p = self.players[sex]
        o = self.players[self.other(sex)]
        da = float(p.hubs.get("da") or 0)
        oa = float(p.hubs.get("oa") or 0)
        mn9 = p.hz("mn9_hz")
        mn = p.hz("sez_mn_hz")
        npf = p.hz("npf_hz")
        lean = abs(float(p.hubs.get("cx_lean") or 0))
        head = abs(float(p.hubs.get("epg_heading") or 0))
        fru = p.hz("fru_hz")
        drunk = p.alcohol
        wob = p.mix_cx()

        if p.on_ceiling:
            return "fall", "потолок кончился. Гравитация не кончается.", "cx_instability"
        if p.fallen:
            # Down is not nothing to do. There are chips on a bar floor.
            if p.credits < SHOT and not p.stale("scrounge", 3) and random.random() < 0.5:
                return "scrounge", "раз уж внизу — надо посмотреть, что тут лежит.", "sez_potential"
            if p.alcohol > 0.45:
                return "wait", "ещё рано. Пол пока мягче табуретки.", "cx_instability"
            return "get_up", "качка отпустила — можно лезть.", "cx_instability"

        # Every move is weighted by something the model measured this beat, and
        # every move has a cooldown. The cooldowns are what keep the evening
        # moving: a softmax with three options and no memory will happily pick
        # the same winner forever, which is how the pair used to end up passing
        # one stack of chips back and forth until morning.
        logits = {
            "spin":     1.1 + 2.2 * da + 0.010 * mn9 - 1.4 * max(0.0, drunk - 0.6),
            "shot":     0.4 + 2.0 * oa + 0.9 * (1.0 - drunk),
            "steal":   -0.2 + 0.9 * lean + 0.8 * head,
            "shove":   -0.3 + 1.5 * oa + 1.3 * lean,
            "groom":    0.3 + 1.4 * oa + 0.8 * (1.0 - da) - 1.0 * drunk,
            "work":     0.2 + 1.6 * max(0.0, 1.0 - p.credits / 30.0) - 1.6 * drunk,
            "scrounge": 0.0 + 1.3 * max(0.0, 1.0 - p.credits / 20.0),
            "lamp":    -0.4 + 2.0 * head + 1.1 * drunk,
            "ceiling": -1.2 + 2.2 * drunk + 1.4 * wob,
            "sing":    -0.6 + 0.020 * fru + 1.6 * da + 0.7 * drunk,
            "toast":   -0.5 + 1.8 * da + 1.2 * float(o.hubs.get("da") or 0),
            "bubble":  -0.6 + 0.012 * mn9 + 1.5 * drunk,
        }
        # what is simply not possible right now
        if p.credits < SPIN:
            logits.pop("spin", None)
        if p.credits < SHOT or drunk > 0.8:
            logits.pop("shot", None)
        if o.fallen or o.credits < 5:
            logits.pop("steal", None)
        if o.fallen:
            logits.pop("shove", None)
            logits.pop("sing", None)
        if p.credits < SHOT or o.credits < SHOT or o.fallen:
            logits.pop("toast", None)
        if drunk < 0.25:
            logits.pop("bubble", None)
        # and what is possible but was just done
        for move, gap in COOLDOWN.items():
            if p.stale(move, gap):
                logits.pop(move, None)

        if p.credits == 0 and p.debt < MAX_DEBT and (oa > 0.25 or npf > 8) and not p.stale("borrow", 12):
            return "borrow", f"ноль фишек, OA {oa:.2f} — идёт к ростовщику.", "npf_stress"
        if not logits:
            return "wait", "ничего не тянет. Сидит.", "mb_reward"
        if da + oa < 0.12 and mn9 + mn < 10 and drunk < 0.35 and random.random() < 0.22:
            return "wait", "тихо. DA почти ноль — сидит.", "mb_reward"

        keys = list(logits)
        mx = max(logits.values())
        weights = [math.exp(logits[k] - mx) for k in keys]
        pick = random.random() * sum(weights)
        acc = 0.0
        choice = keys[-1]
        for k, w in zip(keys, weights):
            acc += w
            if pick <= acc:
                choice = k
                break
        why, drive = WHY[choice](p, o, {
            "da": da, "oa": oa, "mn9": mn9, "mn": mn, "npf": npf,
            "lean": lean, "head": head, "fru": fru, "drunk": drunk, "wob": wob,
        })
        return choice, why, drive

    def act(self, sex: str) -> dict[str, Any]:
        p = self.players[sex]
        choice, why, drive = self.decide(sex)
        for move in ALL_MOVES:
            p.since[move] = p.since.get(move, 99) + 1
        p.since[choice] = 0
        spin_info: dict[str, Any] = {}
        steal_info: dict[str, Any] = {}
        if choice == "spin":
            spin_info = self.spin(sex)
        elif choice == "steal":
            steal_info = self.steal(sex)
        elif choice in self.MOVES:
            steal_info = self.MOVES[choice](self, sex) or {}
        elif choice == "get_up":
            self._get_up(p)
        elif choice == "fall":
            p.on_ceiling = False
            p.fallen = True
            p.pose = "fall"
            self._run(sex, {}, oa_boost=0.2)
            self._say(f"{WHO[p.sex]} отцепляется от потолка. Приземление так себе.", sex)
        elif p.fallen:
            # Already down. Say so plainly, so the stage holds the lying pose
            # instead of standing the fly up and toppling it again.
            p.pose = "down"
        else:
            p.pose = "nap" if p.credits < SPIN else "idle"
        if choice not in ("ceiling",):
            p.on_ceiling = False
        bump = False
        f, m = self.players["female"], self.players["male"]
        if (
            not f.fallen and not m.fallen
            and f.mix_cx() > 0.5 and m.mix_cx() > 0.5
            and random.random() < 0.18
        ):
            f.alcohol = min(1.0, f.alcohol + 0.05)
            m.alcohol = min(1.0, m.alcohol + 0.05)
            bump = True
            self._say("Толкаются у автомата. Шляпы едут, фишки тоже — почти.")
        kind = p.pose if choice == "wait" else choice
        extra = {**steal_info, **spin_info}
        self._set_beat(sex, choice, why, drive, extra)
        payload = {**extra, "sex": sex, "kind": kind, "bump": bump, "hold_ms": self.beat["hold_ms"]}
        self._fx(**payload)
        return spin_info

    def _ambient(self, sex: str) -> None:
        """A beat of the fly that is not acting: nothing in its glass, just the
        tonic ring drive and whatever alcohol is still in it. This is a real
        trial, not a decay curve — it runs on its own thread, and because the
        LIF kernel releases the GIL the two brains genuinely occupy two cores.
        """
        self._run(sex, {}, t_ms=AMBIENT_MS)

    def tick(self) -> dict[str, Any]:
        with self.lock:
            for p in self.players.values():
                # A fly on the floor is not drinking, so it clears faster —
                # otherwise it lies there for a minute of real time.
                p.alcohol *= 0.88 if p.fallen else 0.96
            spin_info: dict[str, Any] = {}
            if self.autopilot:
                actor = self.other(self.last_sex)
                bystander = self.last_sex
                self.last_sex = actor
                side = Thread(target=self._ambient, args=(bystander,), daemon=True)
                side.start()
                spin_info = self.act(actor)
                side.join()
            else:
                # nobody is simulating, so the pools just leak in sim time
                for sex, p in self.players.items():
                    b = self.brains.get(sex)
                    b.da *= math.exp(-T_MS / 900.0)
                    b.oa *= math.exp(-T_MS / 1100.0)
                    p.hubs["da"] = round(b.da, 3)
                    p.hubs["oa"] = round(b.oa, 3)
                    p.hubs["mb_reward"] = min(1.0, b.da / 1.15)
                    p.hubs["mb_aversion"] = min(1.0, b.oa / 1.15)
            st = self._state()
            if spin_info:
                st["spin"] = spin_info
            return st

    def reset(self) -> dict[str, Any]:
        with self.lock:
            self.brains.female.reset_state()
            self.brains.male.reset_state()
            self.players = {"female": Player("female"), "male": Player("male")}
            self.players["male"].cooldown = 1
            self.lines.clear()
            self.autopilot = True
            self.fx = None
            self.last_sex = "male"
            self.beat = {
                "sex": "", "who": "", "do": "сидят", "why": "заново. Смотрим.",
                "drive": "", "hold_ms": 3200, "line": "",
            }
            self._run("female", {"sugar_grn": SUGAR_HZ * 0.4}, t_ms=300)
            self._run("male", {"sugar_grn": SUGAR_HZ * 0.4}, t_ms=300)
            self._say("Сначала. Оба на табуретках, долгов нет. Пусть сами.")
            return self._state()

    def set_auto(self, on: bool) -> dict[str, Any]:
        with self.lock:
            self.autopilot = on
            self._say("Пусть сами. Мы только смотрим." if on else "Стоп. Теперь можно ткнуть пальцем.")
            return self._state()

    def poke_shot(self, sex: str) -> dict[str, Any]:
        with self.lock:
            self.shot(sex)
            why = "угощение. На вход — сахар. DA сам."
            self.players[sex].why = why
            self._set_beat(sex, "shot", why, "sez_potential")
            self._fx(sex=sex, kind="shot", hold_ms=self.beat["hold_ms"])
            return self._state()

    def poke_spin(self, sex: str) -> dict[str, Any]:
        with self.lock:
            info = self.spin(sex)
            info.setdefault("sex", sex)
            why = "сама крутит. Посмотрим."
            self.players[sex].why = why
            self._set_beat(sex, "spin", why, "mb_reward", info)
            self._fx(kind="spin", hold_ms=self.beat["hold_ms"], **info)
            st = self._state()
            st["spin"] = info
            return st


bar = Bar()
app = FastAPI(title="Муха выбрала быть счастливой", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/")
def index() -> FileResponse:
    return FileResponse(ROOT / "index.html")


@app.get("/stage.js")
def stage_js() -> FileResponse:
    return FileResponse(ROOT / "stage.js", media_type="application/javascript")


@app.get("/fly.js")
def fly_js() -> FileResponse:
    return FileResponse(ROOT / "fly.js", media_type="application/javascript")


@app.get("/preview.html")
def preview() -> FileResponse:
    """Development turntable for the accessories; not linked from the game."""
    return FileResponse(ROOT / "preview.html")


app.mount("/vendor", StaticFiles(directory=ROOT / "vendor"), name="vendor")


@app.get("/api/state")
def get_state() -> dict[str, Any]:
    return bar.state()


@app.post("/api/tick")
def post_tick() -> dict[str, Any]:
    return bar.tick()


@app.post("/api/shot")
def post_shot(body: SexBody) -> dict[str, Any]:
    return bar.poke_shot(body.sex)


@app.post("/api/spin")
def post_spin(body: SexBody) -> dict[str, Any]:
    return bar.poke_spin(body.sex)


@app.post("/api/borrow")
def post_borrow(body: SexBody) -> dict[str, Any]:
    with bar.lock:
        bar.borrow(body.sex)
        bar._fx(sex=body.sex, kind="borrow")
        return bar._state()


@app.post("/api/auto")
def post_auto(body: AutoBody) -> dict[str, Any]:
    return bar.set_auto(body.on)


@app.post("/api/reset")
def post_reset() -> dict[str, Any]:
    return bar.reset()
