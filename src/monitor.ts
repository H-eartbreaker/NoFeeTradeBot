import type { Address } from "viem";
import { NATIVE, getRoute } from "./kyber.ts";
import type { State } from "./state.ts";
import { balanceOf, sell } from "./trade.ts";
import type { TradeDeps } from "./trade.ts";
import { errMsg, fmtUnits } from "./util.ts";

const INTERVAL_MS = 20_000;
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
};

export function startMonitor(o: MonitorOpts): () => void {
  const fails = new Map<string, number>();
  let running = false;

  async function check(chain: string, token: string): Promise<void> {
    const pos = o.state.position(chain, token);
    const d = o.deps.get(chain);
    if (!pos || !d || (pos.tp === null && pos.sl === null)) return;

    const balance = await balanceOf(d, pos.token as Address);
    if (balance === 0n) {
      o.state.removePosition(chain, token);
      return;
    }
    const route = await getRoute(d.chain.kyberSlug!, pos.token as Address, NATIVE, balance);
    const value = BigInt(route.routeSummary.amountOut);
    const hit = decide(pos.cost, value, pos.tp, pos.sl);
    if (!hit) return;

    const key = `${chain}:${pos.token}`;
    const sym = d.chain.nativeSymbol;
    const label = hit === "tp" ? "止盈" : "止损";
    const change = (Number(((value - pos.cost) * 10_000n) / pos.cost) / 100).toFixed(1);
    try {
      await o.notify(`🎯 <b>${label}触发</b> [${d.chain.label}]\n<code>${pos.token}</code>\n成本 ${fmtUnits(pos.cost, 18, 5)} ${sym} → 现值 ${fmtUnits(value, 18, 5)} ${sym}（${change}%），正在全部卖出…`);
      const r = await sell(d, pos.token as Address, 100, o.slippageBps(chain));
      o.state.recordSell(chain, token, 100);
      fails.delete(key);
      await o.notify(`✅ ${label}卖出成功，收到约 ${fmtUnits(r.receivedNative, 18, 6)} ${sym}\n<a href="${d.chain.explorerTx(r.hash)}">查看交易</a>`);
    } catch (e) {
      const n = (fails.get(key) ?? 0) + 1;
      fails.set(key, n);
      if (n >= MAX_FAILS) {
        o.state.setRule(chain, token, { tp: null, sl: null });
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
      for (const p of o.state.positions()) {
        await check(p.chain, p.token).catch((e) => console.log(`止盈止损检查失败 ${p.chain}:${p.token}:`, errMsg(e)));
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), INTERVAL_MS);
  return () => clearInterval(timer);
}
