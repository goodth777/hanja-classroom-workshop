export function StatusPill({ connected }: { connected: boolean }) {
  return (
    <span className={`statusPill ${connected ? "isConnected" : "isDisconnected"}`} role="status">
      <span className="statusDot" aria-hidden="true" />
      {connected ? "실시간 연결됨" : "연결 복구 중"}
    </span>
  );
}
