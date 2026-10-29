import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Bot } from "grammy";
import type { InlineKeyboard } from "grammy";
import { decodeFunctionData, erc20Abi, maxUint256 } from "viem";
import type { Address, Hex } from "viem";
import { knownSpenders, revokeAllowance } from "../src/allowances.ts";
import { registerApprovals } from "../src/approvals-panel.ts";
import { CHAINS } from "../src/chains.ts";
import { Journal } from "../src/journal.ts";
import { Logos } from "../src/logos.ts";
import { State } from "../src/state.ts";
import { PendingTransactionError } from "../src/trade.ts";
import type { TradeDeps } from "../src/trade.ts";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const SPENDER = "0x2222222222222222222222222222222222222222" as Address;
const OWNER = "0x3333333333333333333333333333333333333333" as Address;
const HASH = `0x${"a".repeat(64)}` as Hex;
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "approvals-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new State(join(dir, "state.json")); state.recordBuy("bsc", TOKEN, 100n);
  const journal = new Journal(join(dir, "journal.jsonl"));
  const id = journal.start({ wallet: "main", chain: "bsc", kind: "approve", token: TOKEN, recipient: SPENDER }); journal.update(id, { status: "confirmed" });
  let allowance = maxUint256; let verify = true; let timeout = false; let writes = 0;
  let sent: { to: Address; data: Hex; value: bigint } | null = null;
  const d = { chain: CHAINS.bsc, walletId: "main", journal, clients: { account: { address: OWNER },
    publicClient: { readContract: async (p: { blockNumber?: bigint }) => p.blockNumber && verify ? 0n : allowance,
      getBalance: async () => 1000000n,
      waitForTransactionReceipt: async () => { if (timeout) throw new Error("timeout"); return { status: "success", blockNumber: 7n, gasUsed: 100n, effectiveGasPrice: 1n }; } },
    walletClient: { chain: CHAINS.bsc.viemChain, prepareTransactionRequest: async (tx: object) => ({ ...tx, gas: 100n, gasPrice: 1n }), sendTransaction: async (tx: typeof sent) => { writes++; sent = tx; return HASH; } },
  } } as unknown as TradeDeps;
  return { state, journal, d, writes: () => writes, sent: () => sent, zero: () => { allowance = 0n; }, unverified: () => { verify = false; }, timeout: () => { timeout = true; } };
}
test("撤销只向指定代币 approve 指定对象为零，已有零授权不花 Gas", async (t) => {
  const f = fixture(t); assert.deepEqual(knownSpenders(f.d, TOKEN), [SPENDER]);
  const r = await revokeAllowance(f.d, TOKEN, SPENDER, Date.now() + 60000, 1000n);
  assert.equal(r.verified, true); assert.equal(f.writes(), 1); assert.equal(f.sent()!.to, TOKEN); assert.equal(f.sent()!.value, 0n);
  const decoded = decodeFunctionData({ abi: erc20Abi, data: f.sent()!.data }); assert.equal(decoded.functionName, "approve"); assert.deepEqual(decoded.args, [SPENDER, 0n]);
  assert.equal(f.journal.entries()[0].amountIn, "0");
  f.zero(); await revokeAllowance(f.d, TOKEN, SPENDER, Date.now() + 60000, 1000n); assert.equal(f.writes(), 1);
});
test("撤销过期/超预算不广播；回执成功但链上额度没归零不声称已撤销", async (t) => {
  const f = fixture(t);
  await assert.rejects(revokeAllowance(f.d, TOKEN, SPENDER, Date.now() - 1, 1000n), /过期/);
  await assert.rejects(revokeAllowance(f.d, TOKEN, SPENDER, Date.now() + 60000, 100n), /预算/); assert.equal(f.writes(), 0);
  f.unverified(); const r = await revokeAllowance(f.d, TOKEN, SPENDER, Date.now() + 60000, 1000n); assert.equal(r.verified, false); assert.equal(f.writes(), 1);
});
test("撤销结果未知时保存 hash 并阻止重发", async (t) => {
  const f = fixture(t); f.timeout();
  await assert.rejects(revokeAllowance(f.d, TOKEN, SPENDER, Date.now() + 60000, 1000n), PendingTransactionError);
  await assert.rejects(revokeAllowance(f.d, TOKEN, SPENDER, Date.now() + 60000, 1000n), PendingTransactionError);
  assert.equal(f.writes(), 1); assert.equal(f.journal.entries()[0].hash, HASH);
});

function ui(t: TestContext) {
  const f = fixture(t); const bot = new Bot("123:test"); bot.botInfo = { id: 999, username: "test_bot", first_name: "Test", is_bot: true } as never;
  const messages: { text: string; kb?: InlineKeyboard }[] = []; let revokes = 0; let verified = true;
  bot.api.config.use(async (_p, method, payload) => {
    if (method === "answerCallbackQuery") return { ok: true, result: true } as never;
    assert.equal(method, "sendMessage"); const p = payload as { text: string; reply_markup?: InlineKeyboard }; assert.ok(p.text.length < 4096);
    for (const b of p.reply_markup?.inline_keyboard.flat() ?? []) if ("callback_data" in b) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
    messages.push({ text: p.text, kb: p.reply_markup }); return { ok: true, result: { message_id: messages.length, date: 0, chat: { id: 123, type: "private" }, text: p.text } } as never;
  });
  let clear!: () => void;
  bot.use(async (ctx, next) => { if (ctx.from?.id !== 123) return; if (ctx.callbackQuery && !ctx.callbackQuery.data?.startsWith("auth:")) clear(); await next(); });
  clear = registerApprovals(bot, { state: f.state, chains: [CHAINS.bsc, CHAINS.base], logos: new Logos(f.state), activeChain: () => "bsc", activeWallet: () => "main", deps: (chain, wallet) => chain === "bsc" && wallet === "main" ? f.d : undefined }, {
    readToken: async () => ({ address: TOKEN, name: "Test", symbol: "TEST", balance: 100n, decimals: 18 }),
    getRoute: async () => { throw new Error("route unavailable"); }, allowanceOf: async () => maxUint256, revokeBudget: async () => 1000n,
    revokeAllowance: async () => { revokes++; return { hash: HASH, verified }; },
  });
  let n = 0; const callback = (data: string, id = 123) => bot.handleUpdate({ update_id: ++n, callback_query: { id: String(n), from: { id, is_bot: false, first_name: "User" }, chat_instance: "test", data,
    message: { message_id: 1, date: 0, chat: { id, type: "private", first_name: "User" }, text: "card" } } });
  const button = (prefix: string) => messages.flatMap((m) => m.kb?.inline_keyboard.flat() ?? []).filter((b) => "callback_data" in b && b.callback_data.startsWith(prefix)).map((b) => "callback_data" in b ? b.callback_data : "").at(-1)!;
  return { callback, messages, button, revokes: () => revokes, unverified: () => { verified = false; } };
}
test("授权列表明确范围，撤销先核对链/钱包/CA/对象，双击与非白名单不重复执行", async (t) => {
  const f = ui(t); await f.callback("auth:list:bsc:main:0"); assert.match(f.messages.at(-1)!.text, /不代表钱包全部授权/);
  await f.callback(f.button("auth:token:")); assert.match(f.messages.at(-1)!.text, /无限额度/);
  await f.callback(f.button("auth:prepare:")); const text = f.messages.at(-1)!.text;
  for (const part of [OWNER, TOKEN, SPENDER, "额度改为：0", "Gas 预算"]) assert.ok(text.includes(part));
  const confirm = f.button("auth:confirm:"); await f.callback(confirm, 456); assert.equal(f.revokes(), 0);
  await Promise.all([f.callback(confirm), f.callback(confirm)]); assert.equal(f.revokes(), 1); assert.match(f.messages.at(-1)!.text, /授权额度为零/);
});
test("撤销取消/过期/切换菜单会失效，未核对为零的结果明确提示", async (t) => {
  const f = ui(t); await f.callback(`auth:token:bsc:main:${TOKEN}`); const prepare = f.button("auth:prepare:");
  await f.callback(prepare); const cancelled = f.button("auth:confirm:"); await f.callback("auth:cancel"); await f.callback(cancelled); assert.equal(f.revokes(), 0);
  await f.callback(prepare); const stale = f.button("auth:confirm:"); await f.callback("logos:settings"); await f.callback(stale); assert.equal(f.revokes(), 0);
  await f.callback(prepare); const expired = f.button("auth:confirm:"); const now = Date.now(); const clock = t.mock.method(Date, "now", () => now + 61000); await f.callback(expired); clock.mock.restore(); assert.equal(f.revokes(), 0);
  f.unverified(); await f.callback(prepare); await f.callback(f.button("auth:confirm:")); assert.equal(f.revokes(), 1); assert.match(f.messages.at(-1)!.text, /尚未确认归零/);
});
