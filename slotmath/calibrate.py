"""
Калибровка математики под целевой RTP.

Задача: подобрать счётчики символов на лентах так, чтобы
аналитический RTP попал в целевой коридор при сохранении
заданной волатильности и частоты фриспинов.

Метод: покоординатный спуск по «весам» премиальных и низких символов.
Мы не трогаем структуру (число барабанов, линий, таблицу выплат),
а меняем только количество копий символов на лентах.

Почему не градиентные методы: пространство дискретное (целые счётчики),
функция кусочно-постоянная. Покоординатный поиск с уменьшающимся шагом
работает надёжнее и полностью детерминирован — важно для воспроизводимости.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Callable, Dict, List, Tuple

from .analytic import analyse
from .config import GameConfig
from .strips import build_strip, counts_from_strip


@dataclass
class CalibrationReport:
    iterations: int
    start_rtp: float
    final_rtp: float
    target_rtp: float
    converged: bool
    history: List[Tuple[int, float]]


def _rebuild_reels(
    cfg: GameConfig,
    counts_per_reel: List[Dict[str, int]],
    premium: List[str],
) -> List[List[str]]:
    """Пересобирает ленты из счётчиков."""
    return [
        build_strip(counts, cfg.scatter, cfg.wild, premium)
        for counts in counts_per_reel
    ]


def calibrate(
    cfg: GameConfig,
    premium: List[str],
    tolerance: float = 0.002,
    max_iterations: int = 400,
    adjustable: List[str] | None = None,
) -> Tuple[GameConfig, CalibrationReport]:
    """
    Подгоняет базовые ленты под cfg.target_rtp.

    Стратегия:
      * если RTP слишком высок — добавляем копии низких символов
        (разбавляем ленту, снижая частоту дорогих комбинаций);
      * если слишком низок — добавляем премиальные.

    Scatter и wild не трогаем: они управляют частотой бонуса
    и настраиваются отдельно, до вызова калибровки.
    """
    cfg = copy.deepcopy(cfg)

    if adjustable is None:
        adjustable = [
            s for s in cfg.symbols if s not in (cfg.scatter, cfg.wild)
        ]

    low_syms = [s for s in adjustable if s not in premium]
    high_syms = [s for s in adjustable if s in premium]

    if not low_syms or not high_syms:
        raise ValueError("Нужны и премиальные, и низкие символы для калибровки")

    counts_per_reel = [counts_from_strip(reel) for reel in cfg.base_reels]

    result = analyse(cfg)
    start_rtp = result.total_rtp
    history: List[Tuple[int, float]] = [(0, start_rtp)]

    converged = abs(start_rtp - cfg.target_rtp) <= tolerance
    iteration = 0

    # Курсоры, чтобы правки распределялись по разным барабанам и символам.
    low_cursor = 0
    high_cursor = 0

    while not converged and iteration < max_iterations:
        iteration += 1
        error = result.total_rtp - cfg.target_rtp

        # Чем больше ошибка, тем крупнее шаг.
        step = 3 if abs(error) > 0.05 else (2 if abs(error) > 0.015 else 1)

        trial_counts = [dict(c) for c in counts_per_reel]

        if error > 0:
            # RTP высок -> разбавляем низкими символами
            for _ in range(step):
                reel_idx = low_cursor % len(trial_counts)
                sym = low_syms[(low_cursor // len(trial_counts)) % len(low_syms)]
                trial_counts[reel_idx][sym] = trial_counts[reel_idx].get(sym, 0) + 1
                low_cursor += 1
        else:
            # RTP низок -> добавляем премиальных, убираем низких, чтобы длина не росла
            for _ in range(step):
                reel_idx = high_cursor % len(trial_counts)
                sym = high_syms[(high_cursor // len(trial_counts)) % len(high_syms)]
                trial_counts[reel_idx][sym] = trial_counts[reel_idx].get(sym, 0) + 1

                # Компенсируем длину: снимаем один низкий символ с того же барабана
                donors = sorted(
                    (s for s in low_syms if trial_counts[reel_idx].get(s, 0) > 3),
                    key=lambda s: -trial_counts[reel_idx][s],
                )
                if donors:
                    trial_counts[reel_idx][donors[0]] -= 1
                high_cursor += 1

        try:
            trial_reels = _rebuild_reels(cfg, trial_counts, premium)
        except Exception:
            # Раскладка не удалась — пробуем другой барабан на следующей итерации
            low_cursor += 1
            high_cursor += 1
            continue

        candidate = copy.deepcopy(cfg)
        candidate.base_reels = trial_reels

        try:
            candidate.validate()
            new_result = analyse(candidate)
        except Exception:
            low_cursor += 1
            high_cursor += 1
            continue

        # Принимаем шаг, только если стало ближе к цели.
        if abs(new_result.total_rtp - cfg.target_rtp) < abs(result.total_rtp - cfg.target_rtp):
            counts_per_reel = trial_counts
            cfg.base_reels = trial_reels
            result = new_result
            history.append((iteration, result.total_rtp))
            converged = abs(result.total_rtp - cfg.target_rtp) <= tolerance
        else:
            low_cursor += 1
            high_cursor += 1

    report = CalibrationReport(
        iterations=iteration,
        start_rtp=start_rtp,
        final_rtp=result.total_rtp,
        target_rtp=cfg.target_rtp,
        converged=converged,
        history=history,
    )

    return cfg, report


def tune_paytable_scale(
    cfg: GameConfig,
    scale: float,
    symbols: List[str] | None = None,
) -> GameConfig:
    """
    Масштабирует выплаты (грубая настройка перед покоординатной калибровкой).

    Полезно, когда стартовая математика промахивается на десятки процентов:
    один вызов приближает к цели быстрее сотни итераций по счётчикам.
    """
    cfg = copy.deepcopy(cfg)
    targets = symbols or list(cfg.paytable.keys())

    for sym in targets:
        for count in list(cfg.paytable[sym].keys()):
            scaled = max(1, int(round(cfg.paytable[sym][count] * scale)))
            cfg.paytable[sym][count] = scaled

    return cfg


def solve_paytable_scale(
    cfg: GameConfig,
    lo: float = 0.05,
    hi: float = 20.0,
    tolerance: float = 0.0005,
    max_steps: int = 60,
) -> Tuple[GameConfig, float]:
    """
    Бинарный поиск множителя таблицы выплат, дающего целевой RTP.

    RTP монотонно растёт по множителю, поэтому бисекция корректна.
    Из-за округления выплат до целых точное попадание не гарантировано —
    остаток добирается покоординатной калибровкой.
    """
    best_cfg = cfg
    best_scale = 1.0
    best_err = float("inf")

    for _ in range(max_steps):
        mid = (lo + hi) / 2
        trial = tune_paytable_scale(cfg, mid)
        rtp = analyse(trial).total_rtp
        err = abs(rtp - cfg.target_rtp)

        if err < best_err:
            best_err = err
            best_cfg = trial
            best_scale = mid

        if err <= tolerance:
            break

        if rtp > cfg.target_rtp:
            hi = mid
        else:
            lo = mid

    return best_cfg, best_scale
