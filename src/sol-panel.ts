import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { SolanaWallet } from "./sol-wallet.ts";
import { holdings, isSolanaAddress, mintInfo, openRpc, solBalance, SOL_DECIMALS, tokenMeta } from "./sol-chain.ts";
import type { MintInfo, SolRpc, TokenMeta } from "./sol-chain.ts";
import { buySol, serial, SolPendingError, sellToken, SolTradeError } from "./sol-trade.ts";
import type { State } from "./state.ts";
import { errMsg, escapeHtml, fmtUnits, parseSlippageInput } from "./util.ts";

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;
const BASE58_MINT = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const BASE58_LIKE = new RegExp(`^${BASE58_MINT}$`);
const PRESETS: { lamports: bigint; label: string }[] = [
  { lamports: 10_000_000n, label: "0.01 SOL" },
  { lamports: 50_000_000n, label: "0.05 SOL" },
  { lamports: 100_000_000n, label: "0.1 SOL" },
];
const MAX_CUSTOM = 100n * 10n ** 9n;
const INPUT_MS = 5 * 60_000;
const CONFIRM_MS = 60_000;
const MAX_PENDING = 50;
const MAX_HOLDINGS_SHOWN = 10;

type Pending =
  | { kind: "buy"; mint: string; symbol: string; decimals: number; lamports: bigint; slippageBps: number; expires: number }
  | { kind: "sell"; mint: string; symbol: string; decimals: number; pct: 25 | 50 | 100; slippageBps: number; expires: number };

type Input =
  | { kind: "slip"; expires: number }
  | { kind: "custom"; mint: string; expires: number };

type Options = { state: State; rpcUrl: string };
type DistributiveOmit<T> = T extends unknown ? Omit<T, "expires"> : never;

function parseSol(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(text);
  if (!m) return null;
  const lamports = BigInt(m[1] ?? "0") * 10n ** 9n + BigInt((m[2] ?? "").padEnd(9, "0"));
  return lamports > 0n && lamports <= MAX_CUSTOM ? lamports : null;
}

const shortMint = (mint: string) => `${mint.slice(0, 4)}…${mint.slice(-4)}`;
const solscan = (sig: string) => `https://solscan.io/tx/${sig}`;

// 第一版只做买卖和持仓：不做止盈止损、订单和追踪，也不做蜜罐检测
export function registerSolana(bot: Bot, o: Options): () => void {
  const wallet = new SolanaWallet();
  const rpc: SolRpc = openRpc(o.rpcUrl);
  const pending = new Map<string, Pending>();
  const metaCache = new Map<string, TokenMeta>();
  let input: Input | null = null;
  const clear = () => { input = null; };
  const reply = (ctx: Context, text: string, kb?: InlineKeyboard) => ctx.reply(text, { ...HTML, reply_markup: kb });
  const homeKb = () => new InlineKeyboard().text("Solana 交易", "sol:home").text("返回首页", "nav:start");

  async function symbolOf(mint: string): Promise<{ symbol: string; name: string }> {
    const cached = metaCache.get(mint);
    if (cached) return cached;
    const meta = await tokenMeta(mint);
    if (meta) metaCache.set(mint, meta);
    return meta ?? { symbol: shortMint(mint), name: "未知名称" };
  }

  function createPending(item: DistributiveOmit<Pending>): string {
    const now = Date.now();
    for (const [id, p] of pending) if (p.expires <= now) pending.delete(id);
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
    const id = randomBytes(8).toString("hex");
    pending.set(id, { ...item, expires: now + CONFIRM_MS } as Pending);
    return id;
  }

  async function home(ctx: Context) {
    const addr = wallet.address();
    if (!addr) {
      await reply(ctx, [
        "<b>Solana 交易</b>",
        "还没有 Solana 钱包。",
        "点「生成钱包」后，机器人在本机创建钱包。私钥只写入本地 .env（权限 600），不会发到 Telegram。",
        "生成后先向这个地址转入 SOL，再买卖。",
      ].join("\n"), new InlineKeyboard().text("生成钱包", "sol:gen").text("返回首页", "nav:start"));
      return;
    }
    let balance = "读取失败，请稍后刷新";
    try { balance = `${fmtUnits(await solBalance(rpc, addr), SOL_DECIMALS, 6)} SOL`; }
    catch (e) { console.log("Solana 余额读取失败:", errMsg(e)); }
    const lines = [
      "<b>Solana 交易</b>（第一版：买卖 + 持仓）",
      `钱包：<code>${addr}</code>`,
      `SOL 余额：${escapeHtml(balance)}`,
      `滑点：${o.state.solanaSlippageBps / 100}%`,
      "",
      "发送 Solana 代币地址（Mint），会弹出买卖卡片。",
      "止盈止损、订单和追踪暂不支持 Solana。",
    ];
    await reply(ctx, lines.join("\n"), new InlineKeyboard().text("持仓", "sol:hold").text("滑点", "sol:slip").row().text("刷新", "sol:home").text("返回首页", "nav:start"));
  }

  async function hold(ctx: Context) {
    const addr = wallet.address();
    if (!addr) { await reply(ctx, "还没有 Solana 钱包，请先生成。", homeKb()); return; }
    const list = (await holdings(rpc, addr)).filter((h) => h.amount > 0n);
    if (!list.length) { await reply(ctx, "当前没有 Solana 代币持仓。", homeKb()); return; }
    const shown = list.slice(0, MAX_HOLDINGS_SHOWN);
    const metas = await Promise.all(shown.map((h) => symbolOf(h.mint)));
    const lines = ["<b>Solana 持仓</b>", ""];
    const kb = new InlineKeyboard();
    shown.forEach((h, i) => {
      const symbol = metas[i]?.symbol ?? shortMint(h.mint);
      lines.push(`${i + 1}. ${escapeHtml(symbol)} ${fmtUnits(h.amount, h.decimals, 4)}`);
      kb.text(`查看：${symbol}`, `sol:card:${h.mint}`).row();
    });
    if (list.length > shown.length) lines.push("", `仅显示前 ${shown.length} 个，共 ${list.length} 个。`);
    kb.text("返回 Solana", "sol:home").text("返回首页", "nav:start");
    await reply(ctx, lines.join("\n"), kb);
  }

  async function card(ctx: Context, mint: string) {
    const addr = wallet.address();
    if (!addr) { await reply(ctx, "还没有 Solana 钱包，请先生成。", homeKb()); return; }
    let info: MintInfo;
    try { info = await mintInfo(rpc, mint); }
    catch (e) { await reply(ctx, escapeHtml(errMsg(e)), homeKb()); return; }
    const [meta, held] = await Promise.all([
      symbolOf(mint),
      holdings(rpc, addr).then((list) => list.find((h) => h.mint === mint)),
    ]);
    const heldText = held && held.amount > 0n ? `${fmtUnits(held.amount, info.decimals, 6)} ${escapeHtml(meta.symbol)}` : "无";
    const lines = [
      "<b>Solana 代币</b>",
      `代币：${escapeHtml(meta.name)}（${escapeHtml(meta.symbol)}）`,
      `地址：<code>${mint}</code>`,
      `精度：${info.decimals}`,
      `增发权限：${info.mintAuthority ? "未放弃，发行方仍可增发" : "已放弃"}`,
      `冻结权限：${info.freezeAuthority ? "存在，发行方可冻结账户" : "无"}`,
      "蜜罐检测：Solana 暂不支持，未检查",
      `你的持仓：${heldText}`,
    ];
    const kb = new InlineKeyboard();
    for (const p of PRESETS.map((x, i) => ({ ...x, i }))) kb.text(`买入 ${p.label}`, `sol:b:${mint}:${p.i}`);
    kb.row().text("自定义买入", `sol:cb:${mint}`).row();
    if (held && held.amount > 0n) {
      kb.text("卖出 25%", `sol:s:${mint}:25`).text("卖出 50%", `sol:s:${mint}:50`).text("卖出 100%", `sol:s:${mint}:100`).row();
    }
    kb.text("刷新", `sol:card:${mint}`).text("持仓", "sol:hold").row().text("返回 Solana", "sol:home").text("返回首页", "nav:start");
    await reply(ctx, lines.join("\n"), kb);
  }

  async function askBuy(ctx: Context, mint: string, lamports: bigint) {
    const addr = wallet.address();
    if (!addr) { await reply(ctx, "还没有 Solana 钱包，请先生成。", homeKb()); return; }
    let info: MintInfo;
    try { info = await mintInfo(rpc, mint); }
    catch (e) { await reply(ctx, escapeHtml(errMsg(e)), homeKb()); return; }
    const meta = await symbolOf(mint);
    const slippageBps = o.state.solanaSlippageBps;
    const id = createPending({ kind: "buy", mint, symbol: meta.symbol, decimals: info.decimals, lamports, slippageBps });
    const lines = [
      "<b>确认买入（Solana）</b>",
      "链：Solana",
      `代币：${escapeHtml(meta.name)}（${escapeHtml(meta.symbol)}）`,
      `地址：<code>${mint}</code>`,
      `金额：${fmtUnits(lamports, SOL_DECIMALS, 9)} SOL`,
      `滑点：${slippageBps / 100}%`,
      "",
      "确认后会按当时报价立即发送交易，发出后不能撤回。60 秒内有效。",
    ];
    await reply(ctx, lines.join("\n"), new InlineKeyboard().text("确认买入", `sol:ok:${id}`).text("取消", `sol:no:${id}`));
  }

  async function askSell(ctx: Context, mint: string, pct: 25 | 50 | 100) {
    const addr = wallet.address();
    if (!addr) { await reply(ctx, "还没有 Solana 钱包，请先生成。", homeKb()); return; }
    let info: MintInfo;
    try { info = await mintInfo(rpc, mint); }
    catch (e) { await reply(ctx, escapeHtml(errMsg(e)), homeKb()); return; }
    const held = (await holdings(rpc, addr)).find((h) => h.mint === mint);
    if (!held || held.amount <= 0n) { await reply(ctx, "当前钱包没有这个代币的余额。", homeKb()); return; }
    const meta = await symbolOf(mint);
    const amount = pct === 100 ? held.amount : (held.amount * BigInt(pct)) / 100n;
    const slippageBps = o.state.solanaSlippageBps;
    const id = createPending({ kind: "sell", mint, symbol: meta.symbol, decimals: info.decimals, pct, slippageBps });
    const lines = [
      "<b>确认卖出（Solana）</b>",
      "链：Solana",
      `代币：${escapeHtml(meta.name)}（${escapeHtml(meta.symbol)}）`,
      `地址：<code>${mint}</code>`,
      `数量：${pct}% 持仓，约 ${fmtUnits(amount, info.decimals, 6)} ${escapeHtml(meta.symbol)}`,
      `滑点：${slippageBps / 100}%`,
      "",
      "执行时按当时余额和报价计算，确认后立即发送，发出后不能撤回。60 秒内有效。",
    ];
    await reply(ctx, lines.join("\n"), new InlineKeyboard().text("确认卖出", `sol:ok:${id}`).text("取消", `sol:no:${id}`));
  }

  async function execute(ctx: Context, p: Pending) {
    const addr = wallet.address();
    if (!addr) { await reply(ctx, "还没有 Solana 钱包，请先生成。", homeKb()); return; }
    const signer = await wallet.signer();
    await reply(ctx, p.kind === "buy" ? "已提交买入，等待链上确认（最长约 2 分钟）…" : "已提交卖出，等待链上确认（最长约 2 分钟）…");
    try {
      const result = await serial(addr, () => (p.kind === "buy"
        ? buySol(rpc, signer, p.mint, p.lamports, p.slippageBps)
        : sellToken(rpc, signer, p.mint, p.pct, p.slippageBps)));
      const out = BigInt(result.quote.outAmount);
      const got = p.kind === "buy" ? `预计得到 ${fmtUnits(out, p.decimals, 6)} ${escapeHtml(p.symbol)}` : `预计得到 ${fmtUnits(out, SOL_DECIMALS, 6)} SOL`;
      await reply(ctx, `✅ ${p.kind === "buy" ? "买入" : "卖出"}成功（Solana）\n${got}\n交易：<a href="${solscan(result.signature)}">查看 Solscan</a>`, homeKb());
    } catch (e) {
      if (e instanceof SolPendingError) {
        await reply(ctx, `⏳ 交易已发出，但等待时间内没有查到确认结果。\n签名：<code>${e.signature}</code>\n<a href="${solscan(e.signature)}">在 Solscan 查看</a>\n机器人不会自动重发，请以 Solscan 结果为准。`, homeKb());
        return;
      }
      const message = e instanceof SolTradeError ? e.message : errMsg(e);
      await reply(ctx, `❌ ${escapeHtml(message)}`, homeKb());
    }
  }

  bot.command("sol", async (ctx) => { clear(); await home(ctx); });

  bot.callbackQuery("sol:home", async (ctx) => { clear(); await ctx.answerCallbackQuery(); await home(ctx); });
  bot.callbackQuery("sol:hold", async (ctx) => { clear(); await ctx.answerCallbackQuery(); await hold(ctx); });
  bot.callbackQuery("sol:slip", async (ctx) => {
    input = { kind: "slip", expires: Date.now() + INPUT_MS };
    await ctx.answerCallbackQuery();
    await reply(ctx, `当前 Solana 滑点 ${o.state.solanaSlippageBps / 100}%。发送新的百分比，例如 1 表示 1%（0.01 到 99.99）。发送“取消”退出。`);
  });
  bot.callbackQuery("sol:gen", async (ctx) => {
    clear(); await ctx.answerCallbackQuery();
    if (wallet.address()) { await home(ctx); return; }
    await reply(ctx, "将在本机生成新的 Solana 钱包。私钥只写入本地 .env（权限 600），不会发到 Telegram。生成后请向地址转入 SOL。", new InlineKeyboard().text("确认生成", "sol:genok").text("取消", "sol:home"));
  });
  bot.callbackQuery("sol:genok", async (ctx) => {
    clear(); await ctx.answerCallbackQuery();
    try {
      const address = wallet.generate();
      await reply(ctx, `已生成 Solana 钱包：<code>${address}</code>\n私钥只保存在本地 .env（权限 600），不会在 Telegram 显示。\n请先向这个地址转入 SOL，再买卖。`, homeKb());
    } catch (e) {
      await reply(ctx, escapeHtml(errMsg(e)), homeKb());
    }
  });
  bot.callbackQuery(new RegExp(`^sol:card:(${BASE58_MINT})$`), async (ctx) => {
    clear(); await ctx.answerCallbackQuery(); await card(ctx, ctx.match[1]!);
  });
  bot.callbackQuery(new RegExp(`^sol:b:(${BASE58_MINT}):([0-2])$`), async (ctx) => {
    clear(); await ctx.answerCallbackQuery();
    const preset = PRESETS[Number(ctx.match[2])];
    if (!preset) return;
    await askBuy(ctx, ctx.match[1]!, preset.lamports);
  });
  bot.callbackQuery(new RegExp(`^sol:cb:(${BASE58_MINT})$`), async (ctx) => {
    input = { kind: "custom", mint: ctx.match[1]!, expires: Date.now() + INPUT_MS };
    await ctx.answerCallbackQuery();
    await reply(ctx, "发送要买入的 SOL 数量，例如 0.2（最多 100 SOL，最多 9 位小数）。发送“取消”退出。");
  });
  bot.callbackQuery(new RegExp(`^sol:s:(${BASE58_MINT}):(25|50|100)$`), async (ctx) => {
    clear(); await ctx.answerCallbackQuery();
    await askSell(ctx, ctx.match[1]!, Number(ctx.match[2]) as 25 | 50 | 100);
  });
  bot.callbackQuery(/^sol:ok:([0-9a-f]{16})$/, async (ctx) => {
    clear();
    const id = ctx.match[1]!;
    const p = pending.get(id);
    pending.delete(id);
    if (!p || p.expires <= Date.now()) { await ctx.answerCallbackQuery("确认已超时，请重新操作"); return; }
    await ctx.answerCallbackQuery("已提交");
    void execute(ctx, p).catch((e) => console.log("Solana 交易处理失败:", errMsg(e)));
  });
  bot.callbackQuery(/^sol:no:([0-9a-f]{16})$/, async (ctx) => {
    clear();
    pending.delete(ctx.match[1]!);
    await ctx.answerCallbackQuery("已取消");
    await reply(ctx, "已取消，没有发送任何交易。", homeKb());
  });

  bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    const text = ctx.message?.text;
    if ((data && !data.startsWith("sol:")) || text?.startsWith("/")) clear();
    if (!text || text.startsWith("/")) { await next(); return; }
    const value = text.trim();
    if (input && input.expires <= Date.now()) clear();
    if (input && /^0x[0-9a-fA-F]{40}$/.test(value)) clear();
    if (input) {
      if (/^(取消|cancel)$/i.test(value)) { clear(); await reply(ctx, "已取消。", homeKb()); return; }
      const current = input;
      if (current.kind === "slip") {
        const bps = parseSlippageInput(value);
        if (bps === null) { await reply(ctx, "滑点格式不对，请发送 0.01 到 99.99 之间的数字，例如 1。"); return; }
        clear();
        o.state.setSolanaSlippageBps(bps);
        await reply(ctx, `已设置 Solana 滑点为 ${bps / 100}%。`, homeKb());
        return;
      }
      const lamports = parseSol(value);
      if (lamports === null) { await reply(ctx, "金额不对：请输入大于 0、不超过 100 SOL 的数字，最多 9 位小数，例如 0.2。"); return; }
      clear();
      await askBuy(ctx, current.mint, lamports);
      return;
    }
    if (isSolanaAddress(value)) { await card(ctx, value); return; }
    if (BASE58_LIKE.test(value)) { await reply(ctx, "这不是有效的 Solana 代币地址。"); return; }
    await next();
  });

  return clear;
}
