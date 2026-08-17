#!/usr/bin/env python3
"""
Генератор эталонных раундов (golden fixtures).

Зачем: у нас будет три независимые реализации одной и той же математики —
Python (`slotmath/`), TypeScript-сервер (`src/`) и офлайн-верификатор
(один HTML-файл). Расхождение между ними означает, что provably fair
не работает: игрок пересчитает раунд и получит не то, что показал сервер.

Фикстуры — это контракт. Каждая реализация обязана на тех же сидах
выдать те же стопы, ту же сетку и ту же выплату до последнего кредита.

Файл на выходе: tests/fixtures/rounds.json

Отбор случаев не случайный: перебираем nonce, пока не наберём
представителей всех интересных ветвей — пустой спин, выигрыш по линии,
scatter-выплата без триггера, триггер фриспинов, ретриггер, крупный
выигрыш. Так фикстуры покрывают код, а не только «средний» спин.

Использование:
    python3 scripts/gen_fixtures.py
    python3 scripts/gen_fixtures.py --out tests/fixtures/rounds.json --scan 20000
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from slotmath.config import GameConfig, load_config  # noqa: E402
from slotmath.round import hash_server_seed, play_round  # noqa: E402

# Фиксированные сиды. Серверный сид здесь ПУБЛИЧНЫЙ и намеренно
# «некриптографический» — это тестовые данные, а не боевая пара.
SERVER_SEED = "a" * 64
CLIENT_SEED = "player-fixture-seed"


def classify(record) -> str:
    """
    К какой ветви логики относится раунд.

    Порядок проверок — от более редкой ветви к более частой, потому что
    один раунд может подходить сразу под несколько (например, ретриггер
    почти всегда ещё и крупный выигрыш).

    Отдельной ветви «scatter-выплата без фриспинов» не существует
    по построению математики: scatter начинает платить с трёх штук,
    а три штуки — это уже триггер. Поэтому прямая выплата за scatter
    всегда попадает внутрь случаев free_spins_* и retrigger.

    Потолок выигрыша (maxWinCap = 5000x) в фикстурах тоже не встречается:
    за 200 тыс. просканированных раундов максимум составил около 200x.
    Обрезка по потолку проверяется отдельным юнит-тестом на синтетическом
    конфиге с заниженным потолком — см. tests/test_round.py.
    """
    base = record.spins[0]
    free_spins = [s for s in record.spins if s.free]
    win_x = record.total_win / record.total_bet

    if record.capped:
        return "capped"
    if any(s.triggered_free_spins > 0 for s in free_spins):
        return "retrigger"
    if base.scatter_count >= 4:
        return "free_spins_4"
    if base.triggered_free_spins > 0:
        return "free_spins_3"
    if win_x >= 20:
        return "big_win"
    if win_x >= 2:
        return "line_win_mid"
    if record.total_win > 0:
        return "line_win_small"
    return "no_win"


# Сколько раундов каждого типа положить в фикстуры.
# Порядок ключей задаёт порядок вывода отчёта.
QUOTA = {
    "no_win": 5,
    "line_win_small": 6,
    "line_win_mid": 4,
    "big_win": 3,
    "free_spins_3": 4,
    "free_spins_4": 2,
    "retrigger": 2,
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Генерация эталонных раундов")
    parser.add_argument("--config", default=None, help="путь к game.json")
    parser.add_argument(
        "--out",
        default="tests/fixtures/rounds.json",
        help="куда записать фикстуры",
    )
    parser.add_argument(
        "--scan",
        type=int,
        default=100_000,
        help="сколько nonce перебрать в поисках редких случаев",
    )
    parser.add_argument("--bet-per-line", type=int, default=1)
    args = parser.parse_args()

    cfg: GameConfig = load_config(args.config) if args.config else load_config()

    print(f"Игра: {cfg.name} v{cfg.version}")
    print(f"Хэш конфигурации: {cfg.config_hash()}")
    print(f"Серверный сид (тестовый): {SERVER_SEED}")
    print(f"Коммитмент: {hash_server_seed(SERVER_SEED)}")
    print(f"Клиентский сид: {CLIENT_SEED}")
    print(f"Сканируем nonce 0..{args.scan - 1}\n")

    collected: dict[str, list] = {key: [] for key in QUOTA}
    scanned = 0

    for nonce in range(args.scan):
        scanned += 1
        record = play_round(cfg, SERVER_SEED, CLIENT_SEED, nonce, args.bet_per_line)
        kind = classify(record)

        if kind in collected and len(collected[kind]) < QUOTA[kind]:
            collected[kind].append((nonce, record))

        if all(len(collected[k]) >= QUOTA[k] for k in QUOTA):
            break

    print(f"Просканировано nonce: {scanned}")
    for kind in QUOTA:
        found = len(collected[kind])
        mark = "OK " if found >= QUOTA[kind] else "НЕТ"
        print(f"  [{mark}] {kind:<12} {found}/{QUOTA[kind]}")

    cases = []
    for kind in QUOTA:
        for nonce, record in collected[kind]:
            data = record.as_dict()
            data["kind"] = kind
            data["nonce"] = nonce
            cases.append(data)

    cases.sort(key=lambda c: c["nonce"])

    payload = {
        "generatedBy": "scripts/gen_fixtures.py",
        "game": cfg.name,
        "gameVersion": cfg.version,
        "configHash": cfg.config_hash(),
        "serverSeed": SERVER_SEED,
        "serverSeedHash": hash_server_seed(SERVER_SEED),
        "clientSeed": CLIENT_SEED,
        "betPerLine": args.bet_per_line,
        "scannedNonces": scanned,
        "note": (
            "Эталонные раунды. Любая реализация математики обязана "
            "воспроизвести reelStops, grid и win в точности. "
            "Серверный сид здесь публичный — это тестовые данные."
        ),
        "cases": cases,
    }

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = Path(__file__).resolve().parent.parent / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"\nЗаписано случаев: {len(cases)}")
    print(f"Файл: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
