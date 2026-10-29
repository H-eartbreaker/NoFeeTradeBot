import { randomBytes } from "node:crypto";
import { InlineKeyboard, InputFile } from "grammy";
import type { Bot, Context } from "grammy";
import type { Address } from "viem";
import type { ChainConfig } from "./chains.ts";
import { getRoute, NATIVE, routeIdentity, routePools } from "./kyber.ts";
import type { Route } from "./kyber.ts";
import type { Logos } from "./logos.ts";
import { swapBudget } from "./money.ts";
import { calculatePnl, floatingPnl, unrecoveredPrincipal } from "./pnl.ts";
import type { TokenBook } from "./pnl.ts";
import { renderPnlCard } from "./pnl-card.ts";
import type { PnlCardRow } from "./pnl-card.ts";
import { parseNativeAmount } from "./settings.ts";
import type { State } from "./state.ts";
import { readToken } from "./token.ts";
import { ConfirmedTransactionError, PendingTransactionError, sell } from "./trade.ts";
import type { SellConfirmation, TradeDeps } from "./trade.ts";
import { errMsg, escapeHtml, fmtUnits } from "./util.ts";

const defaults = { readToken, getRoute, sell, swapBudget };
type Options = { state: State; chains: ChainConfig[]; logos: Logos; activeChain: () => string; activeWallet: () => string;
  deps: (chain: string, wallet: string) => TradeDeps | undefined; slippage: (chain: string) => number;
  refresh: (ctx: Context, d: TradeDeps, token: Address, block: bigint, message?: number) => Promise<void> };
type Input = { chain: string; wallet: string; token: Address; expires: number; source?: number };
type Exit = Input & { id: string; amount: bigint; balance: bigint; target: bigint; slip: number; route: Route; minimum: bigint; budget: bigint; owner: Address };
const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;
const CARD_TOKENS = 20;
const signed =(value: bigint) => `${value > 0n ? "+" : ""}${fmtUnits(value, 18, 8)}`;

export async function quoteExit(d: TradeDeps, token: Address, balance: bigint, target: bigint, slip: number, quote: typeof getRoute = getRoute): Promise<{ amount: bigint; route: Route }> {
  if (target <= 0n || balance <= 0n || !Number.isInteger(slip) || slip < 1 || slip > 9999) throw new Error("目标金额、余额或滑点无效");
  const required = (target * 10000n + BigInt(9999 - slip)) / BigInt(10000 - slip);
  let high = balance; let low = 0n;
  let best = await quote(d.chain.kyberSlug!, token, NATIVE, high);
  if (BigInt(best.routeSummary.amountIn) !== high || BigInt(best.routeSummary.amountOut) < required) throw new Error("按当前报价和滑点，全部持仓也不足以换回目标金额；可降低目标或调整滑点");
  let next = (balance * required + BigInt(best.routeSummary.amountOut) - 1n) / BigInt(best.routeSummary.amountOut);
  for (let i = 0; i < 5 && high - low > 1n; i++) {
    const amount = i === 0 ? next : (low + high) / 2n;
    if (amount <= low || amount >= high) break;
    const route = await quote(d.chain.kyberSlug!, token, NATIVE, amount);
    if (BigInt(route.routeSummary.amountIn) !== amount) throw new Error("卖出报价输入金额不符");
    if (BigInt(route.routeSummary.amountOut) >= required) { high = amount; best = route; } else low = amount;
  }
  return { amount: high, route: best };
}

export function registerPositions(bot: Bot, o: Options, overrides: Partial<typeof defaults> = {}): () => void {
  const s = { ...defaults, ...overrides }; let input: Input | null = null; let pending: Exit | null = null; let revision = 0;
  const clear = () => { input = null; pending = null; revision++; };
  const back = () => new InlineKeyboard().text("持仓与盈亏", `positions:${o.activeChain()}:${o.activeWallet()}:0`).text("返回首页", "nav:start");
  const reply = (ctx: Context, text: string, kb: InlineKeyboard) => ctx.reply(text, { ...HTML, reply_markup: kb });
  const report = (d: TradeDeps) => calculatePnl(d.journal?.entries(d.walletId ?? "main", d.chain.key) ?? []);
  const tracked = (chain: string, wallet: string, books: Map<string, TokenBook>) => [...new Set([...o.state.positions().filter((p) => p.chain === chain && p.wallet === wallet).map((p) => p.token), ...[...books].filter(([, b]) => b.quantity !== 0n).map(([token]) => token)])];
  async function holding(d: TradeDeps, token: Address, book: TokenBook | undefined) {
    const info = await s.readToken(d.clients, token).catch(() => null);
    if (!info) return null;
    const route = info.balance > 0n ? await s.getRoute(d.chain.kyberSlug!, info.address, NATIVE, info.balance).catch(() => null) : null;
    const value = info.balance === 0n ? 0n : route ? BigInt(route.routeSummary.amountOut) : null;
    return { info, value, profit: floatingPnl(book, info.balance, value), principal: unrecoveredPrincipal(book, info.balance) };
  }
  async function card(ctx: Context, chain: string, wallet: string) {
    const d = o.deps(chain, wallet); if (!d) { await ctx.reply("钱包或链不可用"); return; }
    const pnl = report(d);
    const tokens = tracked(chain, wallet, pnl.books);
    const rows: PnlCardRow[] = []; let floating = 0n; let floatingUnknown = 0; let principal: bigint | null = 0n;
    const checked = await Promise.all(tokens.slice(0, CARD_TOKENS).map((token) => holding(d, token as Address, pnl.books.get(token))));
    for (const h of checked) {
      if (!h) { floatingUnknown++; continue; }
      if (h.info.balance === 0n) continue;
      if (h.profit !== null) floating += h.profit; else floatingUnknown++;
      if (h.principal === null) principal = null; else if (principal !== null) principal += h.principal;
      rows.push({ symbol: h.info.symbol, profit: h.profit, principal: h.principal });
    }
    try {
      const png = renderPnlCard({ chainLabel: d.chain.label, nativeSymbol: d.chain.nativeSymbol, wallet: d.clients.account.address,
        time: new Date().toLocaleString("zh-CN", { timeZone: o.state.display.timeZone, hour12: false }),
        realized: pnl.realized, realizedTrades: pnl.realizedTrades, estimated: pnl.estimated, floating, floatingUnknown,
        gas: pnl.gas, feeComplete: pnl.feeComplete, principal, rows, omitted: Math.max(0, tokens.length - CARD_TOKENS) });
      await ctx.replyWithPhoto(new InputFile(png, "pnl.png"), { caption: "持仓盈亏图（收益未扣 Gas）", reply_markup: back() });
    } catch (e) { await ctx.reply(`盈亏图片生成失败：${errMsg(e)}`, { reply_markup: back() }); }
  }
  async function positions(ctx: Context, chain: string, wallet: string, requestedPage: number) {
    const d = o.deps(chain, wallet); if (!d) { await ctx.reply("钱包或链不可用"); return; }
    const pnl = report(d);
    const tokens = tracked(chain, wallet, pnl.books);
    const last = Math.max(0, Math.ceil(tokens.length / 5) - 1); const page = Math.min(requestedPage, last);
    const kb = new InlineKeyboard(); let floating = 0n; let unknown = 0;
    const details = await Promise.all(tokens.slice(page * 5, page * 5 + 5).map(async (token) => {
      const h = await holding(d, token as Address, pnl.books.get(token));
      if (!h) { unknown++; return `\n<code>${token}</code>\n代币信息暂不可读`; }
      const { info, value, profit, principal } = h;
      if (profit !== null) floating += profit; else if (info.balance > 0n) unknown++;
      const lines = ["", `<b>${escapeHtml(info.symbol.slice(0, 30))}</b> · ${fmtUnits(info.balance, info.decimals, 8)}`, `<code>${token}</code>`,
        `卖出报价：${value === null ? "暂不可查" : `${fmtUnits(value, 18, 8)} ${d.chain.nativeSymbol}`}`,
        profit === null ? "浮动收益：成本链条或余额无法完整核对" : `浮动收益：${signed(profit)} ${d.chain.nativeSymbol}（未扣 Gas）`];
      if (principal !== null && info.balance > 0n) lines.push(`尚未收回本金：${fmtUnits(principal, 18, 8)} ${d.chain.nativeSymbol}（未计 Gas）`);
      if (info.balance > 0n) kb.text(`${info.symbol.slice(0, 12)} · 买卖`, `r:${chain}:${wallet}:${token}`).row();
      return lines.join("\n");
    }));
    const lines = ["<b>持仓与盈亏</b>", `链：${o.logos.chain(d.chain)}`, `钱包：<code>${d.clients.account.address}</code>`,
      `已实现收益${pnl.estimated ? "（估算）" : ""}：${signed(pnl.realized)} ${d.chain.nativeSymbol}（${pnl.realizedTrades} 笔可核对卖出，未扣 Gas）`,
      `本页浮动收益：${signed(floating)} ${d.chain.nativeSymbol}（未扣 Gas）`,
      `本链已记录 Gas：${fmtUnits(pnl.gas, 18, 10)} ${d.chain.nativeSymbol}${pnl.feeComplete ? "" : "（部分费用缺失）"}`,
      `未知成本卖出 ${pnl.unknownSales} 笔 · 本页不可核对 ${unknown} 个 · 待确认操作 ${pnl.unresolved} 笔`,
      `已跟踪仓位第 ${page + 1}/${last + 1} 页`, ...details, ...(tokens.length ? [] : ["", "暂无可展示的已跟踪仓位。"]),
      "", "只统计本地账本可核对部分；未知成本不按零计算，报价不代表已成交。各链单独用原生币核算。"];
    for (const c of o.chains) o.logos.button(kb.row(), c, c.label, `positions:${c.key}:${wallet}:0`);
    kb.row(); if (page > 0) kb.text("上一页", `positions:${chain}:${wallet}:${page - 1}`); if (page < last) kb.text("下一页", `positions:${chain}:${wallet}:${page + 1}`);
    kb.row().text("盈亏图片", `pcard:${chain}:${wallet}`).text("刷新", `positions:${chain}:${wallet}:${page}`).text("返回首页", "nav:start");
    await reply(ctx, lines.join("\n"), kb);
  }
  async function preview(ctx: Context, p: Input, target?: bigint) {
    const v = revision; const d = o.deps(p.chain, p.wallet); if (!d) throw new Error("钱包或链不可用");
    const info = await s.readToken(d.clients, p.token); if (!info || info.balance <= 0n) throw new Error("没有可卖出的持仓");
    if (target === undefined) {
      const principal = unrecoveredPrincipal(report(d).books.get(p.token.toLowerCase()), info.balance);
      if (principal === null) throw new Error("本金历史无法完整核对，请使用按金额卖出");
      if (principal === 0n) throw new Error("本轮买入本金已收回，无需再卖回本金");
      target = principal;
    }
    const slip = o.slippage(p.chain);
    const quote = await quoteExit(d, p.token, info.balance, target, slip, s.getRoute);
    const budget = await s.swapBudget(d, quote.route, { code: "exit", address: p.token, decimals: info.decimals, symbol: info.symbol });
    if (budget <= 0n || await d.clients.publicClient.getBalance({ address: d.clients.account.address }) < budget) throw new Error("原生币不足以支付卖出 Gas 预算或费用暂不可核对");
    if (v !== revision) return;
    const id = randomBytes(8).toString("hex"); const minimum = BigInt(quote.route.routeSummary.amountOut) * BigInt(10000 - slip) / 10000n;
    pending = { ...p, id, owner: d.clients.account.address, amount: quote.amount, balance: info.balance, target, route: quote.route, minimum, budget, slip, expires: Date.now() + 60000 };
    const pools = routePools(quote.route);
    const text = ["<b>确认按金额卖出</b>", `链：${o.logos.chain(d.chain)}`, `钱包：<code>${d.clients.account.address}</code>`, `代币：${escapeHtml(info.name.slice(0, 80))}（${escapeHtml(info.symbol.slice(0, 30))}）`, `CA：<code>${p.token}</code>`,
      `目标换回：${fmtUnits(target, 18, 18)} ${d.chain.nativeSymbol}（未扣 Gas）`, `本次卖出：${fmtUnits(quote.amount, info.decimals, info.decimals)} ${escapeHtml(info.symbol.slice(0, 30))}`,
      `预计换回：${fmtUnits(BigInt(quote.route.routeSummary.amountOut), 18, 8)} ${d.chain.nativeSymbol}`, `最低接受：${fmtUnits(minimum, 18, 18)} ${d.chain.nativeSymbol}`,
      `滑点：${slip / 100}% · 执行 Gas 预算：${fmtUnits(budget, 18, 10)} ${d.chain.nativeSymbol}`,
      ...((p.chain === "base" || p.chain === "rh") ? ["另有 L1 数据费，不计入执行 Gas 预算。"] : []),
      ...pools.slice(0, 4).map((pool) => `${escapeHtml(pool.exchange.slice(0, 30))} · <code>${escapeHtml(pool.pool.slice(0, 100))}</code>`),
      "", "为保留滑点余量，可能卖出比目标金额对应的代币更多，实际换回也可能高于目标。", "价格、交易池或持仓改变将要求重新确认；必要授权会先产生 Gas。60 秒内有效。"].join("\n");
    try { await reply(ctx, text, new InlineKeyboard().text("确认卖出", `exit:confirm:${id}`).text("取消", "exit:cancel")); }
    catch { pending = null; throw new Error("确认页发送失败，未卖出"); }
  }
  async function execute(ctx: Context, p: Exit) {
    const d = o.deps(p.chain, p.wallet);
    if (!d || d.clients.account.address !== p.owner || o.slippage(p.chain) !== p.slip) { await ctx.reply("钱包或滑点已改变，请重新确认"); return; }
    const confirmation: SellConfirmation = { amount: p.amount, balance: p.balance, route: routeIdentity(p.route), minimumOutput: p.minimum, expiresAt: p.expires, maxGasCost: p.budget };
    const pct = Number(p.amount * 1000000n / p.balance) / 10000;
    let result;
    try {
      result = await s.sell(d, p.token, pct, p.slip, confirmation);
    } catch (e) {
      if (e instanceof ConfirmedTransactionError) {
        try { o.state.recordSell(p.chain, p.token, pct, p.wallet, e.hash, { sold: p.amount, balance: p.balance }); } catch { console.error("已成交卖出的本地记录更新失败"); }
      }
      const text = `${e instanceof ConfirmedTransactionError || e instanceof PendingTransactionError ? "⚠️" : "❌ 卖出未完成："}${escapeHtml(errMsg(e))}`;
      await reply(ctx, text, back()).catch(() => console.error("卖出结果通知失败，请查看交易记录")); return;
    }
    let text = `✅ 卖出已成交，换回估算 ${fmtUnits(result.receivedNative, 18, 8)} ${d.chain.nativeSymbol}（未扣 Gas）\n<a href="${d.chain.explorerTx(result.hash)}">查看交易</a>`;
    try { o.state.recordSell(p.chain, p.token, pct, p.wallet, result.hash, { sold: p.amount, balance: p.balance }); }
    catch { text += "\n本地记录更新失败，请核对链上交易，勿重复卖出。"; }
    await o.refresh(ctx, d, p.token, result.blockNumber, p.source).catch(() => undefined);
    await reply(ctx, text, back()).catch(() => console.error("卖出结果通知失败，请查看交易记录"));
  }
  bot.command("positions", async (ctx) => { clear(); await positions(ctx, o.activeChain(), o.activeWallet(), 0); });
  bot.callbackQuery(/^positions:([a-z]+):([a-z0-9]{1,4}):(\d{1,4})$/, async (ctx) => { clear(); await ctx.answerCallbackQuery(); await positions(ctx, ctx.match[1], ctx.match[2], Number(ctx.match[3])); });
  bot.callbackQuery(/^pcard:([a-z]+):([a-z0-9]{1,4})$/, async (ctx) => { clear(); await ctx.answerCallbackQuery("正在生成…"); await card(ctx, ctx.match[1], ctx.match[2]); });
  bot.callbackQuery(/^exit:([pa]):([a-z]+):([a-z0-9]{1,4}):(0x[0-9a-f]{40})$/, async (ctx) => {
    clear(); await ctx.answerCallbackQuery();
    const p: Input = { chain: ctx.match[2], wallet: ctx.match[3], token: ctx.match[4] as Address, source: ctx.callbackQuery.message?.message_id, expires: Date.now() + 300000 };
    if (ctx.match[1] === "p") { try { await preview(ctx, p); } catch (e) { await reply(ctx, escapeHtml(errMsg(e)), back()); } }
    else { input = p; await reply(ctx, `直接发送希望换回的 ${o.deps(p.chain, p.wallet)?.chain.nativeSymbol ?? "原生币"} 金额（未扣 Gas），例如 0.001。\n发送“取消”退出，5 分钟内有效。`, new InlineKeyboard().text("取消", "exit:cancel")); }
  });
  bot.callbackQuery(/^exit:confirm:([0-9a-f]{16})$/, async (ctx) => {
    const p = pending;
    if (!p || p.id !== ctx.match[1] || p.expires <= Date.now()) { await ctx.answerCallbackQuery("确认已过期或已处理"); return; }
    clear(); await ctx.answerCallbackQuery("正在卖出…"); await execute(ctx, p);
  });
  bot.callbackQuery("exit:cancel", async (ctx) => { clear(); await ctx.answerCallbackQuery("已取消"); await reply(ctx, "已取消本次输入或卖出确认", back()); });
  bot.use(async (ctx, next) => {
    if (!input || !ctx.message?.text) { await next(); return; }
    const p = input;
    if (p.expires <= Date.now()) { clear(); await ctx.reply("输入已超时，请重新点按金额卖出"); return; }
    const text = ctx.message.text.trim();
    if (/^(取消|cancel)$/i.test(text)) { clear(); await ctx.reply("已取消"); return; }
    const amount = parseNativeAmount(text);
    if (amount === null) { await ctx.reply("请输入大于 0 的原生币金额，最多 18 位小数，或发送“取消”。"); return; }
    input = null;
    try { await preview(ctx, p, amount); } catch (e) { await reply(ctx, escapeHtml(errMsg(e)), back()); }
  });
  return clear;
}
