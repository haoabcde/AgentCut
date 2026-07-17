import { describe, expect, it } from "vitest";
import {
  addTime,
  compareTime,
  convertTime,
  rangeEnd,
  rangesOverlap,
  timeToRationalSeconds,
} from "./time.js";

const fps2997 = { numerator: 30_000, denominator: 1_001 };
const millis = { numerator: 1_000, denominator: 1 };
const samples = { numerator: 48_000, denominator: 1 };

describe("exact timeline time", () => {
  it("preserves 29.97 fps as a rational instead of a float", () => {
    expect(timeToRationalSeconds({ value: 300, rate: fps2997 })).toEqual({
      numerator: 1001n,
      denominator: 100n,
    });
  });

  it("compares equal instants represented by different rates", () => {
    expect(compareTime(
      { value: 1_000, rate: millis },
      { value: 48_000, rate: samples },
    )).toBe(0);
  });

  it("converts exactly and rejects implicit lossy conversion", () => {
    expect(convertTime({ value: 48_000, rate: samples }, millis)).toEqual({
      value: 1_000,
      rate: millis,
    });
    expect(() => convertTime({ value: 1, rate: samples }, millis)).toThrow(/exactly/);
    expect(convertTime({ value: 24, rate: samples }, millis, "nearest").value).toBe(1);
  });

  it("computes half-open range overlap without frame drift", () => {
    const left = {
      start: { value: 0, rate: millis },
      duration: { value: 1_000, rate: millis },
    };
    const touching = {
      start: { value: 48_000, rate: samples },
      duration: { value: 48_000, rate: samples },
    };
    const overlapping = {
      start: { value: 47_999, rate: samples },
      duration: { value: 1, rate: samples },
    };
    expect(rangesOverlap(left, touching)).toBe(false);
    expect(rangesOverlap(left, overlapping)).toBe(true);
    expect(rangeEnd(left)).toEqual({ value: 1_000, rate: millis });
  });

  it("adds mixed rates exactly when the target rate can represent both", () => {
    expect(addTime(
      { value: 500, rate: millis },
      { value: 24_000, rate: samples },
      samples,
    )).toEqual({ value: 48_000, rate: samples });
  });

  it("checks mixed-rate ranges without forcing a lossy target rate", () => {
    const frameRange = {
      start: { value: 0, rate: fps2997 },
      duration: { value: 1, rate: fps2997 },
    };
    const sampleRange = {
      start: { value: 1_601, rate: samples },
      duration: { value: 1, rate: samples },
    };
    expect(rangesOverlap(frameRange, sampleRange)).toBe(true);
  });
});
