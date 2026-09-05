import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { uiBootstrapFromValue } from "./App.js";
import { UiAccessGate } from "./components/UiAccessGate.js";

describe("Studio UI access", () => {
  it("extracts the bootstrap only from a raw token or explicit URL fragment", () => {
    expect(uiBootstrapFromValue("ui_bootstrap_token_001")).toBe("ui_bootstrap_token_001");
    expect(uiBootstrapFromValue(
      "http://127.0.0.1:4320/#ui-bootstrap=ui_bootstrap_token_002",
    )).toBe("ui_bootstrap_token_002");
    expect(uiBootstrapFromValue("#ui-bootstrap=short")).toBeUndefined();
    expect(uiBootstrapFromValue("https://example.com/?ui-bootstrap=not-a-fragment"))
      .toBeUndefined();
  });

  it("renders a pairing gate without persisting or displaying a supplied secret", () => {
    const checking = renderToStaticMarkup(
      <UiAccessGate
        pairingCode=""
        busy={false}
        checking
        onPairingCodeChange={vi.fn()}
        onPair={vi.fn()}
      />,
    );
    expect(checking).toContain("正在检查本地浏览器会话");

    const form = renderToStaticMarkup(
      <UiAccessGate
        pairingCode="secret-value-not-rendered"
        busy={false}
        onPairingCodeChange={vi.fn()}
        onPair={vi.fn()}
      />,
    );
    expect(form).toContain("连接这个浏览器");
    expect(form).toContain('type="password"');
    expect(form).not.toContain(">secret-value-not-rendered<");
    expect(form).toContain("HttpOnly cookie");
  });
});
