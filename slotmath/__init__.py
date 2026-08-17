"""
slotmath — математическое ядро слота «Crown of Fortune».

Пакет отвечает за:
  * описание конфигурации игры (ленты барабанов, таблица выплат, линии);
  * точный аналитический расчёт RTP базовой игры по полному циклу;
  * симуляцию Monte Carlo (включая фриспины с ретриггером);
  * калибровку лент под целевой RTP;
  * генерацию PAR sheet.

Единый источник правды о конфигурации — `config/game.json`.
Тот же файл читает игровой сервер на TypeScript, поэтому математика
и продакшен-код физически не могут разойтись.
"""

from .config import GameConfig, load_config, save_config  # noqa: F401
from .paylines import PAYLINES  # noqa: F401

__all__ = ["GameConfig", "load_config", "save_config", "PAYLINES"]
