import type { Address } from "viem";
import { checkToken } from "./honeypot.ts";
import type { RiskReport } from "./honeypot.ts";
import { NATIVE, getRoute } from "./kyber.ts";
import { NO_FILTER, blacklistReasons, filterBlocks } from "./risk-policy.ts";
import { priceOf, supplyOf } from "./order-market.ts";
import { isBuyKind, isMcapKind, metricValue, minimumNativeOut, minimumTokensOut, targetPrice, triggered } from "./orders.ts";
import type { Order, OrderStore } from "./orders.ts";
import type { State } from "./state.ts";
import { readOwner } from "./token.ts";
import { balanceOf, buy, sell, ConfirmedTransactionError, LimitNotMetError, PendingTransactionError } from "./trade.ts";
import type { TradeDeps } from "./trade.ts";
import { errMsg, escapeHtml, fmtUnits } from "./util.ts";

export const ORDER_INTERVAL_MS = 10_000;
const MAX_FAILS = 3;
class OrderStoppedError extends Error {}

export type OrderOps = {
  balanceOf: typeof balanceOf;
  getRoute: typeof getRoute;
  buy: typeof buy;
  sell: typeof sell;
  checkToken: typeof checkToken;
  supply: typeof supplyOf;
  readOwner: typeof readOwner;
};
export type OrderRunnerOpts = {
  store: OrderStore;
  state: State;
  getDeps: (wallet: string, chain: string) => TradeDeps | undefined;
  slippageBps: (chain: string, side: "buy" | "sell") => number;
  notify: (html: string) => Promise<unknown>;
  ops?: Partial<OrderOps>;
};

// 执行前检查：过期、持仓、貔貅盘、限价、余额和滑点（余额与 Gas 由交易函数再次检查）
export function startOrderRunner(o: OrderRunnerOpts): () => void {
  const ops: OrderOps = { balanceOf, getRoute, buy, sell, checkToken, supply: supplyOf, readOwner, ...o.ops };
  let running = false;

  // 上次进程在交易途中退出时，结果未知，不能自动重发
  for (const order of o.store.list()) {
    if (order.status !== "executing") continue;
    o.store.update(order.id, { status: "needs-check", note: "程序在执行途中中断，请先在链上核对，确认无误后再取消或新建订单" });
    void o.notify(`⚠️ 订单 #${order.id.slice(0, 6)} 上次执行时程序中断，已暂停，请核对链上记录后再处理。`).catch(() => undefined);
  }

  const say = (text: string) => o.notify(text).catch((e) => console.log("订单通知发送失败:", errMsg(e)));
  const tag = (order: Order) => `#${order.id.slice(0, 6)} ${escapeHtml(order.symbol.slice(0, 40))}`;
  const ready = (order: Order) => {
    const current = o.store.get(order.id);
    return !o.state.autoPaused && current?.status === "active" && (current.expiresAt === null || Date.now() < current.expiresAt);
  };
  const executionCheck = (order: Order) => () => {
    const current = o.store.get(order.id);
    if (o.state.autoPaused || current?.status !== "executing" || (current.expiresAt !== null && Date.now() >= current.expiresAt)) {
      throw new OrderStoppedError("订单已暂停、取消或过期，未提交交易");
    }
  };

  async function expire(order: Order) {
    o.store.update(order.id, { status: "cancelled", note: "已过期，未执行" });
    await say(`⌛ 订单 ${tag(order)} 已过期，未执行。`);
  }

  // 只用于买入。貔貅和黑名单取消订单；过滤不通过则保留订单，等下一轮再检查
  async function buyGate(order: Order, d: TradeDeps, amount: bigint): Promise<boolean> {
    const report: RiskReport | null = d.chain.honeypotChainId ? await ops.checkToken(d.chain.honeypotChainId, order.token as Address) : null;
    if (report?.isHoneypot) {
      o.store.update(order.id, { status: "failed", note: "检测到貔貅盘，已取消，未买入" });
      await say(`🚨 订单 ${tag(order)} 检测到貔貅盘，已取消。`);
      return true;
    }
    const owner = await ops.readOwner(d.clients, order.token as Address);
    const blocked = blacklistReasons(o.state, { chain: d.chain.key, token: order.token, owner });
    if (blocked.length) {
      o.store.update(order.id, { status: "cancelled", note: `已取消，未买入：${blocked.join("；")}` });
      await say(`🚫 订单 ${tag(order)} 已取消：${escapeHtml(blocked.join("；"))}。`);
      return true;
    }
    const filter = o.state.chainSettings(d.chain.key).risk ?? NO_FILTER;
    const route = filter.maxImpactPct !== null && d.chain.kyberSlug ? await ops.getRoute(d.chain.kyberSlug, NATIVE, order.token as Address, amount).catch(() => null) : null;
    const waiting = filterBlocks(filter, report, route);
    if (waiting.length) {
      const note = `风控过滤暂不买入，将继续检查：${waiting.join("；")}`;
      if (order.note !== note) o.store.update(order.id, { note });
      return true;
    }
    return false;
  }

  async function failed(order: Order, error: unknown, pausedStatus: "failed" | "paused") {
    if (error instanceof OrderStoppedError) {
      const current = o.store.get(order.id);
      if (current?.status === "executing") o.store.update(order.id, {
        status: current.expiresAt !== null && Date.now() >= current.expiresAt ? "cancelled" : "active", note: error.message,
      });
      return;
    }
    if (error instanceof PendingTransactionError || error instanceof ConfirmedTransactionError) {
      o.store.update(order.id, { status: "needs-check", lastHash: error.hash ?? order.lastHash, note: errMsg(error) });
      await say(`⚠️ 订单 ${tag(order)} 交易结果待确认，已停止此订单，请核对链上记录：${escapeHtml(errMsg(error))}`);
      return;
    }
    if (error instanceof LimitNotMetError) {
      o.store.update(order.id, { status: "active", note: "价格未达限价，等待中" });
      return;
    }
    const n = order.failures + 1;
    if (n >= MAX_FAILS) {
      o.store.update(order.id, { status: pausedStatus, failures: n, note: `连续失败 ${n} 次：${errMsg(error)}` });
      await say(`❌ 订单 ${tag(order)} 连续失败 ${n} 次，已${pausedStatus === "failed" ? "结束" : "暂停"}：${escapeHtml(errMsg(error))}`);
      return;
    }
    o.store.update(order.id, { status: "active", failures: n, note: `第 ${n} 次失败，稍后自动重试：${errMsg(error)}` });
  }

  function recordBuy(order: Order, d: TradeDeps, amount: bigint, hash: `0x${string}`) {
    try { o.state.recordBuy(d.chain.key, order.token, amount, order.wallet, hash); }
    catch { throw new ConfirmedTransactionError(hash); }
  }

  async function runBuy(order: Order, d: TradeDeps, amount: bigint, floor: bigint | undefined, pausedStatus: "failed" | "paused") {
    if (!ready(order)) return;
    if (await buyGate(order, d, amount)) return;
    if (!ready(order)) return;
    o.store.update(order.id, { status: "executing", note: "正在执行" });
    try {
      const r = await ops.buy(d, order.token as Address, amount, o.slippageBps(order.chain, "buy"), undefined, undefined, floor, executionCheck(order));
      recordBuy(order, d, amount, r.hash);
      const spent = BigInt(order.spent) + amount;
      const runsLeft = order.runsLeft === null ? null : order.runsLeft - 1;
      const finished = order.kind !== "dca" || runsLeft === 0;
      o.store.update(order.id, {
        status: finished ? "done" : "active",
        spent: spent.toString(), runs: order.runs + 1, lastHash: r.hash, failures: 0, runsLeft,
        nextRunAt: order.kind === "dca" && order.nextRunAt !== null ? order.nextRunAt + (order.intervalMs ?? 0) : null,
        note: finished ? "已执行完成" : "已执行一次，等待下一次",
      });
      await say(`✅ 订单 ${tag(order)} 买入成功 ${fmtUnits(amount, 18, 6)} ${d.chain.nativeSymbol}\n<a href="${d.chain.explorerTx(r.hash)}">查看交易</a>`);
    } catch (e) {
      await failed(o.store.get(order.id) ?? order, e, pausedStatus);
    }
  }

  async function runSell(order: Order, d: TradeDeps, pct: number, floor: bigint) {
    if (!ready(order)) return;
    o.store.update(order.id, { status: "executing", note: "正在执行" });
    try {
      const r = await ops.sell(d, order.token as Address, pct, o.slippageBps(order.chain, "sell"), undefined, floor, executionCheck(order));
      try {
        o.state.recordSell(d.chain.key, order.token, pct, order.wallet, r.hash, r.balanceBefore ? { sold: r.soldAmount, balance: r.balanceBefore } : undefined);
      } catch { throw new ConfirmedTransactionError(r.hash); }
      o.store.update(order.id, { status: "done", runs: 1, lastHash: r.hash, failures: 0, note: "已执行完成" });
      await say(`✅ 订单 ${tag(order)} 卖出 ${pct}% 成功，收到约 ${fmtUnits(r.receivedNative, 18, 6)} ${d.chain.nativeSymbol}\n<a href="${d.chain.explorerTx(r.hash)}">查看交易</a>`);
    } catch (e) {
      await failed(o.store.get(order.id) ?? order, e, "failed");
    }
  }

  async function runDca(order: Order, d: TradeDeps, now: number) {
    const interval = order.intervalMs ?? 0;
    const due = order.nextRunAt ?? now;
    if (now < due) return;
    // 迟到超过一个间隔视为错过：不补买，直接排到下一次
    if (now - due > interval) {
      let skipped = order.skipped; let next = due;
      while (next <= now) { next += interval; skipped++; }
      o.store.update(order.id, { nextRunAt: next, skipped, note: `错过定投，未补买，下次 ${new Intl.DateTimeFormat("zh-CN", { timeZone: o.state.display.timeZone, hour12: o.state.display.hour12, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(next))}` });
      return;
    }
    await runBuy(order, d, BigInt(order.amount), undefined, "paused");
  }

  async function process(order: Order, now: number) {
    if (order.expiresAt !== null && now >= order.expiresAt) return expire(order);
    const d = o.getDeps(order.wallet, order.chain);
    if (!d || d.journal?.pending(order.wallet, order.chain, order.token)) return;
    if (order.kind === "dca") return runDca(order, d, now);

    const decimals = order.decimals;
    const token = order.token as Address;
    let balance = 0n;
    if (!isBuyKind(order.kind)) {
      balance = await ops.balanceOf(d, token);
      if (balance === 0n) {
        o.store.update(order.id, { status: "done", note: "持仓已清空，订单结束" });
        return;
      }
    }
    const target = BigInt(order.target!);
    const buyAmount = isBuyKind(order.kind) ? BigInt(order.amount) : null;
    const price = await priceOf(d, token, decimals, buyAmount, ops);
    const supply = isMcapKind(order.kind) ? await ops.supply(d, token) : 0n;
    const current = metricValue(order.kind, price, supply, decimals);
    if (!triggered(order.kind, current, target)) return;

    const tPrice = targetPrice(order.kind, target, supply, decimals);
    if (isBuyKind(order.kind)) {
      await runBuy(order, d, buyAmount!, minimumTokensOut(buyAmount!, tPrice, decimals), "failed");
    } else {
      const pct = order.pct!;
      const sold = (balance * BigInt(Math.round(pct * 100))) / 10_000n;
      await runSell(order, d, pct, minimumNativeOut(sold, tPrice, decimals));
    }
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      if (o.state.autoPaused) return;
      const now = Date.now();
      for (const order of o.store.list()) {
        if (order.status !== "active") continue;
        await process(order, now).catch((e) => console.log(`订单 ${order.id.slice(0, 6)} 检查失败:`, errMsg(e)));
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), ORDER_INTERVAL_MS);
  return () => clearInterval(timer);
}
