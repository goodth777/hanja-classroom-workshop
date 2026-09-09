// Use the server epoch with a monotonic local clock, never the phone's wall clock.
export function createServerClock(
  monotonicNow = () => performance.now(),
  wallNow = () => Date.now(),
) {
  let anchor = { local: monotonicNow(), server: wallNow() };
  let bestRtt = Infinity;
  return {
    now: () => anchor.server + monotonicNow() - anchor.local,
    resetSamples: () => { bestRtt = Infinity; },
    sample(serverNow: number, sentAt: number, receivedAt: number) {
      const rtt = receivedAt - sentAt;
      if (!Number.isFinite(serverNow) || !Number.isFinite(rtt) || rtt < 0 || rtt > 3000 || rtt > bestRtt) return;
      bestRtt = rtt;
      anchor = { local: receivedAt, server: serverNow + rtt / 2 };
    },
  };
}
