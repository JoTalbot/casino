/**
 * Тесты provably fair RNG.
 *
 * Запуск: npm test  (node --test по скомпилированным файлам)
 *
 * Проверяется три класса свойств:
 *   1. Корректность коммитмента и валидации входов.
 *   2. Детерминизм и воспроизводимость (то, ради чего всё затевалось).
 *   3. Статистика: равномерность распределения стопов и независимость
 *      потоков при смене nonce / clientSeed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import {
  MAX_CLIENT_SEED_LENGTH,
  RngError,
  RoundRandom,
  SERVER_SEED_BYTES,
  createSeedPair,
  floatsForRound,
  generateClientSeed,
  generateServerSeed,
  hashServerSeed,
  hmacBlock,
  integersForRound,
  verifyCommitment,
  verifyRound,
} from './rng.js';

const REEL_LENGTHS = [42, 41, 41, 41, 42];

describe('генерация сидов', () => {
  it('серверный сид — 32 байта в hex', () => {
    const seed = generateServerSeed();
    assert.equal(seed.length, SERVER_SEED_BYTES * 2);
    assert.match(seed, /^[0-9a-f]{64}$/);
  });

  it('сиды не повторяются', () => {
    const seeds = new Set(Array.from({ length: 1000 }, generateServerSeed));
    assert.equal(seeds.size, 1000);
  });

  it('клиентский сид генерируется непустым', () => {
    const seed = generateClientSeed();
    assert.ok(seed.length > 0);
    assert.ok(!seed.includes(':'));
  });

  it('createSeedPair отдаёт согласованную пару с nonce = 0', () => {
    const pair = createSeedPair('игрок-1');
    assert.equal(pair.nonce, 0);
    assert.equal(pair.clientSeed, 'игрок-1');
    assert.equal(pair.serverSeedHash, hashServerSeed(pair.serverSeed));
  });
});

describe('коммитмент', () => {
  it('хэш совпадает с эталонным SHA-256', () => {
    const seed = 'a'.repeat(64);
    const expected = createHash('sha256').update(seed, 'utf8').digest('hex');
    assert.equal(hashServerSeed(seed), expected);
  });

  it('верификация проходит для честной пары', () => {
    const seed = generateServerSeed();
    assert.equal(verifyCommitment(seed, hashServerSeed(seed)), true);
  });

  it('верификация падает при подмене сида', () => {
    const seed = generateServerSeed();
    const other = generateServerSeed();
    assert.equal(verifyCommitment(other, hashServerSeed(seed)), false);
  });

  it('верификация падает на мусорном хэше, а не бросает исключение', () => {
    const seed = generateServerSeed();
    assert.equal(verifyCommitment(seed, 'не хэш'), false);
    assert.equal(verifyCommitment('не сид', hashServerSeed(seed)), false);
  });

  it('регистр хэша не влияет на результат', () => {
    const seed = generateServerSeed();
    assert.equal(verifyCommitment(seed, hashServerSeed(seed).toUpperCase()), true);
  });
});

describe('поток HMAC', () => {
  it('блок совпадает с эталонным HMAC-SHA256', () => {
    const serverSeed = 'f'.repeat(64);
    const expected = createHmac('sha256', serverSeed)
      .update('player:7:0', 'utf8')
      .digest();
    assert.deepEqual(hmacBlock(serverSeed, 'player', 7, 0), expected);
  });

  it('все числа лежат в [0, 1)', () => {
    const floats = floatsForRound(generateServerSeed(), 'player', 0, 10_000);
    for (const f of floats) {
      assert.ok(f >= 0 && f < 1, `значение вне диапазона: ${f}`);
    }
  });

  it('запрошенное количество чисел возвращается точно', () => {
    const seed = generateServerSeed();
    for (const n of [0, 1, 7, 8, 9, 16, 17, 100]) {
      assert.equal(floatsForRound(seed, 'p', 0, n).length, n);
    }
  });

  it('границы блоков не рвут поток: первые 8 чисел совпадают с длинным запросом', () => {
    const seed = generateServerSeed();
    const short = floatsForRound(seed, 'p', 3, 8);
    const long = floatsForRound(seed, 'p', 3, 64);
    assert.deepEqual(short, long.slice(0, 8));
  });

  it('одинаковые входы дают одинаковый результат', () => {
    const seed = generateServerSeed();
    assert.deepEqual(
      floatsForRound(seed, 'player', 42, 20),
      floatsForRound(seed, 'player', 42, 20),
    );
  });

  it('смена nonce меняет поток', () => {
    const seed = generateServerSeed();
    assert.notDeepEqual(floatsForRound(seed, 'p', 1, 10), floatsForRound(seed, 'p', 2, 10));
  });

  it('смена clientSeed меняет поток', () => {
    const seed = generateServerSeed();
    assert.notDeepEqual(floatsForRound(seed, 'a', 1, 10), floatsForRound(seed, 'b', 1, 10));
  });

  it('смена serverSeed меняет поток', () => {
    assert.notDeepEqual(
      floatsForRound(generateServerSeed(), 'p', 1, 10),
      floatsForRound(generateServerSeed(), 'p', 1, 10),
    );
  });
});

describe('валидация входов', () => {
  const seed = generateServerSeed();

  it('пустой clientSeed отвергается', () => {
    assert.throws(() => floatsForRound(seed, '', 0, 1), RngError);
  });

  it('двоеточие в clientSeed отвергается: иначе возможна коллизия сообщений', () => {
    assert.throws(() => floatsForRound(seed, 'a:1', 0, 1), RngError);
    // Без запрета ("a:1", nonce 0) и ("a", nonce "1:0") дали бы одно сообщение.
  });

  it('слишком длинный clientSeed отвергается', () => {
    const long = 'x'.repeat(MAX_CLIENT_SEED_LENGTH + 1);
    assert.throws(() => floatsForRound(seed, long, 0, 1), RngError);
  });

  it('отрицательный nonce отвергается', () => {
    assert.throws(() => floatsForRound(seed, 'p', -1, 1), RngError);
  });

  it('дробный nonce отвергается', () => {
    assert.throws(() => floatsForRound(seed, 'p', 1.5, 1), RngError);
  });

  it('нецелая или нулевая граница диапазона отвергается', () => {
    assert.throws(() => integersForRound(seed, 'p', 0, [0]), RngError);
    assert.throws(() => integersForRound(seed, 'p', 0, [-5]), RngError);
    assert.throws(() => integersForRound(seed, 'p', 0, [10.5]), RngError);
  });

  it('серверный сид не в hex отвергается', () => {
    assert.throws(() => floatsForRound('zzz', 'p', 0, 1), RngError);
  });
});

describe('стопы барабанов', () => {
  it('каждый стоп лежит в границах своей ленты', () => {
    const seed = generateServerSeed();
    for (let nonce = 0; nonce < 2000; nonce += 1) {
      const stops = integersForRound(seed, 'player', nonce, REEL_LENGTHS);
      assert.equal(stops.length, REEL_LENGTHS.length);
      stops.forEach((stop, i) => {
        assert.ok(
          Number.isInteger(stop) && stop >= 0 && stop < REEL_LENGTHS[i],
          `стоп ${stop} вне [0, ${REEL_LENGTHS[i]})`,
        );
      });
    }
  });

  it('распределение стопов равномерное (хи-квадрат, 200k спинов)', () => {
    const seed = generateServerSeed();
    const spins = 200_000;
    const length = REEL_LENGTHS[0];
    const counts = new Array<number>(length).fill(0);

    for (let nonce = 0; nonce < spins; nonce += 1) {
      counts[integersForRound(seed, 'player', nonce, [length])[0]] += 1;
    }

    const expected = spins / length;
    let chi2 = 0;
    for (const c of counts) {
      chi2 += ((c - expected) ** 2) / expected;
    }

    // df = 41, критическое значение при p = 0.001 составляет ~76.1.
    assert.ok(chi2 < 76.1, `хи-квадрат = ${chi2.toFixed(2)}, ожидалось < 76.1`);
    assert.ok(counts.every((c) => c > 0), 'есть недостижимые позиции ленты');
  });

  it('среднее значение float близко к 0.5', () => {
    const floats = floatsForRound(generateServerSeed(), 'player', 0, 200_000);
    const mean = floats.reduce((a, b) => a + b, 0) / floats.length;
    assert.ok(Math.abs(mean - 0.5) < 0.005, `среднее = ${mean}`);
  });

  it('последовательные nonce не дают повторяющихся комбинаций стопов', () => {
    const seed = generateServerSeed();
    const seen = new Set<string>();
    let duplicates = 0;
    for (let nonce = 0; nonce < 20_000; nonce += 1) {
      const key = integersForRound(seed, 'p', nonce, REEL_LENGTHS).join(',');
      if (seen.has(key)) duplicates += 1;
      seen.add(key);
    }
    // Парадокс дней рождения: при 121.6 млн комбинаций и 20k выборок
    // ожидается ~1.6 совпадения. Порог с большим запасом.
    assert.ok(duplicates < 20, `слишком много повторов: ${duplicates}`);
  });
});

describe('RoundRandom', () => {
  it('даёт тот же поток, что и floatsForRound', () => {
    const seed = generateServerSeed();
    const rr = new RoundRandom(seed, 'player', 5);
    const streamed = Array.from({ length: 40 }, () => rr.nextFloat());
    assert.deepEqual(streamed, floatsForRound(seed, 'player', 5, 40));
  });

  it('корректно переходит через границу блока (8 чисел)', () => {
    const seed = generateServerSeed();
    const rr = new RoundRandom(seed, 'p', 0);
    const first = Array.from({ length: 8 }, () => rr.nextFloat());
    const second = Array.from({ length: 8 }, () => rr.nextFloat());
    assert.deepEqual([...first, ...second], floatsForRound(seed, 'p', 0, 16));
  });

  it('reelStops совпадает с integersForRound', () => {
    const seed = generateServerSeed();
    const rr = new RoundRandom(seed, 'player', 11);
    assert.deepEqual(rr.reelStops(REEL_LENGTHS), integersForRound(seed, 'player', 11, REEL_LENGTHS));
  });

  it('считает израсходованные значения — для аудит-лога', () => {
    const rr = new RoundRandom(generateServerSeed(), 'p', 0);
    assert.equal(rr.drawCount, 0);
    rr.reelStops(REEL_LENGTHS);
    assert.equal(rr.drawCount, 5);
    rr.nextFloat();
    assert.equal(rr.drawCount, 6);
  });

  it('длинный раунд с фриспинами воспроизводится побайтово', () => {
    const seed = generateServerSeed();
    const play = () => {
      const rr = new RoundRandom(seed, 'player', 77);
      const out: number[][] = [rr.reelStops(REEL_LENGTHS)];
      for (let i = 0; i < 25; i += 1) out.push(rr.reelStops(REEL_LENGTHS));
      return out;
    };
    assert.deepEqual(play(), play());
  });

  it('nextInt отвергает некорректную границу', () => {
    const rr = new RoundRandom(generateServerSeed(), 'p', 0);
    assert.throws(() => rr.nextInt(0), RngError);
    assert.throws(() => rr.nextInt(3.7), RngError);
  });
});

describe('верификация раунда игроком', () => {
  const seed = generateServerSeed();
  const hash = hashServerSeed(seed);
  const clientSeed = 'player-seed';
  const nonce = 123;
  const stops = integersForRound(seed, clientSeed, nonce, REEL_LENGTHS);

  it('честный раунд проходит проверку', () => {
    const res = verifyRound({
      serverSeed: seed,
      serverSeedHash: hash,
      clientSeed,
      nonce,
      reelStops: stops,
      reelLengths: REEL_LENGTHS,
    });
    assert.equal(res.valid, true);
    assert.equal(res.commitmentValid, true);
    assert.equal(res.stopsMatch, true);
    assert.deepEqual(res.recomputedStops, stops);
  });

  it('подмена результата раунда обнаруживается', () => {
    const tampered = [...stops];
    tampered[0] = (tampered[0] + 1) % REEL_LENGTHS[0];
    const res = verifyRound({
      serverSeed: seed,
      serverSeedHash: hash,
      clientSeed,
      nonce,
      reelStops: tampered,
      reelLengths: REEL_LENGTHS,
    });
    assert.equal(res.valid, false);
    assert.equal(res.commitmentValid, true);
    assert.equal(res.stopsMatch, false);
    assert.match(res.reason ?? '', /стопы/);
  });

  it('подмена серверного сида обнаруживается коммитментом', () => {
    const other = generateServerSeed();
    const res = verifyRound({
      serverSeed: other,
      serverSeedHash: hash,
      clientSeed,
      nonce,
      reelStops: integersForRound(other, clientSeed, nonce, REEL_LENGTHS),
      reelLengths: REEL_LENGTHS,
    });
    assert.equal(res.commitmentValid, false);
    assert.equal(res.valid, false);
    assert.match(res.reason ?? '', /хэш/);
  });

  it('подмена nonce обнаруживается', () => {
    const res = verifyRound({
      serverSeed: seed,
      serverSeedHash: hash,
      clientSeed,
      nonce: nonce + 1,
      reelStops: stops,
      reelLengths: REEL_LENGTHS,
    });
    assert.equal(res.valid, false);
  });

  it('несовпадение числа барабанов даёт внятную ошибку, а не исключение', () => {
    const res = verifyRound({
      serverSeed: seed,
      serverSeedHash: hash,
      clientSeed,
      nonce,
      reelStops: stops.slice(0, 3),
      reelLengths: REEL_LENGTHS,
    });
    assert.equal(res.valid, false);
    assert.match(res.reason ?? '', /барабан/);
  });

  it('невалидные входы не роняют верификатор', () => {
    const res = verifyRound({
      serverSeed: 'мусор',
      serverSeedHash: hash,
      clientSeed,
      nonce,
      reelStops: stops,
      reelLengths: REEL_LENGTHS,
    });
    assert.equal(res.valid, false);
    assert.equal(res.commitmentValid, false);
  });
});
