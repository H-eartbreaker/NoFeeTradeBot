import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { getAddress, isAddress } from "viem";
import type { Address } from "viem";
import type { Logos } from "./logos.ts";
import type { State, TrackedWallet } from "./state.ts";
import type { TradeDeps } from "./trade.ts";
import { errMsg, escapeHtml, fmtUnits, shortAddr } from "./util.ts";

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;
const PAGE = 5;
const MAX_TRACKED = 50;
const MAX_LABEL = 20;
const INPUT_MS = 5 * 60_000;

type Options = {
  state: State;
  logos: Logos;
  activeChain: () => string;
  deps: (chain: string) => TradeDeps | undefined;
};

// 只记录地址和备注，不会自动买卖或跟单
export function registerTracked(bot: Bot, o: Options): () => void {
  let input: { expires: number } | null = null;
  const clear = () => { input = null; };
  const reply = (ctx: Context, text: string, kb?: InlineKeyboard) => ctx.reply(text, { ...HTML, reply_markup: kb });
  const backKb = () => new InlineKeyboard().text("追踪钱包", "trk:list:0").text("返回首页", "nav:start");
  const find = (address: string) => o.state.trackedWallets().find((w) => w.address.toLowerCase() === address.toLowerCase());

  function parseLine(line: string): TrackedWallet | null {
    const [raw, ...rest] = line.trim().split(/\s+/);
    if (!raw || !isAddress(raw)) return null;
    return { address: getAddress(raw), label: rest.join(" ").slice(0, MAX_LABEL) };
  }

  function addLines(text: string): { added: number; duplicate: number; invalid: string[]; full: boolean } {
    const current = o.state.trackedWallets();
    const seen = new Set(current.map((w) => w.address.toLowerCase()));
    const next = [...current];
    const invalid: string[] = [];
    let added = 0; let duplicate = 0; let full = false;
    for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const entry = parseLine(line);
      if (!entry) { invalid.push(line.slice(0, 30)); continue; }
      if (seen.has(entry.address.toLowerCase())) { duplicate++; continue; }
      if (next.length >= MAX_TRACKED) { full = true; break; }
      next.push(entry);
      seen.add(entry.address.toLowerCase());
      added++;
    }
    if (added) o.state.setTracked(next);
    return { added, duplicate, invalid, full };
  }

  async function list(ctx: Context, requested: number) {
    const all = o.state.trackedWallets();
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    const page = Math.min(Math.max(0, requested), pages - 1);
    const rows = all.slice(page * PAGE, page * PAGE + PAGE);
    const lines = ["<b>追踪钱包</b>", `已追踪 ${all.length} / ${MAX_TRACKED} 个地址。`, "只记录地址，不会自动买卖，也不会自动跟单。", ""];
    if (!rows.length) lines.push("还没有追踪的地址。点「添加地址」开始。");
    rows.forEach((w, i) => lines.push(`${page * PAGE + i + 1}. ${escapeHtml(w.label || "未命名")} <code>${w.address}</code>`));
    if (all.length) lines.push("", `第 ${page + 1} / ${pages} 页`);
    const kb = new InlineKeyboard();
    for (const w of rows) kb.text(`查看：${w.label || shortAddr(w.address)}`, `trk:view:${w.address}`).row();
    if (page > 0) kb.text("上一页", `trk:list:${page - 1}`);
    if (page < pages - 1) kb.text("下一页", `trk:list:${page + 1}`);
    if (page > 0 || page < pages - 1) kb.row();
    kb.text("添加地址", "trk:add").text("导出列表", "trk:export").row();
    kb.text("返回首页", "nav:start");
    await ctx.reply(lines.join("\n"), { ...HTML, reply_markup: kb });
  }

  async function view(ctx: Context, address: string) {
    const w = find(address);
    if (!w) { await reply(ctx, "这个地址已不在追踪列表中。", backKb()); return; }
    const d = o.deps(o.activeChain());
    let balance = "未读取";
    if (d) {
      try { balance = `${fmtUnits(await d.clients.publicClient.getBalance({ address: w.address as Address }), 18, 6)} ${d.chain.nativeSymbol}`; }
      catch (e) { console.log("追踪地址余额读取失败:", errMsg(e)); balance = "读取失败，请稍后刷新"; }
    }
    const lines = ["<b>追踪钱包</b>", `备注：${escapeHtml(w.label || "未命名")}`, `地址：<code>${w.address}</code>`];
    if (d) lines.push(`当前链：${o.logos.chain(d.chain)}`);
    lines.push(`原生币余额：${escapeHtml(balance)}`, "", "只读，不会自动交易。");
    const kb = new InlineKeyboard().text("刷新余额", `trk:view:${w.address}`).text("删除", `trk:del:${w.address}`).row().text("追踪钱包", "trk:list:0").text("返回首页", "nav:start");
    await reply(ctx, lines.join("\n"), kb);
  }

  bot.command("track", async (ctx) => { clear(); await list(ctx, 0); });
  bot.callbackQuery(/^trk:list:(\d{1,3})$/, async (ctx) => {
    clear(); await ctx.answerCallbackQuery(); await list(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery("trk:add", async (ctx) => {
    input = { expires: Date.now() + INPUT_MS };
    await ctx.answerCallbackQuery();
    await reply(ctx, `发送要追踪的地址，每行一个，格式「地址 备注」，备注可省略，例如：\n0x0000000000000000000000000000000000000001 聪明钱1\n最多 ${MAX_TRACKED} 个地址；也可以把导出的列表整段粘贴回来。发送“取消”退出。`);
  });
  bot.callbackQuery("trk:export", async (ctx) => {
    clear(); await ctx.answerCallbackQuery();
    const all = o.state.trackedWallets();
    if (!all.length) { await reply(ctx, "列表为空，没有可导出的地址。", backKb()); return; }
    await ctx.reply(all.map((w) => `${w.address}${w.label ? ` ${w.label}` : ""}`).join("\n"), { link_preview_options: { is_disabled: true } });
  });
  bot.callbackQuery(/^trk:view:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
    clear(); await ctx.answerCallbackQuery(); await view(ctx, ctx.match[1]);
  });
  bot.callbackQuery(/^trk:del:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
    clear();
    const address = ctx.match[1];
    const next = o.state.trackedWallets().filter((w) => w.address.toLowerCase() !== address.toLowerCase());
    o.state.setTracked(next);
    await ctx.answerCallbackQuery("已移出追踪");
    await list(ctx, 0);
  });

  bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    const text = ctx.message?.text;
    if ((data && !data.startsWith("trk:")) || text?.startsWith("/")) clear();
    if (!input || !text || text.startsWith("/")) { await next(); return; }
    if (input.expires <= Date.now()) { clear(); await reply(ctx, "输入已超时，请重新点「添加地址」。", backKb()); return; }
    if (/^(取消|cancel)$/i.test(text.trim())) { clear(); await reply(ctx, "已取消，未添加地址。", backKb()); return; }
    const result = addLines(text);
    if (!result.added && !result.duplicate && !result.full) {
      await ctx.reply("没有识别到有效地址。请按「地址 备注」每行一个重新发送，或发送“取消”。");
      return;
    }
    clear();
    const parts = [`已添加 ${result.added} 个地址`];
    if (result.duplicate) parts.push(`${result.duplicate} 个已在列表中`);
    if (result.invalid.length) parts.push(`${result.invalid.length} 行格式不正确未添加：${result.invalid.slice(0, 5).map((l) => escapeHtml(l)).join(" | ")}`);
    if (result.full) parts.push(`已达上限 ${MAX_TRACKED} 个，超出部分未添加`);
    await reply(ctx, `${parts.join("；")}。`, backKb());
  });

  return clear;
}
