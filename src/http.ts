import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// Node 默认闲置 4 秒就关连接，下一次点按钮要重新握手（走代理时要 0.5~几秒）。
// 改成长连接，并定时轻量访问常用服务器保持热连接。
export function enableKeepAlive(warmUrls: string[]): void {
  setGlobalDispatcher(new EnvHttpProxyAgent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 120_000 }));
  const warm = () => {
    for (const u of warmUrls) fetch(u, { method: "HEAD", signal: AbortSignal.timeout(8_000) }).catch(() => undefined);
  };
  warm();
  setInterval(warm, 20_000).unref();
}
