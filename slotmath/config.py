"""
Загрузка и валидация конфигурации игры.

Конфигурация хранится в `config/game.json` — единый источник правды
для Python-математики и TypeScript-сервера.
"""

from __future__ import annotations

import json
import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List

# Корень репозитория: slotmath/config.py -> slotmath -> корень
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = REPO_ROOT / "config" / "game.json"


@dataclass
class GameConfig:
    """Полное математическое описание игры."""

    name: str
    version: str
    symbols: List[str]
    # Символ -> {количество совпадений: выплата в ставках на линию}
    paytable: Dict[str, Dict[int, int]]
    # Ленты базовой игры: 5 списков символов
    base_reels: List[List[str]]
    # Ленты режима фриспинов (обычно «богаче» на wild/scatter)
    free_reels: List[List[str]]
    wild: str
    scatter: str
    # Сколько скаттеров нужно для запуска фриспинов
    scatter_trigger: int
    # Количество scatter -> число выдаваемых фриспинов
    free_spins_award: Dict[int, int]
    # Количество scatter -> выплата scatter (множитель ОБЩЕЙ ставки)
    scatter_pays: Dict[int, int]
    # Множитель всех выигрышей в режиме фриспинов
    free_spin_multiplier: int
    # Разрешён ли ретриггер фриспинов
    retrigger_enabled: bool
    # Барабаны, на которых может появляться wild (0-индексация)
    wild_reels: List[int]
    lines: int
    target_rtp: float
    max_win_cap: int  # потолок выигрыша за раунд, в общих ставках
    meta: dict = field(default_factory=dict)

    # ---------- производные свойства ----------

    @property
    def num_reels(self) -> int:
        return len(self.base_reels)

    @property
    def base_cycle(self) -> int:
        """Число комбинаций полного цикла базовой игры."""
        total = 1
        for reel in self.base_reels:
            total *= len(reel)
        return total

    def symbol_counts(self, reels: List[List[str]]) -> List[Dict[str, int]]:
        """Счётчики символов по каждому барабану."""
        result = []
        for reel in reels:
            counts: Dict[str, int] = {}
            for sym in reel:
                counts[sym] = counts.get(sym, 0) + 1
            result.append(counts)
        return result

    def config_hash(self) -> str:
        """
        SHA-256 канонического представления конфигурации.

        Пишется в аудит-лог каждого раунда: позволяет доказать,
        на какой именно математике был сыгран раунд.
        """
        # Разделители заданы явно, хотя и совпадают с умолчанием json.dumps.
        # Порт на TypeScript (src/engine/config.ts) обязан выдавать ту же
        # строку байт в байт, а «умолчание» — не спецификация: одна попытка
        # сделать канонический JSON компактным уже разошлась с этим хэшем.
        payload = json.dumps(
            self.to_dict(),
            sort_keys=True,
            ensure_ascii=False,
            separators=(", ", ": "),
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    # ---------- сериализация ----------

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "symbols": self.symbols,
            "paytable": {s: {str(k): v for k, v in t.items()} for s, t in self.paytable.items()},
            "baseReels": self.base_reels,
            "freeReels": self.free_reels,
            "wild": self.wild,
            "scatter": self.scatter,
            "scatterTrigger": self.scatter_trigger,
            "freeSpinsAward": {str(k): v for k, v in self.free_spins_award.items()},
            "scatterPays": {str(k): v for k, v in self.scatter_pays.items()},
            "freeSpinMultiplier": self.free_spin_multiplier,
            "retriggerEnabled": self.retrigger_enabled,
            "wildReels": self.wild_reels,
            "lines": self.lines,
            "targetRtp": self.target_rtp,
            "maxWinCap": self.max_win_cap,
            "meta": self.meta,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "GameConfig":
        return cls(
            name=data["name"],
            version=data["version"],
            symbols=data["symbols"],
            paytable={
                s: {int(k): int(v) for k, v in t.items()} for s, t in data["paytable"].items()
            },
            base_reels=data["baseReels"],
            free_reels=data["freeReels"],
            wild=data["wild"],
            scatter=data["scatter"],
            scatter_trigger=int(data["scatterTrigger"]),
            free_spins_award={int(k): int(v) for k, v in data["freeSpinsAward"].items()},
            scatter_pays={int(k): int(v) for k, v in data["scatterPays"].items()},
            free_spin_multiplier=int(data["freeSpinMultiplier"]),
            retrigger_enabled=bool(data["retriggerEnabled"]),
            wild_reels=list(data["wildReels"]),
            lines=int(data["lines"]),
            target_rtp=float(data["targetRtp"]),
            max_win_cap=int(data["maxWinCap"]),
            meta=data.get("meta", {}),
        )

    def validate(self) -> None:
        """Проверка целостности конфигурации. Падает с ValueError при проблеме."""
        if self.num_reels != 5:
            raise ValueError(f"Ожидалось 5 барабанов, получено {self.num_reels}")

        if len(self.free_reels) != 5:
            raise ValueError("Ленты фриспинов должны состоять из 5 барабанов")

        known = set(self.symbols)
        for name, reels in (("base", self.base_reels), ("free", self.free_reels)):
            for i, reel in enumerate(reels):
                if not reel:
                    raise ValueError(f"{name}: барабан {i} пуст")
                for sym in reel:
                    if sym not in known:
                        raise ValueError(f"{name}: барабан {i} содержит неизвестный символ {sym!r}")

        # Wild не должен встречаться на барабанах вне wild_reels.
        for name, reels in (("base", self.base_reels), ("free", self.free_reels)):
            for i, reel in enumerate(reels):
                if self.wild in reel and i not in self.wild_reels:
                    raise ValueError(
                        f"{name}: wild на барабане {i}, но он не указан в wildReels {self.wild_reels}"
                    )

        # Scatter обязан быть на каждом барабане, иначе триггер недостижим.
        for i, reel in enumerate(self.base_reels):
            if self.scatter not in reel:
                raise ValueError(f"base: на барабане {i} нет scatter — триггер фриспинов невозможен")

        # Wild и scatter не должны быть в обычной таблице выплат как линейные символы,
        # если это не задумано явно.
        if self.scatter in self.paytable:
            raise ValueError("Scatter не должен быть в paytable — для него отдельный scatterPays")

        # Выплаты должны монотонно расти с числом совпадений.
        for sym, tiers in self.paytable.items():
            prev = 0
            for count in sorted(tiers):
                if tiers[count] < prev:
                    raise ValueError(
                        f"Символ {sym}: выплата за {count} совпадений меньше, чем за меньшее число"
                    )
                prev = tiers[count]

        if self.lines <= 0:
            raise ValueError("Количество линий должно быть положительным")

        if not 0.5 < self.target_rtp < 1.0:
            raise ValueError(f"Подозрительный target_rtp: {self.target_rtp}")


def load_config(path: Path | str | None = None) -> GameConfig:
    """Читает и валидирует конфигурацию игры."""
    path = Path(path) if path else DEFAULT_CONFIG_PATH
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    cfg = GameConfig.from_dict(data)
    cfg.validate()
    return cfg


def save_config(cfg: GameConfig, path: Path | str | None = None) -> None:
    """Сохраняет конфигурацию, предварительно провалидировав."""
    cfg.validate()
    path = Path(path) if path else DEFAULT_CONFIG_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(cfg.to_dict(), fh, ensure_ascii=False, indent=2)
        fh.write("\n")
