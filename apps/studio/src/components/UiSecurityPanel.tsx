import { ArrowsClockwise } from "@phosphor-icons/react/ArrowsClockwise";
import { Browser } from "@phosphor-icons/react/Browser";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";

interface UiSecurityPanelProps {
  generation: number;
  busy: boolean;
  onRotate: () => Promise<void>;
}

export function UiSecurityPanel({ generation, busy, onRotate }: UiSecurityPanelProps) {
  return (
    <details className="ui-security-panel">
      <summary>
        <span><Browser size={15} weight="fill" />Studio 浏览器授权</span>
        <small>第 {generation} 代</small>
      </summary>
      <div className="ui-security-copy">
        <ShieldCheck size={18} weight="fill" />
        <p>
          轮换后，其他浏览器的旧 Cookie 会立即失效；当前浏览器自动换取新会话。
          操作只更新本地凭据与安全审计，不修改时间线或 Agent 会话。
        </p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void onRotate()}
      >
        <ArrowsClockwise size={14} />
        {busy ? "正在轮换…" : "轮换并退出其他浏览器"}
      </button>
    </details>
  );
}
