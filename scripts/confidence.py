#!/usr/bin/env python3
"""
Доверительные интервалы RTP и требования к банкроллу (T-019).

Отвечает на четыре вопроса:
  1. Сколько раундов нужно, чтобы наблюдаемый RTP сошёлся к теоретическому
     с заданной точностью?
  2. Какой разброс RTP видно на горизонте от 1 тыс. до 10 млн раундов?
  3. Какой банкролл нужен оператору, чтобы не разориться?
  4. Сколько живёт депозит игрока и с какой вероятностью он уходит в плюсе?

Запуск:
    python3 scripts/confidence.py                        # 5 млн раундов выборки
    python3 scripts/confidence.py --quick                # быстрый прогон для CI
    python3 scripts/confidence.py --json simulations/confidence.json

Результат используется в docs/PAR-SHEET.md §10 (T-020) и в модуле
ответственной игры (T-015).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import numpy as np  # noqa: E402

from slotmath.analytic import analyse  # noqa: E402
from slotmath.confidence import (  # noqa: E402
    DEFAULT_HORIZONS,
    build_report,
    house_bankroll_diffusion,
)
from slotmath.config import load_config  # noqa: E402
from slotmath.simulate import Simulator  # noqa: E402

DEFAULT_JSON = REPO_ROOT / "simulations" / "confidence.json"


def human(n: float) -> str:
    """Целое с неразрывными пробелами между разрядами."""
    return f"{int(round(n)):,}".replace(",", " ")


def main() -> int:
    ap = argparse.ArgumentParser(description="Доверительные интервалы RTP и банкролл")
    ap.add_argument("--rounds", type=int, default=5_000_000, help="размер выборки раундов")
    ap.add_argument("--replicates", type=int, default=20_000, help="реплик бутстрапа")
    ap.add_argument("--blocks", type=int, default=200_000, help="блоков в пуле бутстрапа")
    ap.add_argument("--seed", type=int, default=20260817)
    ap.add_argument("--json", type=Path, default=DEFAULT_JSON, help="куда писать отчёт")
    ap.add_argument("--quick", action="store_true", help="уменьшенные объёмы для CI")
    args = ap.parse_args()

    cfg = load_config()
    cfg.validate()
    analytic = analyse(cfg)

    rounds = 500_000 if args.quick else args.rounds

    print("=" * 74)
    print(f"СХОДИМОСТЬ RTP И БАНКРОЛЛ: {cfg.name} v{cfg.version}")
    print("=" * 74)
    print(f"Хэш конфига:      {cfg.config_hash()[:16]}...")
    print(f"Аналитический RTP: {analytic.total_rtp * 100:.4f}%")
    print(f"Выборка:          {human(rounds)} раундов")

    t0 = time.time()
    sim = Simulator(cfg, seed=args.seed)
    sample = sim.sample_rounds(rounds)
    print(f"Выборка построена за {time.time() - t0:.1f} с")

    t0 = time.time()
    report = build_report(
        sample,
        horizons=[h for h in DEFAULT_HORIZONS if h <= rounds] or [1_000],
        replicates=args.replicates,
        blocks=args.blocks,
        seed=args.seed,
        quick=args.quick,
    )
    print(f"Отчёт посчитан за {time.time() - t0:.1f} с")

    # ---- 1. Базовые характеристики ----
    print()
    print("-" * 74)
    print("1. ХАРАКТЕРИСТИКИ РАУНДА")
    print("-" * 74)
    print(f"Средний возврат:            {report.mean_rtp * 100:.4f}%")
    print(f"Преимущество оператора:     {report.edge * 100:.4f}% от оборота")
    print(f"Ст. отклонение за раунд:    {report.sigma:.4f} ставки")
    print(f"Индекс волатильности (90%): {report.volatility_index:.2f}")
    dev = abs(report.mean_rtp - analytic.total_rtp) * 100
    print(f"Отклонение выборки от аналитики: {dev:.4f} п.п.")

    # ---- 2. Сходимость ----
    print()
    print("-" * 74)
    print("2. РАУНДОВ ДО СХОДИМОСТИ (нормальное приближение)")
    print("-" * 74)
    print(f"{'Точность':>10} {'90%':>14} {'95%':>14} {'99%':>14}")
    for row in report.convergence:
        print(
            f"{'±' + format(row['tolerancePp'], '.2f') + ' п.п.':>10} "
            f"{human(row['spins90']):>14} "
            f"{human(row['spins95']):>14} "
            f"{human(row['spins99']):>14}"
        )

    # ---- 3. Разброс по горизонтам ----
    print()
    print("-" * 74)
    print("3. РАЗБРОС НАБЛЮДАЕМОГО RTP (бутстрап, 95%)")
    print("-" * 74)
    print(
        f"{'Раундов':>12} {'2.5%':>9} {'медиана':>9} {'97.5%':>9} "
        f"{'±п.п.':>8} {'CLT':>7} {'хвост':>7} {'вне 95.5-96.5':>14}"
    )
    for s in report.spread:
        print(
            f"{human(s.spins):>12} "
            f"{s.empirical_p025 * 100:>8.2f}% "
            f"{s.empirical_p50 * 100:>8.2f}% "
            f"{s.empirical_p975 * 100:>8.2f}% "
            f"{s.empirical_half_width_pp:>8.3f} "
            f"{s.skew_ratio:>7.3f} "
            f"{s.tail_ratio:>7.2f} "
            f"{s.outside_band * 100:>13.1f}%"
        )

    # ---- 4. Банкролл оператора ----
    print()
    print("-" * 74)
    print("4. БАНКРОЛЛ ОПЕРАТОРА (в ставках)")
    print("-" * 74)
    print(
        f"{'Риск разорения':>16} {'формула':>12} "
        f"{'MC-риск':>10} {'горизонт':>12}"
    )
    for row, mc in zip(report.house_bankroll, report.house_ruin_mc):
        print(
            f"{row['ruinProbability'] * 100:>15.2f}% "
            f"{human(row['bankrollBets']):>12} "
            f"{mc.ruin_probability * 100:>9.2f}% "
            f"{human(mc.horizon):>12}"
        )
    print()
    print("Формула — бесконечный горизонт (консервативно), MC — конечный.")

    # ---- 5. Сессии игрока ----
    print()
    print("-" * 74)
    print("5. СЕССИЯ ИГРОКА (ставка 1, банкролл в ставках)")
    print("-" * 74)
    print(
        f"{'Банкролл':>10} {'лимит':>8} {'проигрался':>12} "
        f"{'медиана раундов':>17} {'ушёл в плюсе':>14}"
    )
    for s in report.player_sessions:
        print(
            f"{human(s.bankroll):>10} "
            f"{human(s.horizon):>8} "
            f"{s.bust_probability * 100:>11.1f}% "
            f"{human(s.median_spins_survived):>17} "
            f"{s.ahead_probability * 100:>13.1f}%"
        )

    # ---- Проверки ----
    print()
    print("-" * 74)
    print("ПРОВЕРКИ")
    print("-" * 74)
    checks = []

    checks.append((
        "Выборка сходится к аналитике (<= 0.2 п.п.)",
        dev <= 0.2,
        f"{dev:.4f} п.п.",
    ))

    # На больших горизонтах бутстрап и CLT обязаны совпадать: если нет,
    # сломан либо блочный пул, либо оценка sigma.
    tail = [s for s in report.spread if s.spins >= 100_000]
    if tail:
        worst = max(abs(s.skew_ratio - 1.0) for s in tail)
        checks.append((
            "Бутстрап сходится к CLT на n >= 100k (откл. <= 10%)",
            worst <= 0.10,
            f"макс. откл. {worst * 100:.1f}%",
        ))

    # Асимметрия должна убывать с ростом горизонта.
    if len(report.spread) >= 2:
        first, last = report.spread[0], report.spread[-1]
        checks.append((
            "Асимметрия хвостов убывает с горизонтом",
            last.tail_ratio < first.tail_ratio,
            f"{first.tail_ratio:.2f} -> {last.tail_ratio:.2f}",
        ))

    # Диффузионная формула не должна недооценивать риск на конечном
    # горизонте: MC-риск обязан быть не выше заявленного.
    ok_ruin = all(
        mc.ruin_probability <= row["ruinProbability"] * 3 + 0.005
        for row, mc in zip(report.house_bankroll, report.house_ruin_mc)
    )
    checks.append((
        "MC-риск разорения не превышает формулу",
        ok_ruin,
        "; ".join(
            f"{mc.ruin_probability * 100:.2f}% vs {row['ruinProbability'] * 100:.2f}%"
            for row, mc in zip(report.house_bankroll, report.house_ruin_mc)
        ),
    ))

    all_passed = True
    for name, passed, detail in checks:
        status = "PASS" if passed else "FAIL"
        all_passed = all_passed and passed
        print(f"[{status}] {name}: {detail}")

    print()
    print("ИТОГ:", "все проверки пройдены" if all_passed else "ЕСТЬ ПРОВАЛЫ")

    if args.json:
        payload = {
            "config": {
                "name": cfg.name,
                "version": cfg.version,
                "hash": cfg.config_hash(),
            },
            "analyticRtp": analytic.total_rtp,
            "sampleRounds": rounds,
            "seed": args.seed,
            **report.as_dict(),
            "checks": [
                {"name": n, "passed": bool(p), "detail": d} for n, p, d in checks
            ],
            "allChecksPassed": bool(all_passed),
        }
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"Отчёт записан: {args.json}")

    return 0 if all_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
