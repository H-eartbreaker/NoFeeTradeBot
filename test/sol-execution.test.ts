import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { address, blockhash, generateKeyPairSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { buildSolTransaction, decodeSolInstruction, jitoTip, sendSolInstructions, JITO_URL } from "../src/sol-execution.ts";
import { Journal } from "../src/journal.ts";
import { SOL_MINT, type SolRpc } from "../src/sol-chain.ts";

const target = address(SOL_MINT);
test("私有发送需明确小费，拒绝陌生签名账户", () => {
  assert.equal(jitoTip({}), 0n); assert.equal(jitoTip({ mev: true, jitoTipLamports: "1000" }), 1000n);
  for (const value of [undefined, "0", "1.5", "1000001"]) assert.throws(() => jitoTip({ mev: true, jitoTipLamports: value }));
  assert.throws(() => decodeSolInstruction({ programId: SOL_MINT, data: "", accounts: [{ pubkey: SOL_MINT, isSigner: true, isWritable: true }] }, "other"), /陌生/);
});

test("费用超限或预演失败不广播；Jito 发送前已保存编号且不退回公开通道", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sol-send-")); t.after(() => rmSync(dir, { recursive: true }));
  const journal = new Journal(join(dir, "trades.jsonl")); const signer = await generateKeyPairSigner();
  let simError: unknown = null; let publicSends = 0; let privateSends = 0; let fee = 5000n;
  const rpc = {
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 100n } }) }),
    getFeeForMessage: () => ({ send: async () => ({ value: fee }) }),
    simulateTransaction: () => ({ send: async () => ({ value: { err: simError } }) }),
    sendTransaction: () => ({ send: async () => { publicSends++; throw new Error("禁止公开发送"); } }),
    getBlockHeight: () => ({ send: async () => 1n }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] }) }),
    getTransaction: () => ({ send: async () => ({ transaction: { message: { accountKeys: [signer.address, target] } }, meta: { err: null, fee: 5000n, preBalances: [1000000n, 0n], postBalances: [993999n, 1n], preTokenBalances: [], postTokenBalances: [] } }) }),
  } as unknown as SolRpc;
  t.mock.method(globalThis, "fetch", async (url: string | URL) => {
    if (String(url).includes("getTipAccounts")) return Response.json({ result: [target] });
    assert.equal(String(url), JITO_URL); privateSends++; assert.equal(journal.entries()[0]?.status, "pending"); assert.ok(journal.entries()[0]?.signature);
    throw new Error("模拟发送请求超时");
  });
  const ix = getTransferSolInstruction({ source: signer, destination: target, amount: 1n });
  const ctx = { journal, policy: () => ({ mev: true, jitoTipLamports: "1000", maxTxFee: "0.00001" }) };
  fee = 20000n; await assert.rejects(buildSolTransaction(rpc, signer, [ix], [], ctx.policy()), /上限/);
  fee = 5000n; simError = "failure"; await assert.rejects(sendSolInstructions(rpc, signer, [ix], [], ctx, { kind: "transfer" }), /预演/);
  assert.equal(journal.entries().length, 0); simError = null;
  const result = await sendSolInstructions(rpc, signer, [ix], [], ctx, { kind: "transfer" });
  assert.equal(result.entry.status, "confirmed"); assert.equal(result.entry.gasCost, "6000");
  assert.equal(privateSends, 1); assert.equal(publicSends, 0);
});
