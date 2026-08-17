"""
Построение лент барабанов из счётчиков символов.

Порядок символов на ленте — не косметика. Он влияет на:
  * распределение числа scatter в окне (а значит на частоту фриспинов);
  * визуальное восприятие («слипшиеся» символы выглядят как баг);
  * возможность игрока предсказать ленту по видимым символам.

Правила раскладки:
  1. Scatter разносится максимально далеко друг от друга и никогда
     не встречается дважды в одном окне 3x1. Это даёт максимум
     один scatter на барабан и предсказуемое биномиальное распределение.
  2. Wild не ставится рядом с wild.
  3. Премиальные символы не образуют серий длиннее двух подряд.
  4. Остальное заполняется низкими символами с равномерным разбросом.
"""

from __future__ import annotations

from typing import Dict, List

from .paylines import NUM_ROWS


class StripBuildError(RuntimeError):
    """Не удалось построить ленту с заданными ограничениями."""


def build_strip(
    counts: Dict[str, int],
    scatter: str,
    wild: str,
    premium: List[str],
    min_scatter_gap: int = NUM_ROWS,
) -> List[str]:
    """
    Собирает ленту из счётчиков символов с соблюдением правил раскладки.

    Алгоритм детерминированный (никакой случайности) — одна и та же
    конфигурация всегда даёт одну и ту же ленту. Это важно:
    лента является частью сертифицируемой математики.
    """
    length = sum(counts.values())
    if length == 0:
        raise StripBuildError("Пустой набор символов")

    strip: List[str | None] = [None] * length

    # --- 1. Scatter: равномерно по кольцу ---
    n_scatter = counts.get(scatter, 0)
    if n_scatter:
        if n_scatter * min_scatter_gap > length:
            raise StripBuildError(
                f"Невозможно разнести {n_scatter} scatter на ленте длины {length} "
                f"с зазором {min_scatter_gap}"
            )
        step = length / n_scatter
        for i in range(n_scatter):
            pos = int(round(i * step)) % length
            while strip[pos] is not None:
                pos = (pos + 1) % length
            strip[pos] = scatter

    # --- 2. Wild: равномерно по свободным местам, не вплотную ---
    n_wild = counts.get(wild, 0)
    if n_wild:
        free = [i for i, s in enumerate(strip) if s is None]
        if n_wild > len(free):
            raise StripBuildError("Не хватает места для wild")
        step = len(free) / n_wild
        for i in range(n_wild):
            pos = free[int(i * step) % len(free)]
            # Сдвигаемся, если сосед — wild
            attempts = 0
            while (
                strip[pos] is not None
                or strip[(pos - 1) % length] == wild
                or strip[(pos + 1) % length] == wild
            ):
                pos = (pos + 1) % length
                attempts += 1
                if attempts > length:
                    raise StripBuildError("Не удалось разместить wild без соседства")
            strip[pos] = wild

    # --- 3. Остальные символы: чередуем премиальные и низкие ---
    others = [s for s in counts if s not in (scatter, wild) and counts[s] > 0]
    # Порядок: сначала премиальные (их меньше), потом низкие — так они лучше разойдутся.
    premium_syms = [s for s in others if s in premium]
    low_syms = [s for s in others if s not in premium]

    queue: List[str] = []
    # Раскладываем «по слоям»: по одному символу каждого вида за проход.
    remaining = {s: counts[s] for s in others}
    ordered = premium_syms + low_syms
    while any(remaining[s] > 0 for s in ordered):
        for sym in ordered:
            if remaining[sym] > 0:
                queue.append(sym)
                remaining[sym] -= 1

    free_positions = [i for i, s in enumerate(strip) if s is None]
    if len(queue) != len(free_positions):
        raise StripBuildError(
            f"Рассинхрон: {len(queue)} символов на {len(free_positions)} мест"
        )

    for pos, sym in zip(free_positions, queue):
        strip[pos] = sym

    result = [s for s in strip if s is not None]
    if len(result) != length:
        raise StripBuildError("В ленте остались пустые позиции")

    _fix_long_runs(result, scatter, wild)
    return result


def _fix_long_runs(strip: List[str], scatter: str, wild: str, max_run: int = 2) -> None:
    """
    Разбивает серии одинаковых символов длиннее max_run, меняя местами
    элементы внутри ленты. Работает по кольцу, модифицирует список на месте.
    """
    length = len(strip)
    for _ in range(3):  # несколько проходов, полная гарантия не требуется
        changed = False
        run_start = 0
        while run_start < length:
            sym = strip[run_start]
            run_len = 1
            while run_len < length and strip[(run_start + run_len) % length] == sym:
                run_len += 1
            if run_len > max_run and sym not in (scatter, wild):
                bad = (run_start + max_run) % length
                # Ищем позицию с другим символом и другими соседями
                for offset in range(1, length):
                    cand = (bad + offset) % length
                    if strip[cand] == sym:
                        continue
                    if strip[(cand - 1) % length] == sym or strip[(cand + 1) % length] == sym:
                        continue
                    if strip[cand] in (scatter, wild):
                        continue
                    strip[bad], strip[cand] = strip[cand], strip[bad]
                    changed = True
                    break
            run_start += max(run_len, 1)
        if not changed:
            break


def counts_from_strip(strip: List[str]) -> Dict[str, int]:
    """Обратная операция: счётчики символов из готовой ленты."""
    counts: Dict[str, int] = {}
    for sym in strip:
        counts[sym] = counts.get(sym, 0) + 1
    return counts


def max_scatter_in_window(strip: List[str], scatter: str, rows: int = NUM_ROWS) -> int:
    """Максимальное число scatter, которое может попасть в окно одного барабана."""
    length = len(strip)
    best = 0
    for stop in range(length):
        count = sum(1 for row in range(rows) if strip[(stop + row) % length] == scatter)
        best = max(best, count)
    return best
