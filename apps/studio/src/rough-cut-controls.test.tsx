import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RoughCutControls } from "./components/RoughCutControls.js";

describe("RoughCutControls", () => {
  it("offers generation before the first rough cut", () => {
    const html = renderToStaticMarkup(
      <RoughCutControls
        status="not_started"
        projectRevision={2}
        pendingCount={0}
        busy={false}
        onGenerate={vi.fn()}
        keepRemainingConfirmation={false}
        onRequestKeepRemaining={vi.fn()}
        onCancelKeepRemaining={vi.fn()}
        onKeepRemaining={vi.fn()}
      />,
    );

    expect(html).toContain("生成初剪");
    expect(html).not.toContain("保留全部剩余");
  });

  it("makes the remaining review queue explicitly finishable", () => {
    const html = renderToStaticMarkup(
      <RoughCutControls
        status="reviewing"
        projectRevision={9}
        pendingCount={3}
        busy={false}
        onGenerate={vi.fn()}
        keepRemainingConfirmation={false}
        onRequestKeepRemaining={vi.fn()}
        onCancelKeepRemaining={vi.fn()}
        onKeepRemaining={vi.fn()}
      />,
    );

    expect(html).toContain("还剩 3 项必须决定");
    expect(html).toContain("保留全部剩余");
    expect(html).not.toContain("确认保留 REV");
  });

  it("requires a revision-bound second confirmation before bulk keeping", () => {
    const html = renderToStaticMarkup(
      <RoughCutControls
        status="reviewing"
        projectRevision={9}
        pendingCount={4}
        busy={false}
        onGenerate={vi.fn()}
        keepRemainingConfirmation
        onRequestKeepRemaining={vi.fn()}
        onCancelKeepRemaining={vi.fn()}
        onKeepRemaining={vi.fn()}
      />,
    );

    expect(html).toContain("确认保留 REV 9 的 4 项");
    expect(html).toContain("会写入保护锁并结束当前审阅");
    expect(html).toContain("确认保留 4 项");
    expect(html).toContain("取消");
  });

  it("shows completion after every candidate is decided", () => {
    const html = renderToStaticMarkup(
      <RoughCutControls
        status="rough_cut_ready"
        projectRevision={10}
        pendingCount={0}
        busy={false}
        onGenerate={vi.fn()}
        keepRemainingConfirmation={false}
        onRequestKeepRemaining={vi.fn()}
        onCancelKeepRemaining={vi.fn()}
        onKeepRemaining={vi.fn()}
      />,
    );

    expect(html).toContain("初剪内容已确认");
  });
});
