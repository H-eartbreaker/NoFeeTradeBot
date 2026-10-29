import { solOrderMarket, SOL_ORDER_SCALE } from "./sol-order-market.ts";
import type { SolMarket } from "./sol-order-market.ts";
import { SOLANA } from "./sol-settings.ts";
import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import type { Address } from "viem";
import type { ChainConfig } from "./chains.ts";
import { getRoute } from "./kyber.ts";
import type { Logos } from "./logos.ts";
import { priceOf, supplyOf } from "./order-market.ts";
import { KIND_LABEL, MAX_OPEN_ORDERS, ORDER_TTL_MS, STATUS_LABEL, isBuyKind, isMcapKind, isOpen, metricValue, minimumNativeOut, minimumTokensOut, targetPrice, triggered } from "./orders.ts";
import type { Order, OrderKind, OrderStore } from "./orders.ts";
import { parseNativeAmount, parseSellPercentage } from "./settings.ts";
import type { State } from "./state.ts";
import { readToken } from "./token.ts";
import type { TradeDeps } from "./trade.ts";
import { errMsg, escapeHtml, fmtUnits } from "./util.ts";

const defaults = { readToken, getRoute, supplyOf };
export type OrdersServices = typeof defaults;
type Options = {
  sol?: SolMarket;
  store: OrderStore;
  state: State;
  chains: ChainConfig[];
  logos: Logos;
  deps: (chain: string, wallet: string) => TradeDeps | undefined;
  slippage: (chain: string, side: "buy" | "sell") => number;
};
type Short = "lb" | "ls" | "mb" | "ms" | "dca";
type Input = { kind: OrderKind; chain: string; wallet: string; token: string; expires: number };
type Parsed = { target?: bigint; amount?: bigint; pct?: number; intervalMs?: number; runs?: number };
type Pending = { order: Order; expires: number };

const SHORT: Record<Short, OrderKind> = { lb: "limit-buy", ls: "limit-sell", mb: "mcap-buy", ms: "mcap-sell", dca: "dca" };
const PROMPT: Record<OrderKind, string> = {
  "limit-buy": "发送「目标单价 买入金额」，用空格分隔，例如 0.0000012 0.01。目标单价必须低于当前单价，单位：原生币 / 每个代币。",
  "limit-sell": "发送「目标单价 卖出比例」，例如 0.000002 100。目标单价必须高于当前单价，比例 0.01～100。",
  "mcap-buy": "发送「目标市值 买入金额」，例如 500 0.01。市值按原生币计价，且必须低于当前市值。",
  "mcap-sell": "发送「目标市值 卖出比例」，例如 800 50。市值按原生币计价，且必须高于当前市值。",
  dca: "发送「每次金额 间隔分钟 次数」，例如 0.005 60 10。间隔 5～43200 分钟，次数 1～100，第一次在一个间隔后执行。",
};
const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;
const PAGE = 5;
const MINUTE = 60_000;

export function registerOrders(bot: Bot, o: Options, overrides: Partial<OrdersServices> = {}): () => void {
  const s = { ...defaults, ...overrides };
  let input: Input | null = null;
  const pendings = new Map<string, Pending>();
  const clear = () => { input = null; pendings.clear(); };
  const nativeOf = (chain: string) => [...o.chains, SOLANA].find((c) => c.key === chain)?.nativeSymbol ?? "";
  const chainLabel = (chain: string) => { const c = [...o.chains, SOLANA].find((x) => x.key === chain); return c ? o.logos.chain(c) : escapeHtml(chain); };
  const time = (t: number) => new Intl.DateTimeFormat("zh-CN", { timeZone: o.state.display.timeZone, hour12: o.state.display.hour12, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
  const reply = (ctx: Context, text: string, kb?: InlineKeyboard) => ctx.reply(text, { ...HTML, reply_markup: kb });
  const backKb = () => new InlineKeyboard().text("自动订单", "ord:list:0").text("返回首页", "nav:start");

  function condition(order: Order): string {
    const sym = nativeOf(order.chain);
    if (order.kind === "dca") return `每 ${(order.intervalMs ?? 0) / MINUTE} 分钟买入 ${fmtUnits(BigInt(order.amount), 18, 6)} ${sym}，剩余 ${order.runsLeft ?? 0} 次`;
    const unit = isMcapKind(order.kind) ? "市值" : "单价";
    const digits = isMcapKind(order.kind) ? 6 : 12;
    const op = isBuyKind(order.kind) ? "≤" : "≥";
    return `${unit} ${op} ${fmtUnits(BigInt(order.target!), 18, digits)} ${sym}`;
  }
  function action(order: Order): string {
    if (order.kind === "limit-sell" || order.kind === "mcap-sell") return `卖出 ${order.pct}%`;
    return `买入 ${fmtUnits(BigInt(order.amount), 18, 6)} ${nativeOf(order.chain)}`;
  }

  async function list(ctx: Context, requested: number) {
    const sorted = o.store.list().sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.createdAt - a.createdAt);
    const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
    const page = Math.min(Math.max(0, requested), pages - 1);
    const rows = sorted.slice(page * PAGE, page * PAGE + PAGE);
    const lines = ["<b>自动订单</b>",
      `全局状态：${o.state.autoPaused ? "已全局暂停，订单不会执行（可在止盈止损页恢复）" : "运行中，约每 10 秒检查一次"}`,
      `进行中：${o.store.openCount()} / ${MAX_OPEN_ORDERS}`, ""];
    if (!rows.length) lines.push("还没有自动订单。在代币卡片里点「自动订单」即可创建限价、市值或定投。");
    const kb = new InlineKeyboard();
    for (const order of rows) {
      const kind = KIND_LABEL[order.kind];
      lines.push(`<b>#${order.id.slice(0, 6)}</b> ${kind} · ${escapeHtml(order.symbol)} · ${chainLabel(order.chain)} · 钱包 ${escapeHtml(order.wallet)}`,
        `状态：${STATUS_LABEL[order.status]} · ${action(order)}`, `条件：${escapeHtml(condition(order))}`);
      if (order.runs > 0) lines.push(`已执行 ${order.runs} 次，累计花费 ${fmtUnits(BigInt(order.spent), 18, 6)} ${nativeOf(order.chain)}${order.skipped ? `，错过 ${order.skipped} 次未补买` : ""}`);
      if (order.nextRunAt !== null && isOpen(order) && order.kind === "dca") lines.push(`下次执行：${time(order.nextRunAt)}`);
      if (order.expiresAt !== null && isOpen(order)) lines.push(`有效期至：${time(order.expiresAt)}`);
      if (order.note) lines.push(`备注：${escapeHtml(order.note)}`);
      lines.push("");
      const buttons: [string, string][] = [];
      if (order.status === "active" || order.status === "paused") buttons.push([`${order.status === "active" ? "暂停" : "恢复"} #${order.id.slice(0, 6)}`, `ord:t:${order.id}`]);
      if (isOpen(order) && order.status !== "executing") buttons.push([`取消 #${order.id.slice(0, 6)}`, `ord:x:${order.id}`]);
      for (const [text, data] of buttons) kb.text(text, data);
      if (buttons.length) kb.row();
    }
    lines.push(`第 ${page + 1} / ${pages} 页`);
    if (page > 0) kb.text("上一页", `ord:list:${page - 1}`);
    if (page < pages - 1) kb.text("下一页", `ord:list:${page + 1}`);
    if (page > 0 || page < pages - 1) kb.row();
    kb.text("返回首页", "nav:start");
    await ctx.reply(lines.join("\n"), { ...HTML, reply_markup: kb });
  }

  async function menu(ctx: Context, chain: string, wallet: string, token: string) {
    const kb = new InlineKeyboard()
      .text("限价买入", `ord:k:lb:${chain}:${wallet}:${token}`).text("限价卖出", `ord:k:ls:${chain}:${wallet}:${token}`).row()
      .text("市值买入", `ord:k:mb:${chain}:${wallet}:${token}`).text("市值卖出", `ord:k:ms:${chain}:${wallet}:${token}`).row()
      .text("定投买入", `ord:k:dca:${chain}:${wallet}:${token}`).row()
      .text("自动订单中心", "ord:list:0").text("返回首页", "nav:start");
    await reply(ctx, ["<b>创建自动订单</b>", `链：${chainLabel(chain)}`, `CA：<code>${token}</code>`, "",
      "限价：到达设定单价后执行，只执行一次。",
      "市值：按原生币计价的市值到达条件后执行，只执行一次。",
      "定投：按固定间隔买入，共执行设定的次数，错过的次数不补买。",
      "确认前不会发送交易；确认后可在订单中心暂停或取消。"].join("\n"), kb);
  }

  async function market(chain: string, wallet: string, token: string, buyAmount: bigint | null) {
    if (chain === "sol") {
      if (!o.sol || wallet !== "main") throw new Error("Solana 钱包未启用");
      return solOrderMarket(o.sol, token, buyAmount);
    }
    const d = o.deps(chain, wallet); if (!d) throw new Error("这条链或钱包未启用");
    const info = await s.readToken(d.clients, token as Address); if (!info) throw new Error("读取代币信息失败");
    return { info, owner: d.clients.account.address, native: await d.clients.publicClient.getBalance({ address: d.clients.account.address }), reserve: d.chain.gasReserve,
      symbol: d.chain.nativeSymbol, price: () => priceOf(d, token as Address, info.decimals, buyAmount, s), supply: () => s.supplyOf(d, token as Address) };
  }

  async function prompt(ctx: Context, kind: OrderKind, chain: string, wallet: string, token: string) {
    const m = await market(chain, wallet, token, isBuyKind(kind) ? (chain === "sol" ? 10_000_000n * SOL_ORDER_SCALE : o.deps(chain, wallet)!.chain.buyAmounts[0]) : null);
    const info = m.info;
    if (!isBuyKind(kind) && info.balance === 0n) return reply(ctx, "当前钱包没有这个代币的持仓，无法创建卖出订单。请先买入。", backKb());
    let current = "";
    if (kind !== "dca") {
      try {
        const price = await m.price();
        const supply = isMcapKind(kind) ? await m.supply() : 0n;
        const value = metricValue(kind, price, supply, info.decimals);
        current = `当前${isMcapKind(kind) ? "市值" : "单价"}约 ${fmtUnits(value, 18, isMcapKind(kind) ? 6 : 12)} ${m.symbol}`;
      } catch {
        current = "当前报价暂不可用，确认时会重新核对";
      }
    }
    input = { kind, chain, wallet, token, expires: Date.now() + 5 * MINUTE };
    await reply(ctx, [`<b>${KIND_LABEL[kind]}</b> · ${escapeHtml(info.symbol.slice(0, 40))}`, current, PROMPT[kind], "发送“取消”退出，5 分钟内有效。"].filter(Boolean).join("\n"),
      new InlineKeyboard().text("取消", "ord:cancel"));
  }

  function parse(kind: OrderKind, text: string): Parsed | null {
    const parts = text.trim().split(/\s+/);
    if (kind === "dca") {
      if (parts.length !== 3 || !/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) return null;
      const amount = parseNativeAmount(parts[0]);
      const minutes = Number(parts[1]); const runs = Number(parts[2]);
      if (!amount || minutes < 5 || minutes > 43_200 || runs < 1 || runs > 100) return null;
      return { amount, intervalMs: minutes * MINUTE, runs };
    }
    if (parts.length !== 2) return null;
    const target = parseNativeAmount(parts[0]);
    if (!target) return null;
    if (kind === "limit-sell" || kind === "mcap-sell") {
      const pct = parseSellPercentage(parts[1]);
      return pct === null ? null : { target, pct };
    }
    const amount = parseNativeAmount(parts[1]);
    return amount ? { target, amount } : null;
  }

  async function preview(ctx: Context, p: Input, parsed: Parsed) {
    const m = await market(p.chain, p.wallet, p.token, isBuyKind(p.kind) ? parsed.amount! : null);
    const info = m.info;
    const sym = m.symbol;
    if (p.chain === "sol" && parsed.amount && parsed.amount % SOL_ORDER_SCALE !== 0n) throw new Error("Solana 买入金额最多 9 位小数");
    const now = Date.now();
    const kind = p.kind;
    const native = m.native;
    const lines = ["<b>确认自动订单</b>", `类型：${KIND_LABEL[kind]}`, `链：${chainLabel(p.chain)}`, `钱包：<code>${m.owner}</code>`,
      `代币：${escapeHtml(info.symbol.slice(0, 40))}（${escapeHtml(info.name.slice(0, 100))}）`, `CA：<code>${p.token}</code>`];
    const base = { id: randomBytes(6).toString("hex"), kind, wallet: p.wallet, chain: p.chain, token: p.chain === "sol" ? p.token : p.token.toLowerCase(), symbol: info.symbol.slice(0, 40), decimals: info.decimals,
      status: "active" as const, createdAt: now, spent: "0", runs: 0, skipped: 0, failures: 0, note: "", lastHash: null };
    let order: Order;

    if (kind === "dca") {
      const amount = parsed.amount!; const interval = parsed.intervalMs!; const runs = parsed.runs!;
      if (native < amount + m.reserve) throw new Error(`${sym} 余额不足（首次买入金额 + 少量 gas）`);
      lines.push(`每次买入：${fmtUnits(amount, 18, 6)} ${sym}，间隔 ${interval / MINUTE} 分钟，共 ${runs} 次`,
        `总预算：约 ${fmtUnits(amount * BigInt(runs), 18, 6)} ${sym}（不含 gas）`,
        `第一次执行：${time(now + interval)}`, "错过的次数不补买；余额不足时会连续失败并暂停。");
      order = { ...base, expiresAt: null, target: null, amount: amount.toString(), pct: null, intervalMs: interval, runsLeft: runs, nextRunAt: now + interval };
    } else if (isBuyKind(kind)) {
      const amount = parsed.amount!; const target = parsed.target!;
      if (native < amount + m.reserve) throw new Error(`${sym} 余额不足（需要买入金额 + 少量 gas）`);
      const supply = isMcapKind(kind) ? await m.supply() : 0n;
      const price = await m.price();
      const current = metricValue(kind, price, supply, info.decimals);
      if (triggered(kind, current, target)) throw new Error("当前价已达到或低于目标价，会立即买入。请调低目标价，或直接用买入按钮。");
      const floor = minimumTokensOut(amount, targetPrice(kind, target, supply, info.decimals), info.decimals);
      const digits = isMcapKind(kind) ? 6 : 12;
      lines.push(`触发条件：${isMcapKind(kind) ? "市值" : "单价"} ≤ ${fmtUnits(target, 18, digits)} ${sym}`,
        `当前${isMcapKind(kind) ? "市值" : "单价"}：约 ${fmtUnits(current, 18, digits)} ${sym}`,
        `买入金额：${fmtUnits(amount, 18, 6)} ${sym}`,
        `最少收到：约 ${fmtUnits(floor, info.decimals, 6)} ${escapeHtml(info.symbol.slice(0, 40))}（按目标价计算的保护下限）`);
      order = { ...base, expiresAt: now + ORDER_TTL_MS, target: target.toString(), amount: amount.toString(), pct: null, intervalMs: null, runsLeft: null, nextRunAt: null };
    } else {
      const pct = parsed.pct!; const target = parsed.target!;
      if (info.balance === 0n) throw new Error("没有这个代币的持仓，无法创建卖出订单");
      const supply = isMcapKind(kind) ? await m.supply() : 0n;
      const price = await m.price();
      const current = metricValue(kind, price, supply, info.decimals);
      if (triggered(kind, current, target)) throw new Error("当前价已达到或高于目标价，会立即卖出。请调高目标价，或直接用卖出按钮。");
      const sold = (info.balance * BigInt(Math.round(pct * 100))) / 10_000n;
      const floor = minimumNativeOut(sold, targetPrice(kind, target, supply, info.decimals), info.decimals);
      const digits = isMcapKind(kind) ? 6 : 12;
      lines.push(`触发条件：${isMcapKind(kind) ? "市值" : "单价"} ≥ ${fmtUnits(target, 18, digits)} ${sym}`,
        `当前${isMcapKind(kind) ? "市值" : "单价"}：约 ${fmtUnits(current, 18, digits)} ${sym}`,
        `卖出：${pct}%（约 ${fmtUnits(sold, info.decimals, 6)} ${escapeHtml(info.symbol.slice(0, 40))}）`,
        `最低换回：约 ${fmtUnits(floor, 18, 6)} ${sym}（按目标价计算的保护下限）`);
      order = { ...base, expiresAt: now + ORDER_TTL_MS, target: target.toString(), amount: "0", pct, intervalMs: null, runsLeft: null, nextRunAt: null };
    }

    const side = isBuyKind(kind) ? "buy" : "sell";
    lines.push(`滑点：${side === "buy" ? "买入" : "卖出"} ${o.slippage(p.chain, side) / 100}%`,
      `有效期：${order.expiresAt === null ? "无，取消后停止" : "7 天，未触发则自动取消"}`,
      "", "确认后自动生效。执行前会检查有效期、持仓、报价、余额和滑点。Solana 貔貅和税费检测未知，不能当成安全。",
      "全局暂停开启时不会执行。确认页 60 秒内有效；确认前不会发送任何交易。");

    const token = randomBytes(8).toString("hex");
    for (const [key, value] of pendings) if (value.expires <= now) pendings.delete(key);
    if (pendings.size >= 50) pendings.delete(pendings.keys().next().value!);
    pendings.set(token, { order, expires: now + 60_000 });
    await reply(ctx, lines.join("\n"), new InlineKeyboard().text("确认创建", `ord:ok:${token}`).text("取消", `ord:no:${token}`));
  }

  bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    const text = ctx.message?.text;
    if ((data && !data.startsWith("ord:")) || text?.startsWith("/")) clear();
    if (!input || !text || text.startsWith("/")) { await next(); return; }
    const p = input;
    if (p.expires <= Date.now()) { clear(); await reply(ctx, "输入已超时，请重新选择订单类型。", backKb()); return; }
    if (/^(取消|cancel)$/i.test(text.trim())) { clear(); await reply(ctx, "已取消，未创建订单。", backKb()); return; }
    const parsed = parse(p.kind, text);
    if (!parsed) { await ctx.reply(`格式不正确。${PROMPT[p.kind]}\n请重新发送，或发送“取消”。`); return; }
    input = null;
    try { await preview(ctx, p, parsed); }
    catch (e) { await reply(ctx, `未创建订单：${escapeHtml(errMsg(e))}`, backKb()); }
  });

  bot.command("orders", (ctx) => list(ctx, 0));
  bot.callbackQuery(/^ord:list:(\d{1,4})$/, async (ctx) => { clear(); await ctx.answerCallbackQuery(); await list(ctx, Number(ctx.match[1])); });
  bot.callbackQuery(/^ord:m:([a-z]+):([a-z0-9]{1,4}):(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    clear(); await ctx.answerCallbackQuery(); await menu(ctx, ctx.match[1], ctx.match[2], ctx.match[3]);
  });
  bot.callbackQuery(/^ord:k:(lb|ls|mb|ms|dca):([a-z]+):([a-z0-9]{1,4}):(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    clear(); await ctx.answerCallbackQuery();
    try { await prompt(ctx, SHORT[ctx.match[1] as Short], ctx.match[2], ctx.match[3], ctx.match[4] as Address); }
    catch (e) { await reply(ctx, `无法打开订单输入：${escapeHtml(errMsg(e))}`, backKb()); }
  });
  bot.callbackQuery("ord:cancel", async (ctx) => { clear(); await ctx.answerCallbackQuery("已取消"); await reply(ctx, "已取消，未创建订单。", backKb()); });
  bot.callbackQuery(/^ord:ok:([0-9a-f]{16})$/, async (ctx) => {
    const pending = pendings.get(ctx.match[1]);
    pendings.delete(ctx.match[1]);
    if (!pending || pending.expires <= Date.now()) { await ctx.answerCallbackQuery("确认已过期"); await reply(ctx, "确认已过期，未创建订单，请重新创建。", backKb()); return; }
    try {
      o.store.add(pending.order);
      await ctx.answerCallbackQuery("已创建");
      await reply(ctx, `已创建自动订单 #${pending.order.id.slice(0, 6)}。\n满足条件时自动执行；可在订单中心暂停或取消。`, new InlineKeyboard().text("查看订单中心", "ord:list:0").text("返回首页", "nav:start"));
    } catch (e) {
      await ctx.answerCallbackQuery("未创建");
      await reply(ctx, `未创建订单：${escapeHtml(errMsg(e))}`, backKb());
    }
  });
  bot.callbackQuery(/^ord:no:([0-9a-f]{16})$/, async (ctx) => {
    pendings.delete(ctx.match[1]); await ctx.answerCallbackQuery("已取消");
    await reply(ctx, "已取消，未创建订单。", backKb());
  });
  bot.callbackQuery(/^ord:t:([0-9a-f]{12})$/, async (ctx) => {
    const order = o.store.get(ctx.match[1]);
    if (!order) { await ctx.answerCallbackQuery("订单不存在"); return; }
    if (order.status === "active") { o.store.update(order.id, { status: "paused", note: "已手动暂停" }); await ctx.answerCallbackQuery("已暂停"); }
    else if (order.status === "paused") { o.store.update(order.id, { status: "active", note: "已恢复" }); await ctx.answerCallbackQuery("已恢复"); }
    else { await ctx.answerCallbackQuery("当前状态不能暂停或恢复"); return; }
    await list(ctx, 0);
  });
  bot.callbackQuery(/^ord:x:([0-9a-f]{12})$/, async (ctx) => {
    const order = o.store.get(ctx.match[1]);
    if (!order || !isOpen(order)) { await ctx.answerCallbackQuery("订单已结束"); return; }
    if (order.status === "executing") { await ctx.answerCallbackQuery("正在执行，稍后再取消"); return; }
    o.store.update(order.id, { status: "cancelled", note: "已手动取消" });
    await ctx.answerCallbackQuery("已取消");
    await list(ctx, 0);
  });
  return clear;
}
