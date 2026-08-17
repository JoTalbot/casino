"""
Ядро оценки выигрышей.

Здесь строится главная структура математики — таблица выплат по линии,
проиндексированная кортежем символов (s0, s1, s2, s3, s4).

Зачем таблица, а не функция: комбинаций всего 11^5 = 161 051. Один раз
посчитав выплату для каждой, мы получаем и точный аналитический расчёт
(свёртка тензора с вероятностями), и быструю симуляцию (одна выборка
по индексу). Оба метода используют ОДНУ И ТУ ЖЕ таблицу, поэтому
расхождение между теорией и симуляцией невозможно по построению.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

import numpy as np

from .config import GameConfig
from .paylines import PAYLINES, NUM_REELS, NUM_ROWS


def build_symbol_index(cfg: GameConfig) -> Dict[str, int]:
    """Символ -> целочисленный код. Порядок задан в config.symbols."""
    return {sym: i for i, sym in enumerate(cfg.symbols)}


def build_pay_lookup(cfg: GameConfig) -> np.ndarray:
    """
    Возвращает тензор формы (S, S, S, S, S) с выплатой за линию
    в единицах ставки на линию.

    Правила оценки линии (классические, слева направо):
      * рассматриваем каждый оплачиваемый символ p;
      * длина серии = число подряд идущих слева барабанов,
        где стоит p или wild;
      * выплата = paytable[p][длина серии], если длина >= 3;
      * итог по линии = максимум по всем p.

    Линия из одних wild автоматически оплачивается как самый дорогой
    символ — это следует из максимума и не требует отдельного правила.
    Scatter в paytable отсутствует, поэтому по линиям он не платит.
    """
    idx = build_symbol_index(cfg)
    n_sym = len(cfg.symbols)
    wild_code = idx[cfg.wild]

    # Все возможные кортежи символов по 5 барабанам.
    grid = np.indices((n_sym,) * NUM_REELS).reshape(NUM_REELS, -1).T  # (n_sym^5, 5)

    best = np.zeros(grid.shape[0], dtype=np.int64)

    for sym, tiers in cfg.paytable.items():
        p_code = idx[sym]

        # Таблица «длина серии -> выплата», индексы 0..5.
        pay_by_len = np.zeros(NUM_REELS + 1, dtype=np.int64)
        for count, amount in tiers.items():
            if count <= NUM_REELS:
                pay_by_len[count] = amount

        match = (grid == p_code) | (grid == wild_code)  # (N, 5)

        # Длина ведущей серии, посчитанная вложенным умножением:
        # m0 * (1 + m1 * (1 + m2 * (1 + m3 * (1 + m4))))
        run = match[:, 4].astype(np.int64)
        for reel in range(NUM_REELS - 2, -1, -1):
            run = match[:, reel].astype(np.int64) * (1 + run)

        np.maximum(best, pay_by_len[run], out=best)

    return best.reshape((n_sym,) * NUM_REELS)


def reel_symbol_probabilities(cfg: GameConfig, reels: List[List[str]]) -> np.ndarray:
    """
    Маргинальное распределение символов на каждом барабане.

    Обоснование: позиция остановки распределена равномерно по ленте,
    поэтому символ в любом фиксированном ряду окна распределён
    равномерно по всем позициям ленты. Барабаны независимы.
    """
    idx = build_symbol_index(cfg)
    n_sym = len(cfg.symbols)
    probs = np.zeros((len(reels), n_sym), dtype=np.float64)

    for r, reel in enumerate(reels):
        for sym in reel:
            probs[r, idx[sym]] += 1.0
        probs[r] /= len(reel)

    return probs


def scatter_count_distribution(cfg: GameConfig, reels: List[List[str]]) -> np.ndarray:
    """
    Точное распределение числа scatter-символов в окне 5x3.

    Считается перебором всех позиций остановки каждого барабана
    (scatter может встретиться в окне до 3 раз на барабан),
    затем свёрткой распределений пяти независимых барабанов.

    Возвращает вектор вероятностей длины (макс. число scatter + 1).
    """
    per_reel: List[np.ndarray] = []

    for reel in reels:
        length = len(reel)
        counts = np.zeros(NUM_ROWS + 1, dtype=np.float64)
        for stop in range(length):
            in_window = sum(
                1 for row in range(NUM_ROWS) if reel[(stop + row) % length] == cfg.scatter
            )
            counts[in_window] += 1.0
        per_reel.append(counts / length)

    total = per_reel[0]
    for dist in per_reel[1:]:
        total = np.convolve(total, dist)

    return total


def scatter_positions_per_stop(cfg: GameConfig, reel: List[str]) -> np.ndarray:
    """Для каждой позиции остановки — сколько scatter попадает в окно."""
    length = len(reel)
    result = np.zeros(length, dtype=np.int8)
    for stop in range(length):
        result[stop] = sum(
            1 for row in range(NUM_ROWS) if reel[(stop + row) % length] == cfg.scatter
        )
    return result


def encode_reels(cfg: GameConfig, reels: List[List[str]]) -> List[np.ndarray]:
    """Ленты в виде массивов целочисленных кодов."""
    idx = build_symbol_index(cfg)
    return [np.array([idx[s] for s in reel], dtype=np.int16) for reel in reels]


def window_from_stops(
    encoded_reels: List[np.ndarray], stops: np.ndarray
) -> np.ndarray:
    """
    Разворачивает позиции остановки в окно символов.

    stops: массив формы (N, 5) с позициями остановки.
    Возвращает массив формы (N, 5, 3): [спин, барабан, ряд].
    """
    n_spins = stops.shape[0]
    window = np.empty((n_spins, NUM_REELS, NUM_ROWS), dtype=np.int16)

    for reel in range(NUM_REELS):
        strip = encoded_reels[reel]
        length = strip.shape[0]
        for row in range(NUM_ROWS):
            window[:, reel, row] = strip[(stops[:, reel] + row) % length]

    return window


def line_indices(window: np.ndarray, pay_lookup: np.ndarray) -> np.ndarray:
    """
    Считает суммарную выплату по всем линиям для каждого спина.

    window: (N, 5, 3) коды символов.
    Возвращает (N,) — сумма выплат в единицах ставки на линию.
    """
    n_sym = pay_lookup.shape[0]
    flat_lookup = pay_lookup.reshape(-1)
    n_spins = window.shape[0]

    total = np.zeros(n_spins, dtype=np.int64)

    for line in PAYLINES:
        # Линейный индекс в тензоре выплат: s0*S^4 + s1*S^3 + ... + s4
        flat_index = np.zeros(n_spins, dtype=np.int64)
        for reel in range(NUM_REELS):
            flat_index = flat_index * n_sym + window[:, reel, line[reel]].astype(np.int64)
        total += flat_lookup[flat_index]

    return total


def evaluate_single_window(
    cfg: GameConfig, window_symbols: List[List[str]], pay_lookup: np.ndarray
) -> Tuple[int, List[dict]]:
    """
    Оценка одного окна в «человеческом» виде — для отладки и юнит-тестов.

    window_symbols: список из 5 барабанов по 3 символа.
    Возвращает (суммарная выплата по линиям, детализация по линиям).
    """
    idx = build_symbol_index(cfg)
    n_sym = len(cfg.symbols)
    flat_lookup = pay_lookup.reshape(-1)

    total = 0
    details = []

    for line_no, line in enumerate(PAYLINES, start=1):
        flat_index = 0
        symbols = []
        for reel in range(NUM_REELS):
            sym = window_symbols[reel][line[reel]]
            symbols.append(sym)
            flat_index = flat_index * n_sym + idx[sym]

        payout = int(flat_lookup[flat_index])
        if payout > 0:
            total += payout
            details.append({"line": line_no, "symbols": symbols, "payout": payout})

    return total, details
