import { Key } from "@phosphor-icons/react/Key";
import { LockKey } from "@phosphor-icons/react/LockKey";

interface UiAccessGateProps {
  pairingCode: string;
  busy: boolean;
  error?: string;
  checking?: boolean;
  onPairingCodeChange: (value: string) => void;
  onPair: () => void;
}

export function UiAccessGate({
  pairingCode,
  busy,
  error,
  checking,
  onPairingCodeChange,
  onPair,
}: UiAccessGateProps) {
  return (
    <main className="ui-access-gate">
      <section aria-labelledby="ui-access-title">
        <div className="ui-access-icon"><LockKey size={24} weight="fill" /></div>
        <span>LOCAL WRITE ACCESS</span>
        <h1 id="ui-access-title">连接这个浏览器</h1>
        <p>
          工程内容可以只读打开。删除、审批、Alpha 标注和导出等写操作，需要使用 Studio
          启动终端显示的本地配对链接授权。
        </p>
        {checking ? (
          <p className="ui-access-checking" role="status">正在检查本地浏览器会话…</p>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); onPair(); }}>
            <label htmlFor="ui-pairing-code">配对链接或授权码</label>
            <div>
              <Key size={16} />
              <input
                id="ui-pairing-code"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={pairingCode}
                onChange={(event) => onPairingCodeChange(event.currentTarget.value)}
                placeholder="#ui-bootstrap=…"
              />
            </div>
            <button type="submit" disabled={busy || pairingCode.trim().length < 16}>
              {busy ? "正在连接…" : "授权本地写入"}
            </button>
          </form>
        )}
        {error ? <p className="ui-access-error" role="alert">{error}</p> : null}
        <small>授权保存在 HttpOnly cookie 中，页面不会把长期凭据写入 localStorage。</small>
      </section>
    </main>
  );
}
