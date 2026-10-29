import { randomBytes } from "node:crypto";
import { InlineKeyboard, InputFile } from "grammy";
import type { Bot, Context } from "grammy";
import { parseUnits } from "viem";
import type { SolanaWallet } from "./sol-wallet.ts";
import { holdings, isSolanaAddress, mintInfo, quote, SOL_MINT, tokenMeta } from "./sol-chain.ts";
import type { Quote, SolRpc } from "./sol-chain.ts";
import type { State } from "./state.ts";
import type { Journal } from "./journal.ts";
import { calculatePnl, floatingPnl, unrecoveredPrincipal } from "./pnl.ts";
import { renderPnlCard, type PnlCard } from "./pnl-card.ts";
import { reconcileSol } from "./sol-ledger.ts";
import { serial } from "./sol-trade.ts";
import { SOL_USDC, swapSolAssets, transferSolAsset } from "./sol-funds.ts";
import { errMsg, escapeHtml, fmtUnits } from "./util.ts";
import { solSettings } from "./sol-settings.ts";

type Options = { state: State; rpc: SolRpc; wallet: Pick<SolanaWallet, "address" | "signer">; journal: Journal };
type Pending = { kind: "transfer" | "swap"; mint: string; recipient?: string; output?: string; amount: bigint; quote?: Quote; expires: number; version: string; owner: string };
const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;
const kbHome = () => new InlineKeyboard().text("返回首页", "nav:start");
export function registerSolFinance(bot: Bot, o: Options) {
  let input: "transfer" | "swap" | null = null; let inputExpires = 0;
  const pending = new Map<string, Pending>();
  const version = () => JSON.stringify(o.state.chainSettings("sol"));
  const selected = () => o.state.activeChain === "sol";
  const clear = () => { input = null; };
  const reply = (ctx: Context, text: string, kb?: InlineKeyboard) => ctx.reply(text, { ...HTML, reply_markup: kb ?? kbHome() });
  async function funds(ctx: Context) {
    await reply(ctx, "<b>转账 / 兑换 / 跨链</b>\n当前链：Solana\n转账与兑换提交前都要确认。新建代币账户可能另收租金。", new InlineKeyboard().text("转账", "sfin:transfer").text("SOL ↔ USDC", "sfin:swap").row().text("跨链", "sbridge:home").text("返回首页", "nav:start"));
  }
  async function history(ctx: Context) {
    await reconcileSol(o.journal, o.rpc);
    const entries = o.journal.entries("main", "sol").slice(0, 12);
    const labels = { buy: "买入", sell: "卖出", swap: "兑换", transfer: "转账", bridge: "跨链", approve: "授权" };
    const statuses = { preparing: "准备中", pending: "待确认", unknown: "待核对", confirmed: "已确认", failed: "失败" };
    await reply(ctx, ["<b>Solana 交易记录</b>", ...(entries.length ? entries.map((e) => `${labels[e.kind]} · ${statuses[e.status]}\n${e.signature ? `<a href="https://solscan.io/tx/${escapeHtml(e.signature)}">查看交易</a>` : "尚无交易编号"}${e.gasCost ? ` · 费用 ${fmtUnits(BigInt(e.gasCost), 9, 8)} SOL` : ""}`) : ["暂无记录。旧版本未记下的成交不会补造成本。"] )].join("\n\n"));
  }
  async function snapshot(): Promise<PnlCard> {
    const owner = o.wallet.address(); if (!owner) throw new Error("请先生成 Solana 钱包");
    await reconcileSol(o.journal, o.rpc);
    const report = calculatePnl(o.journal.entries("main", "sol"));
    const balances = (await holdings(o.rpc, owner)).filter((h) => h.mint !== SOL_MINT);
    let floating = 0n; let floatingUnknown = 0; let principal: bigint | null = 0n;
    const rows = [];
    for (const h of balances.slice(0, 10)) {
      const q = await quote(h.mint, SOL_MINT, h.amount, solSettings(o.state).sellSlippageBps).catch(() => null);
      const book = report.books.get(h.mint); const profit = floatingPnl(book, h.amount, q ? BigInt(q.outAmount) : null); const capital = unrecoveredPrincipal(book, h.amount);
      if (profit === null) floatingUnknown++; else floating += profit;
      if (capital === null) principal = null; else if (principal !== null) principal += capital;
      const meta = await tokenMeta(h.mint); rows.push({ symbol: meta?.symbol ?? `${h.mint.slice(0, 4)}…${h.mint.slice(-4)}`, profit, principal: capital });
    }
    if (balances.length > 10) { floatingUnknown += balances.length - 10; principal = null; }
    return { chainLabel: "Solana", nativeSymbol: "SOL", nativeDecimals: 9, wallet: owner,
      time: new Intl.DateTimeFormat("zh-CN", { timeZone: o.state.display.timeZone, dateStyle: "short", timeStyle: "short", hour12: o.state.display.hour12 }).format(new Date()),
      realized: report.realized, realizedTrades: report.realizedTrades, estimated: report.estimated, floating, floatingUnknown, principal, gas: report.gas, feeComplete: report.feeComplete,
      rows, omitted: Math.max(0, balances.length - 10) };
  }
  async function positions(ctx: Context, image = false) {
    const card = await snapshot();
    if (image) { await ctx.replyWithPhoto(new InputFile(renderPnlCard(card), "solana-pnl.png"), { caption: "Solana 盈亏；费用单列，报价不代表成交，未知成本不计入收益。" }); return; }
    const signed = (n: bigint) => `${n >= 0 ? "+" : ""}${fmtUnits(n, 9, 6)} SOL`;
    await reply(ctx, ["<b>持仓与盈亏 · Solana</b>", `已实现：${card.realizedTrades ? signed(card.realized) : "暂无可核对卖出"}`,
      `浮动合计：${signed(card.floating)}${card.floatingUnknown ? `（另有 ${card.floatingUnknown} 项未知）` : ""}`,
      `已记录费用：${fmtUnits(card.gas, 9, 8)} SOL${card.feeComplete ? "" : "（部分缺失）"}`,
      ...card.rows.map((r) => `${escapeHtml(r.symbol)}：${r.profit === null ? "成本或报价未知" : signed(r.profit)}`),
      "费用单列，未从收益扣除；外部转入或旧版未记录的成本显示未知。"].join("\n"), new InlineKeyboard().text("刷新", "sfin:positions").text("盈亏图片", "sfin:image").row().text("代币持仓 / 卖出", "sol:hold").text("返回首页", "nav:start"));
  }
  bot.callbackQuery(/^sfin:(home|transfer|swap|positions|image|history|ok:[a-f0-9]{16}|no:[a-f0-9]{16})$/, async (ctx) => {
    clear(); await ctx.answerCallbackQuery();
    if (!selected()) { pending.clear(); await reply(ctx, "请先切换到 Solana，旧页面不能跨链操作。"); return; }
    const action = ctx.match[1]!;
    try {
      if (action === "home") return void await funds(ctx);
      if (action === "history") return void await history(ctx);
      if (action === "positions" || action === "image") return void await positions(ctx, action === "image");
      if (action === "transfer" || action === "swap") {
        if (!o.wallet.address()) throw new Error("请先生成 Solana 钱包");
        input = action; inputExpires = Date.now() + 300000;
        await reply(ctx, action === "transfer" ? "直接回复：币种 收款地址 金额\n例如：SOL 地址 0.01\n币种也可以填 SPL 代币地址。" : "直接回复要付出的币和金额，例如 SOL 0.01 或 USDC 10。\n只做 SOL 与官方 USDC 双向兑换。", new InlineKeyboard().text("取消", "sfin:home")); return;
      }
      const id = action.split(":")[1]!; const p = pending.get(id); pending.delete(id);
      if (!p || action.startsWith("no:")) { await reply(ctx, "已取消，或确认已失效。"); return; }
      const ensure = () => { if (!selected() || p.expires <= Date.now() || version() !== p.version || o.wallet.address() !== p.owner) throw new Error("链、钱包、设置或确认已变化，请重新操作"); };
      ensure(); const signer = await o.wallet.signer();
      const context = { journal: o.journal, policy: () => o.state.chainSettings("sol").execution ?? {} };
      const result = await serial(p.owner, () => { ensure(); return p.kind === "transfer"
        ? transferSolAsset(o.rpc, signer, context, p.recipient!, p.mint, p.amount, ensure)
        : swapSolAssets(o.rpc, signer, context, p.mint, p.output!, p.amount, solSettings(o.state).buySlippageBps, ensure, p.quote); });
      await reply(ctx, `交易已上链${result.entry.status === "confirmed" ? "并记录" : "，成交明细待核对"}。\n<a href="https://solscan.io/tx/${result.signature}">查看交易</a>`);
    } catch (e) { await reply(ctx, escapeHtml(errMsg(e))); }
  });
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text?.trim();
    if (ctx.callbackQuery || text?.startsWith("/") || !selected()) clear();
    if (!input || !text) { await next(); return; }
    try {
      if (Date.now() >= inputExpires) { clear(); throw new Error("输入已过期，请重新点选"); }
      if (/^(取消|cancel)$/i.test(text)) { clear(); await funds(ctx); return; }
      const parts = text.split(/\s+/); const mode = input;
      if (parts.length !== (mode === "transfer" ? 3 : 2)) throw new Error("请按提示用空格分隔币种、地址（转账时）和金额");
      const mint = parts[0]!.toUpperCase() === "SOL" ? SOL_MINT : parts[0]!.toUpperCase() === "USDC" ? SOL_USDC : parts[0]!;
      if (!isSolanaAddress(mint) || (mode === "swap" && mint !== SOL_MINT && mint !== SOL_USDC)) throw new Error("币种无效");
      const recipient = mode === "transfer" ? parts[1] : undefined;
      if (recipient && (!isSolanaAddress(recipient) || recipient === o.wallet.address())) throw new Error("请填写其他钱包的有效 Solana 收款地址");
      const decimals = mint === SOL_MINT ? 9 : (await mintInfo(o.rpc, mint)).decimals;
      const value = parts.at(-1)!;
      if (!new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(value)) throw new Error("金额格式或小数位无效");
      const amount = parseUnits(value, decimals); if (amount <= 0n) throw new Error("金额必须大于 0");
      const owner = o.wallet.address(); if (!owner) throw new Error("请先生成钱包");
      const captured = version(); const output = mode === "swap" ? mint === SOL_MINT ? SOL_USDC : SOL_MINT : undefined;
      const q = output ? await quote(mint, output, amount, solSettings(o.state).buySlippageBps) : undefined;
      if (!selected() || captured !== version() || input !== mode) throw new Error("页面或设置已变化，请重新操作");
      const id = randomBytes(8).toString("hex"); pending.clear(); pending.set(id, { kind: mode, mint, recipient, output, amount, quote: q, version: captured, owner, expires: Date.now() + 60000 }); clear();
      await reply(ctx, [`<b>确认${mode === "transfer" ? "转账" : "兑换"}</b>`, "链：Solana", `钱包：<code>${owner}</code>`, `付出：${value} ${mint === SOL_MINT ? "SOL" : mint === SOL_USDC ? "USDC" : `<code>${mint}</code>`}`,
        recipient ? `收款：<code>${recipient}</code>` : `最少得到：${fmtUnits(BigInt(q!.otherAmountThreshold), output === SOL_MINT ? 9 : 6, 8)} ${output === SOL_MINT ? "SOL" : "USDC"}`,
        `费用上限：${o.state.chainSettings("sol").execution?.maxTxFee ?? "未设"} SOL（另可能有账户租金）`].join("\n"), new InlineKeyboard().text("确认提交", `sfin:ok:${id}`).text("取消", `sfin:no:${id}`));
    } catch (e) { await reply(ctx, escapeHtml(errMsg(e))); }
  });
  return { clear, funds, history, positions };
}
