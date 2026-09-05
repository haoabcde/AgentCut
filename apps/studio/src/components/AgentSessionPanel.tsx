import { ClockCounterClockwise } from "@phosphor-icons/react/ClockCounterClockwise";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { XCircle } from "@phosphor-icons/react/XCircle";
import type { AgentSessionSummary } from "../api.js";

interface AgentSessionPanelProps {
  sessions: AgentSessionSummary[];
  busy: boolean;
  onRevoke: (session: AgentSessionSummary) => Promise<void>;
  now?: number;
}

export type AgentSessionState = "active" | "expired" | "revoked";

const SESSION_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function agentSessionState(
  session: AgentSessionSummary,
  now = Date.now(),
): AgentSessionState {
  if (session.revokedAt) return "revoked";
  return Date.parse(session.expiresAt) <= now ? "expired" : "active";
}

export function AgentSessionPanel({
  sessions,
  busy,
  onRevoke,
  now = Date.now(),
}: AgentSessionPanelProps) {
  const activeCount = sessions.filter((session) => agentSessionState(session, now) === "active").length;
  return (
    <details className="agent-session-panel">
      <summary>
        <span><ShieldCheck size={15} weight="fill" />Agent 会话</span>
        <small>{activeCount} 个有效</small>
      </summary>
      <p className="agent-session-note">
        会话只能使用已授予能力。撤销会立即阻止后续请求，不修改时间线，也不会泄露访问令牌。
      </p>
      <div className="agent-session-list">
        {sessions.length === 0 ? (
          <p className="agent-session-empty">尚无 Agent 接入记录。</p>
        ) : sessions.map((session) => {
          const state = agentSessionState(session, now);
          return (
            <article className={`agent-session-item state-${state}`} key={session.id}>
              <header>
                <strong>{session.clientId}</strong>
                <span>{sessionStateLabel(state)}</span>
              </header>
              <code title={session.id}>{session.id}</code>
              <small>{session.capabilities.length} 项能力 · {session.access.allowed} 次允许 · {session.access.denied} 次拒绝</small>
              <div>
                <span><ClockCounterClockwise size={12} />到期 {formatLocalTime(session.expiresAt)}</span>
                <button
                  type="button"
                  disabled={busy || state !== "active"}
                  onClick={() => void onRevoke(session)}
                >
                  <XCircle size={13} />{state === "active" ? "撤销" : sessionStateLabel(state)}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </details>
  );
}

function sessionStateLabel(state: AgentSessionState): string {
  if (state === "active") return "有效";
  if (state === "expired") return "已过期";
  return "已撤销";
}

function formatLocalTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return SESSION_TIME_FORMATTER.format(timestamp);
}
