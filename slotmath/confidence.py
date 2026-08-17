"""
Статистика сходимости RTP, доверительные интервалы и требования к банкроллу.

Зачем это нужно
---------------
Аналитический RTP 95.9778% — это математическое ожидание. Реальная касса
на коротком горизонте от него отличается, и отличается сильно: слот со
стандартным отклонением 4.11 ставки за раунд на тысяче спинов даёт разброс
RTP в десятки процентных пунктов. Отсюда два практических вопроса:

  1. Сколько спинов нужно, чтобы наблюдаемый RTP сошёлся к теоретическому
     с заданной точностью? (проверка честности игры, приёмка билда)
  2. Какой запас денег нужен оператору, чтобы не разориться на дистанции,
     и игроку, чтобы досидеть до бонуса? (экономика и ответственная игра)

Оба вопроса — про одну и ту же величину, дисперсию выигрыша за раунд.

Метод
-----
Нормальная теория (CLT) даёт полуширину доверительного интервала
`z * sigma / sqrt(n)`. Но распределение выигрыша слота тяжелохвостое
(74% нулей, редкие выплаты в сотни ставок), и на малых n нормальное
приближение врёт: реальное распределение среднего скошено вправо.
Поэтому рядом с формулой считается **эмпирическое** распределение через
блочный бутстрап по выборке реальных раундов, а расхождение между двумя
оценками само по себе показатель — оно и говорит, с какого n можно
доверять формуле.

Блочный бутстрап
----------------
Пересэмплировать 10 млн значений на каждую реплику невозможно. Но раунды
независимы, поэтому среднее по `n = b * k` раундов — это среднее по `k`
независимым блочным суммам размера `b`. Считаем один раз пул блочных сумм
(b = 1000), дальше любое n получается дешёвым пересэмплированием этого
пула. Оценка остаётся корректной: блоки iid по построению.

ВАЖНО: numpy.random здесь — инструмент анализа, не игровой генератор.
Продакшен-RNG живёт в `src/engine/rng.ts` (provably fair, HMAC-SHA256).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

import numpy as np

# Квантили стандартного нормального распределения для двусторонних
# интервалов. Зашиты константами, чтобы не тянуть scipy ради трёх чисел.
Z_SCORES: Dict[float, float] = {
    0.90: 1.6448536269514722,
    0.95: 1.959963984540054,
    0.99: 2.5758293035489004,
    0.999: 3.2905267314919255,
}

# Размер блока для бутстрапа. Любое n в таблицах — кратное этому числу.
BLOCK_SIZE = 1_000

# Горизонты, на которых показывается разброс RTP (T-020).
DEFAULT_HORIZONS: List[int] = [
    1_000, 2_000, 5_000,
    10_000, 20_000, 50_000,
    100_000, 200_000, 500_000,
    1_000_000, 5_000_000, 10_000_000,
]

# Целевые точности для «сколько спинов до сходимости», в процентных пунктах.
DEFAULT_TOLERANCES_PP: List[float] = [5.0, 2.0, 1.0, 0.5, 0.2, 0.1, 0.05]

# Вероятности разорения, для которых считается банкролл.
DEFAULT_RUIN_LEVELS: List[float] = [0.05, 0.01, 0.001, 0.0001]


# --------------------------------------------------------------------------
# Нормальная теория
# --------------------------------------------------------------------------

def z_score(confidence: float) -> float:
    """Квантиль нормального распределения для двустороннего интервала."""
    if confidence in Z_SCORES:
        return Z_SCORES[confidence]
    raise ValueError(
        f"Поддерживаются уровни доверия {sorted(Z_SCORES)}, получено {confidence}"
    )


def half_width_pp(sigma: float, spins: int, confidence: float = 0.95) -> float:
    """
    Полуширина доверительного интервала наблюдаемого RTP, в проц. пунктах.

    RTP оценивается средним выигрышем за раунд (в ставках), поэтому
    стандартная ошибка среднего sigma/sqrt(n) переводится в проценты
    умножением на 100.
    """
    if spins <= 0:
        raise ValueError("spins должно быть положительным")
    return 100.0 * z_score(confidence) * sigma / np.sqrt(spins)


def spins_for_tolerance(
    sigma: float, tolerance_pp: float, confidence: float = 0.95
) -> int:
    """
    Сколько раундов нужно, чтобы полуширина интервала уложилась в tolerance_pp.

    Обращение формулы выше: n = (100 * z * sigma / d)^2.
    Число раундов, а не спинов: фриспины входят в раунд и отдельно
    не считаются (иначе выборка перестаёт быть iid).
    """
    if tolerance_pp <= 0:
        raise ValueError("tolerance_pp должно быть положительным")
    n = (100.0 * z_score(confidence) * sigma / tolerance_pp) ** 2
    return int(np.ceil(n))


def volatility_index(sigma: float, confidence: float = 0.90) -> float:
    """
    Индекс волатильности в отраслевом смысле: z * sigma при доверии 90%.

    Это та же величина, что печатают в PAR sheet производители: она
    не несёт новой информации сверх sigma, но её значения привычны
    (ниже 5 — низкая волатильность, 5-10 средняя, 10-20 высокая).
    """
    return z_score(confidence) * sigma


# --------------------------------------------------------------------------
# Банкролл: диффузионное приближение
# --------------------------------------------------------------------------

def house_bankroll_diffusion(
    sigma: float, edge: float, ruin_probability: float
) -> float:
    """
    Банкролл оператора (в ставках) при заданной вероятности разорения.

    Классическое приближение задачи о разорении: если процесс с дрейфом
    `edge` за раунд и волатильностью `sigma` заменить броуновским
    движением, то вероятность когда-либо уйти ниже -B равна
    exp(-2 * edge * B / sigma^2). Отсюда

        B = sigma^2 * ln(1/eps) / (2 * edge)

    Горизонт бесконечный, то есть оценка консервативная: на конечной
    дистанции риск меньше.

    Приближение занижает риск для тяжелохвостых распределений — один
    выигрыш в 600 ставок броуновское движение «не видит». Поэтому
    результат обязательно сверяется с Monte Carlo (`simulate_house_ruin`).
    """
    if edge <= 0:
        raise ValueError(
            "edge должен быть положительным: при RTP >= 100% разорение неизбежно"
        )
    if not 0.0 < ruin_probability < 1.0:
        raise ValueError("ruin_probability должна лежать в (0, 1)")
    return (sigma ** 2) * np.log(1.0 / ruin_probability) / (2.0 * edge)


# --------------------------------------------------------------------------
# Бутстрап
# --------------------------------------------------------------------------

@dataclass
class HorizonSpread:
    """Разброс наблюдаемого RTP на конкретном горизонте."""

    spins: int
    normal_half_width_pp: float      # полуширина по формуле CLT
    empirical_p025: float            # эмпирические перцентили RTP, доли
    empirical_p50: float
    empirical_p975: float
    empirical_half_width_pp: float   # (p975 - p025) / 2, в проц. пунктах
    skew_ratio: float                # эмпирическая полуширина / нормальная
    tail_ratio: float                # (p975-p50) / (p50-p025): асимметрия хвостов
    outside_band: float              # доля реплик вне коридора приёмки

    def as_dict(self) -> dict:
        return {
            "spins": self.spins,
            "normalHalfWidthPp": self.normal_half_width_pp,
            "empiricalP025": self.empirical_p025,
            "empiricalP50": self.empirical_p50,
            "empiricalP975": self.empirical_p975,
            "empiricalHalfWidthPp": self.empirical_half_width_pp,
            "skewRatio": self.skew_ratio,
            "tailRatio": self.tail_ratio,
            "outsideBand": self.outside_band,
        }


class BootstrapEngine:
    """
    Блочный бутстрап по выборке выигрышей за раунд.

    `sample` — выигрыши за раунд в ставках (win / total_bet), уже
    с учётом фриспинов и потолка. Раунды предполагаются независимыми,
    что верно: сиды и позиции остановки от раунда к раунду не связаны.
    """

    def __init__(
        self,
        sample: np.ndarray,
        block_size: int = BLOCK_SIZE,
        blocks: int = 200_000,
        seed: int = 20260817,
    ):
        if sample.size < block_size:
            raise ValueError(
                f"выборка {sample.size} меньше размера блока {block_size}"
            )
        self.sample = np.asarray(sample, dtype=np.float64)
        self.block_size = block_size
        self.rng = np.random.default_rng(seed)
        self.mean = float(self.sample.mean())
        self.sigma = float(self.sample.std(ddof=1))
        self.block_sums = self._build_block_sums(blocks)

    def _build_block_sums(self, blocks: int) -> np.ndarray:
        """
        Пул сумм по `block_size` раундов, полученных пересэмплированием.

        Считается порциями: матрица blocks x block_size целиком заняла бы
        гигабайты. Порция в 5000 блоков — это 40 МБ, что безопасно.
        """
        out = np.empty(blocks, dtype=np.float64)
        chunk = 5_000
        done = 0
        n = self.sample.size
        while done < blocks:
            take = min(chunk, blocks - done)
            idx = self.rng.integers(0, n, size=(take, self.block_size))
            out[done:done + take] = self.sample[idx].sum(axis=1)
            done += take
        return out

    def spread(
        self,
        spins: int,
        replicates: int = 20_000,
        band: Optional[Sequence[float]] = None,
        confidence: float = 0.95,
    ) -> HorizonSpread:
        """
        Эмпирическое распределение наблюдаемого RTP на горизонте `spins`.

        `band` — коридор приёмки (например, 0.955..0.965); считается доля
        реплик, которые из него вышли. Это прямой ответ на вопрос
        «какая доля честных операторов провалит проверку на этом объёме».
        """
        if spins % self.block_size != 0:
            raise ValueError(
                f"горизонт {spins} должен быть кратен блоку {self.block_size}"
            )
        k = spins // self.block_size

        # Матрица replicates x k на больших горизонтах не помещается в память
        # (20 000 реплик по 10 000 блоков = 1.6 ГБ), поэтому реплики
        # считаются порциями с бюджетом ~50 млн элементов на порцию.
        means = np.empty(replicates, dtype=np.float64)
        per_chunk = max(1, 50_000_000 // max(k, 1))
        done = 0
        while done < replicates:
            take = min(per_chunk, replicates - done)
            idx = self.rng.integers(0, self.block_sums.size, size=(take, k))
            means[done:done + take] = self.block_sums[idx].sum(axis=1) / spins
            done += take

        p025, p50, p975 = np.percentile(means, [2.5, 50.0, 97.5])
        emp_half = 100.0 * (p975 - p025) / 2.0
        norm_half = half_width_pp(self.sigma, spins, confidence)

        if band is not None:
            lo, hi = band
            outside = float(np.mean((means < lo) | (means > hi)))
        else:
            outside = float("nan")

        # Асимметрия: во сколько раз верхний хвост длиннее нижнего.
        # Для нормального распределения ровно 1; у слота на коротких
        # горизонтах больше, потому что редкие крупные выплаты тянут
        # наблюдаемый RTP вверх, а вниз он ограничен нулём выплат.
        upper = float(p975 - p50)
        lower = float(p50 - p025)
        tail_ratio = upper / lower if lower > 0 else float("inf")

        return HorizonSpread(
            spins=spins,
            normal_half_width_pp=norm_half,
            empirical_p025=float(p025),
            empirical_p50=float(p50),
            empirical_p975=float(p975),
            empirical_half_width_pp=emp_half,
            skew_ratio=emp_half / norm_half if norm_half else float("nan"),
            tail_ratio=tail_ratio,
            outside_band=outside,
        )


# --------------------------------------------------------------------------
# Monte Carlo для банкролла
# --------------------------------------------------------------------------

@dataclass
class RuinResult:
    """Итог симуляции разорения на конечном горизонте."""

    bankroll: float          # стартовый запас, в ставках
    horizon: int             # длина пути, раундов
    paths: int
    ruin_probability: float
    median_final: float      # медианный итог пути, в ставках
    p05_final: float
    p95_final: float

    def as_dict(self) -> dict:
        return {
            "bankroll": self.bankroll,
            "horizon": self.horizon,
            "paths": self.paths,
            "ruinProbability": self.ruin_probability,
            "medianFinal": self.median_final,
            "p05Final": self.p05_final,
            "p95Final": self.p95_final,
        }


def simulate_house_ruin(
    sample: np.ndarray,
    bankroll: float,
    horizon: int,
    paths: int = 2_000,
    seed: int = 20260817,
    chunk: int = 0,
) -> RuinResult:
    """
    Разорение оператора: путь кассы против одного игрока со ставкой 1.

    За раунд касса получает +1 (ставка) и отдаёт win. Разорение — если
    накопленный итог хоть раз уходит ниже -bankroll. Отслеживается
    именно минимум пути, а не конечная точка: оператор, ушедший в минус
    в середине месяца, уже не может платить.

    Путь строится порциями по `chunk` раундов, чтобы не держать в памяти
    матрицу paths x horizon.
    """
    rng = np.random.default_rng(seed)
    n = sample.size
    # Бюджет ~20 млн элементов на порцию: матрица paths x chunk.
    if chunk <= 0:
        chunk = max(1, 20_000_000 // max(paths, 1))

    current = np.zeros(paths, dtype=np.float64)
    running_min = np.zeros(paths, dtype=np.float64)
    done = 0
    while done < horizon:
        take = min(chunk, horizon - done)
        idx = rng.integers(0, n, size=(paths, take))
        # Прибыль кассы за раунд: ставка минус выплата.
        pnl = 1.0 - sample[idx]
        cum = current[:, None] + np.cumsum(pnl, axis=1)
        running_min = np.minimum(running_min, cum.min(axis=1))
        current = cum[:, -1]
        done += take

    ruined = running_min <= -bankroll
    p05, p50, p95 = np.percentile(current, [5.0, 50.0, 95.0])
    return RuinResult(
        bankroll=float(bankroll),
        horizon=horizon,
        paths=paths,
        ruin_probability=float(ruined.mean()),
        median_final=float(p50),
        p05_final=float(p05),
        p95_final=float(p95),
    )


@dataclass
class SessionResult:
    """Итог игровой сессии с точки зрения игрока."""

    bankroll: float          # стартовый банкролл, в ставках
    horizon: int             # максимум раундов в сессии
    paths: int
    bust_probability: float          # доля сессий, где банкролл кончился
    median_spins_survived: float     # медиана раундов до конца сессии
    ahead_probability: float         # доля сессий, закончивших в плюсе
    median_final: float              # медианный итог, в ставках
    p95_final: float

    def as_dict(self) -> dict:
        return {
            "bankroll": self.bankroll,
            "horizon": self.horizon,
            "paths": self.paths,
            "bustProbability": self.bust_probability,
            "medianSpinsSurvived": self.median_spins_survived,
            "aheadProbability": self.ahead_probability,
            "medianFinal": self.median_final,
            "p95Final": self.p95_final,
        }


def simulate_player_session(
    sample: np.ndarray,
    bankroll: float,
    horizon: int,
    paths: int = 20_000,
    seed: int = 20260817,
) -> SessionResult:
    """
    Сессия игрока: сколько раундов живёт банкролл и с чем игрок уходит.

    Игрок ставит 1 за раунд, играет пока есть деньги, но не дольше
    `horizon` раундов. Это оценка для модуля ответственной игры (T-015):
    она показывает, какой депозит соответствует какому времени за игрой.

    Путь строится порциями путей: матрица paths x horizon целиком
    (20 000 x 10 000 = 1.6 ГБ) в память не помещается.
    """
    rng = np.random.default_rng(seed)

    any_bust = np.empty(paths, dtype=bool)
    first_bust = np.empty(paths, dtype=np.int64)
    final = np.empty(paths, dtype=np.float64)

    per_chunk = max(1, 20_000_000 // max(horizon, 1))
    done = 0
    while done < paths:
        take = min(per_chunk, paths - done)
        idx = rng.integers(0, sample.size, size=(take, horizon))
        pnl = sample[idx] - 1.0
        cum = bankroll + np.cumsum(pnl, axis=1)

        # Первый момент, когда денег не хватает на следующую ставку.
        busted = cum < 1.0
        chunk_bust = busted.any(axis=1)
        chunk_first = np.where(chunk_bust, busted.argmax(axis=1) + 1, horizon)

        # Итог сессии: баланс на момент выхода.
        chunk_final = np.where(
            chunk_bust,
            cum[np.arange(take), chunk_first - 1],
            cum[:, -1],
        )

        any_bust[done:done + take] = chunk_bust
        first_bust[done:done + take] = chunk_first
        final[done:done + take] = chunk_final
        done += take

    return SessionResult(
        bankroll=float(bankroll),
        horizon=horizon,
        paths=paths,
        bust_probability=float(any_bust.mean()),
        median_spins_survived=float(np.median(first_bust)),
        ahead_probability=float((final > bankroll).mean()),
        median_final=float(np.median(final)),
        p95_final=float(np.percentile(final, 95.0)),
    )


# --------------------------------------------------------------------------
# Сводный расчёт
# --------------------------------------------------------------------------

@dataclass
class ConfidenceReport:
    """Полный отчёт по сходимости и банкроллу."""

    sample_rounds: int
    mean_rtp: float
    sigma: float
    volatility_index: float
    edge: float

    convergence: List[dict] = field(default_factory=list)
    spread: List[HorizonSpread] = field(default_factory=list)
    house_bankroll: List[dict] = field(default_factory=list)
    house_ruin_mc: List[RuinResult] = field(default_factory=list)
    player_sessions: List[SessionResult] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "sampleRounds": self.sample_rounds,
            "meanRtp": self.mean_rtp,
            "sigma": self.sigma,
            "volatilityIndex": self.volatility_index,
            "edge": self.edge,
            "convergence": self.convergence,
            "spread": [s.as_dict() for s in self.spread],
            "houseBankroll": self.house_bankroll,
            "houseRuinMc": [r.as_dict() for r in self.house_ruin_mc],
            "playerSessions": [s.as_dict() for s in self.player_sessions],
        }


def build_report(
    sample: np.ndarray,
    horizons: Optional[Sequence[int]] = None,
    tolerances_pp: Optional[Sequence[float]] = None,
    ruin_levels: Optional[Sequence[float]] = None,
    band: Sequence[float] = (0.955, 0.965),
    replicates: int = 20_000,
    blocks: int = 200_000,
    seed: int = 20260817,
    quick: bool = False,
) -> ConfidenceReport:
    """
    Считает всё сразу: сходимость, разброс, банкролл оператора и игрока.

    `sample` — выигрыши за раунд в ставках. `quick` уменьшает объёмы
    Monte Carlo для быстрого прогона в CI.
    """
    horizons = list(horizons if horizons is not None else DEFAULT_HORIZONS)
    tolerances_pp = list(
        tolerances_pp if tolerances_pp is not None else DEFAULT_TOLERANCES_PP
    )
    ruin_levels = list(
        ruin_levels if ruin_levels is not None else DEFAULT_RUIN_LEVELS
    )

    engine = BootstrapEngine(
        sample, blocks=blocks if not quick else 20_000, seed=seed
    )
    sigma = engine.sigma
    mean = engine.mean
    edge = 1.0 - mean

    convergence = [
        {
            "tolerancePp": tol,
            "spins90": spins_for_tolerance(sigma, tol, 0.90),
            "spins95": spins_for_tolerance(sigma, tol, 0.95),
            "spins99": spins_for_tolerance(sigma, tol, 0.99),
        }
        for tol in tolerances_pp
    ]

    spread = [
        engine.spread(
            n,
            replicates=replicates if not quick else 2_000,
            band=band,
        )
        for n in horizons
    ]

    # float() обязателен: numpy-скаляры не сериализуются json.dump.
    house_bankroll = [
        {
            "ruinProbability": float(eps),
            "bankrollBets": float(house_bankroll_diffusion(sigma, edge, eps)),
        }
        for eps in ruin_levels
    ]

    # Сверка диффузионной формулы с Monte Carlo на конечном горизонте.
    horizon_mc = 100_000 if not quick else 10_000
    paths_mc = 2_000 if not quick else 200
    house_ruin_mc = [
        simulate_house_ruin(
            sample,
            bankroll=row["bankrollBets"],
            horizon=horizon_mc,
            paths=paths_mc,
            seed=seed + i,
        )
        for i, row in enumerate(house_bankroll)
    ]

    session_paths = 20_000 if not quick else 2_000
    player_sessions = [
        simulate_player_session(
            sample, bankroll=b, horizon=h, paths=session_paths, seed=seed + 100 + i
        )
        for i, (b, h) in enumerate(
            [(50, 500), (100, 1_000), (250, 2_000), (500, 5_000), (1_000, 10_000)]
        )
    ]

    return ConfidenceReport(
        sample_rounds=int(sample.size),
        mean_rtp=mean,
        sigma=sigma,
        volatility_index=volatility_index(sigma),
        edge=edge,
        convergence=convergence,
        spread=spread,
        house_bankroll=house_bankroll,
        house_ruin_mc=house_ruin_mc,
        player_sessions=player_sessions,
    )
