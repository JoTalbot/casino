"""
Симуляция Monte Carlo.

Назначение — независимая проверка аналитического расчёта и получение
тех характеристик, которые аналитически считать дорого:
распределение выигрышей, реальная hit frequency (линии зависимы),
максимальный выигрыш, поведение банкролла.

Векторизация: спины обрабатываются пачками по несколько сот тысяч.
Внутри пачки всё считается матричными операциями numpy, поэтому
10 млн спинов укладываются в десятки секунд, а не в часы.

ВАЖНО: здесь используется numpy.random (Mersenne Twister / PCG64) —
это НЕ криптостойкий генератор, и в продакшене он недопустим.
Для симуляции это правильный выбор: нужна скорость и воспроизводимость.
Продакшен-RNG живёт отдельно, в `src/engine/rng.ts`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np

from .config import GameConfig
from .engine import (
    build_pay_lookup,
    encode_reels,
    line_indices,
    scatter_positions_per_stop,
    window_from_stops,
)
from .paylines import NUM_REELS


@dataclass
class SimulationResult:
    """Итоги симуляции."""

    spins: int
    total_bet: int
    total_win: int
    rtp: float

    base_win: int
    free_win: int
    scatter_win: int

    hits: int                      # спины с выигрышем > 0
    hit_frequency: float
    triggers: int                  # число запусков фриспинов
    trigger_frequency: float
    free_spins_played: int
    retriggers: int

    max_win_x: float               # максимальный выигрыш за раунд, в ставках
    mean_win_x: float
    std_win_x: float
    volatility_index: float

    win_distribution: Dict[str, int] = field(default_factory=dict)
    percentiles: Dict[str, float] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "spins": self.spins,
            "totalBet": self.total_bet,
            "totalWin": self.total_win,
            "rtp": self.rtp,
            "baseWin": self.base_win,
            "freeWin": self.free_win,
            "scatterWin": self.scatter_win,
            "hits": self.hits,
            "hitFrequency": self.hit_frequency,
            "triggers": self.triggers,
            "triggerFrequency": self.trigger_frequency,
            "freeSpinsPlayed": self.free_spins_played,
            "retriggers": self.retriggers,
            "maxWinX": self.max_win_x,
            "meanWinX": self.mean_win_x,
            "stdWinX": self.std_win_x,
            "volatilityIndex": self.volatility_index,
            "winDistribution": self.win_distribution,
            "percentiles": self.percentiles,
        }


# Границы корзин распределения выигрышей, в ставках.
# Нулевые выигрыши считаются отдельно (первая метка), поэтому
# гистограмма строится только по положительным значениям:
# 11 границ -> 11 корзин, плюс корзина нуля = 12 меток.
WIN_BUCKETS = [0, 0.5, 1, 2, 5, 10, 20, 50, 100, 500, 1000, float("inf")]
BUCKET_LABELS = [
    "0 (без выигрыша)",
    "0-0.5x",
    "0.5-1x",
    "1-2x",
    "2-5x",
    "5-10x",
    "10-20x",
    "20-50x",
    "50-100x",
    "100-500x",
    "500-1000x",
    "1000x+",
]


class Simulator:
    """Векторизованный симулятор слота."""

    def __init__(self, cfg: GameConfig, seed: int = 20260817):
        self.cfg = cfg
        self.rng = np.random.default_rng(seed)
        self.pay_lookup = build_pay_lookup(cfg)
        self.base_enc = encode_reels(cfg, cfg.base_reels)
        self.free_enc = encode_reels(cfg, cfg.free_reels)
        self.base_lengths = np.array([len(r) for r in cfg.base_reels])
        self.free_lengths = np.array([len(r) for r in cfg.free_reels])
        self.base_scatter_map = [
            scatter_positions_per_stop(cfg, reel) for reel in cfg.base_reels
        ]
        self.free_scatter_map = [
            scatter_positions_per_stop(cfg, reel) for reel in cfg.free_reels
        ]
        self.total_bet = cfg.lines  # 1 кредит на линию

    # ---------- низкоуровневые операции ----------

    def _random_stops(self, n: int, lengths: np.ndarray) -> np.ndarray:
        """Случайные позиции остановки для n спинов."""
        stops = np.empty((n, NUM_REELS), dtype=np.int64)
        for reel in range(NUM_REELS):
            stops[:, reel] = self.rng.integers(0, lengths[reel], size=n)
        return stops

    def _scatter_counts(self, stops: np.ndarray, scatter_map: List[np.ndarray]) -> np.ndarray:
        """Число scatter в окне для каждого спина."""
        total = np.zeros(stops.shape[0], dtype=np.int64)
        for reel in range(NUM_REELS):
            total += scatter_map[reel][stops[:, reel]]
        return total

    def _scatter_payout(self, scatter_counts: np.ndarray) -> np.ndarray:
        """Прямые выплаты за scatter, в кредитах."""
        payout = np.zeros(scatter_counts.shape[0], dtype=np.int64)
        for count, mult in self.cfg.scatter_pays.items():
            payout += (scatter_counts == count) * (mult * self.total_bet)
        return payout

    def _spin_batch(self, n: int, free_mode: bool):
        """
        Один пакет спинов.

        Возвращает (выплата по линиям, выплата за scatter, число scatter).
        Выплаты в кредитах, БЕЗ множителя фриспинов.
        """
        lengths = self.free_lengths if free_mode else self.base_lengths
        enc = self.free_enc if free_mode else self.base_enc
        smap = self.free_scatter_map if free_mode else self.base_scatter_map

        stops = self._random_stops(n, lengths)
        window = window_from_stops(enc, stops)
        line_pay = line_indices(window, self.pay_lookup)  # в ставках на линию
        scatter_counts = self._scatter_counts(stops, smap)
        scatter_pay = self._scatter_payout(scatter_counts)

        return line_pay, scatter_pay, scatter_counts

    # ---------- основной цикл ----------

    def run(
        self,
        spins: int,
        batch_size: int = 250_000,
        progress: Optional[callable] = None,
    ) -> SimulationResult:
        """
        Прогоняет заданное число базовых спинов.

        Раунд = один базовый спин плюс, если сработал триггер,
        все связанные с ним фриспины (включая ретриггеры).
        """
        cfg = self.cfg
        bet = self.total_bet
        cap = cfg.max_win_cap * bet

        total_win = 0
        base_win_acc = 0
        free_win_acc = 0
        scatter_win_acc = 0
        hits = 0
        triggers = 0
        free_spins_played = 0
        retriggers = 0

        max_win = 0
        sum_win = 0.0
        sum_win_sq = 0.0
        bucket_counts = np.zeros(len(BUCKET_LABELS), dtype=np.int64)

        # Резервуарная выборка для перцентилей: хранить 10 млн значений
        # в памяти нельзя, поэтому берём случайную подвыборку.
        reservoir_size = min(spins, 2_000_000)
        reservoir = np.zeros(reservoir_size, dtype=np.float64)
        reservoir_filled = 0

        done = 0
        while done < spins:
            n = min(batch_size, spins - done)

            line_pay, scatter_pay, scatter_counts = self._spin_batch(n, free_mode=False)
            round_win = line_pay + scatter_pay

            base_win_acc += int(line_pay.sum())
            scatter_win_acc += int(scatter_pay.sum())

            # --- Фриспины ---
            trigger_mask = scatter_counts >= cfg.scatter_trigger
            n_triggers = int(trigger_mask.sum())

            if n_triggers:
                triggers += n_triggers
                free_win, spins_played, n_retrig = self._play_free_spins(
                    scatter_counts[trigger_mask]
                )
                round_win[trigger_mask] += free_win
                free_win_acc += int(free_win.sum())
                free_spins_played += spins_played
                retriggers += n_retrig

            # --- Потолок выигрыша ---
            np.minimum(round_win, cap, out=round_win)

            total_win += int(round_win.sum())
            hits += int((round_win > 0).sum())

            win_x = round_win / bet
            batch_max = float(win_x.max()) if n else 0.0
            max_win = max(max_win, batch_max)
            sum_win += float(win_x.sum())
            sum_win_sq += float((win_x.astype(np.float64) ** 2).sum())

            # Корзина 0 — спины без выигрыша, остальные — по границам.
            zero_mask = round_win == 0
            bucket_counts[0] += int(zero_mask.sum())
            positive = win_x[~zero_mask]
            if positive.size:
                bucket_counts[1:] += np.histogram(positive, bins=WIN_BUCKETS)[0]

            # Заполнение резервуара
            if reservoir_filled < reservoir_size:
                take = min(n, reservoir_size - reservoir_filled)
                reservoir[reservoir_filled:reservoir_filled + take] = win_x[:take]
                reservoir_filled += take

            done += n
            if progress:
                progress(done, spins)

        total_bet_amount = spins * bet
        rtp = total_win / total_bet_amount if total_bet_amount else 0.0

        mean_win = sum_win / spins
        variance = max(0.0, sum_win_sq / spins - mean_win ** 2)
        std_win = variance ** 0.5

        # Индекс волатильности по методике GLI: 1.96 * sqrt(variance / spins_ref)
        # Приводится к 10 спинам — отраслевая практика.
        volatility_index = 1.96 * (variance ** 0.5)

        sample = reservoir[:reservoir_filled]
        percentiles = {
            "p50": float(np.percentile(sample, 50)),
            "p90": float(np.percentile(sample, 90)),
            "p99": float(np.percentile(sample, 99)),
            "p999": float(np.percentile(sample, 99.9)),
            "p9999": float(np.percentile(sample, 99.99)),
        }

        return SimulationResult(
            spins=spins,
            total_bet=total_bet_amount,
            total_win=total_win,
            rtp=rtp,
            base_win=base_win_acc,
            free_win=free_win_acc,
            scatter_win=scatter_win_acc,
            hits=hits,
            hit_frequency=hits / spins,
            triggers=triggers,
            trigger_frequency=triggers / spins,
            free_spins_played=free_spins_played,
            retriggers=retriggers,
            max_win_x=max_win,
            mean_win_x=mean_win,
            std_win_x=std_win,
            volatility_index=volatility_index,
            win_distribution={
                label: int(count) for label, count in zip(BUCKET_LABELS, bucket_counts)
            },
            percentiles=percentiles,
        )

    def sample_rounds(
        self,
        rounds: int,
        batch_size: int = 250_000,
        progress: Optional[callable] = None,
    ) -> np.ndarray:
        """
        Возвращает выигрыши за раунд в ставках, по одному числу на раунд.

        В отличие от `run()`, который агрегирует всё на лету, здесь
        сохраняется сырая выборка: она нужна для бутстрапа доверительных
        интервалов и симуляции банкролла (`slotmath.confidence`).
        Раунд включает базовый спин, все его фриспины и потолок.

        Память: float64 по 8 байт на раунд, то есть 10 млн раундов = 80 МБ.
        """
        cfg = self.cfg
        bet = self.total_bet
        cap = cfg.max_win_cap * bet

        out = np.empty(rounds, dtype=np.float64)
        done = 0
        while done < rounds:
            n = min(batch_size, rounds - done)

            line_pay, scatter_pay, scatter_counts = self._spin_batch(n, free_mode=False)
            round_win = line_pay + scatter_pay

            trigger_mask = scatter_counts >= cfg.scatter_trigger
            if int(trigger_mask.sum()):
                free_win, _, _ = self._play_free_spins(scatter_counts[trigger_mask])
                round_win[trigger_mask] += free_win

            np.minimum(round_win, cap, out=round_win)
            out[done:done + n] = round_win / bet

            done += n
            if progress:
                progress(done, rounds)

        return out

    def _play_free_spins(self, trigger_scatters: np.ndarray):
        """
        Разыгрывает бонусные раунды.

        Векторизовано по «поколениям»: на каждой итерации крутим
        по одному фриспину для всех активных бонусов сразу.
        Бонусы с исчерпанным счётчиком выбывают.
        """
        cfg = self.cfg
        n_bonuses = trigger_scatters.shape[0]

        remaining = np.zeros(n_bonuses, dtype=np.int64)
        for count, award in cfg.free_spins_award.items():
            remaining += (trigger_scatters == count) * award

        accumulated = np.zeros(n_bonuses, dtype=np.int64)
        spins_played = 0
        retriggers = 0

        # Защита от патологического зацикливания (не должно срабатывать
        # при корректной математике — analyse() проверяет сходимость).
        max_generations = 500
        generation = 0

        while True:
            active = remaining > 0
            n_active = int(active.sum())
            if n_active == 0:
                break

            generation += 1
            if generation > max_generations:
                break

            line_pay, scatter_pay, scatter_counts = self._spin_batch(n_active, free_mode=True)

            win = line_pay * cfg.free_spin_multiplier + scatter_pay
            accumulated[active] += win
            spins_played += n_active

            remaining[active] -= 1

            if cfg.retrigger_enabled:
                retrig_mask = scatter_counts >= cfg.scatter_trigger
                n_retrig = int(retrig_mask.sum())
                if n_retrig:
                    retriggers += n_retrig
                    extra = np.zeros(n_active, dtype=np.int64)
                    for count, award in cfg.free_spins_award.items():
                        extra += (scatter_counts == count) * award
                    idx = np.flatnonzero(active)
                    remaining[idx] += extra

        return accumulated, spins_played, retriggers
