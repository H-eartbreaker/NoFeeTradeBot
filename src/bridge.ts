import { isAddress } from "viem";
import type { Address, Hex } from "viem";
import type { ChainConfig } from "./chains.ts";
import { queueKey, sendAndWait, serial } from "./trade.ts";
import type { TradeDeps } from "./trade.ts";
import { feeBudget } from "./money.ts";
import type { Journal } from "./journal.ts";

const API = "https://api.relay.link";
const ZERO = "0x0000000000000000000000000000000000000000";
export type BridgeQuote = { requestId: string; to: Address; data: Hex; value: bigint; fromChain: number; destination: string; recipient: Address; amountOut: bigint; minimumOut: bigint; relayerUsd: string; gasUsd: string; seconds: number; expires: number };
export async function bridgeQuote(d: TradeDeps, destination: ChainConfig, amount: bigint): Promise<BridgeQuote> {
  if (destination.key === d.chain.key || amount <= 0n) throw new Error("请选择不同的目标链和大于 0 的金额");
  const owner = d.clients.account.address;
  const response = await fetch(`${API}/quote`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ user: owner, recipient: owner, originChainId: d.chain.viemChain.id, destinationChainId: destination.viemChain.id, originCurrency: ZERO, destinationCurrency: ZERO, amount: amount.toString(), tradeType: "EXACT_INPUT" }) });
  const raw = await response.json() as any;
  if (!response.ok || !raw.details) throw new Error("跨链服务暂不支持此路线或金额，请调整后重试");
  const { details, steps, fees } = raw;
  if (details.sender?.toLowerCase() !== owner.toLowerCase() || details.recipient?.toLowerCase() !== owner.toLowerCase() || details.currencyIn.currency.chainId !== d.chain.viemChain.id || details.currencyOut.currency.chainId !== destination.viemChain.id || details.currencyIn.currency.address.toLowerCase() !== ZERO || details.currencyOut.currency.address.toLowerCase() !== ZERO || BigInt(details.currencyIn.amount) !== amount) throw new Error("跨链报价身份、链或金额不匹配");
  if (fees?.app?.amount === undefined || BigInt(fees.app.amount) !== 0n) throw new Error("跨链报价平台费用无法确认是零，已拒绝");
  if (!Array.isArray(steps) || steps.length !== 1 || steps[0].kind !== "transaction" || steps[0].items?.length !== 1) throw new Error("此路线需要额外步骤，当前不自动执行");
  const step = steps[0]; const tx = step.items[0].data;
  const requestId = step.requestId ?? new URL(step.items[0].check?.endpoint, API).searchParams.get("requestId");
  if (!/^0x[0-9a-f]{64}$/i.test(requestId ?? "") || tx.from?.toLowerCase() !== owner.toLowerCase() || tx.chainId !== d.chain.viemChain.id || BigInt(tx.value) !== amount || !isAddress(tx.to) || !/^0x(?:[0-9a-f]{2}){4,}$/i.test(tx.data) || tx.to.toLowerCase() === ZERO) throw new Error("跨链交易数据无法通过核对");
  const amountOut = BigInt(details.currencyOut.amount); const minimumOut = BigInt(details.currencyOut.minimumAmount);
  if (amountOut <= 0n || minimumOut <= 0n || minimumOut > amountOut) throw new Error("跨链到账报价无效");
  return { requestId, to: tx.to, data: tx.data, value: amount, fromChain: tx.chainId, destination: destination.key, recipient: owner, amountOut, minimumOut, relayerUsd: fees?.relayer?.amountUsd ?? "未知", gasUsd: fees?.gas?.amountUsd ?? "未知", seconds: Number(details.timeEstimate) || 0, expires: Date.now() + 60_000 };
}
export async function bridgeBudget(d: TradeDeps, quote: BridgeQuote): Promise<bigint> {
  const [gas, price] = await Promise.all([d.clients.publicClient.estimateGas({ account: d.clients.account.address, to: quote.to, data: quote.data, value: quote.value }), d.clients.publicClient.getGasPrice()]);
  return gas * price * 3n;
}
export function bridge(d: TradeDeps, quote: BridgeQuote, maxGasCost: bigint) {
  return serial(async () => {
    if (quote.fromChain !== d.chain.viemChain.id || quote.recipient.toLowerCase() !== d.clients.account.address.toLowerCase()) throw new Error("跨链钱包或链不匹配");
    if (await d.clients.publicClient.getBalance({ address: d.clients.account.address }) < quote.value + maxGasCost + d.chain.gasReserve) throw new Error("余额不足，跨链需保留 Gas");
    const result = await sendAndWait(d, { to: quote.to, value: quote.value, data: quote.data }, feeBudget(quote.expires, maxGasCost),
      { kind: "bridge", amountIn: quote.value.toString(), symbol: d.chain.nativeSymbol, decimals: 18, recipient: quote.recipient, destinationChain: quote.destination, requestId: quote.requestId,
        bridgeStatus: "pending", quotedAmountOut: quote.amountOut.toString(), minimumOut: quote.minimumOut.toString() });
    return result;
  }, queueKey(d));
}
const statusLabels: Record<string, string> = { success: "服务报告已到账", refund: "服务报告已退款", failure: "服务报告异常，请核对", pending: "等待目标链到账", waiting: "等待处理", submitted: "目标链处理中" };
export const bridgeStatusLabel = (status?: string) => statusLabels[status ?? ""] ?? "状态暂不可查";

// 与止盈止损独立调度，查询慢不会拖住 3 秒的检查；只查询，不补发跨链交易。
export function startBridgeMonitor(journal: Journal, notify: (text: string) => Promise<unknown>): () => void {
  let running = false; let cursor = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const all = journal.entries().filter((e) => e.kind === "bridge" && e.status === "confirmed" && e.requestId && !["success", "refund", "failure"].includes(e.bridgeStatus ?? ""));
      const entries = all.length ? Array.from({ length: Math.min(3, all.length) }, (_, i) => all[(cursor + i) % all.length]) : [];
      cursor = all.length ? (cursor + entries.length) % all.length : 0;
      await Promise.all(entries.map(async (e) => {
        try {
          const status = await bridgeStatus(e.requestId!);
          if (status !== e.bridgeStatus) {
            journal.update(e.id, { bridgeStatus: status });
            if (["success", "refund", "failure"].includes(status)) await notify(`🌉 跨链状态：${bridgeStatusLabel(status)}\n钱包 ${e.wallet} · ${e.chain} → ${e.destinationChain}\n请求编号：${e.requestId}\n请以目标链或退款交易记录核对到账。`);
          }
        } catch { /* 服务暂不可用，保留原状态，下轮继续查询 */ }
      }));
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 15_000);
  return () => clearInterval(timer);
}
export async function bridgeStatus(requestId: string): Promise<string> {
  if (!/^0x[0-9a-f]{64}$/i.test(requestId)) throw new Error("跨链请求编号无效");
  const response = await fetch(`${API}/intents/status?requestId=${requestId}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("跨链状态暂不可查");
  const result = await response.json() as { status?: string };
  return ["success", "refund", "failure", "pending", "waiting", "submitted"].includes(result.status ?? "") ? result.status! : "pending";
}
