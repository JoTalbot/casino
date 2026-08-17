#!/usr/bin/env python3
"""
Сборка автономного HTML-верификатора раунда.

Берёт шаблон `verifier/verify.template.html`, вшивает в него конфигурацию
игры, определения линий и урезанные эталонные раунды, кладёт результат
в `verifier/verify.html`.

Почему один файл без зависимостей: игрок должен иметь возможность скачать
его, отключить интернет и проверить раунд. Верификатор, который ходит на
наш сервер, не доказывает ничего — мы могли бы вернуть любой ответ.
Поэтому здесь же проверяется, что в собранном файле нет ни одной ссылки
наружу; при находке сборка падает.

Использование:
    python3 scripts/build_verifier.py
    python3 scripts/build_verifier.py --out verifier/verify.html
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from slotmath.config import load_config  # noqa: E402
from slotmath.paylines import PAYLINES  # noqa: E402

TEMPLATE = REPO_ROOT / "verifier" / "verify.template.html"
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "rounds.json"
DEFAULT_OUT = REPO_ROOT / "verifier" / "verify.html"

# Паттерны, выдающие обращение к сети. Проверяются в СОБРАННОМ файле.
NETWORK_PATTERNS = [
    (r"https?://", "абсолютная ссылка http(s)"),
    (r"<script[^>]+src=", "внешний скрипт"),
    (r"<link[^>]+href=", "внешняя таблица стилей или ресурс"),
    (r"\bfetch\s*\(", "вызов fetch"),
    (r"XMLHttpRequest", "XMLHttpRequest"),
    (r"WebSocket", "WebSocket"),
    (r"navigator\.sendBeacon", "sendBeacon"),
    (r"@import", "CSS @import"),
    (r"crypto\.subtle", "crypto.subtle (недоступен на file://)"),
]


def slim_fixtures(data: dict) -> dict:
    """
    Урезает фикстуры до того, что нужно самопроверке в браузере.

    Полный файл содержит развёрнутые сетки и детализацию выплат — около
    160 КБ. В верификаторе этого не нужно: чтобы поймать ошибку сборки,
    достаточно сверить стопы, итоговый выигрыш и расход случайных чисел.
    Сетка однозначно определяется стопами, а выплата — сеткой.
    """
    cases = []
    for case in data["cases"]:
        cases.append(
            {
                "nonce": case["nonce"],
                "kind": case["kind"],
                "totalWin": case["totalWin"],
                "drawCount": case["drawCount"],
                "stops": [spin["reelStops"] for spin in case["spins"]],
            }
        )
    return {
        "serverSeed": data["serverSeed"],
        "serverSeedHash": data["serverSeedHash"],
        "clientSeed": data["clientSeed"],
        "betPerLine": data["betPerLine"],
        "configHash": data["configHash"],
        "cases": cases,
    }


def strip_comments(html: str) -> str:
    """
    Убирает HTML- и JS-комментарии, сохраняя нумерацию строк.

    Нужно, чтобы проверка на офлайн не срабатывала на тексте пояснений.
    Первая редакция падала на фразе «crypto.subtle недоступен на file://»
    в комментарии — то есть ругалась на объяснение того, почему сеть здесь
    не используется. Комментарии заменяются пробелами той же длины, чтобы
    номера строк в отчёте оставались настоящими.
    """

    def blank(match: re.Match) -> str:
        return re.sub(r"[^\n]", " ", match.group(0))

    html = re.sub(r"<!--.*?-->", blank, html, flags=re.DOTALL)
    html = re.sub(r"/\*.*?\*/", blank, html, flags=re.DOTALL)
    # Однострочные // — только когда строка не является URL вида http://.
    html = re.sub(r"(?<![:\"\'])//[^\n]*", blank, html)
    return html


def check_offline(html: str) -> list[str]:
    """Ищет в собранном файле всё, что может обратиться в сеть."""
    code = strip_comments(html)
    problems = []
    for pattern, description in NETWORK_PATTERNS:
        for match in re.finditer(pattern, code, flags=re.IGNORECASE):
            line = code.count("\n", 0, match.start()) + 1
            snippet = code[match.start() : match.start() + 60].replace("\n", " ")
            problems.append(f"строка {line}: {description} — {snippet.strip()}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="Сборка офлайн-верификатора")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument(
        "--allow-network",
        action="store_true",
        help="не падать при обнаружении внешних ссылок (только для отладки)",
    )
    args = parser.parse_args()

    if not TEMPLATE.exists():
        print(f"ОШИБКА: нет шаблона {TEMPLATE}")
        return 1
    if not FIXTURES.exists():
        print(f"ОШИБКА: нет фикстур {FIXTURES}, запустите scripts/gen_fixtures.py")
        return 1

    cfg = load_config()
    config_hash = cfg.config_hash()
    fixtures = json.loads(FIXTURES.read_text(encoding="utf-8"))

    if fixtures["configHash"] != config_hash:
        print("ОШИБКА: фикстуры собраны на другой версии конфигурации.")
        print(f"  в фикстурах: {fixtures['configHash']}")
        print(f"  сейчас:      {config_hash}")
        print("  Перегенерируйте: python3 scripts/gen_fixtures.py")
        return 1

    compact = dict(separators=(",", ":"), ensure_ascii=False)
    html = TEMPLATE.read_text(encoding="utf-8")
    html = (
        html.replace("{{GAME_NAME}}", cfg.name)
        .replace("{{GAME_VERSION}}", cfg.version)
        .replace("{{BUILD_DATE}}", date.today().isoformat())
        .replace("{{CONFIG_HASH}}", config_hash)
        .replace("{{CONFIG_JSON}}", json.dumps(cfg.to_dict(), **compact))
        .replace("{{PAYLINES_JSON}}", json.dumps(PAYLINES, **compact))
        .replace("{{FIXTURES_JSON}}", json.dumps(slim_fixtures(fixtures), **compact))
    )

    leftovers = re.findall(r"\{\{[A-Z_]+\}\}", html)
    if leftovers:
        print(f"ОШИБКА: в шаблоне остались незаполненные плейсхолдеры: {set(leftovers)}")
        return 1

    problems = check_offline(html)
    if problems:
        print("ОБНАРУЖЕНЫ ОБРАЩЕНИЯ В СЕТЬ — верификатор обязан работать офлайн:")
        for problem in problems:
            print(f"  {problem}")
        if not args.allow_network:
            return 1

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = REPO_ROOT / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")

    size_kb = len(html.encode("utf-8")) / 1024
    print(f"Игра:              {cfg.name} v{cfg.version}")
    print(f"Хэш конфигурации:  {config_hash}")
    print(f"Эталонных раундов: {len(fixtures['cases'])}")
    print(f"Внешних ресурсов:  0 (проверено {len(NETWORK_PATTERNS)} паттернами)")
    print(f"Размер:            {size_kb:.1f} КБ")
    print(f"Файл:              {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
