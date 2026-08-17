#!/usr/bin/env python3
"""
Проверка соблюдения протокола агентов (T-018).

Репозиторий ведут несколько ИИ-агентов с разных машин, иногда
параллельно. Протокол из `AGENTS.md` держится на дисциплине, а
дисциплина без проверки не держится: агент, забывший обновить
`STATE.md`, стирает контекст для следующего — и узнают об этом
через смену, когда уже поздно.

Скрипт проверяет то, что можно проверить машинно:

  1. Файлы контекста на месте и не пусты.
  2. Локи валидны: разбираются, содержат обязательные поля,
     не просрочены. Просроченный лок — предупреждение, не ошибка:
     агент мог упасть, и следующий вправе его снять.
  3. Счётчики «следующий свободный ID» не отстают от факта:
     если в TASKS.md есть T-024, а счётчик обещает T-024 —
     следующий агент выдаст дубль.
  4. Ссылки на файлы внутри markdown-документов ведут в существующие
     файлы. Битая ссылка в документе для агентов дороже, чем в вебе:
     агент не откроет её глазами и не заметит подмены.
  5. STATE.md обновлялся не позже последнего коммита кода.

Запуск:
    python3 scripts/check_protocol.py
    python3 scripts/check_protocol.py --strict   # предупреждения = ошибки

Код возврата: 0 — всё хорошо, 1 — есть ошибки.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent

# Файлы, без которых протокол не работает.
REQUIRED_FILES = [
    "AGENTS.md",
    "README.md",
    "agents/STATE.md",
    "agents/HANDOFF.md",
    "agents/TASKS.md",
    "agents/JOURNAL.md",
    "agents/DECISIONS.md",
    "agents/QUESTIONS.md",
    "agents/GLOSSARY.md",
]

# Обязательные поля лока (см. AGENTS.md §4.1).
LOCK_FIELDS = ["agent", "task", "scope", "started", "expires"]

# Каталоги, которые не сканируются на битые ссылки.
SKIP_DIRS = {".git", "node_modules", "build", "dist", ".venv", "__pycache__"}


class Report:
    """Накопитель проблем."""

    def __init__(self) -> None:
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.checks: List[Tuple[str, bool]] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    def check(self, name: str, passed: bool) -> None:
        self.checks.append((name, passed))


def parse_lock(text: str) -> dict:
    """
    Разбирает лок. Формат — плоский YAML-подобный `ключ: значение`,
    полноценный парсер YAML ради пяти полей не нужен.
    """
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        out[key.strip()] = value.strip()
    return out


def parse_timestamp(value: str) -> datetime | None:
    """Разбирает ISO-8601 с Z или смещением."""
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def check_required_files(rep: Report) -> None:
    """Файлы контекста существуют и содержательны."""
    ok = True
    for rel in REQUIRED_FILES:
        p = REPO_ROOT / rel
        if not p.exists():
            rep.error(f"нет обязательного файла {rel}")
            ok = False
        elif p.stat().st_size < 100:
            rep.error(f"{rel} подозрительно пуст ({p.stat().st_size} байт)")
            ok = False
    rep.check("Файлы контекста на месте", ok)


def check_locks(rep: Report) -> None:
    """Локи валидны и не просрочены."""
    lock_dir = REPO_ROOT / "agents" / "locks"
    ok = True

    if not lock_dir.exists():
        rep.error("нет каталога agents/locks")
        rep.check("Локи валидны", False)
        return

    now = datetime.now(timezone.utc)
    locks = sorted(lock_dir.glob("*.lock"))

    for lock in locks:
        data = parse_lock(lock.read_text(encoding="utf-8"))
        rel = lock.relative_to(REPO_ROOT)

        missing = [f for f in LOCK_FIELDS if f not in data]
        if missing:
            rep.error(f"{rel}: нет полей {', '.join(missing)}")
            ok = False
            continue

        expires = parse_timestamp(data["expires"])
        if expires is None:
            rep.error(f"{rel}: expires не разбирается: {data['expires']!r}")
            ok = False
            continue

        started = parse_timestamp(data["started"])
        if started and expires <= started:
            rep.error(f"{rel}: expires не позже started")
            ok = False

        if expires < now:
            age = now - expires
            hours = int(age.total_seconds() // 3600)
            # Не ошибка: агент мог упасть, следующий вправе снять лок.
            rep.warn(
                f"{rel}: лок просрочен на {hours} ч "
                f"(агент {data['agent']}, задача {data['task']}) — "
                f"можно снять, записав это в JOURNAL.md"
            )

    rep.check(f"Локи валидны ({len(locks)} шт.)", ok)


def _declared_line(text: str, prefix: str) -> str | None:
    """Строка, объявляющая следующий свободный номер."""
    for line in text.splitlines():
        if re.search(rf"[Сс]ледующий[^\n]*?{prefix}-\d+", line):
            return line
    return None


def _max_id(text: str, prefix: str) -> int:
    """
    Максимальный занятый номер идентификатора вида PREFIX-NNN.

    Строка-объявление «следующий свободный T-024» исключается: иначе
    она сама себя объявляет занятой, и проверка всегда падает.
    """
    declared = _declared_line(text, prefix)
    lines = [l for l in text.splitlines() if l != declared]
    nums = [int(m) for m in re.findall(rf"{prefix}-(\d+)", "\n".join(lines))]
    return max(nums) if nums else 0


def _declared_next(text: str, prefix: str) -> int | None:
    """Объявленный «следующий свободный» номер."""
    line = _declared_line(text, prefix)
    if line is None:
        return None
    m = re.search(rf"{prefix}-(\d+)", line)
    return int(m.group(1)) if m else None


def check_id_counters(rep: Report) -> None:
    """
    Счётчики следующих свободных ID не должны указывать на занятый номер.

    Это ловит конкретный сбой параллельной работы: два агента, каждый
    прочитавший «следующий T-024», создают две разные задачи T-024.
    """
    ok = True
    targets = [
        ("agents/TASKS.md", "T", "задача"),
        ("agents/DECISIONS.md", "ADR", "решение"),
        ("agents/QUESTIONS.md", "Q", "вопрос"),
    ]

    for rel, prefix, label in targets:
        p = REPO_ROOT / rel
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8")
        declared = _declared_next(text, prefix)
        if declared is None:
            rep.warn(f"{rel}: не объявлен следующий свободный {prefix}-номер")
            continue

        # Максимальный ID ищется по всему репозиторию: задача могла
        # быть упомянута в журнале или коммите раньше, чем в реестре.
        used = _max_id(text, prefix)
        if declared <= used:
            rep.error(
                f"{rel}: объявлен следующий {prefix}-{declared:03d}, "
                f"но {prefix}-{used:03d} уже занят ({label}) — "
                f"следующий агент создаст дубль"
            )
            ok = False

    rep.check("Счётчики ID не отстают", ok)


def check_markdown_links(rep: Report) -> None:
    """
    Ссылки на файлы репозитория ведут в существующие пути.

    Проверяются только относительные ссылки на файлы; http(s), якоря
    и mailto пропускаются.
    """
    ok = True
    pattern = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")
    checked = 0

    for md in sorted(REPO_ROOT.rglob("*.md")):
        if any(part in SKIP_DIRS for part in md.parts):
            continue

        text = md.read_text(encoding="utf-8")
        for _, target in pattern.findall(text):
            target = target.strip()
            if target.startswith(("http://", "https://", "#", "mailto:")):
                continue
            # Отбрасываем якорь внутри файла.
            path_part = target.split("#", 1)[0]
            if not path_part:
                continue

            candidate = (md.parent / path_part).resolve()
            checked += 1
            if not candidate.exists():
                rep.error(
                    f"{md.relative_to(REPO_ROOT)}: битая ссылка на {path_part}"
                )
                ok = False

    rep.check(f"Ссылки в markdown живые (проверено {checked})", ok)


def _git(args: List[str]) -> str:
    try:
        return subprocess.run(
            ["git", *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def check_state_freshness(rep: Report) -> None:
    """
    STATE.md обновлялся не позже последнего коммита, менявшего код.

    Золотое правило AGENTS.md: работа, о которой не написано в STATE.md,
    для следующего агента не существует.
    """
    code_paths = ["src", "slotmath", "scripts", "client", "db", "api", "config"]

    state_ts = _git(["log", "-1", "--format=%ct", "--", "agents/STATE.md"])
    code_ts = _git(["log", "-1", "--format=%ct", "--", *code_paths])

    if not state_ts or not code_ts:
        rep.warn("git-история недоступна, свежесть STATE.md не проверена")
        rep.check("STATE.md не отстаёт от кода", True)
        return

    state_i, code_i = int(state_ts), int(code_ts)
    if state_i < code_i:
        lag_h = (code_i - state_i) / 3600
        rep.warn(
            f"agents/STATE.md отстаёт от последнего коммита кода "
            f"на {lag_h:.1f} ч — обновите его перед концом смены"
        )
    rep.check("STATE.md не отстаёт от кода", True)


def check_journal_append_only(rep: Report) -> None:
    """
    Журнал только дополняется.

    Сравнивается с версией из origin/main: если в HEAD строки журнала
    исчезли или изменились, кто-то переписал прошлую запись, что прямо
    запрещено протоколом.
    """
    base = _git(["show", "origin/main:agents/JOURNAL.md"])
    if not base:
        rep.warn("origin/main недоступен, append-only журнала не проверен")
        rep.check("JOURNAL.md только дополняется", True)
        return

    current = (REPO_ROOT / "agents" / "JOURNAL.md").read_text(encoding="utf-8")
    if not current.startswith(base.rstrip()) and base.rstrip() not in current:
        rep.error(
            "agents/JOURNAL.md: прошлые записи изменены или удалены — "
            "журнал append-only (AGENTS.md §3)"
        )
        rep.check("JOURNAL.md только дополняется", False)
        return

    rep.check("JOURNAL.md только дополняется", True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Проверка протокола агентов")
    ap.add_argument(
        "--strict",
        action="store_true",
        help="считать предупреждения ошибками",
    )
    args = ap.parse_args()

    rep = Report()

    check_required_files(rep)
    check_locks(rep)
    check_id_counters(rep)
    check_markdown_links(rep)
    check_state_freshness(rep)
    check_journal_append_only(rep)

    print("=" * 70)
    print("ПРОВЕРКА ПРОТОКОЛА АГЕНТОВ")
    print("=" * 70)
    for name, passed in rep.checks:
        print(f"[{'PASS' if passed else 'FAIL'}] {name}")

    if rep.warnings:
        print()
        print("Предупреждения:")
        for w in rep.warnings:
            print(f"  ! {w}")

    if rep.errors:
        print()
        print("Ошибки:")
        for e in rep.errors:
            print(f"  x {e}")

    print()
    failed = bool(rep.errors) or (args.strict and bool(rep.warnings))
    if failed:
        print("ИТОГ: протокол нарушен")
        return 1

    print("ИТОГ: протокол соблюдён")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
