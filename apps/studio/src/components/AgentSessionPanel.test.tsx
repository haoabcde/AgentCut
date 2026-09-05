import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionSummary } from "../api.js";
import { AgentSessionPanel, agentSessionState } from "./AgentSessionPanel.js";

const active: AgentSessionSummary = {
  id: "session_active_001",
  clientId: "codex-mcp",
  capabilities: ["project:read", "approval:request"],
  createdAt: "2026-08-10T01:00:00.000Z",
  expiresAt: "2026-08-10T03:00:00.000Z",
  access: { total: 4, allowed: 3, denied: 1, lastAccessAt: "2026-08-10T01:20:00.000Z" },
};

describe("AgentSessionPanel", () => {
  it("separates active, expired, and revoked sessions without exposing credentials", () => {
    const expired = { ...active, id: "session_expired_001", clientId: "old-cli", expiresAt: "2026-08-10T01:30:00.000Z" };
    const revoked = { ...active, id: "session_revoked_001", clientId: "stopped-agent", revokedAt: "2026-08-10T01:40:00.000Z" };
    const now = Date.parse("2026-08-10T02:00:00.000Z");
    expect(agentSessionState(active, now)).toBe("active");
    expect(agentSessionState(expired, now)).toBe("expired");
    expect(agentSessionState(revoked, now)).toBe("revoked");

    const html = renderToStaticMarkup(
      <AgentSessionPanel
        sessions={[active, expired, revoked]}
        busy={false}
        onRevoke={vi.fn()}
        now={now}
      />,
    );
    expect(html).toContain("Agent 会话");
    expect(html).toContain("1 个有效");
    expect(html).toContain("codex-mcp");
    expect(html).toContain("3 次允许 · 1 次拒绝");
    expect(html).toContain("已过期");
    expect(html).toContain("已撤销");
    expect(html).not.toContain("accessToken");
    expect(html).not.toContain("tokenHash");
    expect(buttonTags(html).filter((tag) => !tag.includes("disabled"))).toHaveLength(1);
  });

  it("disables revoke while another mutation is in flight", () => {
    const html = renderToStaticMarkup(
      <AgentSessionPanel sessions={[active]} busy onRevoke={vi.fn()} now={0} />,
    );
    expect(buttonTags(html)[0]).toContain("disabled");
  });
});

function buttonTags(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
}
