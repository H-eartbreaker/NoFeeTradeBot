import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { isAddress, maxUint256 } from "viem";
import type { Address } from "viem";
import { allowanceOf, knownSpenders, revokeAllowance, revokeBudget } from "./allowances.ts";
import type { ChainConfig } from "./chains.ts";
import { getRoute, NATIVE } from "./kyber.ts";
import type { Logos } from "./logos.ts";
import type { State } from "./state.ts";
import { readToken } from "./token.ts";
import { PendingTransactionError } from "./trade.ts";
import type { TradeDeps } from "./trade.ts";
import { errMsg, escapeHtml, fmtUnits, shortAddr } from "./util.ts";

const defaults = { allowanceOf, knownSpenders, revokeAllowance, revokeBudget, readToken, getRoute };
type Options = { state: State; chains: ChainConfig[]; logos: Logos; activeChain: () => string; activeWallet: () => string; deps: (chain: string, wallet: string) => TradeDeps | undefined };
type Scope = { chain: string; wallet: string; token: Address; spenders: Address[]; expires: number };
type Pending = { id: string; chain: string; wallet: string; token: Address; spender: Address; owner: Address; expires: number; budget: bigint };
const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;
export function registerApprovals(bot: Bot, o: Options, overrides: Partial<typeof defaults> = {}): () => void {
  const s = { ...defaults, ...overrides }; let pending: Pending | null = null; let revision = 0;
  const contexts = new Map<string, Scope>();
  const clear = () => { pending = null; revision++; };
  const back = () => new InlineKeyboard().text("授权管理", `auth:list:${o.activeChain()}:${o.activeWallet()}:0`).text("返回首页", "nav:start");
  const reply = (ctx: Context, lines: string[], kb: InlineKeyboard) => ctx.reply(lines.join("\n"), { ...HTML, reply_markup: kb });
  async function list(ctx: Context, chain: string, wallet: string, requestedPage: number) {
    const d = o.deps(chain, wallet); if (!d) { await ctx.reply("钱包或链不可用"); return; }
    const recorded = d.journal?.entries(wallet, chain).flatMap((e) => e.kind === "approve" && e.token && isAddress(e.token) ? [e.token.toLowerCase()] : []) ?? [];
    const tokens = [...new Set([...o.state.tokens(chain, wallet), ...recorded])].filter((t) => t !== NATIVE);
    const last = Math.max(0, Math.ceil(tokens.length / 5) - 1); const page = Math.min(requestedPage, last);
    const kb = new InlineKeyboard();
    for (const token of tokens.slice(page * 5, page * 5 + 5)) {
      const info = await s.readToken(d.clients, token as Address).catch(() => null);
      kb.text(`${info?.symbol.slice(0, 16) ?? "代币"} · ${shortAddr(token)}`, `auth:token:${chain}:${wallet}:${token}`).row();
    }
    for (const c of o.chains) o.logos.button(kb, c, c.label, `auth:list:${c.key}:${wallet}:0`).row();
    if (page > 0) kb.text("上一页", `auth:list:${chain}:${wallet}:${page - 1}`);
    if (page < last) kb.text("下一页", `auth:list:${chain}:${wallet}:${page + 1}`);
    kb.row().text("返回首页", "nav:start");
    await reply(ctx, ["<b>授权管理</b>", `链：${o.logos.chain(d.chain)}`, `钱包：<code>${d.clients.account.address}</code>`, `已跟踪代币第 ${page + 1}/${last + 1} 页`, "", "点代币查询本地记录中的授权对象，以及当前 Kyber 路由的链上额度。", "此页不代表钱包全部授权；旧路由、其他应用及 Permit2 等授权可能不在此范围。", ...(tokens.length ? [] : ["", "暂无已跟踪代币或授权记录。"])], kb);
  }
  async function show(ctx: Context, id: string, page: number) {
    const p = contexts.get(id); const d = p ? o.deps(p.chain, p.wallet) : undefined;
    if (!p || p.expires <= Date.now() || !d) { await ctx.reply("授权查询已过期，请重新打开"); return; }
    const info = await s.readToken(d.clients, p.token).catch(() => null);
    const last = Math.max(0, Math.ceil(p.spenders.length / 5) - 1); page = Math.min(page, last);
    const lines = ["<b>链上授权额度</b>", `链：${o.logos.chain(d.chain)}`, `钱包：<code>${d.clients.account.address}</code>`, `代币：${escapeHtml(info?.symbol.slice(0, 30) ?? "未知")}`, `CA：<code>${p.token}</code>`, `授权对象第 ${page + 1}/${last + 1} 页`];
    const kb = new InlineKeyboard();
    for (const [n, spender] of p.spenders.slice(page * 5, page * 5 + 5).entries()) {
      const value = await s.allowanceOf(d, p.token, spender).catch(() => null);
      const amount = value === null ? "查询失败" : value === 0n ? "未授权" : value === maxUint256 ? "无限额度" : info ? `${fmtUnits(value, info.decimals, info.decimals)} ${escapeHtml(info.symbol.slice(0, 30))}` : `${value} 原始单位`;
      lines.push("", `对象：<code>${spender}</code>`, `当前额度：${amount}`);
      if (value !== null && value > 0n) kb.text(`撤销 ${shortAddr(spender)}`, `auth:prepare:${id}:${page * 5 + n}`).row();
    }
    if (!p.spenders.length) lines.push("", "本地没有找到授权对象，当前路由也暂不可查；这不代表钱包没有其他授权。");
    if (page > 0) kb.text("上一页", `auth:page:${id}:${page - 1}`); if (page < last) kb.text("下一页", `auth:page:${id}:${page + 1}`);
    kb.row().text("刷新", `auth:page:${id}:${page}`).text("返回授权管理", `auth:list:${p.chain}:${p.wallet}:0`);
    await reply(ctx, lines, kb);
  }
  bot.command("approvals", async (ctx) => { clear(); await list(ctx, o.activeChain(), o.activeWallet(), 0); });
  bot.callbackQuery(/^auth:list:([a-z]+):([a-z0-9]{1,4}):(\d{1,4})$/, async (ctx) => { clear(); await ctx.answerCallbackQuery(); await list(ctx, ctx.match[1], ctx.match[2], Number(ctx.match[3])); });
  bot.callbackQuery(/^auth:token:([a-z]+):([a-z0-9]{1,4}):(0x[0-9a-f]{40})$/, async (ctx) => {
    clear(); const v = revision; const d = o.deps(ctx.match[1], ctx.match[2]); if (!d) { await ctx.answerCallbackQuery("钱包或链不可用"); return; }
    await ctx.answerCallbackQuery(); const token = ctx.match[3] as Address;
    const spenders = s.knownSpenders(d, token);
    const info = await s.readToken(d.clients, token).catch(() => null);
    if (info) {
      const route = await s.getRoute(d.chain.kyberSlug!, token, NATIVE, info.balance > 0n ? info.balance : 10n ** BigInt(Math.min(info.decimals, 18))).catch(() => null);
      if (route && isAddress(route.routerAddress)) spenders.push(route.routerAddress.toLowerCase() as Address);
    }
    if (v !== revision) return;
    for (const [id, p] of contexts) if (p.expires <= Date.now()) contexts.delete(id);
    if (contexts.size >= 100) contexts.delete(contexts.keys().next().value!);
    const id = randomBytes(8).toString("hex"); contexts.set(id, { chain: d.chain.key, wallet: ctx.match[2], token, spenders: [...new Set(spenders)], expires: Date.now() + 300000 }); await show(ctx, id, 0);
  });
  bot.callbackQuery(/^auth:page:([0-9a-f]{16}):(\d{1,4})$/, async (ctx) => { clear(); await ctx.answerCallbackQuery(); await show(ctx, ctx.match[1], Number(ctx.match[2])); });
  bot.callbackQuery(/^auth:prepare:([0-9a-f]{16}):(\d{1,4})$/, async (ctx) => {
    clear(); const v = revision; const p = contexts.get(ctx.match[1]); const spender = p?.spenders[Number(ctx.match[2])]; const d = p ? o.deps(p.chain, p.wallet) : undefined;
    if (!p || p.expires <= Date.now() || !spender || !d) { await ctx.answerCallbackQuery("授权查询已过期"); return; }
    await ctx.answerCallbackQuery();
    try {
      if (await s.allowanceOf(d, p.token, spender) === 0n) { await ctx.reply("当前额度已经是零，无需撤销"); return; }
      const budget = await s.revokeBudget(d, p.token, spender);
      if (budget <= 0n || await d.clients.publicClient.getBalance({ address: d.clients.account.address }) < budget) throw new Error("Gas 余额或预算不足");
      if (v !== revision) return;
      const id = randomBytes(8).toString("hex"); pending = { id, chain: p.chain, wallet: p.wallet, token: p.token, spender, owner: d.clients.account.address, expires: Date.now() + 60000, budget };
      await reply(ctx, ["<b>确认撤销授权</b>", `链：${o.logos.chain(d.chain)}`, `钱包：<code>${d.clients.account.address}</code>`, `代币 CA：<code>${p.token}</code>`, `授权对象：<code>${spender}</code>`,
        "授权额度改为：0", `执行 Gas 预算：${fmtUnits(budget, 18, 10)} ${d.chain.nativeSymbol}`,
        ...(["base", "rh"].includes(p.chain) ? ["另有 L1 数据费，不在执行 Gas 预算中。"] : []),
        "撤销会产生 Gas，之后通过该对象卖出可能需要重新授权。60 秒内有效。"], new InlineKeyboard().text("确认撤销", `auth:confirm:${id}`).text("取消", "auth:cancel"));
    } catch (e) { if (v === revision) { pending = null; await ctx.reply(`撤销确认未生成：${errMsg(e)}`); } }
  });
  bot.callbackQuery(/^auth:confirm:([0-9a-f]{16})$/, async (ctx) => {
    const p = pending;
    if (!p || p.id !== ctx.match[1] || p.expires <= Date.now()) { await ctx.answerCallbackQuery("撤销确认已过期或已处理"); return; }
    clear(); await ctx.answerCallbackQuery("正在撤销…"); const d = o.deps(p.chain, p.wallet);
    if (!d || d.clients.account.address !== p.owner) { await ctx.reply("钱包已改变，请重新确认"); return; }
    let text: string;
    try {
      const r = await s.revokeAllowance(d, p.token, p.spender, p.expires, p.budget);
      text = r.verified ? "✅ 链上已核对，该对象的授权额度为零。" : "⚠️ 撤销交易已上链，但额度尚未确认归零，请刷新查询并核对。";
      if (r.hash) text += `\n<a href="${d.chain.explorerTx(r.hash)}">查看交易</a>`;
    } catch (e) { text = `${e instanceof PendingTransactionError ? "⚠️" : "❌ 撤销未完成："}${escapeHtml(errMsg(e))}`; }
    await reply(ctx, [text], back()).catch(() => console.error("授权操作通知失败，请核对交易记录"));
  });
  bot.callbackQuery("auth:cancel", async (ctx) => { clear(); await ctx.answerCallbackQuery("已取消"); await reply(ctx, ["已取消撤销确认。"], back()); });
  return clear;
}
