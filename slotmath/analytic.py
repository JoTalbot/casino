"""
Точный аналитический расчёт RTP.

Ключевой момент: прямой перебор полного цикла невозможен —
при лентах по ~40 позиций это 40^5 ≈ 102 млн комбинаций для одного окна,
а с учётом трёх рядов и 20 линий счёт идёт на триллионы операций.

Решение — свёртка. Выплата по линии зависит только от кортежа
из 5 символов, а барабаны независимы. Поэтому

    E[выплата по линии] = sum_{s0..s4} P(s0)P(s1)P(s2)P(s3)P(s4) * pay(s0..s4)

то есть свёртка тензора выплат с внешним произведением маргинальных
распределений. Это точное значение, а не приближение, и считается
за миллисекунды.

Все 20 линий статистически одинаковы (каждая берёт по одному символу
с каждого барабана, и распределение символа не зависит от ряда),
поэтому достаточно посчитать одну линию и умножить на 20.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

import numpy as np

from .config import GameConfig
from .engine import (
    build_pay_lookup,
    build_symbol_index,
    reel_symbol_probabilities,
    scatter_count_distribution,
)
from .paylines import NUM_REELS


@dataclass
class AnalyticResult:
    """Разложение теоретического RTP по компонентам."""

    base_line_rtp: float          # вклад линейных выплат базовой игры
    scatter_pay_rtp: float        # вклад прямых выплат за scatter
    free_spins_rtp: float         # вклад режима фриспинов
    total_rtp: float

    trigger_probability: float    # вероятность запуска фриспинов за спин
    expected_free_spins: float    # ожидаемое число фриспинов за один триггер (с ретриггером)
    retrigger_probability: float  # вероятность ретриггера внутри фриспинов
    free_spin_value: float        # ожидаемая выплата одного фриспина, в ставках

    hit_frequency_lines: float    # доля спинов с выигрышем хотя бы по одной линии

    def as_dict(self) -> dict:
        return {
            "baseLineRtp": self.base_line_rtp,
            "scatterPayRtp": self.scatter_pay_rtp,
            "freeSpinsRtp": self.free_spins_rtp,
            "totalRtp": self.total_rtp,
            "triggerProbability": self.trigger_probability,
            "expectedFreeSpins": self.expected_free_spins,
            "retriggerProbability": self.retrigger_probability,
            "freeSpinValue": self.free_spin_value,
            "hitFrequencyLines": self.hit_frequency_lines,
        }


def expected_line_payout(
    cfg: GameConfig, reels: List[List[str]], pay_lookup: np.ndarray
) -> float:
    """
    Матожидание выплаты по ОДНОЙ линии, в единицах ставки на линию.

    Считается точной свёрткой: последовательно сворачиваем тензор
    выплат с распределением каждого барабана.
    """
    probs = reel_symbol_probabilities(cfg, reels)

    # Свёртка по барабанам: на каждом шаге схлопываем первую ось.
    acc = pay_lookup.astype(np.float64)
    for reel in range(NUM_REELS):
        acc = np.tensordot(probs[reel], acc, axes=([0], [0]))

    return float(acc)


def line_hit_probability(
    cfg: GameConfig, reels: List[List[str]], pay_lookup: np.ndarray
) -> float:
    """Вероятность, что конкретная линия принесёт выигрыш."""
    probs = reel_symbol_probabilities(cfg, reels)

    acc = (pay_lookup > 0).astype(np.float64)
    for reel in range(NUM_REELS):
        acc = np.tensordot(probs[reel], acc, axes=([0], [0]))

    return float(acc)


def analyse(cfg: GameConfig) -> AnalyticResult:
    """Полный аналитический расчёт RTP игры."""
    pay_lookup = build_pay_lookup(cfg)
    total_bet = float(cfg.lines)  # ставка = 1 кредит на линию

    # ---- 1. Линейные выплаты базовой игры ----
    base_line_per_line = expected_line_payout(cfg, cfg.base_reels, pay_lookup)
    base_line_total = base_line_per_line * cfg.lines
    base_line_rtp = base_line_total / total_bet

    # ---- 2. Распределение scatter в базовой игре ----
    base_scatter_dist = scatter_count_distribution(cfg, cfg.base_reels)

    scatter_pay_total = 0.0
    for count, mult in cfg.scatter_pays.items():
        if count < len(base_scatter_dist):
            scatter_pay_total += base_scatter_dist[count] * mult * total_bet
    scatter_pay_rtp = scatter_pay_total / total_bet

    trigger_prob = float(base_scatter_dist[cfg.scatter_trigger:].sum())

    # ---- 3. Фриспины ----
    free_line_per_line = expected_line_payout(cfg, cfg.free_reels, pay_lookup)
    free_scatter_dist = scatter_count_distribution(cfg, cfg.free_reels)

    # Выплата одного фриспина: линии + scatter-выплаты, всё под множителем.
    free_line_total = free_line_per_line * cfg.lines * cfg.free_spin_multiplier
    free_scatter_total = 0.0
    for count, mult in cfg.scatter_pays.items():
        if count < len(free_scatter_dist):
            free_scatter_total += free_scatter_dist[count] * mult * total_bet
    free_spin_value = (free_line_total + free_scatter_total) / total_bet

    # Ожидаемое число фриспинов за триггер.
    # Базовое: взвешенное по количеству скаттеров, вызвавших триггер.
    if trigger_prob > 0:
        base_award = 0.0
        for count in range(cfg.scatter_trigger, len(base_scatter_dist)):
            award = cfg.free_spins_award.get(count, 0)
            base_award += base_scatter_dist[count] * award
        base_award /= trigger_prob
    else:
        base_award = 0.0

    # Ретриггер: внутри фриспинов снова выпадает scatter_trigger+ скаттеров.
    if cfg.retrigger_enabled:
        retrigger_prob = float(free_scatter_dist[cfg.scatter_trigger:].sum())
        # Средняя добавка за один ретриггер.
        if retrigger_prob > 0:
            retrigger_award = 0.0
            for count in range(cfg.scatter_trigger, len(free_scatter_dist)):
                award = cfg.free_spins_award.get(count, 0)
                retrigger_award += free_scatter_dist[count] * award
            retrigger_award /= retrigger_prob
        else:
            retrigger_award = 0.0

        # Ожидаемое число дополнительных спинов на один фриспин:
        #   g = retrigger_prob * retrigger_award
        # Полное число спинов — сумма геометрического ряда: n = base / (1 - g).
        # Расходимость при g >= 1 означает бесконечную игру — недопустимо.
        growth = retrigger_prob * retrigger_award
        if growth >= 1.0:
            raise ValueError(
                f"Ретриггер расходится: ожидаемый прирост {growth:.4f} >= 1. "
                "Уменьши число scatter на лентах фриспинов или размер награды."
            )
        expected_spins = base_award / (1.0 - growth)
    else:
        retrigger_prob = 0.0
        expected_spins = base_award

    free_spins_rtp = trigger_prob * expected_spins * free_spin_value

    # ---- 4. Hit frequency ----
    p_line_hit = line_hit_probability(cfg, cfg.base_reels, pay_lookup)
    # Линии не независимы (делят символы), поэтому 1-(1-p)^20 — верхняя оценка.
    # Точное значение даёт симуляция; здесь помечаем как приближение.
    hit_freq_approx = 1.0 - (1.0 - p_line_hit) ** cfg.lines

    total_rtp = base_line_rtp + scatter_pay_rtp + free_spins_rtp

    return AnalyticResult(
        base_line_rtp=base_line_rtp,
        scatter_pay_rtp=scatter_pay_rtp,
        free_spins_rtp=free_spins_rtp,
        total_rtp=total_rtp,
        trigger_probability=trigger_prob,
        expected_free_spins=expected_spins,
        retrigger_probability=retrigger_prob,
        free_spin_value=free_spin_value,
        hit_frequency_lines=hit_freq_approx,
    )


def symbol_rtp_breakdown(cfg: GameConfig) -> Dict[str, float]:
    """
    Вклад каждого символа в RTP базовой игры.

    Нужен для PAR sheet: лаборатория проверяет разложение,
    а не только итоговое число.
    """
    idx = build_symbol_index(cfg)
    n_sym = len(cfg.symbols)
    probs = reel_symbol_probabilities(cfg, cfg.base_reels)
    wild_code = idx[cfg.wild]

    grid = np.indices((n_sym,) * NUM_REELS).reshape(NUM_REELS, -1).T
    full_lookup = build_pay_lookup(cfg).reshape(-1)

    breakdown: Dict[str, float] = {}

    for sym, tiers in cfg.paytable.items():
        p_code = idx[sym]

        pay_by_len = np.zeros(NUM_REELS + 1, dtype=np.int64)
        for count, amount in tiers.items():
            if count <= NUM_REELS:
                pay_by_len[count] = amount

        match = (grid == p_code) | (grid == wild_code)
        run = match[:, 4].astype(np.int64)
        for reel in range(NUM_REELS - 2, -1, -1):
            run = match[:, reel].astype(np.int64) * (1 + run)

        own = pay_by_len[run]
        # Символ получает вклад только там, где ИМЕННО он даёт максимум.
        credited = np.where(own >= full_lookup, own, 0).astype(np.float64)

        acc = credited.reshape((n_sym,) * NUM_REELS)
        for reel in range(NUM_REELS):
            acc = np.tensordot(probs[reel], acc, axes=([0], [0]))

        # На ставку: (вклад на линию * число линий) / общая ставка = вклад на линию
        breakdown[sym] = float(acc)

    return breakdown
