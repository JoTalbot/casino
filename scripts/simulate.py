#!/usr/bin/env python3
"""
Прогон Monte Carlo и сверка с аналитическим расчётом.

Запуск:
    python3 scripts/simulate.py                 # 10 млн спинов, 3 прогона
    python3 scripts/simulate.py --spins 1000000 --runs 1
    python3 scripts/simulate.py --json out.json

Критерии приёмки (по требованиям сертификационных лабораторий,
см. research/02-SLOT-MATH.md §7):
  * отклонение одиночного прогона на 1 млн спинов  <= 2.0%
  * отклонение среднего по трём прогонам           <= 0.5%
  * симуляция должна сойтись к аналитическому RTP
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from slotmath.analytic import analyse  # noqa: E402
from slotmath.config import load_config  # noqa: E402
from slotmath.simulate import Simulator  # noqa: E402


def human(n: int) -> str:
    return f"{n:,}".replace(",", " ")


def main() -> int:
    parser = argparse.ArgumentParser(description="Monte Carlo симуляция слота")
    parser.add_argument("--spins", type=int, default=10_000_000, help="спинов за прогон")
    parser.add_argument("--runs", type=int, default=3, help="число независимых прогонов")
    parser.add_argument("--batch", type=int, default=250_000, help="размер пачки")
    parser.add_argument("--seed", type=int, default=20260817, help="базовый seed")
    parser.add_argument("--json", type=str, default=None, help="сохранить отчёт в JSON")
    parser.add_argument("--quiet", action="store_true", help="без прогресса")
    args = parser.parse_args()

    cfg = load_config()

    print("=" * 74)
    print(f"СИМУЛЯЦИЯ: {cfg.name} v{cfg.version}")
    print("=" * 74)
    print(f"Конфигурация:   {cfg.num_reels} барабанов x 3 ряда, {cfg.lines} линий")
    print(f"Длины лент:     базовые {[len(r) for r in cfg.base_reels]}")
    print(f"                фриспины {[len(r) for r in cfg.free_reels]}")
    print(f"Хэш конфига:    {cfg.config_hash()[:16]}...")
    print(f"Целевой RTP:    {cfg.target_rtp * 100:.2f}%")

    # ---- Аналитика ----
    t0 = time.time()
    analytic = analyse(cfg)
    t_analytic = time.time() - t0

    print(f"\n--- Аналитический расчёт ({t_analytic * 1000:.0f} мс) ---")
    print(f"RTP теоретический:       {analytic.total_rtp * 100:.4f}%")
    print(f"  линии базовой игры:    {analytic.base_line_rtp * 100:.4f}%")
    print(f"  выплаты за scatter:    {analytic.scatter_pay_rtp * 100:.4f}%")
    print(f"  фриспины:              {analytic.free_spins_rtp * 100:.4f}%")
    print(f"Вероятность триггера:    {analytic.trigger_probability * 100:.4f}% "
          f"(1 к {1 / analytic.trigger_probability:.0f})")
    print(f"Фриспинов за триггер:    {analytic.expected_free_spins:.3f}")

    # ---- Симуляция ----
    print(f"\n--- Monte Carlo: {args.runs} x {human(args.spins)} спинов ---")

    results = []
    for run in range(args.runs):
        sim = Simulator(cfg, seed=args.seed + run * 1000)

        def progress(done, total, _run=run):
            if args.quiet:
                return
            pct = done / total * 100
            bar = "#" * int(pct / 4) + "." * (25 - int(pct / 4))
            print(f"\r  прогон {_run + 1}/{args.runs} [{bar}] {pct:5.1f}%", end="", flush=True)

        t0 = time.time()
        result = sim.run(args.spins, batch_size=args.batch, progress=progress)
        elapsed = time.time() - t0

        if not args.quiet:
            print()

        speed = args.spins / elapsed if elapsed else 0
        deviation = (result.rtp - analytic.total_rtp) * 100

        print(
            f"  прогон {run + 1}: RTP {result.rtp * 100:.4f}%  "
            f"откл. {deviation:+.4f} п.п.  "
            f"hit {result.hit_frequency * 100:.2f}%  "
            f"max {result.max_win_x:.0f}x  "
            f"({elapsed:.1f} с, {speed / 1000:.0f}k спинов/с)"
        )
        results.append(result)

    # ---- Сводка ----
    mean_rtp = sum(r.rtp for r in results) / len(results)
    mean_dev = abs(mean_rtp - analytic.total_rtp) * 100
    max_single_dev = max(abs(r.rtp - analytic.total_rtp) * 100 for r in results)

    agg = results[0]
    total_spins = sum(r.spins for r in results)
    total_hits = sum(r.hits for r in results)
    total_triggers = sum(r.triggers for r in results)
    total_free = sum(r.free_spins_played for r in results)
    total_retrig = sum(r.retriggers for r in results)
    overall_max = max(r.max_win_x for r in results)

    print("\n" + "=" * 74)
    print("СВОДКА")
    print("=" * 74)
    print(f"Всего спинов:            {human(total_spins)}")
    print(f"RTP теоретический:       {analytic.total_rtp * 100:.4f}%")
    print(f"RTP симуляции (среднее): {mean_rtp * 100:.4f}%")
    print(f"Отклонение среднего:     {mean_dev:.4f} п.п.")
    print(f"Макс. откл. прогона:     {max_single_dev:.4f} п.п.")
    print()
    print(f"Hit frequency:           {total_hits / total_spins * 100:.2f}%")
    print(f"Триггер фриспинов:       {total_triggers / total_spins * 100:.4f}% "
          f"(1 к {total_spins / max(total_triggers, 1):.0f})")
    print(f"Фриспинов сыграно:       {human(total_free)} "
          f"({total_free / max(total_triggers, 1):.2f} за триггер)")
    print(f"Ретриггеров:             {human(total_retrig)}")
    print(f"Максимальный выигрыш:    {overall_max:.1f}x  (потолок {cfg.max_win_cap}x)")
    print(f"Ср. выигрыш за спин:     {agg.mean_win_x:.4f}x")
    print(f"Ст. отклонение:          {agg.std_win_x:.4f}")
    print(f"Индекс волатильности:    {agg.volatility_index:.2f}")

    print("\nРаспределение выигрышей (прогон 1):")
    for label, count in agg.win_distribution.items():
        share = count / agg.spins * 100
        bar = "#" * int(share / 2)
        print(f"  {label:<18} {count:>12,}  {share:6.3f}%  {bar}")

    print("\nПерцентили выигрыша за раунд (в ставках):")
    for key, value in agg.percentiles.items():
        print(f"  {key:<7} {value:>10.2f}x")

    # ---- Критерии приёмки ----
    print("\n" + "=" * 74)
    print("КРИТЕРИИ ПРИЁМКИ")
    print("=" * 74)

    checks = [
        ("Отклонение среднего <= 0.5 п.п.", mean_dev <= 0.5, f"{mean_dev:.4f}"),
        ("Отклонение прогона <= 2.0 п.п.", max_single_dev <= 2.0, f"{max_single_dev:.4f}"),
        (
            "RTP в коридоре 95.5-96.5%",
            0.955 <= mean_rtp <= 0.965,
            f"{mean_rtp * 100:.4f}%",
        ),
        (
            "Hit frequency 20-35%",
            0.20 <= total_hits / total_spins <= 0.35,
            f"{total_hits / total_spins * 100:.2f}%",
        ),
        (
            "Триггер бонуса 1 к 150-500",
            150 <= total_spins / max(total_triggers, 1) <= 500,
            f"1 к {total_spins / max(total_triggers, 1):.0f}",
        ),
        (
            f"Макс. выигрыш <= потолка {cfg.max_win_cap}x",
            overall_max <= cfg.max_win_cap,
            f"{overall_max:.0f}x",
        ),
    ]

    all_ok = True
    for name, ok, value in checks:
        mark = "OK  " if ok else "FAIL"
        print(f"  [{mark}] {name:<38} {value}")
        all_ok = all_ok and ok

    print()
    print("РЕЗУЛЬТАТ:", "ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" if all_ok else "ЕСТЬ ОТКЛОНЕНИЯ")

    if args.json:
        report = {
            "config": {
                "name": cfg.name,
                "version": cfg.version,
                "hash": cfg.config_hash(),
                "targetRtp": cfg.target_rtp,
            },
            "analytic": analytic.as_dict(),
            "runs": [r.as_dict() for r in results],
            "summary": {
                "totalSpins": total_spins,
                "meanRtp": mean_rtp,
                "meanDeviationPp": mean_dev,
                "maxSingleDeviationPp": max_single_dev,
                "hitFrequency": total_hits / total_spins,
                "triggerFrequency": total_triggers / total_spins,
                "maxWinX": overall_max,
                "freeSpinsPlayed": sum(r.free_spins_played for r in results),
                "triggers": total_triggers,
                "retriggers": sum(r.retriggers for r in results),
                "stdWinX": results[0].std_win_x,
                "volatilityIndex": results[0].volatility_index,
                "winDistribution": results[0].win_distribution,
                "percentiles": results[0].percentiles,
                "allChecksPassed": bool(all_ok),
            },
            "checks": [
                {"name": name, "passed": bool(ok), "value": value} for name, ok, value in checks
            ],
        }
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
        print(f"\nОтчёт сохранён: {out}")

    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
