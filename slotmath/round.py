"""
Эталонное проигрывание одного раунда — от сидов до итоговой выплаты.

Это ЕДИНСТВЕННОЕ место, где зафиксирован порядок обращений к RNG.
Всё остальное — сервер, клиент, офлайн-верификатор — обязано повторять
его байт в байт, иначе provably fair не работает.

Порядок жёстко определён так (см. docs/ROUND-PROTOCOL.md):

  1. Базовый спин: 5 обращений nextInt(len(baseReels[i])), i = 0..4.
  2. Если выпал триггер — фриспины разыгрываются ПО ОДНОМУ,
     каждый забирает 5 обращений nextInt(len(freeReels[i])), i = 0..4.
     Ретриггер увеличивает счётчик оставшихся спинов, порядок не меняет.

Модуль намеренно НЕ использует numpy: он должен читаться построчно и
переноситься на любой язык. Скорость здесь не важна — это эталон и
генератор фикстур, массовые прогоны делает `simulate.py`.

Совместимость с `src/engine/rng.ts` обеспечивается функциями
`hmac_block` и `RoundRandom` ниже: ключ HMAC — серверный сид как
UTF-8 строка (не как декодированные из hex байты), сообщение —
"clientSeed:nonce:cursor".
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .config import GameConfig
from .paylines import NUM_REELS, NUM_ROWS, PAYLINES

HMAC_BYTES = 32
BYTES_PER_FLOAT = 4
FLOATS_PER_BLOCK = HMAC_BYTES // BYTES_PER_FLOAT  # 8


def hash_server_seed(server_seed: str) -> str:
    """Коммитмент: SHA-256 от серверного сида, взятого как UTF-8 строка."""
    return hashlib.sha256(server_seed.encode("utf-8")).hexdigest()


def hmac_block(server_seed: str, client_seed: str, nonce: int, cursor: int) -> bytes:
    """Блок из 32 байт. Ключ — серверный сид как UTF-8, не как hex-байты."""
    message = f"{client_seed}:{nonce}:{cursor}".encode("utf-8")
    return hmac.new(server_seed.encode("utf-8"), message, hashlib.sha256).digest()


class RoundRandom:
    """Ленивый поток чисел одного раунда. Аналог класса из rng.ts."""

    def __init__(self, server_seed: str, client_seed: str, nonce: int):
        if ":" in client_seed:
            raise ValueError('clientSeed не может содержать ":"')
        self.server_seed = server_seed
        self.client_seed = client_seed
        self.nonce = nonce
        self.block_index = 0
        self.block = hmac_block(server_seed, client_seed, nonce, 0)
        self.offset = 0
        self.consumed = 0

    def next_float(self) -> float:
        if self.offset + BYTES_PER_FLOAT > HMAC_BYTES:
            self.block_index += 1
            self.block = hmac_block(
                self.server_seed, self.client_seed, self.nonce, self.block_index
            )
            self.offset = 0
        b = self.block
        o = self.offset
        self.offset += BYTES_PER_FLOAT
        self.consumed += 1
        return (
            b[o] / 256
            + b[o + 1] / 256 ** 2
            + b[o + 2] / 256 ** 3
            + b[o + 3] / 256 ** 4
        )

    def next_int(self, bound: int) -> int:
        if bound <= 0:
            raise ValueError(f"bound должен быть > 0, получено {bound}")
        return min(int(self.next_float() * bound), bound - 1)

    @property
    def draw_count(self) -> int:
        return self.consumed


# ---------------------------------------------------------------------------
# Оценка окна
# ---------------------------------------------------------------------------


def window_from_stops(reels: List[List[str]], stops: List[int]) -> List[List[str]]:
    """Окно 5x3 в виде window[reel][row]."""
    window: List[List[str]] = []
    for reel_index in range(NUM_REELS):
        strip = reels[reel_index]
        length = len(strip)
        stop = stops[reel_index]
        window.append([strip[(stop + row) % length] for row in range(NUM_ROWS)])
    return window


def evaluate_lines(
    cfg: GameConfig, window: List[List[str]]
) -> Tuple[int, List[dict]]:
    """
    Выплата по всем линиям в единицах ставки на линию + детализация.

    Правило классическое: слева направо от первого барабана, wild заменяет
    любой оплачиваемый символ, итог по линии — максимум по всем символам.
    """
    total = 0
    details: List[dict] = []

    for line_number, line in enumerate(PAYLINES, start=1):
        symbols = [window[reel][line[reel]] for reel in range(NUM_REELS)]

        best_pay = 0
        best_symbol: Optional[str] = None
        best_run = 0

        for symbol, tiers in cfg.paytable.items():
            run = 0
            for reel in range(NUM_REELS):
                if symbols[reel] == symbol or symbols[reel] == cfg.wild:
                    run += 1
                else:
                    break
            pay = tiers.get(run, 0) if run >= 3 else 0
            if pay > best_pay:
                best_pay = pay
                best_symbol = symbol
                best_run = run

        if best_pay > 0:
            total += best_pay
            details.append(
                {
                    "line": line_number,
                    "symbol": best_symbol,
                    "count": best_run,
                    "positions": [[reel, line[reel]] for reel in range(best_run)],
                    "pay": best_pay,
                }
            )

    return total, details


def count_scatters(cfg: GameConfig, window: List[List[str]]) -> int:
    return sum(1 for reel in window for symbol in reel if symbol == cfg.scatter)


# ---------------------------------------------------------------------------
# Раунд
# ---------------------------------------------------------------------------


@dataclass
class SpinRecord:
    index: int
    free: bool
    reel_stops: List[int]
    grid: List[List[str]]
    win: int
    multiplier: int
    scatter_count: int
    triggered_free_spins: int
    win_details: List[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "index": self.index,
            "free": self.free,
            "reelStops": self.reel_stops,
            "grid": self.grid,
            "win": self.win,
            "multiplier": self.multiplier,
            "scatterCount": self.scatter_count,
            "triggeredFreeSpins": self.triggered_free_spins,
            "winDetails": self.win_details,
        }


@dataclass
class RoundRecord:
    server_seed_hash: str
    client_seed: str
    nonce: int
    bet_per_line: int
    lines: int
    total_bet: int
    total_win: int
    capped: bool
    draw_count: int
    spins: List[SpinRecord]

    def as_dict(self) -> dict:
        return {
            "serverSeedHash": self.server_seed_hash,
            "clientSeed": self.client_seed,
            "nonce": self.nonce,
            "betPerLine": self.bet_per_line,
            "lines": self.lines,
            "totalBet": self.total_bet,
            "totalWin": self.total_win,
            "capped": self.capped,
            "drawCount": self.draw_count,
            "spins": [s.as_dict() for s in self.spins],
        }


# Предохранитель от патологического зацикливания на ретриггерах.
# При принятой математике недостижим: вероятность ретриггера 0.38%,
# 200 фриспинов подряд имеют вероятность порядка 10^-500.
MAX_FREE_SPINS = 200


def play_round(
    cfg: GameConfig,
    server_seed: str,
    client_seed: str,
    nonce: int,
    bet_per_line: int = 1,
) -> RoundRecord:
    """Проигрывает раунд целиком: базовый спин плюс вся серия фриспинов."""
    rng = RoundRandom(server_seed, client_seed, nonce)
    total_bet = bet_per_line * cfg.lines
    spins: List[SpinRecord] = []

    # --- Базовый спин ---
    base_lengths = [len(r) for r in cfg.base_reels]
    stops = [rng.next_int(n) for n in base_lengths]
    window = window_from_stops(cfg.base_reels, stops)

    line_pay, details = evaluate_lines(cfg, window)
    scatter_count = count_scatters(cfg, window)
    scatter_pay = cfg.scatter_pays.get(scatter_count, 0) * total_bet

    if scatter_pay:
        details.append(
            {
                "symbol": cfg.scatter,
                "count": scatter_count,
                "pay": cfg.scatter_pays[scatter_count] * cfg.lines,
                "scatter": True,
            }
        )

    triggered = 0
    remaining = 0
    if scatter_count >= cfg.scatter_trigger:
        triggered = cfg.free_spins_award.get(scatter_count, 0)
        remaining = triggered

    base_win = line_pay * bet_per_line + scatter_pay
    spins.append(
        SpinRecord(
            index=0,
            free=False,
            reel_stops=stops,
            grid=window,
            win=base_win,
            multiplier=1,
            scatter_count=scatter_count,
            triggered_free_spins=triggered,
            win_details=details,
        )
    )
    total_win = base_win

    # --- Фриспины, строго по одному ---
    free_lengths = [len(r) for r in cfg.free_reels]
    spin_index = 1
    played = 0

    while remaining > 0 and played < MAX_FREE_SPINS:
        remaining -= 1
        played += 1

        f_stops = [rng.next_int(n) for n in free_lengths]
        f_window = window_from_stops(cfg.free_reels, f_stops)

        f_line_pay, f_details = evaluate_lines(cfg, f_window)
        f_scatter_count = count_scatters(cfg, f_window)
        f_scatter_pay = cfg.scatter_pays.get(f_scatter_count, 0) * total_bet

        if f_scatter_pay:
            f_details.append(
                {
                    "symbol": cfg.scatter,
                    "count": f_scatter_count,
                    "pay": cfg.scatter_pays[f_scatter_count] * cfg.lines,
                    "scatter": True,
                }
            )

        f_triggered = 0
        if cfg.retrigger_enabled and f_scatter_count >= cfg.scatter_trigger:
            f_triggered = cfg.free_spins_award.get(f_scatter_count, 0)
            remaining += f_triggered

        # Множитель применяется к линиям, но НЕ к прямой выплате за scatter.
        f_win = f_line_pay * cfg.free_spin_multiplier * bet_per_line + f_scatter_pay

        spins.append(
            SpinRecord(
                index=spin_index,
                free=True,
                reel_stops=f_stops,
                grid=f_window,
                win=f_win,
                multiplier=cfg.free_spin_multiplier,
                scatter_count=f_scatter_count,
                triggered_free_spins=f_triggered,
                win_details=f_details,
            )
        )
        total_win += f_win
        spin_index += 1

    # --- Потолок выигрыша ---
    cap = cfg.max_win_cap * total_bet
    capped = total_win > cap
    if capped:
        total_win = cap

    return RoundRecord(
        server_seed_hash=hash_server_seed(server_seed),
        client_seed=client_seed,
        nonce=nonce,
        bet_per_line=bet_per_line,
        lines=cfg.lines,
        total_bet=total_bet,
        total_win=total_win,
        capped=capped,
        draw_count=rng.draw_count,
        spins=spins,
    )
