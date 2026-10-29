import type { Address } from "viem";
import { NATIVE, getRoute } from "./kyber.ts";
import type { State } from "./state.ts";
import { balanceOf, ConfirmedTransactionError, PendingTransactionError, sell } from "./trade.ts";
import type { TradeDeps } from "./trade.ts";
import { errMsg, fmtUnits } from "./util.ts";

export const INTERVAL_MS = 3_000;
const MAX_FAILS = 3;

// 价值相对成本涨到 +tp% 返回 "tp"，跌到 -sl% 返回 "sl"；止损优先
export function decide(cost: bigint, value: bigint, tp: number | null, sl: number | null): "tp" | "sl" | null {
  if (cost <= 0n) return null;
  if (sl !== null && value * 10_000n <= cost * BigInt(Math.round(10_000 - sl * 100))) return "sl";
  if (tp !== null && value * 10_000n >= cost * BigInt(Math.round(10_000 + tp * 100))) return "tp";
  return null;
}

export type MonitorOpts = {
  state: State;
  deps: Map<string, TradeDeps>;
  slippageBps: (chain: string) => number;
  notify: (html: string) => Promise<unknown>;
  getDeps?: (wallet: string, chain: string) => TradeDeps | undefined;
  onTick?: () => Promise<unknown>;
};

export function startMonitor(o: MonitorOpts): () => void {
  const fails = new Map<string, number>();
  const zeros = new Map<string, number>();
  let running = false;

  async function check(chain: string, token: string, wallet: string): Promise<void> {
    const pos = o.state.position(chain, token, wallet);
    const d = o.getDeps?.(wallet, chain) ?? (wallet === "main" ? o.deps.get(chain) : undefined);
    if (!pos || !d || (pos.tp === null && pos.sl === null)) return;
    if (d.journal?.pending(wallet, chain, token)) return;
    const key = `${wallet}:${chain}:${pos.token}`;

    const balance = await balanceOf(d, pos.token as Address);
    if (balance === 0n) {
      const count = (zeros.get(key) ?? 0) + 1;
      zeros.set(key, count);
      if (count >= 2) { o.state.removePosition(chain, token, wallet); zeros.delete(key); }
      return;
    }
    zeros.delete(key);
    const route = await getRoute(d.chain.kyberSlug!, pos.token as Address, NATIVE, balance);
    const value = BigInt(route.routeSummary.amountOut);
    const hit = decide(pos.cost, value, pos.tp, pos.sl);
    if (!hit) return;

    const sym = d.chain.nativeSymbol;
    const label = hit === "tp" ? "止盈" : "止损";
    const change = (Number(((value - pos.cost) * 10_000n) / pos.cost) / 100).toFixed(1);
    try {
      await o.notify(`🎯 <b>${label}触发</b> [${d.chain.label}]\n<code>${pos.token}</code>\n成本 ${fmtUnits(pos.cost, 18, 5)} ${sym} → 现值 ${fmtUnits(value, 18, 5)} ${sym}（${change}%），正在全部卖出…`);
      const r = await sell(d, pos.token as Address, 100, o.slippageBps(chain));
      o.state.recordSell(chain, token, 100, wallet, r.hash, r.balanceBefore ? { sold: r.soldAmount, balance: r.balanceBefore } : undefined);
      fails.delete(key);
      await o.notify(`✅ ${label}卖出成功，收到约 ${fmtUnits(r.receivedNative, 18, 6)} ${sym}\n<a href="${d.chain.explorerTx(r.hash)}">查看交易</a>`);
    } catch (e) {
      if (e instanceof ConfirmedTransactionError) {
        o.state.recordSell(chain, token, 100, wallet, e.hash);
        await o.notify(`✅ 自动卖出已成交，到账数据暂未读全，请核对交易：${e.hash}`);
        return;
      }
      if (e instanceof PendingTransactionError) {
        o.state.setRule(chain, token, { tp: null, sl: null }, wallet);
        await o.notify(`⚠️ 自动卖出结果待确认，已暂停此仓位规则，避免重复卖出：${errMsg(e)}`);
        return;
      }
      const n = (fails.get(key) ?? 0) + 1;
      fails.set(key, n);
      if (n >= MAX_FAILS) {
        o.state.setRule(chain, token, { tp: null, sl: null }, wallet);
        fails.delete(key);
        await o.notify(`❌ ${label}卖出连续失败 ${n} 次，已关闭这个仓位的自动止盈止损，请手动处理: ${errMsg(e)}`);
      } else {
        await o.notify(`⚠️ ${label}卖出失败（第 ${n} 次，稍后自动重试）: ${errMsg(e)}`);
      }
    }
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      if (o.onTick) await o.onTick().catch(() => console.error("交易账本同步暂时失败，下轮重试"));
      for (const p of o.state.positions()) {
        await check(p.chain, p.token, p.wallet).catch((e) => console.log(`止盈止损检查失败 ${p.wallet}:${p.chain}:${p.token}:`, errMsg(e)));
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), INTERVAL_MS);
  return () => clearInterval(timer);
}
