import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { isAddress } from "viem";
import type { Address } from "viem";
import { assets, assetBalance, parseAssetAmount, verifyAsset } from "./assets.ts";
import type { Asset } from "./assets.ts";
import { bridge, bridgeBudget, bridgeQuote } from "./bridge.ts";
import type { BridgeQuote } from "./bridge.ts";
import type { ChainConfig } from "./chains.ts";
import { getRoute, NATIVE, routePools } from "./kyber.ts";
import type { Route } from "./kyber.ts";
import type { Logos } from "./logos.ts";
import { swapBudget, swapCurrency, transfer, transferEstimate } from "./money.ts";
import { ConfirmedTransactionError, PendingTransactionError } from "./trade.ts";
import type { TradeDeps } from "./trade.ts";
import { errMsg, escapeHtml, fmtUnits } from "./util.ts";

const defaults = { assetBalance, verifyAsset, getRoute, transferEstimate, transfer, swapBudget, swapCurrency, bridgeQuote, bridgeBudget, bridge };
export type FundsServices = typeof defaults;
type Options = { chains: ChainConfig[]; logos: Logos; activeChain: () => string; activeWallet: () => string;
  deps: (chain: string, wallet: string) => TradeDeps | undefined; slippage: (chain: string) => number };
type Input = { kind: "transfer" | "swap" | "bridge"; chain: string; wallet: string; asset: Asset; output?: Asset; destination?: ChainConfig; recipient?: Address; expires: number };
type Pending = Input & { id: string; owner: Address; amount: bigint; budget: bigint; route?: Route; quote?: BridgeQuote; slip?: number };
const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

export function registerFundsPanel(bot: Bot, o: Options, overrides: Partial<FundsServices> = {}): () => void {
  const s = { ...defaults, ...overrides };
  let input: Input | null = null; let pending: Pending | null = null; let revision = 0;
  const clear = () => { input = null; pending = null; revision++; };
  const back = () => new InlineKeyboard().text("资金管理", "funds:menu").text("返回首页", "nav:start");
  const cancelled = () => new InlineKeyboard().text("取消", "funds:cancel");
  const reply = (ctx: Context, lines: string[], kb: InlineKeyboard) => ctx.reply(lines.join("\n"), { ...HTML, reply_markup: kb });
  const feeLines = (d: TradeDeps, budget: bigint) => [
    `执行 Gas 预算：${fmtUnits(budget, 18, 10)} ${d.chain.nativeSymbol}（预算非预扣费用）`,
    ...(d.chain.key === "base" || d.chain.key === "rh" ? ["另有 L1 数据费，不包含在此执行 Gas 预算里。"] : []),
  ];
  async function menu(ctx: Context) {
    const d = o.deps(o.activeChain(), o.activeWallet())!;
    await reply(ctx, ["<b>资金管理</b>", `当前链：${o.logos.chain(d.chain)}`, `钱包：<code>${d.clients.account.address}</code>`,
      "", "选择转账、兑换或跨链，再直接回复地址和金额。", "每次操作都需单独确认，买前确认开关不影响这里。"], new InlineKeyboard()
      .text("转账", "funds:transfer").text("稳定币兑换", "funds:swap").row().text("跨链", "funds:bridge").row()
      .text("交易记录", `history:${o.activeWallet()}:${d.chain.key}:0`).text("返回首页", "nav:start"));
  }
  async function choose(ctx: Context, kind: Input["kind"]) {
    const wallet = o.activeWallet(); const d = o.deps(o.activeChain(), wallet)!;
    const kb = new InlineKeyboard();
    const lines = [`<b>${kind === "transfer" ? "转账" : kind === "swap" ? "稳定币兑换" : "跨链"}</b>`, `来源链：${o.logos.chain(d.chain)}`, `钱包：<code>${d.clients.account.address}</code>`, ""];
    if (kind === "bridge") {
      lines.push("选择目标链。此入口将来源链原生币换成目标链原生币，收款地址为你当前钱包。", "跨链使用 Relay 服务，可能有服务费；本机器人不加平台抽成。", "服务不支持的路线或金额会在报价时提示。");
      for (const c of o.chains.filter((c) => c.key !== d.chain.key)) o.logos.button(kb, c, c.label, `funds:bridge:${d.chain.key}:${wallet}:${c.key}`).row();
    } else {
      lines.push(kind === "transfer" ? "选择要转出的币。" : "选择支出的币。兑换只在当前链进行。"
      );
      for (const a of assets(d)) kb.text(kind === "swap" ? `${a.symbol} → ${assets(d).find((other) => other.code !== a.code)!.symbol}` : a.symbol, `funds:${kind}:${d.chain.key}:${wallet}:${a.code}`).row();
    }
    kb.text("返回资金管理", "funds:menu"); await reply(ctx, lines, kb);
  }
  async function preview(ctx: Context, p: Input, amount: bigint, v: number) {
    const d = o.deps(p.chain, p.wallet); if (!d) throw new Error("钱包或链已不可用");
    const [balance, native] = await Promise.all([s.assetBalance(d, p.asset), d.clients.publicClient.getBalance({ address: d.clients.account.address })]);
    if (balance < amount) throw new Error(`${p.asset.symbol} 余额不足`);
    let budget: bigint; let route: Route | undefined; let quote: BridgeQuote | undefined; let slip: number | undefined;
    const lines = ["<b>确认资金操作</b>", `操作：${p.kind === "transfer" ? "转账" : p.kind === "swap" ? "稳定币兑换" : "跨链"}`, `来源链：${o.logos.chain(d.chain)}`, `钱包：<code>${d.clients.account.address}</code>`,
      `支出：${fmtUnits(amount, p.asset.decimals, p.asset.decimals)} ${p.asset.symbol}`, `支出币 CA：<code>${p.asset.address}</code>`];
    if (p.kind === "transfer") {
      budget = (await s.transferEstimate(d, p.asset, p.recipient!, amount)).gasCost;
      lines.push(`收款地址：<code>${p.recipient}</code>`);
    } else if (p.kind === "swap") {
      await Promise.all([s.verifyAsset(d, p.asset), s.verifyAsset(d, p.output!)]);
      route = await s.getRoute(d.chain.kyberSlug!, p.asset.address, p.output!.address, amount);
      slip = o.slippage(p.chain);
      const minimum = BigInt(route.routeSummary.amountOut) * BigInt(10000 - slip) / 10000n;
      if (BigInt(route.routeSummary.amountIn) !== amount || minimum <= 0n) throw new Error("兑换报价无效");
      budget = await s.swapBudget(d, route, p.asset);
      lines.push(`收款地址：<code>${d.clients.account.address}</code>`, `收到币 CA：<code>${p.output!.address}</code>`,
        `预计收到：${fmtUnits(BigInt(route.routeSummary.amountOut), p.output!.decimals, 8)} ${p.output!.symbol}`, `最低接受：${fmtUnits(minimum, p.output!.decimals, p.output!.decimals)} ${p.output!.symbol}`, `滑点：${slip / 100}%`);
      const pools = routePools(route);
      lines.push(...(pools.length ? [`报价经过 ${pools.length} 个池：`, ...pools.slice(0, 4).map((pool) => `${escapeHtml(pool.exchange.slice(0, 40))} · <code>${escapeHtml(pool.pool.slice(0, 100))}</code>`)] : ["交易池详情：报价服务未提供"]));
      if (p.asset.address !== NATIVE) lines.push("需要授权时，仅授权本次兑换数量；授权可能先产生 Gas。之后若价格变化，兑换会停止，已完成的授权不会自动撤销。");
      lines.push("本机器人不加平台抽成；报价包含交易池手续费与价差。");
    } else {
      quote = await s.bridgeQuote(d, p.destination!, amount); budget = await s.bridgeBudget(d, quote);
      lines.push(`目标链：${o.logos.chain(p.destination!)}`, `收款地址：<code>${quote.recipient}</code>`,
        `预计收到：${fmtUnits(quote.amountOut, 18, 8)} ${p.destination!.nativeSymbol}`, `服务报价最低到账：${fmtUnits(quote.minimumOut, 18, 18)} ${p.destination!.nativeSymbol}`,
        `跨链服务费：$${escapeHtml(quote.relayerUsd)}`, `服务估计来源链 Gas：$${escapeHtml(quote.gasUsd)}`, `预计耗时：${quote.seconds > 0 ? `${quote.seconds} 秒` : "暂不可估计"}`,
        `来源链交互合约：<code>${quote.to}</code>`, "来源链成功后仍需等待目标链到账；服务异常时会继续保留记录供核对。");
    }
    if (budget <= 0n || native < (p.asset.address === NATIVE ? amount : 0n) + budget + (p.kind === "bridge" ? d.chain.gasReserve : 0n)) throw new Error("原生币余额不足，需保留 Gas 预算");
    if (revision !== v) return;
    if (quote && quote.expires <= Date.now()) throw new Error("跨链报价已过期，请重新报价");
    const id = randomBytes(8).toString("hex");
    pending = { ...p, id, owner: d.clients.account.address, amount, budget, route: route ? structuredClone(route) : undefined, quote, slip, expires: Math.min(Date.now() + 60_000, quote?.expires ?? Infinity) };
    lines.push("", ...feeLines(d, budget), "60 秒内有效。核对链、金额和收款地址后再确认。");
    try { await reply(ctx, lines, new InlineKeyboard().text("确认提交", `funds:confirm:${id}`).text("取消", "funds:cancel")); }
    catch { if (pending?.id === id) pending = null; throw new Error("确认页发送失败，未提交交易"); }
  }
  async function execute(ctx: Context, p: Pending) {
    const d = o.deps(p.chain, p.wallet);
    if (!d || d.clients.account.address.toLowerCase() !== p.owner.toLowerCase()) { await ctx.reply("钱包配置已改变，请重新确认"); return; }
    if (p.kind === "swap" && p.slip !== o.slippage(p.chain)) { await ctx.reply("滑点已改变，请重新确认"); return; }
    let text: string;
    try {
      if (p.kind === "transfer") {
        const r = await s.transfer(d, p.asset, p.recipient!, p.amount, p.expires, p.budget);
        text = `✅ 转账已在来源链成功\n${fmtUnits(p.amount, p.asset.decimals, p.asset.decimals)} ${p.asset.symbol}\n收款地址：<code>${p.recipient}</code>\n<a href="${d.chain.explorerTx(r.hash)}">查看交易</a>`;
      } else if (p.kind === "swap") {
        const r = await s.swapCurrency(d, p.asset, p.output!, p.amount, p.slip!, p.route!, p.expires, p.budget);
        text = `✅ 兑换已成交\n到账${p.output!.address === NATIVE ? "估算" : ""}：${fmtUnits(r.received, p.output!.decimals, 8)} ${p.output!.symbol}\n<a href="${d.chain.explorerTx(r.hash)}">查看交易</a>`;
      } else {
        const r = await s.bridge(d, p.quote!, p.budget);
        text = `🌉 跨链来源链交易已成功，正在等待目标链到账\n${d.chain.label} → ${p.destination!.label}\n请求编号：<code>${p.quote!.requestId}</code>\n<a href="${d.chain.explorerTx(r.hash)}">查看来源链交易</a>\n可在交易记录查看后续状态。`;
      }
    } catch (e) {
      text = `${e instanceof PendingTransactionError || e instanceof ConfirmedTransactionError ? "⚠️" : "❌ 操作未完成："}${escapeHtml(errMsg(e))}`;
    }
    // 已确认的链上结果不因 Telegram 发送失败被当作交易失败或再次执行。
    try { await reply(ctx, [text], back()); } catch { console.error("资金操作状态通知发送失败，请在交易记录核对结果"); }
  }
  bot.command("funds", async (ctx) => { clear(); await menu(ctx); });
  bot.callbackQuery(/^funds:(menu|transfer|swap|bridge|cancel)$/, async (ctx) => {
    clear(); await ctx.answerCallbackQuery();
    if (ctx.match[1] === "cancel") { await reply(ctx, ["已取消，未提交本次资金操作。"], back()); }
    else if (ctx.match[1] === "menu") await menu(ctx); else await choose(ctx, ctx.match[1] as Input["kind"]);
  });
  bot.callbackQuery(/^funds:(transfer|swap|bridge):([a-z]+):([a-z0-9]{1,4}):([a-z]+)$/, async (ctx) => {
    clear(); const kind = ctx.match[1] as Input["kind"]; const chain = ctx.match[2]; const wallet = ctx.match[3];
    const d = o.deps(chain, wallet);
    const asset = d ? assets(d).find((a) => a.code === (kind === "bridge" ? "native" : ctx.match[4])) : null;
    const destination = o.chains.find((c) => c.key === ctx.match[4]);
    if (!d || !asset || (kind === "bridge" && (!destination || destination.key === chain))) { await ctx.answerCallbackQuery("钱包、币种或链不可用"); return; }
    input = { kind, chain, wallet, asset, output: kind === "swap" ? assets(d).find((a) => a.code !== asset.code) : undefined, destination, expires: Date.now() + 5 * 60_000 };
    await ctx.answerCallbackQuery();
    await reply(ctx, [`${o.logos.chain(d.chain)} · <code>${d.clients.account.address}</code>`, kind === "transfer" ? "直接发送收款地址（完整的 0x 地址）。" : `直接发送支出金额，单位 ${asset.symbol}。`, "发送“取消”退出，5 分钟内有效。"], cancelled());
  });
  bot.callbackQuery(/^funds:confirm:([0-9a-f]{16})$/, async (ctx) => {
    const p = pending;
    if (!p || p.id !== ctx.match[1] || p.expires <= Date.now()) { await ctx.answerCallbackQuery("确认已过期或已处理，请重新操作"); return; }
    clear(); await ctx.answerCallbackQuery("正在处理…");
    await execute(ctx, p);
  });
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery || ctx.message?.text?.startsWith("/")) { clear(); await next(); return; }
    const p = input;
    if (!p || !ctx.message?.text) { await next(); return; }
    if (p.expires <= Date.now()) { clear(); await ctx.reply("输入已超时，请重新打开资金管理"); return; }
    const text = ctx.message.text.trim();
    if (/^(取消|cancel)$/i.test(text)) { clear(); await reply(ctx, ["已取消当前输入。"], back()); return; }
    if (p.kind === "transfer" && !p.recipient) {
      if (!isAddress(text) || /^0x0{40}$/i.test(text)) { await ctx.reply("请输入完整有效的收款地址，或发送“取消”。"); return; }
      if (text.toLowerCase() === o.deps(p.chain, p.wallet)!.clients.account.address.toLowerCase()) { await ctx.reply("收款地址与当前钱包相同，请核对后重新输入。"); return; }
      input = { ...p, recipient: text as Address };
      await ctx.reply(`直接发送转出金额，单位 ${p.asset.symbol}。发送“取消”退出。`); return;
    }
    const amount = parseAssetAmount(text, p.asset.decimals);
    if (!amount) { await ctx.reply(`请输入大于 0 的 ${p.asset.symbol} 金额，最多 ${p.asset.decimals} 位小数，或发送“取消”。`); return; }
    input = null; const v = revision;
    try { await preview(ctx, p, amount, v); }
    catch (e) { if (revision === v) await reply(ctx, [`未生成可提交的确认页：${escapeHtml(errMsg(e))}`], back()); }
  });
  return clear;
}
