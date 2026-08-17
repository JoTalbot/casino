#!/usr/bin/env python3
"""
Генератор PAR sheet (Probability Accounting Report).

PAR sheet — основной документ, который сертификационная лаборатория
(GLI, BMM, eCOGRA, iTech Labs) требует вместе с исходниками игры.
В нём фиксируется ВСЁ, что определяет математику:

  1. Паспорт игры и хэш конфигурации
  2. Таблица выплат
  3. Ленты барабанов посимвольно + счётчики
  4. Распределения символов по барабанам
  5. Разложение RTP по компонентам и по символам
  6. Механика фриспинов и ретриггера
  7. Результаты Monte Carlo-верификации
  8. Профиль волатильности и распределение выигрышей
  9. Сходимость RTP, доверительные интервалы, банкролл

Использование:
    python3 scripts/par_sheet.py
    python3 scripts/par_sheet.py --sim simulations/report-10m.json
    python3 scripts/par_sheet.py --conf simulations/confidence.json
    python3 scripts/par_sheet.py --out docs/PAR-SHEET.md --csv

Документ пишется на русском (ADR-003), идентификаторы — на английском.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from slotmath.analytic import analyse, symbol_rtp_breakdown  # noqa: E402
from slotmath.config import GameConfig, load_config  # noqa: E402
from slotmath.engine import (  # noqa: E402
    reel_symbol_probabilities,
    scatter_count_distribution,
)
from slotmath.paylines import PAYLINES, NUM_REELS, NUM_ROWS  # noqa: E402

DEFAULT_OUT = REPO_ROOT / "docs" / "PAR-SHEET.md"
DEFAULT_SIM = REPO_ROOT / "simulations" / "report-10m.json"
DEFAULT_CONF = REPO_ROOT / "simulations" / "confidence.json"


# --------------------------------------------------------------------------
# вспомогательные функции форматирования
# --------------------------------------------------------------------------

def pct(value: float, digits: int = 4) -> str:
    return f"{value * 100:.{digits}f}%"


def num(value: int) -> str:
    return f"{value:,}".replace(",", " ")


def table(headers: List[str], rows: List[List[str]], align: Optional[List[str]] = None) -> str:
    """Markdown-таблица."""
    if align is None:
        align = ["left"] + ["right"] * (len(headers) - 1)
    sep = []
    for a in align:
        sep.append({"left": ":---", "right": "---:", "center": ":---:"}[a])
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join(sep) + " |"]
    for row in rows:
        out.append("| " + " | ".join(str(c) for c in row) + " |")
    return "\n".join(out)


def one_to(p: float) -> str:
    return f"1 к {1 / p:,.0f}".replace(",", " ") if p > 0 else "—"


# --------------------------------------------------------------------------
# секции документа
# --------------------------------------------------------------------------

def section_header(cfg: GameConfig, sim: Optional[dict]) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    verified = "да" if sim else "нет (только аналитика)"
    return f"""# PAR SHEET — {cfg.name}

> **Probability Accounting Report.** Документ описывает полную
> математическую модель игры и является приложением к пакету на
> сертификацию RNG. Сгенерирован автоматически из `config/game.json`
> скриптом `scripts/par_sheet.py` — править вручную нельзя.

{table(
    ["Поле", "Значение"],
    [
        ["Игра", cfg.name],
        ["Версия математики", cfg.version],
        ["SHA-256 конфигурации", f"`{cfg.config_hash()}`"],
        ["Формат", f"{NUM_REELS} барабанов x {NUM_ROWS} ряда"],
        ["Линий выплат", f"{cfg.lines} (фиксированные)"],
        ["Ставка", "1 кредит на линию, общая ставка = BETLINES кредитов"],
        ["Целевой RTP", pct(cfg.target_rtp, 2)],
        ["Потолок выигрыша", f"{num(cfg.max_win_cap)}x от общей ставки"],
        ["Верифицировано симуляцией", verified],
        ["Сгенерирован", now],
    ],
    ["left", "left"],
)}
""".replace("BETLINES", str(cfg.lines))


def section_summary(cfg: GameConfig, res) -> str:
    return f"""## 1. Итоговые показатели

{table(
    ["Показатель", "Значение", "Комментарий"],
    [
        ["**RTP (теоретический)**", f"**{pct(res.total_rtp)}**", "точный расчёт полного цикла"],
        ["  — линии базовой игры", pct(res.base_line_rtp), f"{res.base_line_rtp / res.total_rtp * 100:.1f}% от RTP"],
        ["  — выплаты за scatter", pct(res.scatter_pay_rtp), f"{res.scatter_pay_rtp / res.total_rtp * 100:.1f}% от RTP"],
        ["  — режим фриспинов", pct(res.free_spins_rtp), f"{res.free_spins_rtp / res.total_rtp * 100:.1f}% от RTP"],
        ["Преимущество казино", pct(1 - res.total_rtp), "house edge"],
        ["Hit frequency (аналит. оценка)", pct(res.hit_frequency_lines, 2), "верхняя граница, точное значение — в §7"],
        ["Вероятность триггера бонуса", f"{pct(res.trigger_probability)} ({one_to(res.trigger_probability)})", f"{cfg.scatter_trigger}+ scatter"],
        ["Фриспинов за триггер", f"{res.expected_free_spins:.3f}", "с учётом ретриггера"],
        ["Вероятность ретриггера", pct(res.retrigger_probability), "за один фриспин"],
        ["Ценность одного фриспина", f"{res.free_spin_value:.4f}x", "в общих ставках"],
        ["Полный цикл базовой игры", num(cfg.base_cycle), "произведение длин лент"],
    ],
    ["left", "right", "left"],
)}

### Формулы

```
RTP_total   = RTP_lines + RTP_scatter + RTP_freespins

RTP_lines   = lines * SUM over (s0..s4) P(s0)*P(s1)*P(s2)*P(s3)*P(s4) * pay(s0..s4) / bet
RTP_scatter = SUM over k>=3  P(k scatters) * scatterPay(k)
RTP_free    = P(trigger) * E[spins] * value(free spin)

E[spins]    = award / (1 - p_retrigger * award_retrigger)      # сумма геом. ряда
Total Ways  = PROD len(reel_i)
```

Расчёт линейных выплат выполнен **точной свёрткой**: тензор выплат
размером {len(cfg.symbols)}^{NUM_REELS} сворачивается с маргинальными распределениями
барабанов. Это не оценка Монте-Карло, а аналитически точное значение
полного цикла ({num(cfg.base_cycle)} комбинаций).
"""


def section_symbols(cfg: GameConfig) -> str:
    rows = []
    max_len = max(len(t) for t in cfg.paytable.values())
    counts_all = [str(k) for k in sorted({k for t in cfg.paytable.values() for k in t})]

    header = ["Символ", "Тип"] + [f"{c} в ряд" for c in counts_all]
    for sym in cfg.symbols:
        if sym == cfg.wild:
            kind = f"WILD (барабаны {', '.join(str(r + 1) for r in cfg.wild_reels)})"
        elif sym == cfg.scatter:
            kind = "SCATTER (в любом месте)"
        else:
            # Классификация по стоимости: пять самых дешёвых символов —
            # «карточные» низкие, остальные — премиум.
            by_top = sorted(cfg.paytable, key=lambda s: max(cfg.paytable[s].values()))
            kind = "низкий" if by_top.index(sym) < 5 else "премиум"

        tiers = cfg.paytable.get(sym, {})
        row = [f"`{sym}`", kind]
        for c in counts_all:
            v = tiers.get(int(c))
            row.append(num(v) if v else "—")
        rows.append(row)

    scatter_rows = [
        [f"{k} scatter", f"{v}x общей ставки", f"{cfg.free_spins_award.get(k, 0)} фриспинов"]
        for k, v in sorted(cfg.scatter_pays.items())
    ]

    return f"""## 2. Таблица выплат

Выплаты указаны **в ставках на линию**. Комбинация засчитывается
слева направо, начиная с барабана 1. Засчитывается только самая
длинная (самая дорогая) комбинация на линии — приоритет выплат
реализован в `slotmath/engine.py: build_pay_lookup()`.

{table(header, rows, ["left", "left"] + ["right"] * len(counts_all))}

### Специальные символы

- **`{cfg.wild}`** — замещает любой символ, кроме `{cfg.scatter}`.
  Появляется только на барабанах {', '.join(str(r + 1) for r in cfg.wild_reels)}.
  Wild намеренно отсутствует на первом барабане: это стандартная
  практика, которая удерживает волатильность и hit frequency в норме.
- **`{cfg.scatter}`** — платит вне линий, множитель применяется к
  **общей** ставке; запускает фриспины при {cfg.scatter_trigger}+ на экране.

{table(["Комбинация", "Выплата за scatter", "Награда фриспинами"], scatter_rows, ["left", "right", "right"])}

- Множитель всех выигрышей в режиме фриспинов: **x{cfg.free_spin_multiplier}**
- Ретриггер: **{'разрешён' if cfg.retrigger_enabled else 'запрещён'}**
"""


def section_paylines(cfg: GameConfig) -> str:
    rows = []
    for i, line in enumerate(PAYLINES, start=1):
        pattern = []
        for r in range(NUM_ROWS):
            pattern.append("".join("X" if line[c] == r else "." for c in range(NUM_REELS)))
        rows.append([str(i), " ".join(str(x) for x in line), " / ".join(pattern)])

    return f"""## 3. Линии выплат

{cfg.lines} фиксированных линий. Каждая линия задана номером ряда
(0 = верхний, {NUM_ROWS - 1} = нижний) для каждого из {NUM_REELS} барабанов.
Определение — `slotmath/paylines.py`.

{table(["№", "Ряды по барабанам", "Схема (верх / центр / низ)"], rows, ["right", "left", "left"])}

Все {cfg.lines} линий статистически эквивалентны: каждая берёт ровно один
символ с каждого барабана, а распределение символов не зависит от ряда.
Поэтому матожидание считается для одной линии и умножается на {cfg.lines}.
"""


def section_reels(cfg: GameConfig) -> str:
    def reel_block(title: str, reels: List[List[str]]) -> str:
        lengths = [len(r) for r in reels]
        cycle = 1
        for n in lengths:
            cycle *= n

        counts = cfg.symbol_counts(reels)
        all_syms = cfg.symbols
        header = ["Символ"] + [f"Барабан {i + 1}" for i in range(len(reels))] + ["Всего"]
        rows = []
        for sym in all_syms:
            vals = [c.get(sym, 0) for c in counts]
            rows.append([f"`{sym}`"] + [str(v) if v else "—" for v in vals] + [f"**{sum(vals)}**"])
        rows.append(["**Длина ленты**"] + [f"**{n}**" for n in lengths] + [f"**{sum(lengths)}**"])

        strips = []
        for i, reel in enumerate(reels, start=1):
            strips.append(f"**Барабан {i}** ({len(reel)} поз.)\n\n```\n" +
                          "\n".join(
                              f"{j:>3}: {s}" for j, s in enumerate(reel)
                          ) + "\n```")

        return f"""### {title}

Полный цикл: **{num(cycle)}** комбинаций ({" x ".join(str(n) for n in lengths)}).

{table(header, rows, ["left"] + ["right"] * (len(reels) + 1))}

<details>
<summary>Развернуть ленты посимвольно</summary>

{chr(10).join(strips)}

</details>
"""

    def prob_block(title: str, reels: List[List[str]]) -> str:
        probs = reel_symbol_probabilities(cfg, reels)
        header = ["Символ"] + [f"Барабан {i + 1}" for i in range(len(reels))]
        rows = []
        for j, sym in enumerate(cfg.symbols):
            row = [f"`{sym}`"]
            for i in range(len(reels)):
                p = float(probs[i][j])
                row.append(pct(p, 3) if p > 0 else "—")
            rows.append(row)
        return f"#### {title}\n\n{table(header, rows)}\n"

    return f"""## 4. Ленты барабанов

Ленты собраны детерминированно из счётчиков символов
(`slotmath/strips.py: build_strip()`) с двумя ограничениями:
серии одинаковых символов не длиннее 2 подряд, а scatter
разнесён так, чтобы в окне {NUM_ROWS} рядов не могло оказаться
более одного scatter с одного барабана. Сборка воспроизводима:
из тех же счётчиков всегда получается та же лента.

{reel_block("4.1. Базовая игра", cfg.base_reels)}

{reel_block("4.2. Режим фриспинов", cfg.free_reels)}

### 4.3. Вероятности символов на барабан

{prob_block("Базовая игра", cfg.base_reels)}
{prob_block("Фриспины", cfg.free_reels)}
"""


def section_rtp_breakdown(cfg: GameConfig, res) -> str:
    breakdown = symbol_rtp_breakdown(cfg)
    total_line = sum(breakdown.values())

    rows = []
    for sym, val in sorted(breakdown.items(), key=lambda kv: -kv[1]):
        rtp_share = val * cfg.lines / cfg.lines  # вклад в RTP в долях ставки
        rows.append([
            f"`{sym}`",
            pct(rtp_share),
            f"{val / total_line * 100:.2f}%" if total_line else "—",
        ])
    rows.append(["**Итого линии**", f"**{pct(total_line)}**", "**100.00%**"])

    base_dist = scatter_count_distribution(cfg, cfg.base_reels)
    free_dist = scatter_count_distribution(cfg, cfg.free_reels)
    dist_rows = []
    # Больше NUM_REELS скаттеров быть не может: на каждый барабан
    # приходится максимум один scatter в окне.
    for k in range(min(len(base_dist), NUM_REELS + 1)):
        pb = float(base_dist[k])
        pf = float(free_dist[k]) if k < len(free_dist) else 0.0
        dist_rows.append([
            f"{k} scatter",
            pct(pb, 5),
            one_to(pb),
            pct(pf, 5),
        ])

    return f"""## 5. Разложение RTP

### 5.1. Вклад символов в линейные выплаты базовой игры

Символу засчитывается только та часть, где именно его комбинация
даёт максимальную выплату на линии (учёт приоритета выплат).

{table(["Символ", "Вклад в RTP", "Доля линейных выплат"], rows)}

### 5.2. Распределение количества scatter на экране

{table(["Событие", "База: вероятность", "База: частота", "Фриспины: вероятность"], dist_rows)}

Вероятность триггера ({cfg.scatter_trigger}+ scatter): **{pct(res.trigger_probability)}**,
то есть {one_to(res.trigger_probability)} спинов.

### 5.3. Баланс компонентов

{table(
    ["Компонент", "RTP", "Доля"],
    [
        ["Линии базовой игры", pct(res.base_line_rtp), f"{res.base_line_rtp / res.total_rtp * 100:.2f}%"],
        ["Выплаты за scatter", pct(res.scatter_pay_rtp), f"{res.scatter_pay_rtp / res.total_rtp * 100:.2f}%"],
        ["Режим фриспинов", pct(res.free_spins_rtp), f"{res.free_spins_rtp / res.total_rtp * 100:.2f}%"],
        ["**Итого**", f"**{pct(res.total_rtp)}**", "**100.00%**"],
    ],
)}
"""


def section_freespins(cfg: GameConfig, res) -> str:
    return f"""## 6. Режим фриспинов

{table(
    ["Параметр", "Значение"],
    [
        ["Условие запуска", f"{cfg.scatter_trigger}+ `{cfg.scatter}` на экране"],
        ["Награда", ", ".join(f"{k} scatter → {v} спинов" for k, v in sorted(cfg.free_spins_award.items()))],
        ["Множитель выигрышей", f"x{cfg.free_spin_multiplier}"],
        ["Ленты", "отдельный набор `freeReels` (см. §4.2)"],
        ["Ретриггер", "разрешён" if cfg.retrigger_enabled else "запрещён"],
        ["Вероятность ретриггера (за спин)", pct(res.retrigger_probability)],
        ["Ожидаемое число спинов за триггер", f"{res.expected_free_spins:.4f}"],
        ["Ценность одного фриспина", f"{res.free_spin_value:.4f}x общей ставки"],
        ["Вклад режима в RTP", pct(res.free_spins_rtp)],
    ],
    ["left", "left"],
)}

### Учёт ретриггера

Ретриггер — классическая точка ошибки в математике слотов: если
считать награду как фиксированное число спинов, RTP занижается.
Правильный расчёт — сумма геометрического ряда:

```
g        = p_retrigger * award_retrigger      # прирост спинов на один фриспин
E[spins] = award_base / (1 - g)
```

Здесь `g = {res.retrigger_probability:.6f} * award ≈ {(res.expected_free_spins - (res.expected_free_spins * (1 - res.retrigger_probability))):.4f}`,
ряд сходится. При `g >= 1` игра была бы бесконечной — расчёт
в `slotmath/analytic.py` в этом случае аварийно завершается.
"""


def _agg(sim: dict) -> dict:
    """Нормализованная сводка отчёта симуляции."""
    s = sim.get("summary", {})
    runs = sim.get("runs", [])
    first = runs[0] if runs else {}
    return {
        "spins": s.get("totalSpins", 0),
        "rtp": s.get("meanRtp", 0.0),
        "mean_dev": s.get("meanDeviationPp", 0.0),
        "max_dev": s.get("maxSingleDeviationPp", 0.0),
        "hit_frequency": s.get("hitFrequency", 0.0),
        "trigger_frequency": s.get("triggerFrequency", 0.0),
        "max_win_x": s.get("maxWinX", 0.0),
        "triggers": s.get("triggers", sum(r.get("triggers", 0) for r in runs)),
        "free_spins_played": s.get(
            "freeSpinsPlayed", sum(r.get("freeSpinsPlayed", 0) for r in runs)
        ),
        "retriggers": s.get("retriggers", sum(r.get("retriggers", 0) for r in runs)),
        "std_win_x": s.get("stdWinX", first.get("stdWinX", 0.0)),
        "volatility_index": s.get("volatilityIndex", first.get("volatilityIndex", 0.0)),
        "win_distribution": s.get("winDistribution", first.get("winDistribution", {})),
        "percentiles": s.get("percentiles", first.get("percentiles", {})),
        "all_passed": s.get("allChecksPassed"),
        "sample_spins": first.get("spins", 0),
    }


def section_simulation(sim: Optional[dict], cfg: GameConfig, res) -> str:
    if not sim:
        return """## 7. Верификация Monte Carlo

> Отчёт симуляции не найден. Запустите:
> `python3 scripts/simulate.py --json simulations/report-10m.json`
"""

    agg = _agg(sim)
    runs = sim.get("runs", [])
    checks = sim.get("checks", [])

    run_rows = []
    for i, r in enumerate(runs, start=1):
        run_rows.append([
            f"Прогон {i}",
            num(r.get("spins", 0)),
            pct(r.get("rtp", 0)),
            f"{(r.get('rtp', 0) - res.total_rtp) * 100:+.4f} п.п.",
            pct(r.get("hitFrequency", 0), 2),
            f"{r.get('maxWinX', 0):.0f}x",
        ])

    check_rows = []
    for c in checks:
        ok = c.get("passed")
        check_rows.append([
            "PASS" if ok else "**FAIL**",
            c.get("name", ""),
            str(c.get("value", "")),
        ])

    sample = max(agg["sample_spins"], 1)
    dist_rows = [
        [label, num(count), f"{count / sample * 100:.3f}%"]
        for label, count in agg["win_distribution"].items()
    ]
    perc_rows = [[k, f"{v:.2f}x"] for k, v in agg["percentiles"].items()]

    fs_per_trigger = agg["free_spins_played"] / max(agg["triggers"], 1)

    return f"""## 7. Верификация Monte Carlo

Независимая проверка аналитики: {len(runs)} независимых прогона по
{num(agg["sample_spins"])} спинов, итого **{num(agg["spins"])} спинов**.
Требование индустрии для сертификации — не менее 10 млн спинов на игру.

Генератор симуляции: numpy PCG64 с фиксированным сидом
(воспроизводимость прогонов). Продакшен-RNG — отдельная реализация
`src/engine/rng.ts` (provably fair, HMAC-SHA256); симуляционный
генератор в игровой контур не попадает.

{table(["Прогон", "Спинов", "RTP", "Откл. от теории", "Hit freq.", "Max win"], run_rows)}

### Сходимость к аналитике

{table(
    ["Показатель", "Аналитика", "Симуляция", "Расхождение"],
    [
        ["RTP", pct(res.total_rtp), pct(agg["rtp"]),
         f"{(agg['rtp'] - res.total_rtp) * 100:+.4f} п.п."],
        ["Hit frequency", pct(res.hit_frequency_lines, 2) + " (верхняя оценка)",
         pct(agg["hit_frequency"], 2),
         f"{(agg['hit_frequency'] - res.hit_frequency_lines) * 100:+.2f} п.п."],
        ["Частота триггера", one_to(res.trigger_probability),
         one_to(agg["trigger_frequency"]), "—"],
        ["Фриспинов за триггер", f"{res.expected_free_spins:.3f}",
         f"{fs_per_trigger:.3f}",
         f"{fs_per_trigger - res.expected_free_spins:+.3f}"],
    ],
)}

Отклонение среднего по прогонам: **{agg["mean_dev"]:.4f} п.п.**,
максимальное отклонение одиночного прогона: **{agg["max_dev"]:.4f} п.п.**
Сыграно фриспинов: {num(agg["free_spins_played"])}, из них по ретриггеру
инициировано {num(agg["retriggers"])} продлений.

Дополнительно: индекс волатильности **{agg["volatility_index"]:.2f}**,
стандартное отклонение выигрыша за спин **{agg["std_win_x"]:.4f}**,
максимальный зафиксированный выигрыш **{agg["max_win_x"]:.0f}x**
при потолке {num(cfg.max_win_cap)}x.

### Распределение выигрышей за раунд (прогон 1)

{table(["Диапазон (в ставках)", "Спинов", "Доля"], dist_rows) if dist_rows else "_нет данных_"}

### Перцентили выигрыша за раунд

{table(["Перцентиль", "Выигрыш"], perc_rows) if perc_rows else "_нет данных_"}

### Критерии приёмки

{table(["Статус", "Критерий", "Значение"], check_rows, ["center", "left", "right"]) if check_rows else "_нет данных_"}

**Итог:** {"все проверки пройдены" if agg["all_passed"] else "**есть отклонения — математика не принята**"}.
"""


def section_volatility(cfg: GameConfig, res, sim: Optional[dict]) -> str:
    agg = _agg(sim) if sim else {}
    vol = agg.get("volatility_index")
    hf = agg.get("hit_frequency")

    if vol is None:
        profile = "не измерена (нет отчёта симуляции)"
    elif vol < 5:
        profile = "низкая"
    elif vol < 10:
        profile = "средняя"
    elif vol < 20:
        profile = "высокая"
    else:
        profile = "очень высокая"

    return f"""## 8. Профиль волатильности

{table(
    ["Параметр", "Значение", "Ориентир индустрии"],
    [
        ["Индекс волатильности", f"{vol:.2f}" if vol is not None else "—", "низкая <5, средняя 5-10, высокая 10-20"],
        ["Профиль", profile, "цель проекта: средняя"],
        ["Hit frequency", pct(hf, 2) if hf is not None else "—", "25-35% для линейного слота"],
        ["Максимальный выигрыш", f"{num(cfg.max_win_cap)}x", "1000-10000x"],
        ["Доля RTP в бонусе", pct(res.free_spins_rtp / res.total_rtp, 2), "10-40%"],
        ["Частота бонуса", one_to(res.trigger_probability), "1 к 100-500"],
    ],
    ["left", "right", "left"],
)}

Игра целится в **среднюю волатильность**: игрок получает выигрыш
примерно в каждом четвёртом спине, бонус — раз в ~300 спинов,
а {pct(res.free_spins_rtp / res.total_rtp, 1)} возврата приходит из режима фриспинов.
Такой баланс даёт достаточно частую обратную связь и при этом
сохраняет ощутимость бонуса.
"""


def section_convergence(conf: Optional[dict]) -> str:
    """§9: разброс наблюдаемого RTP по горизонтам (T-019/T-020)."""
    if not conf:
        return """## 9. Сходимость RTP и разброс по горизонтам

> Отчёт не найден. Запустите:
>
> ```bash
> python3 scripts/confidence.py --json simulations/confidence.json
> ```
"""

    sigma = conf["sigma"]
    edge = conf["edge"]
    spread = conf["spread"]
    conv = conf["convergence"]
    house = conf["houseBankroll"]
    house_mc = {
        row["bankroll"]: row for row in conf.get("houseRuinMc", [])
    }
    sessions = conf["playerSessions"]

    spread_rows = [
        [
            num(s["spins"]),
            pct(s["empiricalP025"], 2),
            pct(s["empiricalP50"], 2),
            pct(s["empiricalP975"], 2),
            f"{s['empiricalHalfWidthPp']:.3f}",
            f"{s['tailRatio']:.2f}",
            pct(s["outsideBand"], 1),
        ]
        for s in spread
    ]

    conv_rows = [
        [
            f"±{row['tolerancePp']:.2f} п.п.",
            num(row["spins90"]),
            num(row["spins95"]),
            num(row["spins99"]),
        ]
        for row in conv
    ]

    bankroll_rows = []
    for row in house:
        mc = house_mc.get(row["bankrollBets"])
        bankroll_rows.append([
            pct(row["ruinProbability"], 2),
            num(round(row["bankrollBets"])),
            pct(mc["ruinProbability"], 2) if mc else "—",
            num(mc["horizon"]) if mc else "—",
        ])

    session_rows = [
        [
            num(round(s["bankroll"])),
            num(s["horizon"]),
            pct(s["bustProbability"], 1),
            num(round(s["medianSpinsSurvived"])),
            pct(s["aheadProbability"], 1),
        ]
        for s in sessions
    ]

    # Ориентиры для текста: горизонт, на котором коридор приёмки
    # проходит хотя бы в половине случаев, и порог 95%.
    half_ok = next((s for s in spread if s["outsideBand"] <= 0.5), None)
    tight = next((s for s in spread if s["outsideBand"] <= 0.05), None)
    tol_1pp = next((r for r in conv if abs(r["tolerancePp"] - 1.0) < 1e-9), None)

    return f"""## 9. Сходимость RTP и разброс по горизонтам

Теоретический RTP — это математическое ожидание. Наблюдаемый RTP
на конечной дистанции от него отличается, и на коротких горизонтах
отличается очень сильно: стандартное отклонение выигрыша за раунд
составляет **{sigma:.4f} ставки**, то есть в {sigma / (1 - edge):.1f} раза
больше самой средней выплаты. Этот раздел показывает, какому объёму
игры соответствует какая точность.

Метод: блочный бутстрап (блок 1 000 раундов) по выборке
{num(conf["sampleRounds"])} независимых раундов, {num(20000)} реплик
на горизонт. Нормальное приближение считается рядом для контроля.

### 9.1. Раундов до сходимости

Сколько раундов нужно, чтобы доверительный интервал наблюдаемого
RTP уложился в заданную точность:

{table(
    ["Точность", "90% доверия", "95% доверия", "99% доверия"],
    conv_rows,
    ["left", "right", "right", "right"],
)}

Практический вывод: чтобы подтвердить RTP с точностью
**±1 п.п. при 95% доверия**, нужно {num(tol_1pp["spins95"]) if tol_1pp else "—"}
раундов. Отсюда же требование индустрии к объёму симуляции: 10 млн
спинов дают точность порядка ±0.25 п.п., чего достаточно для приёмки.

### 9.2. Разброс наблюдаемого RTP

{table(
    ["Раундов", "2.5%", "медиана", "97.5%", "±п.п.", "асим.", "вне 95.5-96.5%"],
    spread_rows,
    ["right", "right", "right", "right", "right", "right", "right"],
)}

Колонка «асим.» — отношение длины верхнего хвоста к нижнему
`(p97.5 - медиана) / (медиана - p2.5)`. На коротких горизонтах она
заметно больше единицы: редкие крупные выплаты тянут наблюдаемый RTP
вверх, а вниз он ограничен нулём выплат. С ростом дистанции
распределение симметризуется и сходится к нормальному.

Колонка «вне 95.5-96.5%» — доля честных прогонов, которые вышли бы
за коридор приёмки. На {num(spread[0]["spins"])} раундах это
{pct(spread[0]["outsideBand"], 1)}: **на коротких дистанциях выход за
коридор ничего не доказывает**. Коридор становится осмысленным
примерно от {num(half_ok["spins"]) if half_ok else "—"} раундов
(половина прогонов внутри) и надёжным
от {num(tight["spins"]) if tight else "—"} раундов (95% внутри).

Это же объясняет жалобы игроков вида «RTP занижен»: сессия в тысячу
спинов с наблюдаемым возвратом {pct(spread[0]["empiricalP025"], 0)}
лежит внутри нормального разброса честной игры.

### 9.3. Банкролл оператора

Преимущество оператора — **{pct(edge, 4)}** от оборота, но приходит
оно медленнее, чем накапливается риск. Минимальный запас считается
по диффузионному приближению задачи о разорении
`B = sigma^2 * ln(1/eps) / (2 * edge)`, значения в ставках:

{table(
    ["Риск разорения", "Банкролл (ставок)", "Проверка Monte Carlo", "Горизонт MC"],
    bankroll_rows,
    ["right", "right", "right", "right"],
)}

Формула считает бесконечный горизонт и потому консервативна; колонка
Monte Carlo проверяет её на конечной дистанции по реальной выборке
раундов, с отслеживанием минимума пути, а не конечной точки.

Практический вывод: при ставке 1 денежная единица оператору нужно
около **{num(round(house[1]["bankrollBets"]))} ставок** резерва, чтобы
риск разорения не превышал 1%. Резерв масштабируется линейно размеру
ставки и не зависит от числа игроков — но только если игроки
независимы, а лимит максимальной ставки соблюдается.

### 9.4. Сессия игрока

Оценка для модуля ответственной игры (T-015): сколько живёт депозит
при ставке 1 за раунд.

{table(
    ["Банкролл", "Лимит раундов", "Проигрался", "Медиана раундов", "Ушёл в плюсе"],
    session_rows,
    ["right", "right", "right", "right", "right"],
)}

Числа стоит показывать игроку в честной формулировке: депозит в
{num(round(sessions[0]["bankroll"]))} ставок заканчивается
в {pct(sessions[0]["bustProbability"], 0)} сессий, а медианное время
игры — около {num(round(sessions[0]["medianSpinsSurvived"]))} раундов.

Строки таблицы **не сравнимы напрямую**: в каждой растёт и банкролл,
и лимит раундов, поэтому доля выигрышных сессий по столбцу
немонотонна. Больший депозит снижает риск проиграть всё
({pct(sessions[0]["bustProbability"], 0)} против
{pct(sessions[-1]["bustProbability"], 0)}), но одновременно удлиняет
игру, а с числом сыгранных раундов вероятность уйти в плюсе падает.
Общий предел один: доля сессий, законченных в плюсе, ни в одном
сценарии не превышает {pct(max(s["aheadProbability"] for s in sessions), 0)},
и при неограниченной игре стремится к нулю — это и есть
математическое содержание фразы «дом всегда выигрывает».

### 9.5. Воспроизведение

```bash
python3 scripts/confidence.py --json simulations/confidence.json
```
"""


def section_integrity(cfg: GameConfig) -> str:
    return f"""## 10. Целостность и воспроизводимость

### Хэш конфигурации

```
SHA-256(config/game.json, канонический JSON) =
{cfg.config_hash()}
```

Хэш вычисляется по каноническому представлению
(`GameConfig.config_hash()`: JSON с сортировкой ключей) и
записывается в аудит-лог **каждого раунда**. Это позволяет
доказать постфактум, на какой именно версии математики был
сыгран конкретный раунд, и обнаружить любую подмену лент
или таблицы выплат.

### Воспроизведение расчётов

```bash
# пересобрать математику из счётчиков символов
python3 scripts/build_game.py

# аналитика + Monte Carlo + критерии приёмки
python3 scripts/simulate.py --spins 10000000 --runs 3 \\
        --json simulations/report-10m.json

# перегенерировать этот документ
python3 scripts/par_sheet.py
```

Все шаги детерминированы: сборка лент из счётчиков воспроизводима
побайтово, аналитика точная (не стохастическая), симуляция
использует фиксированный сид.

### Проверяемые инварианты (`GameConfig.validate()`)

- ровно {NUM_REELS} барабана в базовом наборе и в наборе фриспинов;
- каждый символ ленты присутствует в списке `symbols`;
- `{cfg.wild}` встречается только на барабанах {', '.join(str(r + 1) for r in cfg.wild_reels)};
- `{cfg.scatter}` присутствует на каждом барабане базовой игры;
- `{cfg.scatter}` отсутствует в таблице линейных выплат;
- выплаты монотонно не убывают с ростом числа совпадений;
- число линий > 0, целевой RTP в диапазоне (0.5, 1.0).

### Ограничения документа

1. Hit frequency в §1 — аналитическая **верхняя** оценка
   `1-(1-p)^{cfg.lines}` (линии делят символы и не независимы).
   Точное значение даёт симуляция, §7.
2. Модель описывает математику, но не пользовательский интерфейс,
   не anti-cheat и не серверную RNG — это отдельные документы.
3. Документ не является заключением сертификационной лаборатории.
"""


def write_csv(cfg: GameConfig, res, out_dir: Path) -> List[Path]:
    """Машиночитаемые приложения к PAR sheet."""
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []

    # 1. Ленты
    p = out_dir / "par-reels.csv"
    with p.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["set", "reel", "position", "symbol"])
        for name, reels in (("base", cfg.base_reels), ("free", cfg.free_reels)):
            for i, reel in enumerate(reels, start=1):
                for j, sym in enumerate(reel):
                    w.writerow([name, i, j, sym])
    written.append(p)

    # 2. Паутейбл
    p = out_dir / "par-paytable.csv"
    with p.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["symbol", "matches", "pay_per_line"])
        for sym, tiers in cfg.paytable.items():
            for k, v in sorted(tiers.items()):
                w.writerow([sym, k, v])
        for k, v in sorted(cfg.scatter_pays.items()):
            w.writerow([cfg.scatter, k, f"{v} (x total bet)"])
    written.append(p)

    # 3. Разложение RTP
    p = out_dir / "par-rtp-breakdown.csv"
    breakdown = symbol_rtp_breakdown(cfg)
    with p.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["component", "rtp"])
        for sym, val in sorted(breakdown.items(), key=lambda kv: -kv[1]):
            w.writerow([f"line:{sym}", f"{val:.8f}"])
        w.writerow(["scatter_pays", f"{res.scatter_pay_rtp:.8f}"])
        w.writerow(["free_spins", f"{res.free_spins_rtp:.8f}"])
        w.writerow(["total", f"{res.total_rtp:.8f}"])
    written.append(p)

    return written


def main() -> int:
    ap = argparse.ArgumentParser(description="Генератор PAR sheet")
    ap.add_argument("--config", type=Path, default=None, help="путь к game.json")
    ap.add_argument("--sim", type=Path, default=DEFAULT_SIM, help="отчёт симуляции (JSON)")
    ap.add_argument("--conf", type=Path, default=DEFAULT_CONF, help="отчёт сходимости (JSON)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="куда писать Markdown")
    ap.add_argument("--csv", action="store_true", help="дополнительно выгрузить CSV-приложения")
    args = ap.parse_args()

    cfg = load_config(args.config)
    cfg.validate()
    res = analyse(cfg)

    sim: Optional[dict] = None
    if args.sim and args.sim.exists():
        sim = json.loads(args.sim.read_text(encoding="utf-8"))

    conf: Optional[dict] = None
    if args.conf and args.conf.exists():
        conf = json.loads(args.conf.read_text(encoding="utf-8"))

    parts = [
        section_header(cfg, sim),
        section_summary(cfg, res),
        section_symbols(cfg),
        section_paylines(cfg),
        section_reels(cfg),
        section_rtp_breakdown(cfg, res),
        section_freespins(cfg, res),
        section_simulation(sim, cfg, res),
        section_volatility(cfg, res, sim),
        section_convergence(conf),
        section_integrity(cfg),
    ]

    doc = "\n\n---\n\n".join(p.strip() for p in parts) + "\n"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(doc, encoding="utf-8")

    print(f"PAR sheet записан: {args.out}  ({len(doc.splitlines())} строк)")
    print(f"  RTP {pct(res.total_rtp)}, хэш конфига {cfg.config_hash()[:16]}...")
    if sim:
        agg = _agg(sim)
        print(
            f"  подключён отчёт симуляции: {num(agg['spins'])} спинов, "
            f"RTP {pct(agg['rtp'])}"
        )
    else:
        print("  ВНИМАНИЕ: отчёт симуляции не найден, §7 пустой")

    if conf:
        print(f"  подключён отчёт сходимости: sigma {conf['sigma']:.4f}")
    else:
        print("  ВНИМАНИЕ: отчёт сходимости не найден, §9 пустой")

    if args.csv:
        for p in write_csv(cfg, res, args.out.parent / "par"):
            print(f"  CSV: {p}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
