import { existsSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { escapeHtml, fmtUnits, shortAddr } from "./util.ts";

export type PnlCardRow = { symbol: string; profit: bigint | null; principal: bigint | null };
export type PnlCard = {
  chainLabel: string; nativeSymbol: string; wallet: string; time: string;
  realized: bigint; realizedTrades: number; estimated: boolean;
  floating: bigint; floatingUnknown: number; gas: bigint; feeComplete: boolean;
  principal: bigint | null; rows: PnlCardRow[]; omitted: number;
};

const WIDTH = 720;
const MAX_ROWS = 10;
const FONT_FILES = ["/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "/System/Library/Fonts/STHeiti Medium.ttc"];
const FONT_FAMILY = "Arial Unicode MS, STHeiti, sans-serif";
const GREEN = "#3fb950"; const RED = "#f85149"; const TEXT = "#e6edf3"; const MUTED = "#8b949e";

export const hasCjkFont = () => FONT_FILES.some((f) => existsSync(f));
const xml = (s: string) => escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const signed = (v: bigint, unit: string) => `${v > 0n ? "+" : ""}${fmtUnits(v, 18, 6)} ${unit}`;
const tone = (v: bigint) => (v > 0n ? GREEN : v < 0n ? RED : TEXT);

function text(x: number, y: number, size: number, fill: string, value: string, anchor = "start", weight = "normal"): string {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}">${xml(value)}</text>`;
}

export function renderPnlCard(card: PnlCard): Buffer {
  const fonts = FONT_FILES.filter((f) => existsSync(f));
  if (!fonts.length) throw new Error("未找到中文字体，无法生成盈亏图片");
  const unit = card.nativeSymbol;
  const rows = card.rows.slice(0, MAX_ROWS);
  const tableTop = 366; const footerY = tableTop + Math.max(rows.length, 1) * 40 + 40;
  const height = footerY + 80;
  const parts: string[] = [
    `<rect width="${WIDTH}" height="${height}" fill="#0d1117"/>`,
    text(40, 60, 34, TEXT, "持仓盈亏", "start", "bold"),
    text(40, 96, 20, MUTED, `${card.chainLabel} · ${shortAddr(card.wallet)} · ${card.time}`),
    text(40, 150, 22, MUTED, "已实现收益"), text(380, 150, 22, MUTED, "浮动收益"),
    text(40, 196, 40, tone(card.realized), card.realizedTrades ? signed(card.realized, unit) : "暂无可核对卖出"),
    text(380, 196, 40, tone(card.floating), signed(card.floating, unit)),
    text(40, 230, 18, MUTED, `${card.realizedTrades} 笔可核对卖出${card.estimated ? "（估算）" : ""}`),
    text(380, 230, 18, MUTED, card.floatingUnknown ? `另有 ${card.floatingUnknown} 个未能核对` : "已核对持仓合计"),
    text(40, 268, 20, MUTED, `已记录 Gas：${fmtUnits(card.gas, 18, 8)} ${unit}${card.feeComplete ? "" : "（部分缺失）"}`),
    text(380, 268, 20, MUTED, card.principal === null ? "尚未收回本金：部分无法核对" : `尚未收回本金：${fmtUnits(card.principal, 18, 8)} ${unit}`),
    `<line x1="40" y1="296" x2="${WIDTH - 40}" y2="296" stroke="#30363d" stroke-width="1"/>`,
    text(40, 326, 18, MUTED, "代币"), text(300, 326, 18, MUTED, "浮动收益"), text(680, 326, 18, MUTED, "未收回本金", "end"),
  ];
  rows.forEach((row, i) => {
    const y = tableTop + i * 40;
    parts.push(text(40, y, 22, TEXT, row.symbol.slice(0, 16)));
    parts.push(row.profit === null ? text(300, y, 22, MUTED, "未知") : text(300, y, 22, tone(row.profit), signed(row.profit, unit)));
    parts.push(row.principal === null ? text(680, y, 22, MUTED, "未知", "end") : text(680, y, 22, TEXT, fmtUnits(row.principal, 18, 6), "end"));
  });
  if (!rows.length) parts.push(text(40, tableTop, 22, MUTED, "暂无可展示的持仓"));
  const notes = [
    card.omitted ? `另有 ${card.omitted} 个代币记录未统计` : "",
    "收益未扣 Gas；未知成本不按零计算。",
    "仅统计本地账本可核对部分，报价不代表已成交。",
  ].filter(Boolean);
  notes.forEach((note, i) => parts.push(text(40, footerY + i * 26, 16, MUTED, note)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" font-family="${xml(FONT_FAMILY)}">${parts.join("")}</svg>`;
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: WIDTH }, font: { loadSystemFonts: false, fontFiles: fonts } }).render().asPng());
}
