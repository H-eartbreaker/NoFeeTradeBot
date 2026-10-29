import { address } from "@solana/kit";
import { enabledRule, evaluate, hasRule } from "./auto-rules.ts";
import { holdings, quote, SOL_MINT } from "./sol-chain.ts";
import { buySol, sellToken, serial, SolPendingError } from "./sol-trade.ts";
import { reconcileSol } from "./sol-ledger.ts";
import { isBuyKind, isMcapKind, metricValue, minimumNativeOut, minimumTokensOut, nextSlot, targetPrice, triggered } from "./orders.ts";
import type { OrderStore, Order } from "./orders.ts";
import type { State } from "./state.ts";
import type { Journal } from "./journal.ts";
import type { SolRpc } from "./sol-chain.ts";
import type { SolanaWallet } from "./sol-wallet.ts";
import { solSettings } from "./sol-settings.ts";
import { SOL_ORDER_SCALE } from "./sol-order-market.ts";
import { errMsg, escapeHtml } from "./util.ts";

type Ops = { holdings: typeof holdings; quote: typeof quote; buy: typeof buySol; sell: typeof sellToken; reconcile: typeof reconcileSol };
export type SolAutomationOptions = { state: State; store: OrderStore; journal: Journal; rpc: SolRpc; wallet: Pick<SolanaWallet, "address" | "signer">; notify: (text: string) => Promise<unknown>; ops?: Partial<Ops> };
export function createSolAutomation(o: SolAutomationOptions) {
  const ops = { holdings, quote, buy: buySol, sell: sellToken, reconcile: reconcileSol, ...o.ops };
  let running = false;
  for (const order of o.store.list()) if (order.chain === "sol" && order.status === "executing") o.store.update(order.id, { status: "needs-check", note: "执行期间程序中断，请先核对交易，禁止重发" });
  const say = async (s: string) => { await o.notify(s).catch(() => undefined); };
  const context = () => ({ journal: o.journal, policy: () => o.state.chainSettings("sol").execution ?? {} });
  function ready(order: Order, status: "active" | "executing") {
    const latest = o.store.get(order.id);
    return !o.state.autoPaused && latest?.status === status && (latest.expiresAt === null || Date.now() < latest.expiresAt);
  }
  async function orderTick(order: Order, now: number) {
    if (order.expiresAt !== null && now >= order.expiresAt) { o.store.update(order.id, { status: "cancelled", note: "已过期" }); return; }
    if (order.wallet !== "main") return;
    const owner = o.wallet.address(); if (!owner || o.journal.pending("main", "sol")) return;
    const buying = isBuyKind(order.kind); const settings = solSettings(o.state);
    if (order.kind === "dca") {
      const due = order.nextRunAt; const interval = order.intervalMs;
      if (due === null || !interval || now < due) return;
      if (now - due > interval) { const next = nextSlot(due, interval, now); o.store.update(order.id, { nextRunAt: next, skipped: order.skipped + Math.floor((next - due) / interval), note: "错过的定投未补买" }); return; }
    }
    const balance = (await ops.holdings(o.rpc, owner)).find((h) => h.mint === order.token)?.amount ?? 0n;
    const amount = buying ? BigInt(order.amount) / SOL_ORDER_SCALE : balance * BigInt(Math.round((order.pct ?? 0) * 100)) / 10000n;
    if (buying && BigInt(order.amount) % SOL_ORDER_SCALE !== 0n) throw new Error("Solana 买入金额精度无效");
    if (amount <= 0n) { o.store.update(order.id, { status: buying ? "failed" : "done", note: "没有可执行金额或持仓" }); return; }
    if (buying && o.state.isBlacklisted("token", "sol", order.token)) { o.store.update(order.id, { status: "cancelled", note: "代币已加入黑名单" }); return; }
    let q = await ops.quote(buying ? SOL_MINT : order.token, buying ? order.token : SOL_MINT, amount, buying ? settings.buySlippageBps : settings.sellSlippageBps);
    if (order.kind !== "dca") {
      const supply = isMcapKind(order.kind) ? BigInt((await o.rpc.getTokenSupply(address(order.token)).send()).value.amount) : 0n;
      const out = BigInt(q.outAmount); if (out <= 0n) return;
      const price = buying ? (amount * SOL_ORDER_SCALE * 10n ** BigInt(order.decimals) + out - 1n) / out : out * SOL_ORDER_SCALE * 10n ** BigInt(order.decimals) / amount;
      if (!triggered(order.kind, metricValue(order.kind, price, supply, order.decimals), BigInt(order.target!))) return;
      const target = targetPrice(order.kind, BigInt(order.target!), supply, order.decimals);
      const floor = buying ? minimumTokensOut(amount * SOL_ORDER_SCALE, target, order.decimals) : (minimumNativeOut(amount, target, order.decimals) + SOL_ORDER_SCALE - 1n) / SOL_ORDER_SCALE;
      if (floor > out) return;
      q = { ...q, otherAmountThreshold: (floor > BigInt(q.otherAmountThreshold) ? floor : BigInt(q.otherAmountThreshold)).toString() };
    }
    if (!ready(order, "active")) return;
    const settingsVersion = JSON.stringify(o.state.chainSettings("sol"));
    o.store.update(order.id, { status: "executing", note: "正在执行" });
    const ensure = () => { if (!ready(order, "executing") || owner !== o.wallet.address() || settingsVersion !== JSON.stringify(o.state.chainSettings("sol"))) throw new Error("订单已暂停、取消、过期或设置已变化"); };
    try {
      const result = await serial(owner, async () => {
        ensure(); const signer = await o.wallet.signer(); const ctx = { ...context(), orderId: order.id };
        return buying ? ops.buy(o.rpc, signer, order.token, amount, settings.buySlippageBps, q, ensure, ctx) : ops.sell(o.rpc, signer, order.token, order.pct!, settings.sellSlippageBps, q, ensure, ctx);
      });
      const confirmed = result.entry?.status === "confirmed";
      const remaining = order.runsLeft === null ? null : order.runsLeft - 1;
      o.store.update(order.id, { status: confirmed ? order.kind !== "dca" || remaining === 0 ? "done" : "active" : "needs-check", lastHash: result.signature,
        runs: order.runs + 1, spent: (BigInt(order.spent) + (buying ? BigInt(order.amount) : 0n)).toString(), runsLeft: remaining, failures: 0,
        nextRunAt: order.kind === "dca" ? order.nextRunAt! + order.intervalMs! : null, note: confirmed ? "已执行并记账" : "交易已上链，实际成交数据待核对，禁止重发" });
      await say(`✅ Solana 自动订单 #${order.id.slice(0, 6)} 已提交\n<a href="https://solscan.io/tx/${result.signature}">查看交易</a>`);
    } catch (e) {
      const latest = o.store.get(order.id); if (latest?.status !== "executing") return;
      const entry = o.journal.entries("main", "sol").find((v) => v.orderId === order.id);
      const uncertain = e instanceof SolPendingError || !!entry?.signature;
      o.store.update(order.id, { status: uncertain ? "needs-check" : "paused", lastHash: entry?.signature ?? null, failures: order.failures + 1, note: uncertain ? "已有交易编号，请核对结果；不会重发" : errMsg(e) });
      await say(`⚠️ Solana 自动订单已暂停：${escapeHtml(errMsg(e))}`);
    }
  }
  async function rulesTick() {
    const owner = o.wallet.address(); if (!owner || o.journal.pending("main", "sol")) return;
    const positions = o.state.positions().filter((p) => p.chain === "sol" && p.wallet === "main" && hasRule(enabledRule(p)));
    if (!positions.length) return;
    const balances = await ops.holdings(o.rpc, owner);
    for (const p of positions) {
      if (o.state.autoPaused || o.journal.pending("main", "sol")) return;
      const balance = balances.find((h) => h.mint === p.token)?.amount ?? 0n; if (!balance) continue;
      const settings = solSettings(o.state); const q = await ops.quote(p.token, SOL_MINT, balance, settings.sellSlippageBps);
      const evaluation = evaluate({ ...p, ...enabledRule(p), value: BigInt(q.outAmount) });
      if (evaluation.peak !== p.peak) o.state.setAutoProgress("sol", p.token, "main", { peak: evaluation.peak });
      if (!evaluation.action || o.state.autoPaused) continue;
      const action = evaluation.action; const sold = balance * BigInt(Math.round(action.pct * 100)) / 10000n;
      // 先暂停这一条规则。进程中断/未知结果后不得再卖一遍，需要用户核对再恢复。
      o.state.setRulePaused("sol", p.token, "main", action.kind, true);
      const ruleVersion = (value: unknown) => JSON.stringify(value);
      const claimed = o.state.position("sol", p.token)!;
      const configuration = (v: typeof claimed) => ({ tp: v.tp, sl: v.sl, trail: v.trail, tiers: v.tiers, paused: v.paused });
      const captured = ruleVersion(configuration(claimed)); const settingsVersion = JSON.stringify(o.state.chainSettings("sol"));
      const ensure = () => { const current = o.state.position("sol", p.token); if (o.state.autoPaused || !current || ruleVersion(configuration(current)) !== captured || settingsVersion !== JSON.stringify(o.state.chainSettings("sol"))) throw new Error("止盈止损已暂停或配置已变化"); };
      try {
        await serial(owner, async () => {
          ensure(); const signer = await o.wallet.signer();
          const progress = { done: action.kind === "tp" ? p.done + 1 : p.done, peak: (evaluation.peak * (balance - sold) / balance).toString() };
          const result = await ops.sell(o.rpc, signer, p.token, action.pct, settings.sellSlippageBps, undefined, ensure, { ...context(), autoProgress: progress });
          const current = o.state.position("sol", p.token);
          if (result.entry?.status === "confirmed" && current && ruleVersion(configuration(current)) === captured) o.state.setRulePaused("sol", p.token, "main", action.kind, false);
          await say(`🎯 Solana 止盈止损已提交\n<a href="https://solscan.io/tx/${result.signature}">查看交易</a>`);
        });
      } catch (e) { await say(`⚠️ Solana 本条自动规则已暂停，请核对后恢复：${escapeHtml(errMsg(e))}`); }
    }
  }
  return async function tick() {
    if (running) return; running = true;
    try {
      await ops.reconcile(o.journal, o.rpc);
      if (o.state.autoPaused || !o.wallet.address()) return;
      for (const order of o.store.list()) if (order.chain === "sol" && order.status === "active") await orderTick(order, Date.now()).catch(async (e) => {
        if (ready(order, "active")) o.store.update(order.id, { failures: order.failures + 1, status: order.failures >= 2 ? "paused" : "active", note: errMsg(e) });
      });
      await rulesTick();
    } finally { running = false; }
  };
}
export function startSolAutomation(o: SolAutomationOptions) { const tick = createSolAutomation(o); const timer = setInterval(() => void tick().catch(() => undefined), 3000); return () => clearInterval(timer); }
