import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { Hex } from "viem";
import { CHAINS } from "../src/chains.ts";
import { Journal } from "../src/journal.ts";
import { reconcile } from "../src/reconcile.ts";
import { State } from "../src/state.ts";
import { PendingTransactionError, queueKey, sendAndWait, serial } from "../src/trade.ts";
import type { TradeDeps } from "../src/trade.ts";
import { Wallets } from "../src/wallets.ts";

const KEY1 = `0x${"1".repeat(64)}` as Hex;
const KEY2 = `0x${"2".repeat(64)}` as Hex;
const KEY3 = `0x${"3".repeat(64)}` as Hex;
const HASH = `0x${"a".repeat(64)}` as Hex;
const TOKEN = "0x1111111111111111111111111111111111111111";
function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
test("多钱包持仓隔离，旧主钱包格式兼容，同笔成交恢复不重复记账", (t) => {
  const file = join(directory(t), "state.json");
  writeFileSync(file, JSON.stringify({ tokens: [TOKEN], positions: { [`bsc:${TOKEN}`]: { cost: "100", tp: null, sl: null } } }));
  let s = new State(file);
  s.recordBuy("bsc", TOKEN, 500n, "w001", HASH);
  s.recordBuy("bsc", TOKEN, 500n, "w001", HASH);
  assert.equal(s.position("bsc", TOKEN)!.cost, 100n);
  assert.equal(s.position("bsc", TOKEN, "w001")!.cost, 500n);
  s = new State(file);
  s.recordBuy("bsc", TOKEN, 500n, "w001", HASH);
  assert.equal(s.position("bsc", TOKEN, "w001")!.cost, 500n);
  s.recordSell("bsc", TOKEN, 50, "w001", `0x${"b".repeat(64)}`);
  s.recordSell("bsc", TOKEN, 50, "w001", `0x${"b".repeat(64)}`);
  assert.equal(s.position("bsc", TOKEN, "w001")!.cost, 250n);
  assert.equal(s.position("bsc", TOKEN)!.cost, 100n);
});
test("钱包仅保存本地，限制文件权限并避免其他进程新增钱包被覆盖", (t) => {
  const file = join(directory(t), ".env");
  writeFileSync(file, `PRIVATE_KEY=${KEY1}\nEXISTING_SETTING=keep\n`);
  const first = new Wallets(KEY1, [CHAINS.bsc], file);
  const second = new Wallets(KEY1, [CHAINS.bsc], file);
  const a = first.importKey(KEY2); const b = second.importKey(KEY3);
  assert.equal(a.id, "w001"); assert.equal(b.id, "w002");
  assert.deepEqual(Object.keys(a).sort(), ["address", "id", "label"]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const reloaded = new Wallets(KEY1, [CHAINS.bsc], file);
  assert.equal(reloaded.list().length, 3);
  assert.equal(reloaded.get("w001", "bsc")!.walletId, "w001");
  assert.equal(reloaded.get("w001", "base"), undefined);
  assert.match(readFileSync(file, "utf8"), /EXISTING_SETTING=keep/);
  assert.throws(() => second.importKey(KEY2), /已经存在/);
});
test("钱包保存遇锁退出，原文件不变", (t) => {
  const dir = directory(t); const file = join(dir, ".env");
  writeFileSync(file, `PRIVATE_KEY=${KEY1}\n`);
  const w = new Wallets(KEY1, [CHAINS.bsc], file);
  w.importKey(KEY2);
  writeFileSync(join(dir, "data/wallet-env.lock"), "");
  const before = readFileSync(file, "utf8");
  assert.throws(() => w.importKey(KEY3), /正在进行/);
  assert.equal(readFileSync(file, "utf8"), before);
});
test("账本残缺不静默丢失，pending 经只读回执恢复且成本只更新一次", async (t) => {
  const dir = directory(t); const file = join(dir, "trades.jsonl");
  const j = new Journal(file); const s = new State(join(dir, "state.json"));
  const id = j.start({ chain: "bsc", wallet: "main", kind: "buy", token: TOKEN, amountIn: "100" });
  j.update(id, { hash: HASH, status: "pending" });
  assert.equal(j.pending("main", "bsc"), true);
  const d = { chain: CHAINS.bsc, clients: { publicClient: { getTransactionReceipt: async () => ({ status: "success", gasUsed: 10n, effectiveGasPrice: 2n }) } } } as unknown as TradeDeps;
  await reconcile(j, s, () => d); await reconcile(j, s, () => d);
  assert.equal(s.position("bsc", TOKEN)!.cost, 100n);
  assert.equal(j.entries()[0].gasCost, "20");
  assert.equal(j.pending("main", "bsc"), false);
  assert.equal(new Journal(file).entries()[0].status, "confirmed");
  writeFileSync(file, readFileSync(file, "utf8") + '{"id":');
  assert.throws(() => new Journal(file), /损坏/);
});
test("交易回执超时保留 hash，未确认时拒绝再次广播", async (t) => {
  const journal = new Journal(join(directory(t), "trades.jsonl")); let sent = 0;
  const d = { chain: CHAINS.bsc, walletId: "main", journal, clients: {
    account: { address: TOKEN }, publicClient: { waitForTransactionReceipt: async () => { throw new Error("timeout"); } },
    walletClient: { prepareTransactionRequest: async (tx: object) => ({ ...tx, gas: 100n }), sendTransaction: async () => { sent++; return HASH; } },
  } } as unknown as TradeDeps;
  const tx = { to: TOKEN, value: 1n, data: "0x" as Hex } as const;
  await assert.rejects(sendAndWait(d, tx, undefined, { kind: "transfer", amountIn: "1" }), PendingTransactionError);
  assert.equal(journal.entries()[0].hash, HASH);
  assert.equal(journal.entries()[0].status, "pending");
  await assert.rejects(sendAndWait(d, tx, undefined, { kind: "transfer", amountIn: "1" }), PendingTransactionError);
  assert.equal(sent, 1);
});
test("同钱包同链串行，其他钱包的交易不被挡住", async () => {
  let release!: () => void; let secondRan = false;
  const d = { chain: CHAINS.bsc, clients: { account: { address: TOKEN } } } as unknown as TradeDeps;
  const first = serial(() => new Promise<void>((r) => { release = r; }), queueKey(d));
  await new Promise((r) => setImmediate(r));
  const same = serial(async () => { secondRan = true; }, queueKey(d));
  await serial(async () => { assert.equal(secondRan, false); }, "another-wallet");
  release(); await first; await same; assert.equal(secondRan, true);
});
test("精确数量卖出按实际分数扣成本，账本恢复不因百分比取整而多扣", async (t) => {
  const dir = directory(t); const s = new State(join(dir, "state.json")); const j = new Journal(join(dir, "journal.jsonl"));
  s.recordBuy("bsc", TOKEN, 1000000n);
  const id = j.start({ wallet: "main", chain: "bsc", token: TOKEN, kind: "sell", hash: HASH, amountIn: "1", balanceBefore: "3", sellPct: 33.33 });
  j.update(id, { status: "confirmed" });
  await reconcile(j, s, () => undefined); await reconcile(j, s, () => undefined);
  assert.equal(s.position("bsc", TOKEN)!.cost, 666666n);
});
