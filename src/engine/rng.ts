/**
 * Provably fair RNG: схема commit-reveal на HMAC-SHA256.
 *
 * Решение зафиксировано в ADR-002. Кратко, почему именно так:
 *
 *  - Игрок должен иметь возможность ПОСЛЕ раунда доказать, что сервер
 *    не подкрутил результат. Для этого сервер публикует хэш своего сида
 *    ДО ставки (commitment) и раскрывает сам сид при ротации (reveal).
 *  - Игрок вносит собственный сид (client seed), поэтому сервер не может
 *    заранее подобрать удобный ему результат — он не знает clientSeed
 *    в момент генерации serverSeed.
 *  - Nonce растёт на каждый раунд, поэтому одна пара сидов даёт
 *    неповторяющийся поток раундов без нового коммита.
 *
 * Чего схема НЕ даёт (важно понимать честно):
 *  - Сервер всё равно знает serverSeed заранее и мог бы выбрать его так,
 *    чтобы он был выгоден при КАКОМ-ТО clientSeed. Защита — в том, что
 *    клиентский сид выбирает игрок и может менять его в любой момент.
 *  - Схема не защищает от подмены самой математики игры. Поэтому в
 *    аудит-лог раунда пишется ещё и SHA-256 конфигурации (configHash).
 *
 * ЗАПРЕЩЕНО: Math.random() в любой части игровой логики. Единственный
 * источник энтропии — crypto.randomBytes (CSPRNG операционной системы).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Длина серверного сида в байтах (32 байта = 64 hex-символа). */
export const SERVER_SEED_BYTES = 32;

/** Сколько байт HMAC-SHA256 отдаёт за один вызов. */
const HMAC_BYTES = 32;

/** Сколько байт расходуется на одно случайное число. */
const BYTES_PER_FLOAT = 4;

/** Максимум чисел из одного блока HMAC. */
const FLOATS_PER_BLOCK = HMAC_BYTES / BYTES_PER_FLOAT; // 8

/** Ограничение на длину клиентского сида — защита от abuse. */
export const MAX_CLIENT_SEED_LENGTH = 256;

/** Пара сидов, из которой детерминированно разворачивается раунд. */
export interface SeedPair {
  /** Секрет сервера. Раскрывается только при ротации пары. */
  serverSeed: string;
  /** Публичный commitment: SHA-256(serverSeed). Выдаётся игроку заранее. */
  serverSeedHash: string;
  /** Сид игрока. Игрок может задать свой или принять сгенерированный. */
  clientSeed: string;
  /** Счётчик раундов на этой паре сидов. */
  nonce: number;
}

/** Уже раскрытая (отработавшая) пара — то, что игрок проверяет сам. */
export interface RevealedSeedPair {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  /** Сколько раундов было сыграно на этой паре. */
  finalNonce: number;
  revealedAt: string;
}

export class RngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RngError';
  }
}

/* -------------------------------------------------------------------------
 * Генерация и коммит сидов
 * ---------------------------------------------------------------------- */

/** Криптостойкий серверный сид: 32 байта из CSPRNG ОС, в hex. */
export function generateServerSeed(): string {
  return randomBytes(SERVER_SEED_BYTES).toString('hex');
}

/**
 * Клиентский сид по умолчанию.
 * Игроку он предлагается как стартовое значение; менять его — его право.
 */
export function generateClientSeed(): string {
  return randomBytes(8).toString('hex');
}

/** Commitment: SHA-256 от серверного сида в hex. */
export function hashServerSeed(serverSeed: string): string {
  assertHex(serverSeed, 'serverSeed');
  return createHash('sha256').update(serverSeed, 'utf8').digest('hex');
}

/** Создать новую пару сидов с nonce = 0. */
export function createSeedPair(clientSeed?: string): SeedPair {
  const serverSeed = generateServerSeed();
  const client = clientSeed ?? generateClientSeed();
  assertClientSeed(client);
  return {
    serverSeed,
    serverSeedHash: hashServerSeed(serverSeed),
    clientSeed: client,
    nonce: 0,
  };
}

/**
 * Проверка коммитмента: соответствует ли раскрытый сид опубликованному хэшу.
 * Сравнение — constant-time, чтобы не давать таймингового оракула.
 */
export function verifyCommitment(serverSeed: string, serverSeedHash: string): boolean {
  let actual: Buffer;
  try {
    actual = Buffer.from(hashServerSeed(serverSeed), 'hex');
  } catch {
    return false;
  }
  if (!/^[0-9a-f]{64}$/i.test(serverSeedHash)) return false;
  const expected = Buffer.from(serverSeedHash.toLowerCase(), 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/* -------------------------------------------------------------------------
 * Поток случайных чисел
 * ---------------------------------------------------------------------- */

/**
 * Блок из 32 псевдослучайных байт.
 *
 * Сообщение HMAC — `${clientSeed}:${nonce}:${cursor}`; ключ — серверный сид.
 * Формат сообщения совместим с индустриальной практикой (Stake и
 * производные верификаторы), поэтому сторонние проверялки подходят.
 */
export function hmacBlock(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  cursor: number,
): Buffer {
  assertHex(serverSeed, 'serverSeed');
  assertClientSeed(clientSeed);
  assertIndex(nonce, 'nonce');
  assertIndex(cursor, 'cursor');
  return createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}:${cursor}`, 'utf8')
    .digest();
}

/**
 * `count` чисел в диапазоне [0, 1) для заданного раунда.
 *
 * Каждое число собирается из 4 байт по схеме
 *   f = b0/256 + b1/256^2 + b2/256^3 + b3/256^4
 * Это даёт равномерное распределение с шагом 2^-32 и полностью
 * воспроизводится любым сторонним верификатором.
 */
export function floatsForRound(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  count: number,
): number[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RngError(`count должен быть неотрицательным целым, получено ${count}`);
  }

  const out: number[] = [];
  const blocks = Math.ceil(count / FLOATS_PER_BLOCK);

  for (let cursor = 0; cursor < blocks; cursor += 1) {
    const block = hmacBlock(serverSeed, clientSeed, nonce, cursor);
    for (let i = 0; i < FLOATS_PER_BLOCK && out.length < count; i += 1) {
      const off = i * BYTES_PER_FLOAT;
      out.push(
        block[off] / 256 +
          block[off + 1] / 256 ** 2 +
          block[off + 2] / 256 ** 3 +
          block[off + 3] / 256 ** 4,
      );
    }
  }

  return out;
}

/**
 * Целые числа в диапазоне [0, bounds[i]) — стопы барабанов.
 *
 * Используется умножение float на длину ленты. Смещение от такого
 * приведения не превышает 2^-32 относительно равномерного распределения:
 * при длинах лент ~40 позиций это порядка 10^-8 от вероятности стопа —
 * на четыре порядка меньше, чем допуск сертификационных лабораторий.
 */
export function integersForRound(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  bounds: readonly number[],
): number[] {
  for (const bound of bounds) {
    if (!Number.isInteger(bound) || bound <= 0) {
      throw new RngError(`граница диапазона должна быть целым > 0, получено ${bound}`);
    }
  }
  const floats = floatsForRound(serverSeed, clientSeed, nonce, bounds.length);
  return floats.map((f, i) => Math.min(Math.floor(f * bounds[i]), bounds[i] - 1));
}

/* -------------------------------------------------------------------------
 * Курсор раунда: удобная обёртка для игрового движка
 * ---------------------------------------------------------------------- */

/**
 * Ленивый поток чисел одного раунда.
 *
 * Раунд может потребовать заранее неизвестное число значений (базовый
 * спин + переменное число фриспинов), поэтому байты берутся по мере
 * надобности, а не пачкой. Порядок запросов детерминирован логикой игры,
 * значит результат воспроизводим.
 */
export class RoundRandom {
  private readonly serverSeed: string;
  private readonly clientSeed: string;
  private readonly nonce: number;

  private block: Buffer;
  private blockIndex = 0;
  private offset = 0;
  private consumed = 0;

  constructor(serverSeed: string, clientSeed: string, nonce: number) {
    this.serverSeed = serverSeed;
    this.clientSeed = clientSeed;
    this.nonce = nonce;
    this.block = hmacBlock(serverSeed, clientSeed, nonce, 0);
  }

  /** Сколько чисел уже израсходовано — пишется в аудит-лог раунда. */
  get drawCount(): number {
    return this.consumed;
  }

  /** Следующее число в [0, 1). */
  nextFloat(): number {
    if (this.offset + BYTES_PER_FLOAT > HMAC_BYTES) {
      this.blockIndex += 1;
      this.block = hmacBlock(this.serverSeed, this.clientSeed, this.nonce, this.blockIndex);
      this.offset = 0;
    }
    const b = this.block;
    const o = this.offset;
    this.offset += BYTES_PER_FLOAT;
    this.consumed += 1;
    return b[o] / 256 + b[o + 1] / 256 ** 2 + b[o + 2] / 256 ** 3 + b[o + 3] / 256 ** 4;
  }

  /** Следующее целое в [0, bound). */
  nextInt(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0) {
      throw new RngError(`bound должен быть целым > 0, получено ${bound}`);
    }
    return Math.min(Math.floor(this.nextFloat() * bound), bound - 1);
  }

  /** Стопы для набора барабанов заданных длин. */
  reelStops(lengths: readonly number[]): number[] {
    return lengths.map((n) => this.nextInt(n));
  }
}

/* -------------------------------------------------------------------------
 * Верификация раунда игроком
 * ---------------------------------------------------------------------- */

export interface VerificationInput {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  /** Стопы, которые сервер записал в лог раунда. */
  reelStops: readonly number[];
  /** Длины лент из конфигурации, на которой игрался раунд. */
  reelLengths: readonly number[];
}

export interface VerificationResult {
  /** Совпал ли раскрытый сид с опубликованным хэшем. */
  commitmentValid: boolean;
  /** Совпали ли пересчитанные стопы с записанными в логе. */
  stopsMatch: boolean;
  /** Пересчитанные стопы — чтобы игрок видел, что именно получилось. */
  recomputedStops: number[];
  valid: boolean;
  reason?: string;
}

/**
 * Полная проверка одного раунда — то, что делает публичный /verify.
 * Никаких секретов не требуется: всё считается из раскрытых данных.
 */
export function verifyRound(input: VerificationInput): VerificationResult {
  const commitmentValid = verifyCommitment(input.serverSeed, input.serverSeedHash);

  if (input.reelStops.length !== input.reelLengths.length) {
    return {
      commitmentValid,
      stopsMatch: false,
      recomputedStops: [],
      valid: false,
      reason: 'число стопов не совпадает с числом барабанов',
    };
  }

  let recomputedStops: number[];
  try {
    recomputedStops = integersForRound(
      input.serverSeed,
      input.clientSeed,
      input.nonce,
      input.reelLengths,
    );
  } catch (err) {
    return {
      commitmentValid,
      stopsMatch: false,
      recomputedStops: [],
      valid: false,
      reason: err instanceof Error ? err.message : 'ошибка пересчёта',
    };
  }

  const stopsMatch = recomputedStops.every((v, i) => v === input.reelStops[i]);

  return {
    commitmentValid,
    stopsMatch,
    recomputedStops,
    valid: commitmentValid && stopsMatch,
    reason: !commitmentValid
      ? 'раскрытый серверный сид не соответствует опубликованному хэшу'
      : !stopsMatch
        ? 'пересчитанные стопы барабанов не совпадают с записанными в логе'
        : undefined,
  };
}

/* -------------------------------------------------------------------------
 * Валидаторы
 * ---------------------------------------------------------------------- */

function assertHex(value: string, field: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
    throw new RngError(`${field} должен быть hex-строкой чётной длины`);
  }
}

function assertClientSeed(value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RngError('clientSeed не может быть пустым');
  }
  if (value.length > MAX_CLIENT_SEED_LENGTH) {
    throw new RngError(`clientSeed длиннее ${MAX_CLIENT_SEED_LENGTH} символов`);
  }
  // Двоеточие — разделитель в сообщении HMAC. Если разрешить его в сиде,
  // разные пары (clientSeed, nonce) дадут одинаковое сообщение.
  if (value.includes(':')) {
    throw new RngError('clientSeed не может содержать символ ":"');
  }
}

function assertIndex(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RngError(`${field} должен быть неотрицательным целым, получено ${value}`);
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new RngError(`${field} превышает безопасный диапазон целых`);
  }
}
