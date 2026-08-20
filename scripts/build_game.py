#!/usr/bin/env python3
"""
Собирает стартовую конфигурацию игры «Crown of Fortune» и калибрует её под RTP 96%.

Запуск:
    python3 scripts/build_game.py

Результат: `config/game.json` — единый источник правды для Python и TypeScript.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from slotmath.analytic import analyse, symbol_rtp_breakdown  # noqa: E402
from slotmath.calibrate import calibrate, solve_paytable_scale  # noqa: E402
from slotmath.config import GameConfig, save_config  # noqa: E402
from slotmath.strips import build_strip, max_scatter_in_window  # noqa: E402

# ---------------------------------------------------------------------------
# Символы
# ---------------------------------------------------------------------------
# Тема: средневековая корона / королевская сокровищница.
#   CROWN  — топовый символ
#   RING, CHALICE, SWORD — премиальные
#   A, K, Q, J, TEN — низкие (карточные)
#   WILD    — замещает всё, кроме сундука
#   CHEST   — сундук: триггер бонуса, платит из любой позиции
#
# Версия 1.1.0 (T-211): scatter переименован в CHEST и стал сундуком —
# «поймай три сундука». Бонусная серия крутится на лентах, где нет ни одного
# карточного символа: только меч, кубок, перстень, корона и wild. Это резко
# поднимает ценность фриспинов, поэтому награда снижена с 10/15/25 до
# 8/12/20, а базовая игра пересчитана калибровкой под те же 96%.

SYMBOLS = [
    "TEN", "J", "Q", "K", "A",          # низкие
    "SWORD", "CHALICE", "RING",         # премиальные
    "CROWN",                            # топ
    "WILD", "CHEST",
]

PREMIUM = ["CROWN", "RING", "CHALICE", "SWORD"]
LOW = ["A", "K", "Q", "J", "TEN"]

# Таблица выплат — множители ставки НА ЛИНИЮ.
# Стартовые значения; далее калибруются автоматически.
#
# Дизайнерское решение: TEN и J платят ТОЛЬКО от 4 совпадений.
# Это снижает hit frequency с ~41% до целевых ~28% и переносит вес
# выплат на премиальные символы. Приём стандартен для слотов
# средней и высокой волатильности: он убирает «шум» из мелких
# выигрышей, которые всё равно меньше ставки.
PAYTABLE = {
    "CROWN":   {3: 60,  4: 250, 5: 1200},
    "RING":    {3: 30,  4: 120, 5: 500},
    "CHALICE": {3: 22,  4: 90,  5: 300},
    "SWORD":   {3: 16,  4: 60,  5: 180},
    "A":       {3: 10,  4: 35,  5: 120},
    "K":       {3: 8,   4: 28,  5: 90},
    "Q":       {3: 6,   4: 22,  5: 70},
    "J":       {4: 16,  5: 55},
    "TEN":     {4: 14,  5: 45},
}

# Счётчики символов по барабанам для базовой игры.
# Принципы:
#   * дорогие символы реже, и реже на правых барабанах (удлиняет «почти выигрыш»);
#   * wild только на барабанах 1,2,3 (0-индексация) — не на первом, см. research/02;
#   * ровно 1 scatter на барабан -> максимум 1 в окне -> чистое биномиальное распределение.
#
# Длина ленты выбрана ~42 позиции. Это задаёт вероятность scatter на барабан
# 3/42 = 7.1%, что даёт триггер бонуса примерно раз в 300 спинов —
# отраслевая норма для средней волатильности.
BASE_COUNTS = [
    # барабан 0 (без wild)
    {"TEN": 7, "J": 7, "Q": 6, "K": 6, "A": 5, "SWORD": 4, "CHALICE": 3, "RING": 2, "CROWN": 1, "CHEST": 1},
    # барабан 1
    {"TEN": 6, "J": 6, "Q": 6, "K": 5, "A": 5, "SWORD": 4, "CHALICE": 3, "RING": 2, "CROWN": 1, "WILD": 2, "CHEST": 1},
    # барабан 2
    {"TEN": 6, "J": 6, "Q": 6, "K": 5, "A": 5, "SWORD": 4, "CHALICE": 3, "RING": 2, "CROWN": 1, "WILD": 2, "CHEST": 1},
    # барабан 3
    {"TEN": 6, "J": 6, "Q": 6, "K": 5, "A": 5, "SWORD": 4, "CHALICE": 3, "RING": 2, "CROWN": 1, "WILD": 2, "CHEST": 1},
    # барабан 4 (без wild)
    {"TEN": 7, "J": 7, "Q": 6, "K": 6, "A": 5, "SWORD": 4, "CHALICE": 3, "RING": 2, "CROWN": 1, "CHEST": 1},
]

# Ленты бонуса: НИ ОДНОГО карточного символа.
#
# В бонусе крутятся только меч, кубок, перстень, корона и wild — каждый
# оборот собирает премиальную комбинацию, и это главный смысл фичи.
# Сундук оставляем по одному на барабан: он нужен для ретриггера, но при
# большем количестве серия разгоняется и RTP уходит в разнос.
#
# Расплата за щедрость — редкость: триггер примерно раз в 290 спинов.
FREE_COUNTS = [
    {"SWORD": 14, "CHALICE": 10, "RING": 7, "CROWN": 4, "CHEST": 1},
    {"SWORD": 13, "CHALICE": 9, "RING": 6, "CROWN": 3, "WILD": 5, "CHEST": 1},
    {"SWORD": 13, "CHALICE": 9, "RING": 6, "CROWN": 3, "WILD": 5, "CHEST": 1},
    {"SWORD": 13, "CHALICE": 9, "RING": 6, "CROWN": 3, "WILD": 5, "CHEST": 1},
    {"SWORD": 14, "CHALICE": 10, "RING": 7, "CROWN": 4, "CHEST": 1},
]


def main() -> int:
    base_reels = [build_strip(c, "CHEST", "WILD", PREMIUM) for c in BASE_COUNTS]
    free_reels = [build_strip(c, "CHEST", "WILD", PREMIUM) for c in FREE_COUNTS]

    # Проверка: не более одного scatter в окне на барабан.
    for i, reel in enumerate(base_reels):
        m = max_scatter_in_window(reel, "CHEST")
        if m > 1:
            print(f"ВНИМАНИЕ: барабан {i} может показать {m} scatter в окне")

    cfg = GameConfig(
        name="Crown of Fortune",
        version="1.1.0",
        symbols=SYMBOLS,
        paytable=PAYTABLE,
        base_reels=base_reels,
        free_reels=free_reels,
        wild="WILD",
        scatter="CHEST",
        scatter_trigger=3,
        free_spins_award={3: 8, 4: 12, 5: 20},
        scatter_pays={3: 2, 4: 10, 5: 50},
        free_spin_multiplier=2,
        retrigger_enabled=True,
        wild_reels=[1, 2, 3],
        lines=20,
        target_rtp=0.96,
        max_win_cap=5000,
        meta={
            "grid": "5x3",
            # Волатильность выросла с переходом на бонус: 61% отдачи лежит
            # во фриспинах, которые выпадают раз в ~294 спина. Сигма по
            # симуляции 11.5 против 4.1 у прежней математики.
            "volatility": "high",
            "description": "Слот 5x3 на 20 линий: три сундука дают бонус на премиальных лентах",
        },
    )
    cfg.validate()

    print("=" * 70)
    print("СТАРТОВАЯ КОНФИГУРАЦИЯ")
    print("=" * 70)
    print(f"Длины базовых лент: {[len(r) for r in cfg.base_reels]}")
    print(f"Длины лент фриспинов: {[len(r) for r in cfg.free_reels]}")
    print(f"Полный цикл базовой игры: {cfg.base_cycle:,} комбинаций")

    result = analyse(cfg)
    print(f"\nRTP до калибровки: {result.total_rtp * 100:.4f}%")
    print(f"  линии базовой игры: {result.base_line_rtp * 100:.4f}%")
    print(f"  выплаты за scatter: {result.scatter_pay_rtp * 100:.4f}%")
    print(f"  фриспины:           {result.free_spins_rtp * 100:.4f}%")

    # --- Грубая настройка: масштаб таблицы выплат ---
    print("\n" + "=" * 70)
    print("КАЛИБРОВКА")
    print("=" * 70)
    cfg, scale = solve_paytable_scale(cfg)
    result = analyse(cfg)
    print(f"Шаг 1 — масштаб таблицы выплат x{scale:.4f} -> RTP {result.total_rtp * 100:.4f}%")

    # --- Точная настройка: счётчики символов ---
    cfg, report = calibrate(cfg, premium=PREMIUM, tolerance=0.0015)
    print(
        f"Шаг 2 — покоординатная калибровка: {report.iterations} итераций, "
        f"{report.start_rtp * 100:.4f}% -> {report.final_rtp * 100:.4f}% "
        f"(сошлось: {'да' if report.converged else 'нет'})"
    )

    result = analyse(cfg)

    print("\n" + "=" * 70)
    print("ИТОГОВАЯ МАТЕМАТИКА")
    print("=" * 70)
    print(f"RTP итоговый:            {result.total_rtp * 100:.4f}%")
    print(f"  линии базовой игры:    {result.base_line_rtp * 100:.4f}%")
    print(f"  выплаты за scatter:    {result.scatter_pay_rtp * 100:.4f}%")
    print(f"  фриспины:              {result.free_spins_rtp * 100:.4f}%")
    print(f"Вероятность фриспинов:   {result.trigger_probability * 100:.4f}%  "
          f"(1 к {1 / result.trigger_probability:.0f} спинов)")
    print(f"Ожидаемых фриспинов:     {result.expected_free_spins:.3f} за триггер")
    print(f"Вероятность ретриггера:  {result.retrigger_probability * 100:.4f}%")
    print(f"Ценность фриспина:       {result.free_spin_value:.4f} ставки")
    print(f"Hit frequency (оценка):  {result.hit_frequency_lines * 100:.2f}%")
    print(f"Длины лент:              {[len(r) for r in cfg.base_reels]}")

    print("\nВклад символов в RTP базовой игры (на 1 линию, в ставках на линию):")
    breakdown = symbol_rtp_breakdown(cfg)
    total_bd = sum(breakdown.values())
    for sym in sorted(breakdown, key=lambda s: -breakdown[s]):
        share = breakdown[sym] / total_bd * 100 if total_bd else 0
        print(f"  {sym:<9} {breakdown[sym]:.6f}   ({share:5.2f}% линейных выплат)")

    save_config(cfg)
    print(f"\nКонфигурация сохранена: config/game.json")
    print(f"SHA-256 конфигурации: {cfg.config_hash()}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
