import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UiSecurityPanel } from "./UiSecurityPanel.js";

describe("UiSecurityPanel", () => {
  it("explains session invalidation and shows the current generation", () => {
    const html = renderToStaticMarkup(
      <UiSecurityPanel generation={3} busy={false} onRotate={vi.fn()} />,
    );
    expect(html).toContain("第 3 代");
    expect(html).toContain("其他浏览器的旧 Cookie 会立即失效");
    expect(html).toContain("轮换并退出其他浏览器");
    expect(html).not.toContain("bootstrapToken");
  });

  it("disables repeated rotation while the request is running", () => {
    const html = renderToStaticMarkup(
      <UiSecurityPanel generation={1} busy onRotate={vi.fn()} />,
    );
    expect(html).toContain("disabled");
    expect(html).toContain("正在轮换…");
  });
});
