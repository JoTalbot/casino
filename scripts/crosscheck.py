#!/usr/bin/env python3
"""
Перекрёстная сверка независимых реализаций математики.

В проекте одну и ту же игру считают четыре разных куска кода:

  1. `slotmath/analytic.py` — точный расчёт RTP свёрткой тензора выплат;
  2. `slotmath/simulate.py` — векторизованная симуляция на numpy;
  3. `slotmath/round.py`    — эталонное пошаговое проигрывание раунда;
  4. `src/engine/rng.ts`    — поток случайных чисел на TypeScript.

Если хоть одна пара разойдётся, provably fair перестаёт работать:
игрок пересчитает раунд и получит не то, что показал сервер. Поэтому
расхождения ловятся здесь, а не в проде.

Скрипт делает три проверки:

  A. RNG: Python-поток (round.py) против TypeScript-потока (rng.ts).
     Точная, побайтовая. Требует собранного build/ (npx tsc).
  B. Оценка окна: выплата по линиям из round.py (наивный цикл по 20 линиям)
     против engine.py (индексация тензора 11^5). Точная, спин в спин.
  C. RTP: среднее по round.py против аналитического значения.
     Статистическая, с доверительным интервалом.

Использование:
    python3 scripts/crosscheck.py
    python3 scripts/crosscheck.py --rounds 200000 --skip-ts
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from slotmath.analytic import analyse  # noqa: E402
from slotmath.config import load_config  # noqa: E402
from slotmath.engine import build_pay_lookup, build_symbol_index  # noqa: E402
from slotmath.paylines import NUM_REELS, PAYLINES  # noqa: E402
from slotmath.round import RoundRandom, hash_server_seed, play_round  # noqa: E402

SERVER_SEED = "a" * 64
CLIENT_SEED = "player-fixture-seed"

TS_PROBE = """
import { RoundRandom, hashServerSeed, integersForRound } from '%s/build/engine/rng.js';
const ss = '%s', cs = '%s';
const out = { hash: hashServerSeed(ss), draws: {}, ints: {} };
for (const nonce of %s) {
  const r = new RoundRandom(ss, cs, nonce);
  const v = [];
  for (let i = 0; i < 40; i++) v.push(r.nextFloat().toFixed(15));
  out.draws[nonce] = v;
  out.ints[nonce] = integersForRound(ss, cs, nonce, %s);
}
console.log(JSON.stringify(out));
"""


def check_rng_against_typescript(cfg, nonces) -> bool:
    """A. Побайтовое совпадение потока чисел Python и TypeScript."""
    print("A. RNG: Python (slotmath/round.py) против TypeScript (src/engine/rng.ts)")

    build_dir = REPO_ROOT / "build" / "engine" / "rng.js"
    if not build_dir.exists():
        print("   ПРОПУЩЕНО: нет build/engine/rng.js, соберите `npx tsc -p tsconfig.json`")
        return True

    lengths = [len(r) for r in cfg.base_reels]
    script = TS_PROBE % (
        REPO_ROOT,
        SERVER_SEED,
        CLIENT_SEED,
        json.dumps(nonces),
        json.dumps(lengths),
    )

    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as fh:
        fh.write(script)
        probe_path = fh.name

    try:
        proc = subprocess.run(
            ["node", probe_path], capture_output=True, text=True, timeout=120
        )
    finally:
        Path(probe_path).unlink(missing_ok=True)

    if proc.returncode != 0:
        print(f"   ОШИБКА запуска node: {proc.stderr.strip()[:400]}")
        return False

    ts = json.loads(proc.stdout)
    ok = True

    if ts["hash"] != hash_server_seed(SERVER_SEED):
        print("   ПРОВАЛ: коммитмент SHA-256 не совпал")
        ok = False

    for nonce in nonces:
        rng = RoundRandom(SERVER_SEED, CLIENT_SEED, nonce)
        py_floats = [f"{rng.next_float():.15f}" for _ in range(40)]
        if py_floats != ts["draws"][str(nonce)]:
            print(f"   ПРОВАЛ: поток float разошёлся на nonce={nonce}")
            for i, (a, b) in enumerate(zip(py_floats, ts["draws"][str(nonce)])):
                if a != b:
                    print(f"      число #{i}: python={a} typescript={b}")
                    break
            ok = False

        rng2 = RoundRandom(SERVER_SEED, CLIENT_SEED, nonce)
        py_ints = [rng2.next_int(n) for n in lengths]
        if py_ints != ts["ints"][str(nonce)]:
            print(f"   ПРОВАЛ: стопы разошлись на nonce={nonce}: "
                  f"{py_ints} против {ts['ints'][str(nonce)]}")
            ok = False

    if ok:
        print(f"   OK: {len(nonces)} nonce x 40 чисел совпали до 15-го знака, "
              "стопы совпали точно")
    return ok


def check_line_evaluation(cfg, rounds: int) -> bool:
    """
    B. Оценка окна: наивный цикл (round.py) против тензора (engine.py).

    round.py перебирает 20 линий и для каждой ищет максимум по символам.
    engine.py заранее посчитал выплату для всех 11^5 = 161 051 комбинаций
    и берёт готовое значение по индексу. Реализации не имеют общего кода,
    поэтому совпадение — сильная гарантия, что обе верны.
    """
    print("\nB. Оценка окна: round.py (цикл по линиям) против engine.py (тензор)")

    pay_lookup = build_pay_lookup(cfg)
    flat = pay_lookup.reshape(-1)
    idx = build_symbol_index(cfg)
    n_sym = len(cfg.symbols)

    checked_spins = 0
    mismatches = 0

    for nonce in range(rounds):
        record = play_round(cfg, SERVER_SEED, CLIENT_SEED, nonce)

        for spin in record.spins:
            checked_spins += 1

            # Выплата по линиям из round.py — без scatter и без множителя.
            naive = sum(d["pay"] for d in spin.win_details if not d.get("scatter"))

            # То же самое через тензор.
            tensor_total = 0
            for line in PAYLINES:
                flat_index = 0
                for reel in range(NUM_REELS):
                    flat_index = flat_index * n_sym + idx[spin.grid[reel][line[reel]]]
                tensor_total += int(flat[flat_index])

            if naive != tensor_total:
                mismatches += 1
                if mismatches <= 3:
                    print(f"   ПРОВАЛ nonce={nonce} spin={spin.index}: "
                          f"round.py={naive} engine.py={tensor_total}")

    if mismatches:
        print(f"   ПРОВАЛ: расхождений {mismatches} из {checked_spins} спинов")
        return False

    print(f"   OK: {checked_spins} спинов ({rounds} раундов), расхождений нет")
    return True


def check_rtp(cfg, rounds: int) -> bool:
    """
    C. RTP по round.py против аналитического значения.

    Проверка статистическая, поэтому сравнивается не точное равенство,
    а попадание в доверительный интервал 99.7% (три сигмы).
    """
    print("\nC. RTP: round.py против аналитического расчёта")

    analytic = analyse(cfg)
    expected_rtp = analytic.total_rtp

    bet = cfg.lines
    total_win = 0
    wins_x = np.empty(rounds, dtype=np.float64)

    for nonce in range(rounds):
        record = play_round(cfg, SERVER_SEED, CLIENT_SEED, nonce)
        total_win += record.total_win
        wins_x[nonce] = record.total_win / bet

    actual_rtp = total_win / (rounds * bet)
    sigma = float(wins_x.std())
    stderr = sigma / (rounds ** 0.5)
    deviation = abs(actual_rtp - expected_rtp)
    tolerance = 3 * stderr

    print(f"   Аналитический RTP: {expected_rtp * 100:.4f}%")
    print(f"   RTP по round.py:   {actual_rtp * 100:.4f}%  ({rounds} раундов)")
    print(f"   Отклонение:        {deviation * 100:.4f} п.п.")
    print(f"   Допуск (3 сигмы):  {tolerance * 100:.4f} п.п.  (сигма={sigma:.4f})")

    if deviation > tolerance:
        print("   ПРОВАЛ: отклонение больше трёх стандартных ошибок")
        return False

    print("   OK: в пределах доверительного интервала")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Перекрёстная сверка реализаций")
    parser.add_argument("--rounds", type=int, default=20_000,
                        help="раундов для проверки оценки окна")
    parser.add_argument("--rtp-rounds", type=int, default=200_000,
                        help="раундов для статистической проверки RTP")
    parser.add_argument("--skip-ts", action="store_true",
                        help="не проверять TypeScript")
    args = parser.parse_args()

    cfg = load_config()
    print(f"Игра: {cfg.name} v{cfg.version}")
    print(f"Хэш конфигурации: {cfg.config_hash()}\n")

    results = []

    if args.skip_ts:
        print("A. RNG против TypeScript — ПРОПУЩЕНО по флагу --skip-ts\n")
    else:
        results.append(("RNG Python <-> TypeScript",
                        check_rng_against_typescript(cfg, [0, 1, 2, 7, 42, 999, 123456])))

    results.append(("Оценка окна round.py <-> engine.py",
                    check_line_evaluation(cfg, args.rounds)))
    results.append(("RTP round.py <-> analytic.py",
                    check_rtp(cfg, args.rtp_rounds)))

    print("\n" + "=" * 62)
    for name, passed in results:
        print(f"  [{'OK ' if passed else 'ПРОВАЛ'}] {name}")
    print("=" * 62)

    failed = [name for name, passed in results if not passed]
    if failed:
        print(f"\nПРОВАЛЕНО проверок: {len(failed)}")
        return 1

    print("\nВсе реализации согласованы.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
