#!/usr/bin/env python3
"""
Проверка собранного офлайн-верификатора.

Верификатор — это обещание игроку: «пересчитай сам и убедись». Обещание
стоит ровно столько, сколько стоит доказательство, что встроенный в файл
JavaScript действительно считает то же, что и сервер. Поэтому здесь
JS-логика извлекается из HTML и прогоняется в Node против ПОЛНЫХ фикстур —
не только по итоговой сумме, но и по каждой сетке и каждой выплате.

Проверяется:
  1. Собственная SHA-256 в файле — против hashlib на контрольных векторах.
  2. Поток HMAC — против slotmath/round.py.
  3. Все 26 эталонных раундов: стопы, сетки, выплаты по спинам, итог.
  4. Отсутствие обращений в сеть (повторно, уже в готовом файле).
  5. Отсутствие Math.random в игровой логике.

Использование:
    python3 scripts/test_verifier.py
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from slotmath.config import load_config  # noqa: E402
from slotmath.round import RoundRandom, hash_server_seed, play_round  # noqa: E402

VERIFIER = REPO_ROOT / "verifier" / "verify.html"
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "rounds.json"


def extract_js(html: str) -> str:
    """
    Достаёт из HTML вычислительную часть скрипта.

    Всё, что ниже маркера секции интерфейса, обращается к DOM и в Node
    не запустится. Граница проходит ровно по этому маркеру — он же
    служит проверкой, что структура шаблона не поехала.
    """
    scripts = re.findall(r"<script>(.*?)</script>", html, flags=re.DOTALL)
    if len(scripts) != 1:
        raise SystemExit(f"ОШИБКА: ожидался ровно один тег script, найдено {len(scripts)}")

    js = scripts[0]
    marker = "   4. Интерфейс"
    if marker not in js:
        raise SystemExit("ОШИБКА: не найден маркер секции интерфейса — шаблон изменился")

    # Отрезаем по началу комментария, открывающего секцию интерфейса.
    cut = js.index(marker)
    cut = js.rindex("/*", 0, cut)
    return js[:cut]


HARNESS = r"""
%(js)s

// ---- обвязка для Node ----
const fixtures = %(fixtures)s;
const out = { sha: {}, floats: {}, rounds: [] };

// Контрольные векторы SHA-256
for (const s of fixtures.shaVectors) {
  out.sha[s] = toHex(sha256(utf8(s)));
}

// Поток float
for (const nonce of fixtures.floatNonces) {
  const r = new RoundRandom(fixtures.serverSeed, fixtures.clientSeed, nonce);
  const v = [];
  for (let i = 0; i < 24; i++) v.push(r.nextFloat().toFixed(15));
  out.floats[nonce] = v;
}

// Полный пересчёт раундов
for (const nonce of fixtures.nonces) {
  const rec = playRound(fixtures.serverSeed, fixtures.clientSeed, nonce,
                        fixtures.betPerLine);
  out.rounds.push({
    nonce: nonce,
    totalWin: rec.totalWin,
    totalBet: rec.totalBet,
    drawCount: rec.drawCount,
    capped: rec.capped,
    serverSeedHash: rec.serverSeedHash,
    spins: rec.spins.map(s => ({
      index: s.index, free: s.free, reelStops: s.reelStops, grid: s.grid,
      win: s.win, multiplier: s.multiplier, scatterCount: s.scatterCount,
      triggeredFreeSpins: s.triggeredFreeSpins,
      winDetails: s.winDetails
    }))
  });
}

console.log(JSON.stringify(out));
"""

SHA_VECTORS = [
    "",
    "abc",
    "a" * 64,
    "player-fixture-seed:0:0",
    "x" * 200,  # длиннее одного блока — проверяет дополнение
]


def main() -> int:
    if not VERIFIER.exists():
        print(f"ОШИБКА: нет {VERIFIER}, запустите scripts/build_verifier.py")
        return 1
    if not FIXTURES.exists():
        print(f"ОШИБКА: нет {FIXTURES}")
        return 1

    html = VERIFIER.read_text(encoding="utf-8")
    fixtures = json.loads(FIXTURES.read_text(encoding="utf-8"))
    cfg = load_config()

    print(f"Файл:              {VERIFIER}")
    print(f"Размер:            {len(html.encode('utf-8')) / 1024:.1f} КБ")
    print(f"Хэш конфигурации:  {cfg.config_hash()}\n")

    results: list[tuple[str, bool]] = []

    # ---- 1. Статические проверки самого файла ----
    print("1. Статические проверки файла")
    static_ok = True

    if cfg.config_hash() not in html:
        print("   ПРОВАЛ: в файле нет актуального хэша конфигурации")
        static_ok = False

    # Math.random в игровой логике недопустим ни в каком виде.
    if re.search(r"Math\.random", html):
        print("   ПРОВАЛ: найден Math.random")
        static_ok = False

    code_only = re.sub(r"<!--.*?-->", " ", html, flags=re.DOTALL)
    code_only = re.sub(r"/\*.*?\*/", " ", code_only, flags=re.DOTALL)
    for pattern, label in [
        (r"https?://", "ссылка наружу"),
        (r"\bfetch\s*\(", "fetch"),
        (r"XMLHttpRequest", "XMLHttpRequest"),
        (r"<script[^>]+src=", "внешний скрипт"),
        (r"<link[^>]", "внешний ресурс"),
    ]:
        if re.search(pattern, code_only, flags=re.IGNORECASE):
            print(f"   ПРОВАЛ: обнаружено обращение в сеть — {label}")
            static_ok = False

    if static_ok:
        print("   OK: хэш на месте, сеть не используется, Math.random отсутствует")
    results.append(("Статические проверки файла", static_ok))

    # ---- 2. Прогон JS в Node ----
    print("\n2. Прогон встроенного JavaScript в Node")
    js = extract_js(html)

    nonces = [case["nonce"] for case in fixtures["cases"]]
    harness_input = {
        "serverSeed": fixtures["serverSeed"],
        "clientSeed": fixtures["clientSeed"],
        "betPerLine": fixtures["betPerLine"],
        "nonces": nonces,
        "floatNonces": [0, 1, 42, 999],
        "shaVectors": SHA_VECTORS,
    }

    script = HARNESS % {
        "js": js,
        "fixtures": json.dumps(harness_input, ensure_ascii=False),
    }

    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False,
                                     encoding="utf-8") as fh:
        fh.write(script)
        path = fh.name

    try:
        proc = subprocess.run(["node", path], capture_output=True, text=True,
                              timeout=300)
    finally:
        Path(path).unlink(missing_ok=True)

    if proc.returncode != 0:
        print(f"   ПРОВАЛ: node завершился с ошибкой\n{proc.stderr[:1500]}")
        return 1

    js_out = json.loads(proc.stdout)
    print("   OK: скрипт исполнился без ошибок")

    # ---- 3. SHA-256 ----
    print("\n3. Встроенная SHA-256 против hashlib")
    import hashlib

    sha_ok = True
    for vector in SHA_VECTORS:
        expected = hashlib.sha256(vector.encode("utf-8")).hexdigest()
        actual = js_out["sha"][vector]
        if actual != expected:
            print(f"   ПРОВАЛ на векторе длины {len(vector)}: {actual} != {expected}")
            sha_ok = False
    if sha_ok:
        print(f"   OK: {len(SHA_VECTORS)} контрольных векторов, включая пустую строку "
              "и строку длиннее блока")
    results.append(("SHA-256", sha_ok))

    # ---- 4. Поток HMAC ----
    print("\n4. Поток случайных чисел против slotmath/round.py")
    stream_ok = True
    for nonce in harness_input["floatNonces"]:
        rng = RoundRandom(fixtures["serverSeed"], fixtures["clientSeed"], nonce)
        expected = [f"{rng.next_float():.15f}" for _ in range(24)]
        if expected != js_out["floats"][str(nonce)]:
            print(f"   ПРОВАЛ: поток разошёлся на nonce={nonce}")
            stream_ok = False
    if stream_ok:
        print(f"   OK: {len(harness_input['floatNonces'])} nonce x 24 числа, "
              "совпадение до 15-го знака (пересечение границы блока включено)")
    results.append(("Поток HMAC", stream_ok))

    # ---- 5. Полный пересчёт раундов ----
    print("\n5. Полный пересчёт эталонных раундов")
    rounds_ok = True
    checked_spins = 0

    by_nonce = {case["nonce"]: case for case in fixtures["cases"]}

    for js_round in js_out["rounds"]:
        nonce = js_round["nonce"]
        expected = by_nonce[nonce]

        py = play_round(cfg, fixtures["serverSeed"], fixtures["clientSeed"],
                        nonce, fixtures["betPerLine"]).as_dict()

        for field in ("totalWin", "totalBet", "drawCount", "capped", "serverSeedHash"):
            if js_round[field] != py[field]:
                print(f"   ПРОВАЛ nonce={nonce}: {field} "
                      f"js={js_round[field]} python={py[field]}")
                rounds_ok = False

        if js_round["totalWin"] != expected["totalWin"]:
            print(f"   ПРОВАЛ nonce={nonce}: расхождение с зафиксированной фикстурой")
            rounds_ok = False

        if len(js_round["spins"]) != len(py["spins"]):
            print(f"   ПРОВАЛ nonce={nonce}: спинов js={len(js_round['spins'])} "
                  f"python={len(py['spins'])}")
            rounds_ok = False
            continue

        for js_spin, py_spin in zip(js_round["spins"], py["spins"]):
            checked_spins += 1
            if js_spin != py_spin:
                print(f"   ПРОВАЛ nonce={nonce}, спин {py_spin['index']}: "
                      "содержимое спина разошлось")
                for key in py_spin:
                    if js_spin.get(key) != py_spin[key]:
                        print(f"      {key}: js={js_spin.get(key)} python={py_spin[key]}")
                rounds_ok = False

    if rounds_ok:
        print(f"   OK: {len(js_out['rounds'])} раундов, {checked_spins} спинов — "
              "стопы, сетки, детализация выплат и итог совпали полностью")
    results.append(("Пересчёт раундов", rounds_ok))

    # ---- Итог ----
    print("\n" + "=" * 64)
    for name, ok in results:
        print(f"  [{'OK ' if ok else 'ПРОВАЛ'}] {name}")
    print("=" * 64)

    failed = [name for name, ok in results if not ok]
    if failed:
        print(f"\nПРОВАЛЕНО: {len(failed)}")
        return 1
    print("\nВерификатор корректен и работает офлайн.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
