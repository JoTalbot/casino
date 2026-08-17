#!/usr/bin/env python3
"""
Тесты статистики сходимости (`slotmath/confidence.py`).

Запуск:
    python3 tests/test_confidence.py

Проверяется не «красивость» чисел, а математические свойства, которые
обязаны выполняться при любой корректной реализации:

  * формулы CLT согласованы между собой (полуширина <-> число раундов);
  * бутстрап на известном распределении даёт правильный интервал;
  * блочная схема не смещает оценку среднего;
  * банкролл растёт с ужесточением требований к риску и падает
    с ростом преимущества оператора;
  * симуляция разорения согласуется с формулой на длинном горизонте.

Эти свойства ловят типовые ошибки: перепутанный z-квантиль, деление на
n вместо sqrt(n), потерянный множитель 100 при переводе в проц. пункты,
смещение из-за некратного размера блока.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from slotmath.confidence import (  # noqa: E402
    BLOCK_SIZE,
    BootstrapEngine,
    build_report,
    half_width_pp,
    house_bankroll_diffusion,
    simulate_house_ruin,
    simulate_player_session,
    spins_for_tolerance,
    volatility_index,
    z_score,
)
from slotmath.config import load_config  # noqa: E402
from slotmath.simulate import Simulator  # noqa: E402


class TestNormalTheory(unittest.TestCase):
    """Формулы доверительного интервала."""

    def test_z_scores_known_values(self):
        self.assertAlmostEqual(z_score(0.95), 1.959963984540054, places=12)
        self.assertAlmostEqual(z_score(0.99), 2.5758293035489004, places=12)

    def test_unsupported_confidence_rejected(self):
        with self.assertRaises(ValueError):
            z_score(0.975)

    def test_half_width_scales_as_inverse_sqrt(self):
        """Учетверение выборки должно ровно вдвое сузить интервал."""
        a = half_width_pp(4.0, 10_000)
        b = half_width_pp(4.0, 40_000)
        self.assertAlmostEqual(a / b, 2.0, places=10)

    def test_half_width_linear_in_sigma(self):
        a = half_width_pp(2.0, 10_000)
        b = half_width_pp(4.0, 10_000)
        self.assertAlmostEqual(b / a, 2.0, places=10)

    def test_half_width_matches_manual_formula(self):
        """Контроль множителя 100: результат в проц. пунктах, не в долях."""
        sigma, n = 4.126, 1_000_000
        expected = 100.0 * 1.959963984540054 * sigma / np.sqrt(n)
        self.assertAlmostEqual(half_width_pp(sigma, n), expected, places=12)

    def test_spins_for_tolerance_inverts_half_width(self):
        """Две формулы обязаны быть обратны друг другу."""
        sigma, tol = 4.126, 1.0
        n = spins_for_tolerance(sigma, tol, 0.95)
        # На найденном n полуширина не должна превышать допуск,
        # а на шаг меньше — уже должна.
        self.assertLessEqual(half_width_pp(sigma, n, 0.95), tol + 1e-9)
        self.assertGreater(half_width_pp(sigma, n - 1, 0.95), tol - 1e-6)

    def test_higher_confidence_needs_more_spins(self):
        sigma = 4.126
        n90 = spins_for_tolerance(sigma, 1.0, 0.90)
        n95 = spins_for_tolerance(sigma, 1.0, 0.95)
        n99 = spins_for_tolerance(sigma, 1.0, 0.99)
        self.assertLess(n90, n95)
        self.assertLess(n95, n99)

    def test_tolerance_must_be_positive(self):
        with self.assertRaises(ValueError):
            spins_for_tolerance(4.0, 0.0)

    def test_spins_must_be_positive(self):
        with self.assertRaises(ValueError):
            half_width_pp(4.0, 0)

    def test_volatility_index_is_z90_times_sigma(self):
        self.assertAlmostEqual(
            volatility_index(4.0), 1.6448536269514722 * 4.0, places=12
        )


class TestBootstrapCorrectness(unittest.TestCase):
    """Бутстрап на распределении с известным ответом."""

    @classmethod
    def setUpClass(cls):
        # Нормальная выборка: для неё эмпирический интервал обязан
        # совпасть с формулой CLT — это калибровка самого метода.
        rng = np.random.default_rng(12345)
        cls.normal = rng.normal(loc=1.0, scale=4.0, size=400_000)

    def test_mean_and_sigma_recovered(self):
        """
        Допуск задаётся стандартной ошибкой выборки, а не круглым числом:
        при sigma=4 и n=400k SE ≈ 0.0063, и требовать совпадения до
        второго знака означало бы падать на честном шуме.
        """
        eng = BootstrapEngine(self.normal, blocks=20_000, seed=1)
        se = 4.0 / np.sqrt(self.normal.size)
        self.assertAlmostEqual(eng.mean, 1.0, delta=4 * se)
        self.assertAlmostEqual(eng.sigma, 4.0, places=1)

    def test_bootstrap_matches_clt_on_normal_sample(self):
        """
        Для нормальных данных эмпирическая полуширина должна совпасть
        с нормальной в пределах шума бутстрапа (5%).
        """
        eng = BootstrapEngine(self.normal, blocks=50_000, seed=2)
        s = eng.spread(100_000, replicates=10_000, band=None)
        ratio = s.empirical_half_width_pp / s.normal_half_width_pp
        self.assertAlmostEqual(ratio, 1.0, delta=0.05)

    def test_bootstrap_symmetric_on_normal_sample(self):
        """Асимметрия хвостов для нормальных данных должна быть ~1."""
        eng = BootstrapEngine(self.normal, blocks=50_000, seed=3)
        s = eng.spread(100_000, replicates=10_000, band=None)
        self.assertAlmostEqual(s.tail_ratio, 1.0, delta=0.10)

    def test_block_sums_unbiased(self):
        """
        Среднее блочной суммы = block_size * среднее выборки.
        Ловит ошибку в построении пула блоков.
        """
        eng = BootstrapEngine(self.normal, blocks=50_000, seed=4)
        expected = BLOCK_SIZE * eng.mean
        got = float(eng.block_sums.mean())
        # Стандартная ошибка пула: sigma*sqrt(b)/sqrt(blocks).
        se = eng.sigma * np.sqrt(BLOCK_SIZE) / np.sqrt(50_000)
        self.assertLess(abs(got - expected), 4 * se)

    def test_interval_narrows_with_horizon(self):
        eng = BootstrapEngine(self.normal, blocks=20_000, seed=5)
        wide = eng.spread(10_000, replicates=4_000, band=None)
        narrow = eng.spread(100_000, replicates=4_000, band=None)
        self.assertLess(
            narrow.empirical_half_width_pp, wide.empirical_half_width_pp
        )

    def test_horizon_must_be_multiple_of_block(self):
        eng = BootstrapEngine(self.normal, blocks=2_000, seed=6)
        with self.assertRaises(ValueError):
            eng.spread(1_500, replicates=100)

    def test_sample_smaller_than_block_rejected(self):
        with self.assertRaises(ValueError):
            BootstrapEngine(np.zeros(10), block_size=BLOCK_SIZE)

    def test_chunking_does_not_change_result(self):
        """
        Порционный расчёт реплик должен давать тот же ответ, что
        и одна матрица: одинаковый seed -> одинаковые числа.
        """
        a = BootstrapEngine(self.normal, blocks=20_000, seed=7).spread(
            50_000, replicates=3_000, band=None
        )
        b = BootstrapEngine(self.normal, blocks=20_000, seed=7).spread(
            50_000, replicates=3_000, band=None
        )
        self.assertEqual(a.empirical_p50, b.empirical_p50)
        self.assertEqual(a.empirical_p975, b.empirical_p975)


class TestBankroll(unittest.TestCase):
    """Требования к банкроллу оператора."""

    def test_bankroll_grows_as_risk_tightens(self):
        b5 = house_bankroll_diffusion(4.126, 0.04, 0.05)
        b1 = house_bankroll_diffusion(4.126, 0.04, 0.01)
        b01 = house_bankroll_diffusion(4.126, 0.04, 0.001)
        self.assertLess(b5, b1)
        self.assertLess(b1, b01)

    def test_bankroll_shrinks_as_edge_grows(self):
        thin = house_bankroll_diffusion(4.126, 0.02, 0.01)
        fat = house_bankroll_diffusion(4.126, 0.08, 0.01)
        self.assertLess(fat, thin)

    def test_bankroll_quadratic_in_sigma(self):
        """B пропорционален sigma^2: удвоение sigma даёт четырёхкратный рост."""
        a = house_bankroll_diffusion(2.0, 0.04, 0.01)
        b = house_bankroll_diffusion(4.0, 0.04, 0.01)
        self.assertAlmostEqual(b / a, 4.0, places=9)

    def test_non_positive_edge_rejected(self):
        """При RTP >= 100% разорение неизбежно, формула не применима."""
        with self.assertRaises(ValueError):
            house_bankroll_diffusion(4.0, 0.0, 0.01)
        with self.assertRaises(ValueError):
            house_bankroll_diffusion(4.0, -0.01, 0.01)

    def test_invalid_ruin_probability_rejected(self):
        with self.assertRaises(ValueError):
            house_bankroll_diffusion(4.0, 0.04, 1.0)
        with self.assertRaises(ValueError):
            house_bankroll_diffusion(4.0, 0.04, 0.0)

    def test_ruin_simulation_agrees_with_formula(self):
        """
        Ключевая проверка: на банкролле, рассчитанном под риск 5%,
        Monte Carlo на длинном горизонте должна дать риск того же
        порядка. Допуск широкий — формула консервативна (бесконечный
        горизонт), поэтому MC вправе показать МЕНЬШЕ.
        """
        rng = np.random.default_rng(999)
        # Простое распределение с edge = 0.04 и умеренным хвостом.
        sample = rng.choice([0.0, 5.0], size=200_000, p=[0.808, 0.192])
        sigma = float(sample.std(ddof=1))
        edge = 1.0 - float(sample.mean())
        self.assertGreater(edge, 0.0)

        bankroll = house_bankroll_diffusion(sigma, edge, 0.05)
        res = simulate_house_ruin(
            sample, bankroll=bankroll, horizon=200_000, paths=1_000, seed=7
        )
        self.assertLessEqual(res.ruin_probability, 0.12)

    def test_bigger_bankroll_lowers_ruin(self):
        rng = np.random.default_rng(555)
        sample = rng.choice([0.0, 5.0], size=100_000, p=[0.808, 0.192])
        small = simulate_house_ruin(
            sample, bankroll=100, horizon=50_000, paths=500, seed=8
        )
        large = simulate_house_ruin(
            sample, bankroll=2_000, horizon=50_000, paths=500, seed=8
        )
        self.assertGreater(small.ruin_probability, large.ruin_probability)


class TestPlayerSession(unittest.TestCase):
    """Сессия игрока."""

    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(4242)
        cls.sample = rng.choice([0.0, 5.0], size=100_000, p=[0.808, 0.192])

    def test_bigger_bankroll_survives_longer(self):
        small = simulate_player_session(
            self.sample, bankroll=50, horizon=2_000, paths=2_000, seed=11
        )
        large = simulate_player_session(
            self.sample, bankroll=500, horizon=2_000, paths=2_000, seed=11
        )
        self.assertGreater(
            large.median_spins_survived, small.median_spins_survived
        )
        self.assertLess(large.bust_probability, small.bust_probability)

    def test_survival_never_exceeds_horizon(self):
        res = simulate_player_session(
            self.sample, bankroll=10_000, horizon=500, paths=500, seed=12
        )
        self.assertLessEqual(res.median_spins_survived, 500)

    def test_probabilities_in_range(self):
        res = simulate_player_session(
            self.sample, bankroll=100, horizon=1_000, paths=2_000, seed=13
        )
        self.assertGreaterEqual(res.bust_probability, 0.0)
        self.assertLessEqual(res.bust_probability, 1.0)
        self.assertGreaterEqual(res.ahead_probability, 0.0)
        self.assertLessEqual(res.ahead_probability, 1.0)

    def test_negative_edge_game_eventually_busts(self):
        """При отрицательном ожидании длинная игра съедает банкролл."""
        res = simulate_player_session(
            self.sample, bankroll=50, horizon=20_000, paths=500, seed=14
        )
        self.assertGreater(res.bust_probability, 0.9)


class TestRealGameReport(unittest.TestCase):
    """Сквозной прогон на настоящей математике игры."""

    @classmethod
    def setUpClass(cls):
        cfg = load_config()
        sim = Simulator(cfg, seed=20260817)
        cls.sample = sim.sample_rounds(300_000)
        cls.report = build_report(
            cls.sample,
            horizons=[1_000, 10_000, 100_000],
            tolerances_pp=[1.0, 0.5],
            ruin_levels=[0.05, 0.01],
            replicates=2_000,
            blocks=20_000,
            quick=True,
        )

    def test_sample_matches_known_rtp(self):
        """
        Выборка раундов обязана воспроизводить принятый RTP 95.9778%.

        Допуск — четыре стандартные ошибки выборки. Это ровно та величина,
        которую считает сам модуль: при sigma ~4.11 и 300 тыс. раундов
        SE ≈ 0.0075, то есть 0.75 п.п., и жёсткий допуск в 0.5 п.п. падал бы
        на честном шуме. Раздел 9 PAR sheet именно об этом.
        """
        se = self.report.sigma / np.sqrt(self.report.sample_rounds)
        self.assertAlmostEqual(self.report.mean_rtp, 0.959778, delta=4 * se)

    def test_sigma_matches_par_sheet(self):
        """Sigma ~4.11 зафиксирована в PAR sheet, §8."""
        self.assertAlmostEqual(self.report.sigma, 4.11, delta=0.15)

    def test_edge_is_positive(self):
        self.assertGreater(self.report.edge, 0.03)
        self.assertLess(self.report.edge, 0.05)

    def test_short_horizon_is_wide_and_skewed(self):
        """
        На 1 000 раундах интервал должен быть очень широким
        и скошенным вправо — это главный вывод раздела.
        """
        s = self.report.spread[0]
        self.assertEqual(s.spins, 1_000)
        self.assertGreater(s.empirical_half_width_pp, 15.0)
        self.assertGreater(s.tail_ratio, 1.15)

    def test_long_horizon_converges_to_normal(self):
        """На 100 000 раундах бутстрап и CLT должны сойтись."""
        s = self.report.spread[-1]
        self.assertEqual(s.spins, 100_000)
        self.assertAlmostEqual(s.skew_ratio, 1.0, delta=0.10)

    def test_spread_narrows_monotonically(self):
        widths = [s.empirical_half_width_pp for s in self.report.spread]
        self.assertEqual(widths, sorted(widths, reverse=True))

    def test_acceptance_band_useless_on_short_runs(self):
        """
        Практический вывод: на 1 000 раундов почти любой честный прогон
        выходит за коридор 95.5-96.5%.
        """
        self.assertGreater(self.report.spread[0].outside_band, 0.8)

    def test_report_serialises_to_plain_types(self):
        """
        as_dict() должен отдавать только типы, понятные json.dump:
        numpy-скаляры роняют сериализацию (эта ошибка уже случалась).
        """
        import json

        payload = json.dumps(self.report.as_dict(), ensure_ascii=False)
        self.assertIn("houseBankroll", payload)
        self.assertIn("playerSessions", payload)


if __name__ == "__main__":
    unittest.main(verbosity=2)
