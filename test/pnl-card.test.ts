import assert from "node:assert/strict";
import { test } from "node:test";
import { hasCjkFont, renderPnlCard } from "../src/pnl-card.ts";
import type { PnlCard } from "../src/pnl-card.ts";

const BNB = 10n ** 18n;
const card = (over: Partial<PnlCard> = {}): PnlCard => ({
  chainLabel: "BNB", nativeSymbol: "BNB", wallet: `0x${"ab".repeat(20)}`, time: "2026/10/29 16:00:00",
  realized: BNB / 80n, realizedTrades: 2, estimated: false, floating: -BNB / 300n, floatingUnknown: 1,
  gas: BNB / 1000n, feeComplete: true, principal: BNB / 200n,
  rows: [{ symbol: `<b>&"Coin'`, profit: -BNB / 300n, principal: null }, { symbol: "USDT", profit: BNB / 50n, principal: 0n }],
  omitted: 0, ...over,
});
const skip = hasCjkFont() ? false : "缺少中文字体";

test("盈亏图片输出 720 像素宽的 PNG，并转义代币名称", { skip }, () => {
  const png = renderPnlCard(card());
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 720);
  assert.ok(png.length > 2000);
});

test("没有可核对持仓、本金未知和被省略数量时仍能渲染", { skip }, () => {
  const png = renderPnlCard(card({ realizedTrades: 0, floatingUnknown: 3, principal: null, rows: [], omitted: 5, feeComplete: false }));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});
