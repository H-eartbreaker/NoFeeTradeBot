import type { Address } from "viem";
import { enabledRule, evaluate, hasRule } from "./auto-rules.ts";
import { NATIVE, getRoute } from "./kyber.ts";
import type { State } from "./state.ts";
import { balanceOf, ConfirmedTransactionError, PendingTransactionError, sell } from "./trade.ts";
import type { TradeDeps } from "./trade.ts";
import { errMsg, fmtUnits } from "./util.ts";

export const INTERVAL_MS = 3_000;
const MAX_FAILS = 3;
const LABEL = { sl: "止损", trail: "移动止损", tp: "止盈" } as const;

export type MonitorOps = { balanceOf: typeof balanceOf; getRoute: typeof getRoute; sell: typeof sell };
export type MonitorOpts = {
  state: State;
  deps: Map<string, TradeDeps>;
  slippageBps: (chain: string) => number;
  notify: (html: string) => Promise<unknown>;
  getDeps?: (wallet: string, chain: string) => TradeDeps | undefined;
  onTick?: () => Promise<unknown>;
  ops?: Partial<MonitorOps>;
};

export function startMonitor(o: MonitorOpts): () => void {
  const ops: MonitorOps = { balanceOf, getRoute, sell, ...o.ops };
  const fails = new Map<string, number>();
  const zeros = new Map<string, number>();
  let running = false;

  async function check(chain: string, token: string, wallet: string): Promise<void> {
    const pos = o.state.position(chain, token, wallet);
    const d = o.getDeps?.(wallet, chain) ?? (wallet === "main" ? o.deps.get(chain) : undefined);
    if (!pos || !d) return;
    const rule = enabledRule(pos);
    if (!hasRule(rule)) return;
    if (d.journal?.pending(wallet, chain, token)) return;
    const key = `${wallet}:${chain}:${pos.token}`;

    const balance = await ops.balanceOf(d, pos.token as Address);
    if (balance === 0n) {
      const count = (zeros.get(key) ?? 0) + 1;
      zeros.set(key, count);
      if (count >= 2) { o.state.removePosition(chain, token, wallet); zeros.delete(key); }
      return;
    }
    zeros.delete(key);
    const route = await ops.getRoute(d.chain.kyberSlug!, pos.token as Address, NATIVE, balance);
    const value = BigInt(route.routeSummary.amountOut);
    const evaluation = evaluate({ cost: pos.cost, value, sl: rule.sl, trail: rule.trail, tiers: rule.tiers, done: pos.done, peak: pos.peak });
    if (evaluation.peak !== pos.peak) o.state.setAutoProgress(chain, token, wallet, { peak: evaluation.peak });
    const action = evaluation.action;
    if (!action) return;

    const sym = d.chain.nativeSymbol;
    const label = action.kind === "tp" ? `止盈第 ${pos.done + 1} 档` : LABEL[action.kind];
    const change = (Number(((value - pos.cost) * 10_000n) / pos.cost) / 100).toFixed(1);
    const partial = action.pct < 100;
    const progress = (peak: bigint) => (action.kind === "tp" && partial ? { done: pos.done + 1, peak } : undefined);
    try {
      await o.notify(`🎯 <b>${label}触发</b> [${d.chain.label}]\n<code>${pos.token}</code>\n成本 ${fmtUnits(pos.cost, 18, 5)} ${sym} → 现值 ${fmtUnits(value, 18, 5)} ${sym}（${change}%），正在卖出 ${action.pct}%…`);
      const r = await ops.sell(d, pos.token as Address, action.pct, o.slippageBps(chain));
      const fraction = r.balanceBefore ? { sold: r.soldAmount, balance: r.balanceBefore } : undefined;
      const peak = fraction && fraction.balance > 0n ? evaluation.peak * (fraction.balance - fraction.sold) / fraction.balance : evaluation.peak * BigInt(100 - action.pct) / 100n;
      o.state.recordSell(chain, token, action.pct, wallet, r.hash, fraction, progress(peak));
      fails.delete(key);
      await o.notify(`✅ ${label}卖出成功，收到约 ${fmtUnits(r.receivedNative, 18, 6)} ${sym}\n<a href="${d.chain.explorerTx(r.hash)}">查看交易</a>`);
    } catch (e) {
      if (e instanceof ConfirmedTransactionError) {
        o.state.recordSell(chain, token, action.pct, wallet, e.hash, undefined, progress(evaluation.peak * BigInt(100 - action.pct) / 100n));
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
      if (o.state.autoPaused) return;
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
