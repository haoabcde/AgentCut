import type { Rate, Time, TimeRange } from "@agentcut/timeline-schema";

export interface Rational {
  numerator: bigint;
  denominator: bigint;
}

export type RoundingMode = "exact" | "floor" | "ceil" | "nearest";

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

export function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) {
    throw new RangeError("Rational denominator must not be zero");
  }
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return {
    numerator: (numerator / divisor) * sign,
    denominator: (denominator / divisor) * sign,
  };
}

export function timeToRationalSeconds(time: Time): Rational {
  assertSafeTime(time);
  return rational(
    BigInt(time.value) * BigInt(time.rate.denominator),
    BigInt(time.rate.numerator),
  );
}

export function compareTime(left: Time, right: Time): -1 | 0 | 1 {
  const a = timeToRationalSeconds(left);
  const b = timeToRationalSeconds(right);
  const delta = a.numerator * b.denominator - b.numerator * a.denominator;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

export function convertTime(
  time: Time,
  targetRate: Rate,
  rounding: RoundingMode = "exact",
): Time {
  assertRate(targetRate);
  const seconds = timeToRationalSeconds(time);
  const numerator = seconds.numerator * BigInt(targetRate.numerator);
  const denominator = seconds.denominator * BigInt(targetRate.denominator);
  const value = divide(numerator, denominator, rounding);
  return { value: toSafeInteger(value), rate: { ...targetRate } };
}

export function addTime(
  left: Time,
  right: Time,
  targetRate: Rate = left.rate,
  rounding: RoundingMode = "exact",
): Time {
  const a = timeToRationalSeconds(left);
  const b = timeToRationalSeconds(right);
  const sum = rational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
  return rationalSecondsToTime(sum, targetRate, rounding);
}

export function subtractTime(
  left: Time,
  right: Time,
  targetRate: Rate = left.rate,
  rounding: RoundingMode = "exact",
): Time {
  const a = timeToRationalSeconds(left);
  const b = timeToRationalSeconds(right);
  const difference = rational(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
  if (difference.numerator < 0n) {
    throw new RangeError("Time result must not be negative");
  }
  return rationalSecondsToTime(difference, targetRate, rounding);
}

export function rangeEnd(range: TimeRange, targetRate: Rate = range.start.rate): Time {
  return addTime(range.start, range.duration, targetRate);
}

export function rangesOverlap(left: TimeRange, right: TimeRange): boolean {
  const leftStart = timeToRationalSeconds(left.start);
  const rightStart = timeToRationalSeconds(right.start);
  const leftEnd = addRational(leftStart, timeToRationalSeconds(left.duration));
  const rightEnd = addRational(rightStart, timeToRationalSeconds(right.duration));
  return compareRational(leftStart, rightEnd) < 0 && compareRational(rightStart, leftEnd) < 0;
}

export function rangeContainsTime(range: TimeRange, time: Time): boolean {
  const start = timeToRationalSeconds(range.start);
  const end = addRational(start, timeToRationalSeconds(range.duration));
  const instant = timeToRationalSeconds(time);
  return compareRational(start, instant) <= 0 && compareRational(instant, end) < 0;
}

function addRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function compareRational(left: Rational, right: Rational): -1 | 0 | 1 {
  const delta = left.numerator * right.denominator - right.numerator * left.denominator;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

export function assertSafeTime(time: Time): void {
  if (!Number.isSafeInteger(time.value) || time.value < 0) {
    throw new RangeError("Time value must be a non-negative safe integer");
  }
  assertRate(time.rate);
}

export function assertRate(rate: Rate): void {
  if (
    !Number.isSafeInteger(rate.numerator)
    || !Number.isSafeInteger(rate.denominator)
    || rate.numerator <= 0
    || rate.denominator <= 0
  ) {
    throw new RangeError("Rate numerator and denominator must be positive safe integers");
  }
}

function rationalSecondsToTime(
  seconds: Rational,
  targetRate: Rate,
  rounding: RoundingMode,
): Time {
  assertRate(targetRate);
  const numerator = seconds.numerator * BigInt(targetRate.numerator);
  const denominator = seconds.denominator * BigInt(targetRate.denominator);
  return {
    value: toSafeInteger(divide(numerator, denominator, rounding)),
    rate: { ...targetRate },
  };
}

function divide(numerator: bigint, denominator: bigint, rounding: RoundingMode): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) {
    return quotient;
  }
  if (rounding === "exact") {
    throw new RangeError("Time cannot be represented exactly at the requested rate");
  }
  if (rounding === "floor") {
    return quotient;
  }
  if (rounding === "ceil") {
    return quotient + 1n;
  }
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function toSafeInteger(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Time value exceeds the non-negative safe-integer range");
  }
  return Number(value);
}
