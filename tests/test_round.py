#!/usr/bin/env python3
"""
Тесты эталонного проигрывания раунда (`slotmath/round.py`).

Запуск:
    python3 tests/test_round.py
    python3 -m unittest discover -s tests -v

Зачем отдельный набор от симулятора: `simulate.py` векторизован и проверяет
статистику на миллионах спинов, а здесь проверяется ПОШАГОВАЯ корректность
одного раунда — то, что игрок увидит в интерфейсе и сможет пересчитать сам.
Расхождение между этими двумя реализациями означало бы, что показанная
игроку сетка не соответствует посчитанному RTP.
"""

from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from slotmath.config import GameConfig, load_config  # noqa: E402
from slotmath.paylines import NUM_REELS, NUM_ROWS, PAYLINES  # noqa: E402
from slotmath.round import (  # noqa: E402
    RoundRandom,
    count_scatters,
    evaluate_lines,
    hash_server_seed,
    hmac_block,
    play_round,
    window_from_stops,
)

SERVER_SEED = "a" * 64
CLIENT_SEED = "player-fixture-seed"
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "rounds.json"


class TestHmacStream(unittest.TestCase):
    """Поток чисел должен совпадать с `src/engine/rng.ts` бит в бит."""

    def test_block_is_32_bytes(self):
        block = hmac_block(SERVER_SEED, CLIENT_SEED, 0, 0)
        self.assertEqual(len(block), 32)

    def test_known_commitment(self):
        # Значение зафиксировано: SHA-256 от строки из 64 символов "a".
        self.assertEqual(
            hash_server_seed(SERVER_SEED),
            "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
        )

    def test_floats_in_unit_interval(self):
        rng = RoundRandom(SERVER_SEED, CLIENT_SEED, 0)
        for _ in range(500):
            value = rng.next_float()
            self.assertGreaterEqual(value, 0.0)
            self.assertLess(value, 1.0)

    def test_block_boundary_is_crossed_correctly(self):
        """Девятое число обязано прийти из следующего блока HMAC."""
        rng = RoundRandom(SERVER_SEED, CLIENT_SEED, 0)
        first_eight = [rng.next_float() for _ in range(8)]
        ninth = rng.next_float()

        block1 = hmac_block(SERVER_SEED, CLIENT_SEED, 0, 1)
        expected = (
            block1[0] / 256
            + block1[1] / 256 ** 2
            + block1[2] / 256 ** 3
            + block1[3] / 256 ** 4
        )
        self.assertEqual(ninth, expected)
        self.assertEqual(len(set(first_eight)), 8)

    def test_draw_count_is_tracked(self):
        rng = RoundRandom(SERVER_SEED, CLIENT_SEED, 0)
        for _ in range(13):
            rng.next_float()
        self.assertEqual(rng.draw_count, 13)

    def test_different_nonce_gives_different_stream(self):
        a = RoundRandom(SERVER_SEED, CLIENT_SEED, 0).next_float()
        b = RoundRandom(SERVER_SEED, CLIENT_SEED, 1).next_float()
        self.assertNotEqual(a, b)

    def test_colon_in_client_seed_is_rejected(self):
        """Двоеточие — разделитель в сообщении HMAC, иначе возможна коллизия."""
        with self.assertRaises(ValueError):
            RoundRandom(SERVER_SEED, "bad:seed", 0)

    def test_next_int_respects_bound(self):
        rng = RoundRandom(SERVER_SEED, CLIENT_SEED, 0)
        for _ in range(2000):
            value = rng.next_int(42)
            self.assertGreaterEqual(value, 0)
            self.assertLess(value, 42)

    def test_next_int_rejects_bad_bound(self):
        rng = RoundRandom(SERVER_SEED, CLIENT_SEED, 0)
        with self.assertRaises(ValueError):
            rng.next_int(0)


class TestWindow(unittest.TestCase):
    def setUp(self):
        self.cfg = load_config()

    def test_window_shape(self):
        stops = [0] * NUM_REELS
        window = window_from_stops(self.cfg.base_reels, stops)
        self.assertEqual(len(window), NUM_REELS)
        for reel in window:
            self.assertEqual(len(reel), NUM_ROWS)

    def test_window_wraps_around_strip(self):
        """Лента кольцевая: стоп у последней позиции продолжается с начала."""
        strip = self.cfg.base_reels[0]
        stop = len(strip) - 1
        window = window_from_stops(self.cfg.base_reels, [stop, 0, 0, 0, 0])
        self.assertEqual(window[0][0], strip[-1])
        self.assertEqual(window[0][1], strip[0])
        self.assertEqual(window[0][2], strip[1])


class TestLineEvaluation(unittest.TestCase):
    def setUp(self):
        self.cfg = load_config()

    @staticmethod
    def _grid(rows):
        """Полная сетка: принимает 3 ряда по 5 символов,
        возвращает окно в формате window[reel][row]."""
        return [[rows[row][reel] for row in range(NUM_ROWS)] for reel in range(NUM_REELS)]

    # Не staticmethod: имя символа-заполнителя берётся из конфигурации,
    # чтобы переименование scatter не ломало тесты (T-211).
    def _single_line(self, symbols):
        """
        Сетка, в которой платить может ТОЛЬКО центральная линия (линия 1).

        Верхний и нижний ряды забиты сундуками. Это единственный символ,
        отсутствующий в paytable, поэтому он не образует выигрышных серий
        и, попадая в любую другую линию, обрывает её на первом же барабане.
        Без такой изоляции проверка одной линии превращается в проверку
        всех двадцати — на чём эти тесты и упали в первой редакции.
        """
        rows = [[self.cfg.scatter] * NUM_REELS, list(symbols), [self.cfg.scatter] * NUM_REELS]
        return [[rows[row][reel] for row in range(NUM_ROWS)] for reel in range(NUM_REELS)]

    def test_isolation_helper_really_isolates(self):
        """Страховка на сам приём: заполнитель не должен ничего платить."""
        grid = self._single_line(["TEN", "J", "Q", "K", "A"])
        total, details = evaluate_lines(self.cfg, grid)
        self.assertEqual(total, 0)
        self.assertEqual(details, [])

    def test_no_win_on_mixed_line(self):
        total, details = evaluate_lines(
            self.cfg, self._single_line(["TEN", "J", "Q", "K", "A"])
        )
        self.assertEqual(total, 0)
        self.assertEqual(details, [])

    def test_five_of_a_kind_on_centre_line(self):
        """Пять CROWN на линии 1 оплачиваются по таблице выплат.

        Сумма читается из конфигурации, а не зашивается: она меняется при
        каждой перекалибровке математики, и зашитое число превращает
        осмысленный тест в ложную тревогу (T-211).
        """
        total, details = evaluate_lines(self.cfg, self._single_line(["CROWN"] * 5))
        self.assertEqual(total, self.cfg.paytable["CROWN"][5])
        self.assertEqual(len(details), 1)
        self.assertEqual(details[0]["line"], 1)
        self.assertEqual(details[0]["symbol"], "CROWN")
        self.assertEqual(details[0]["count"], 5)

    def test_win_must_start_from_first_reel(self):
        """Четыре CROWN, начиная со второго барабана, не платят ничего."""
        total, _ = evaluate_lines(
            self.cfg, self._single_line(["TEN", "CROWN", "CROWN", "CROWN", "CROWN"])
        )
        self.assertEqual(total, 0)

    def test_wild_substitutes(self):
        total, details = evaluate_lines(
            self.cfg, self._single_line(["CROWN", "WILD", "CROWN", "TEN", "J"])
        )
        self.assertEqual(total, self.cfg.paytable["CROWN"][3])
        self.assertEqual(details[0]["count"], 3)

    def test_line_of_wilds_pays_as_best_symbol(self):
        """Пять wild оплачиваются как самый дорогой символ — это следует
        из правила максимума и не требует отдельной ветки в коде."""
        total, _ = evaluate_lines(self.cfg, self._single_line(["WILD"] * 5))
        best = max(t.get(5, 0) for t in self.cfg.paytable.values())
        self.assertEqual(total, best)
        self.assertEqual(total, self.cfg.paytable["CROWN"][5])

    def test_highest_paying_symbol_wins_on_line(self):
        """Известная ловушка: если брать первый подходящий символ, а не
        максимум по всем, RTP уезжает на десятки процентных пунктов."""
        total, details = evaluate_lines(
            self.cfg, self._single_line(["WILD", "WILD", "WILD", "TEN", "TEN"])
        )
        # Варианты: три короны через wild или пять десяток. Берётся дороже.
        self.assertGreater(self.cfg.paytable["CROWN"][3], self.cfg.paytable["TEN"][5])
        self.assertEqual(total, self.cfg.paytable["CROWN"][3])
        self.assertEqual(details[0]["symbol"], "CROWN")

    def test_win_details_positions_cover_the_run(self):
        _, details = evaluate_lines(
            self.cfg, self._single_line(["CROWN", "CROWN", "CROWN", "TEN", "J"])
        )
        self.assertEqual(details[0]["positions"], [[0, 1], [1, 1], [2, 1]])

    def test_scatter_does_not_pay_on_lines(self):
        grid = [[self.cfg.scatter] * NUM_ROWS for _ in range(NUM_REELS)]
        total, _ = evaluate_lines(self.cfg, grid)
        self.assertEqual(total, 0)

    def test_scatter_count_ignores_position(self):
        grid = self._grid(
            [
                [self.cfg.scatter, "J", "Q", "K", self.cfg.scatter],
                ["TEN", self.cfg.scatter, "K", "A", "TEN"],
                ["Q", "K", "A", "TEN", "J"],
            ]
        )
        self.assertEqual(count_scatters(self.cfg, grid), 3)

    def test_all_paylines_are_evaluated(self):
        """Однородная сетка из CROWN обязана оплатить все 20 линий."""
        grid = [["CROWN"] * NUM_ROWS for _ in range(NUM_REELS)]
        total, details = evaluate_lines(self.cfg, grid)
        self.assertEqual(len(details), len(PAYLINES))
        self.assertEqual(total, self.cfg.paytable["CROWN"][5] * len(PAYLINES))


class TestPlayRound(unittest.TestCase):
    def setUp(self):
        self.cfg = load_config()

    def test_round_is_deterministic(self):
        a = play_round(self.cfg, SERVER_SEED, CLIENT_SEED, 42)
        b = play_round(self.cfg, SERVER_SEED, CLIENT_SEED, 42)
        self.assertEqual(a.as_dict(), b.as_dict())

    def test_draw_count_matches_number_of_spins(self):
        """Ровно 5 обращений к RNG на каждый спин, включая фриспины."""
        for nonce in range(300):
            record = play_round(self.cfg, SERVER_SEED, CLIENT_SEED, nonce)
            self.assertEqual(record.draw_count, 5 * len(record.spins))

    def test_free_spins_count_matches_award(self):
        """Число фриспинов = награда за триггер + награды за все ретриггеры."""
        found = False
        for nonce in range(3000):
            record = play_round(self.cfg, SERVER_SEED, CLIENT_SEED, nonce)
            base = record.spins[0]
            if base.triggered_free_spins == 0:
                continue
            found = True
            expected = base.triggered_free_spins + sum(
                s.triggered_free_spins for s in record.spins if s.free
            )
            actual = sum(1 for s in record.spins if s.free)
            self.assertEqual(actual, expected, f"nonce={nonce}")
        self.assertTrue(found, "в диапазоне не нашлось ни одного триггера")

    def test_free_spin_multiplier_applies_to_lines_not_scatter(self):
        """Множитель фриспинов умножает выплаты по линиям, но не прямую
        выплату за scatter — иначе RTP разойдётся с аналитикой."""
        for nonce in range(2000):
            record = play_round(self.cfg, SERVER_SEED, CLIENT_SEED, nonce)
            for spin in record.spins:
                if not spin.free:
                    continue
                line_pay = sum(
                    d["pay"] for d in spin.win_details if not d.get("scatter")
                )
                scatter_pay = self.cfg.scatter_pays.get(spin.scatter_count, 0) * (
                    record.total_bet
                )
                expected = line_pay * self.cfg.free_spin_multiplier + scatter_pay
                self.assertEqual(spin.win, expected, f"nonce={nonce}")

    def test_total_win_is_sum_of_spins(self):
        for nonce in range(500):
            record = play_round(self.cfg, SERVER_SEED, CLIENT_SEED, nonce)
            if record.capped:
                continue
            self.assertEqual(record.total_win, sum(s.win for s in record.spins))

    def test_bet_per_line_scales_linearly(self):
        """Выплата обязана быть строго пропорциональна ставке: любое
        отклонение — это скрытая зависимость RTP от размера ставки."""
        for nonce in range(200):
            one = play_round(self.cfg, SERVER_SEED, CLIENT_SEED, nonce, bet_per_line=1)
            ten = play_round(self.cfg, SERVER_SEED, CLIENT_SEED, nonce, bet_per_line=10)
            self.assertEqual(ten.total_bet, one.total_bet * 10)
            self.assertEqual(ten.total_win, one.total_win * 10)
            self.assertEqual(
                [s.reel_stops for s in ten.spins], [s.reel_stops for s in one.spins]
            )

    def test_stops_are_within_strip_length(self):
        for nonce in range(200):
            record = play_round(self.cfg, SERVER_SEED, CLIENT_SEED, nonce)
            for spin in record.spins:
                reels = self.cfg.free_reels if spin.free else self.cfg.base_reels
                for reel_index, stop in enumerate(spin.reel_stops):
                    self.assertGreaterEqual(stop, 0)
                    self.assertLess(stop, len(reels[reel_index]))

    def test_max_win_cap_is_applied(self):
        """Потолок проверяется на синтетическом конфиге: в боевой математике
        5000x за разумное число раундов не встречается."""
        data = self.cfg.to_dict()
        data["maxWinCap"] = 1  # 1x общей ставки — сработает почти всегда
        cheap = GameConfig.from_dict(data)

        capped_seen = False
        for nonce in range(200):
            record = play_round(cheap, SERVER_SEED, CLIENT_SEED, nonce)
            self.assertLessEqual(record.total_win, record.total_bet * 1)
            if record.capped:
                capped_seen = True
                self.assertEqual(record.total_win, record.total_bet)
        self.assertTrue(capped_seen, "потолок ни разу не сработал")

    def test_retrigger_disabled_gives_fixed_length_series(self):
        data = self.cfg.to_dict()
        data["retriggerEnabled"] = False
        no_retrig = GameConfig.from_dict(data)

        for nonce in range(3000):
            record = play_round(no_retrig, SERVER_SEED, CLIENT_SEED, nonce)
            base = record.spins[0]
            if base.triggered_free_spins == 0:
                continue
            free_count = sum(1 for s in record.spins if s.free)
            self.assertEqual(free_count, base.triggered_free_spins)

    def test_commitment_is_recorded(self):
        record = play_round(self.cfg, SERVER_SEED, CLIENT_SEED, 0)
        self.assertEqual(record.server_seed_hash, hash_server_seed(SERVER_SEED))


class TestFixtures(unittest.TestCase):
    """Фикстуры — контракт между Python, TypeScript и офлайн-верификатором."""

    @classmethod
    def setUpClass(cls):
        if not FIXTURES.exists():
            raise unittest.SkipTest(
                "нет tests/fixtures/rounds.json — запустите scripts/gen_fixtures.py"
            )
        cls.data = json.loads(FIXTURES.read_text(encoding="utf-8"))
        cls.cfg = load_config()

    def test_config_hash_matches(self):
        """Если хэш разошёлся — математика изменилась, фикстуры устарели."""
        self.assertEqual(
            self.data["configHash"],
            self.cfg.config_hash(),
            "конфигурация изменилась — перегенерируйте фикстуры",
        )

    def test_every_case_reproduces(self):
        for case in self.data["cases"]:
            with self.subTest(nonce=case["nonce"], kind=case["kind"]):
                record = play_round(
                    self.cfg,
                    self.data["serverSeed"],
                    self.data["clientSeed"],
                    case["nonce"],
                    self.data["betPerLine"],
                )
                actual = record.as_dict()
                expected = {k: v for k, v in case.items() if k != "kind"}
                self.assertEqual(actual, expected)

    def test_fixtures_cover_all_branches(self):
        kinds = {case["kind"] for case in self.data["cases"]}
        for required in ("no_win", "line_win_small", "free_spins_3", "retrigger"):
            self.assertIn(required, kinds)


if __name__ == "__main__":
    unittest.main(verbosity=2)
