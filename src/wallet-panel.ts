import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import type { Address } from "viem";
import type { ChainConfig } from "./chains.ts";
import type { JournalEntry } from "./journal.ts";
import { bridgeStatusLabel } from "./bridge.ts";
import type { Logos } from "./logos.ts";
import type { State } from "./state.ts";
import { readToken } from "./token.ts";
import type { TradeDeps } from "./trade.ts";
import { escapeHtml, fmtUnits, shortAddr } from "./util.ts";
import type { WalletProfile } from "./wallets.ts";

type Directory = { list(): WalletProfile[]; create(): WalletProfile };
type Options = {
  state: State; chains: ChainConfig[]; logos: Logos; directory?: Directory;
  list: () => WalletProfile[]; activeWallet: () => string; activeChain: () => string;
  deps: (chain: string, wallet: string) => TradeDeps | undefined;
  onSwitch: () => void; readToken?: typeof readToken;
};
const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;
const ID = "([a-z0-9]{1,4})";
const PAGE_SIZE = 5;
const kindNames: Record<JournalEntry["kind"], string> = { buy: "买入", sell: "卖出", approve: "授权", transfer: "转账", swap: "兑换", bridge: "跨链" };
const statusNames: Record<JournalEntry["status"], string> = { preparing: "提交结果待核对", pending: "链上确认中", confirmed: "链上成功", failed: "链上失败", unknown: "提交结果待核对" };

// 注册在统一的白名单中间件之后。只读菜单没有交易签名入口。
export function registerWalletPanel(bot: Bot, o: Options): void {
  let pending: { id: string; expires: number } | null = null;
  const back = () => new InlineKeyboard().text("钱包列表", "wallet:page:0").text("返回首页", "nav:start");
  const profile = (id: string) => o.list().find((w) => w.id === id);
  const reply = (ctx: Context, lines: string[], kb: InlineKeyboard) => ctx.reply(lines.join("\n"), { ...HTML, reply_markup: kb });
  async function wallets(ctx: Context, page = 0) {
    const list = o.list(); const last = Math.max(0, Math.ceil(list.length / PAGE_SIZE) - 1);
    page = Math.min(page, last);
    const visible = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const active = profile(o.activeWallet())!;
    const kb = new InlineKeyboard();
    for (const w of visible) kb.text(`${w.id === active.id ? "✓ " : ""}${w.label} · ${shortAddr(w.address)}`, `wallet:view:${w.id}`).row();
    if (page > 0) kb.text("上一页", `wallet:page:${page - 1}`);
    if (page < last) kb.text("下一页", `wallet:page:${page + 1}`);
    kb.row();
    if (o.directory) kb.text("创建新钱包", "wallet:create").row();
    kb.text("本地导入钱包", "wallet:import").row().text("交易记录", `history:${active.id}:${o.activeChain()}:0`).text("返回首页", "nav:start");
    await reply(ctx, ["<b>钱包管理</b>", `当前默认：${escapeHtml(active.label)}`, `<code>${active.address}</code>`,
      `共 ${list.length} 个钱包 · 第 ${page + 1}/${last + 1} 页`, "", "点钱包查看余额、充值地址或设为默认。", "之后新发的 CA 使用默认钱包；旧代币卡片仍绑定原钱包。"], kb);
  }
  async function detail(ctx: Context, id: string, created = false) {
    const w = profile(id); if (!w) { await ctx.reply("这个钱包不存在，请重新打开钱包列表"); return; }
    const sections = await Promise.all(o.chains.map(async (c) => {
      const d = o.deps(c.key, id);
      const balance = d ? await d.clients.publicClient.getBalance({ address: w.address }).catch(() => null) : null;
      return `${o.logos.chain(c)}：${balance === null ? "查询失败" : `${fmtUnits(balance, 18, 8)} ${o.logos.native(c)}`}`;
    }));
    const kb = new InlineKeyboard();
    if (id !== o.activeWallet()) kb.text("设为默认钱包", `wallet:select:${id}`).row();
    kb.text("充值地址", `wallet:deposit:${id}`).text("交易记录", `history:${id}:${o.activeChain()}:0`).row()
      .text("刷新余额", `wallet:view:${id}`).row().text("钱包列表", "wallet:page:0").text("返回首页", "nav:start");
    await reply(ctx, [created ? "<b>新钱包已创建</b>" : "<b>钱包详情</b>", `${escapeHtml(w.label)}${id === o.activeWallet() ? "（当前默认）" : ""}`, `<code>${w.address}</code>`, "", ...sections,
      ...(created ? ["", "私钥已保存在本机 .env，请在本地备份；聊天里只显示地址。", "新钱包尚未设为默认，可点下方按钮切换。"] : [])], kb);
  }
  async function deposit(ctx: Context, id: string) {
    const w = profile(id); if (!w) { await ctx.reply("这个钱包不存在"); return; }
    await reply(ctx, ["<b>充值地址</b>", escapeHtml(w.label), `<code>${w.address}</code>`, "", "充值时核对网络：", ...o.chains.map((c) => `${o.logos.chain(c)} · Gas 使用 ${o.logos.native(c)}`), "", "这些链使用相同地址，各链余额独立；充值平台中选择你要使用的那条链。"], new InlineKeyboard().text("返回钱包", `wallet:view:${id}`).text("返回首页", "nav:start"));
  }
  async function history(ctx: Context, wallet: string, chain: string, page: number) {
    const w = profile(wallet); const d = o.deps(chain, wallet);
    if (!w || !d) { await ctx.reply("钱包或交易链不存在，请重新打开交易记录"); return; }
    const all = d.journal?.entries(wallet, chain) ?? [];
    const last = Math.max(0, Math.ceil(all.length / PAGE_SIZE) - 1); page = Math.min(page, last);
    const entries = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const tokens = [...new Set(entries.filter((e) => e.kind === "buy" || e.kind === "sell").flatMap((e) => e.token ? [e.token] : []))];
    const metadata = new Map(await Promise.all(tokens.map(async (token) => [token, await (o.readToken ?? readToken)(d.clients, token as Address).catch(() => null)] as const)));
    const fees = all.filter((e) => e.gasCost !== undefined);
    const gas = fees.reduce((sum, e) => sum + BigInt(e.gasCost!), 0n);
    const lines = ["<b>交易记录</b>", `${escapeHtml(w.label)} · ${o.logos.chain(d.chain)}`, `<code>${w.address}</code>`,
      `已记录 Gas：${fmtUnits(gas, 18, 10)} ${d.chain.nativeSymbol}${fees.some((e) => e.feeComplete !== true) ? "（部分费用不完整）" : ""}`,
      `共 ${all.length} 笔 · 第 ${page + 1}/${last + 1} 页`, "", "只包含启用本地账本后的交易，之前的历史未补录。"];
    if (fees.length < all.length) lines.push(`其中 ${all.length - fees.length} 笔尚无费用记录。`);
    for (const e of entries) {
      const time = new Intl.DateTimeFormat("zh-CN", { timeZone: o.state.display.timeZone, hour12: o.state.display.hour12, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(e.at));
      lines.push("", `<b>${kindNames[e.kind]} · ${e.kind === "bridge" && e.status === "confirmed" ? "来源链成功" : statusNames[e.status]}</b> · ${time}`);
      const m = e.token ? metadata.get(e.token) : null;
      const tokenAmount = (raw: string) => m ? `${fmtUnits(BigInt(raw), m.decimals, 8)} ${escapeHtml(m.symbol.slice(0, 30))}` : "数量精度暂不可查";
      if (e.kind === "buy" && e.amountIn) lines.push(`支出：${fmtUnits(BigInt(e.amountIn), 18, 8)} ${d.chain.nativeSymbol}`);
      if (e.kind === "sell" && e.amountIn) lines.push(`卖出：${tokenAmount(e.amountIn)}`);
      if (e.amountOut && e.kind === "buy") lines.push(`实际到账：${tokenAmount(e.amountOut)}`);
      if (e.amountOut && e.kind === "sell") lines.push(`实际换回：${fmtUnits(BigInt(e.amountOut), 18, 8)} ${d.chain.nativeSymbol}（未扣 Gas）`);
      if (["transfer", "swap", "bridge"].includes(e.kind) && e.amountIn && e.decimals !== undefined) lines.push(`支出：${fmtUnits(BigInt(e.amountIn), e.decimals, 8)} ${escapeHtml(e.symbol ?? "")}`);
      if (e.kind === "swap" && e.amountOut && e.outputDecimals !== undefined) lines.push(`到账${e.amountOutEstimated ? "估算" : ""}：${fmtUnits(BigInt(e.amountOut), e.outputDecimals, 8)} ${escapeHtml(e.outputSymbol ?? "")}`);
      if (e.kind === "bridge") {
        const destination = o.chains.find((c) => c.key === e.destinationChain);
        lines.push(`目标链：${escapeHtml(destination?.label ?? e.destinationChain ?? "未知")}`, `跨链状态：${bridgeStatusLabel(e.bridgeStatus)}`);
        if (e.quotedAmountOut && destination) lines.push(`报价预计到账：${fmtUnits(BigInt(e.quotedAmountOut), 18, 8)} ${destination.nativeSymbol}（非实收记录）`);
        if (e.requestId) lines.push(`请求编号：<code>${escapeHtml(e.requestId)}</code>`);
      }
      if (e.token) lines.push(`CA：<code>${escapeHtml(e.token)}</code>`);
      if (e.recipient) lines.push(`${e.kind === "approve" ? "授权对象" : "收款地址"}：<code>${escapeHtml(e.recipient)}</code>`);
      if (e.gasCost !== undefined) lines.push(`Gas：${fmtUnits(BigInt(e.gasCost), 18, 10)} ${d.chain.nativeSymbol}${e.feeComplete !== true ? "（费用可能不完整）" : ""}`);
      if (e.hash) lines.push(`<a href="${d.chain.explorerTx(e.hash)}">查看链上交易</a>`);
      if (["preparing", "pending", "unknown"].includes(e.status)) lines.push("结果待确认，请先核对链上记录，勿重复提交。");
    }
    if (!entries.length) lines.push("", "这个钱包在本链还没有本地交易记录。");
    const kb = new InlineKeyboard();
    for (const c of o.chains) o.logos.button(kb, c, `${c.key === chain ? "✓ " : ""}${c.label}`, `history:${wallet}:${c.key}:0`).row();
    if (page > 0) kb.text("上一页", `history:${wallet}:${chain}:${page - 1}`);
    if (page < last) kb.text("下一页", `history:${wallet}:${chain}:${page + 1}`);
    kb.row().text("刷新", `history:${wallet}:${chain}:${page}`).text("返回钱包", `wallet:view:${wallet}`);
    await reply(ctx, lines, kb);
  }
  bot.command("wallets", (ctx) => wallets(ctx));
  bot.command("deposit", (ctx) => deposit(ctx, o.activeWallet()));
  bot.command("history", (ctx) => history(ctx, o.activeWallet(), o.activeChain(), 0));
  bot.callbackQuery(/^wallet:page:(\d{1,4})$/, async (ctx) => { await ctx.answerCallbackQuery(); await wallets(ctx, Number(ctx.match[1])); });
  bot.callbackQuery(new RegExp(`^wallet:(view|deposit|select):${ID}$`), async (ctx) => {
    const id = ctx.match[2];
    if (!profile(id)) { await ctx.answerCallbackQuery("这个钱包不存在"); return; }
    if (ctx.match[1] === "select") { o.state.setActiveWallet(id); o.onSwitch(); await ctx.answerCallbackQuery("默认钱包已切换"); }
    else await ctx.answerCallbackQuery();
    if (ctx.match[1] === "deposit") await deposit(ctx, id); else await detail(ctx, id);
  });
  bot.callbackQuery("wallet:create", async (ctx) => {
    if (!o.directory) { await ctx.answerCallbackQuery("当前环境不可创建钱包"); return; }
    pending = { id: randomBytes(8).toString("hex"), expires: Date.now() + 60_000 };
    await ctx.answerCallbackQuery();
    await reply(ctx, ["<b>创建一个新钱包？</b>", "私钥只保存到本机 .env，不在聊天中显示。", "不会转入资金，也不会更换你当前的默认钱包。", "确认在 60 秒内有效。"], new InlineKeyboard().text("确认创建", `wallet:new:${pending.id}`).text("取消", "wallet:cancel"));
  });
  bot.callbackQuery(/^wallet:new:([0-9a-f]{16})$/, async (ctx) => {
    const p = pending; pending = null;
    if (!p || p.id !== ctx.match[1] || p.expires <= Date.now() || !o.directory) { await ctx.answerCallbackQuery("创建确认已过期或已处理"); return; }
    await ctx.answerCallbackQuery();
    let w: WalletProfile;
    try { w = o.directory.create(); } catch { await ctx.reply("新钱包未能保存，请在本地检查配置文件和保存锁；未切换默认钱包。"); return; }
    await detail(ctx, w.id, true);
  });
  bot.callbackQuery("wallet:cancel", async (ctx) => { pending = null; await ctx.answerCallbackQuery("已取消"); await wallets(ctx); });
  bot.callbackQuery("wallet:import", async (ctx) => {
    await ctx.answerCallbackQuery();
    await reply(ctx, ["<b>本地导入钱包</b>", "在项目终端执行：", "<code>npm run wallet:import</code>", "按提示粘贴私钥，输入内容隐藏；导入后重启机器人。", "请在终端输入，勿把私钥发到 Telegram。"], back());
  });
  bot.callbackQuery(new RegExp(`^history:${ID}:([a-z]+):(\\d{1,4})$`), async (ctx) => {
    await ctx.answerCallbackQuery(); await history(ctx, ctx.match[1], ctx.match[2], Number(ctx.match[3]));
  });
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery || ctx.message?.text?.startsWith("/")) pending = null;
    await next();
  });
}
