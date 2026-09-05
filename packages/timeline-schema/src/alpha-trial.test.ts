import { describe, expect, it } from "vitest";
import {
  ALPHA_TRIAL_EXTENSION_KEY,
  createAlphaTrialEnrollment,
  readAlphaTrialEnrollment,
} from "./alpha-trial.js";

describe("formal Alpha trial extension", () => {
  it("round-trips a versioned formal enrollment", () => {
    const enrollment = createAlphaTrialEnrollment("2026-08-10T00:00:00.000Z");
    expect(readAlphaTrialEnrollment({
      extensions: { [ALPHA_TRIAL_EXTENSION_KEY]: enrollment },
    })).toEqual(enrollment);
  });

  it("treats absence as an ordinary project and rejects malformed enrollment", () => {
    expect(readAlphaTrialEnrollment({})).toBeNull();
    expect(() => readAlphaTrialEnrollment({
      extensions: { [ALPHA_TRIAL_EXTENSION_KEY]: { mode: "formal" } },
    })).toThrow(`Invalid ${ALPHA_TRIAL_EXTENSION_KEY} extension`);
  });
});
