import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RoughCutReadiness } from "../api.js";
import { ReadinessChecklist } from "./ReadinessChecklist.js";

function readiness(overrides: Partial<RoughCutReadiness>): RoughCutReadiness {
  return {
    candidatesPending: 0,
    candidatesDecided: true,
    speechGapsRemaining: 0,
    exportSucceeded: false,
    exportStale: false,
    exportUpToDate: false,
    undo: null,
    ...overrides,
  };
}

describe("ReadinessChecklist", () => {
  it("keeps decided candidates, speech gaps, and export as independent signals", () => {
    const html = renderToStaticMarkup(
      <ReadinessChecklist
        readiness={readiness({ speechGapsRemaining: 2 })}
        busy={false}
        onUndoLatest={vi.fn()}
      />,
    );
    expect(html).toContain("候选已全部决定");
    expect(html).toContain("还有 2 段无口播画面");
    expect(html).toContain("尚未导出成片");
  });

  it("flags a stale export instead of treating it as accepted", () => {
    const html = renderToStaticMarkup(
      <ReadinessChecklist
        readiness={readiness({ exportSucceeded: true, exportStale: true, exportUpToDate: false })}
        busy={false}
        onUndoLatest={vi.fn()}
      />,
    );
    expect(html).toContain("成片已过期");
  });

  it("confirms an up-to-date export", () => {
    const html = renderToStaticMarkup(
      <ReadinessChecklist
        readiness={readiness({ exportSucceeded: true, exportUpToDate: true })}
        busy={false}
        onUndoLatest={vi.fn()}
      />,
    );
    expect(html).toContain("已导出当前版本成片");
  });

  it("offers a global undo for the most recent deletion", () => {
    const html = renderToStaticMarkup(
      <ReadinessChecklist
        readiness={readiness({
          undo: {
            transactionId: "tx_1",
            committedRevision: 4,
            removedDurationSeconds: 2.5,
            labelZh: "无口播画面",
          },
        })}
        busy={false}
        onUndoLatest={vi.fn()}
      />,
    );
    expect(html).toContain("撤销最近一次删除");
    expect(html).toContain("无口播画面");
    expect(html).toContain("2.50 秒");
  });
});
