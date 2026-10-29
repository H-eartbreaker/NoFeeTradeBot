import { test } from "node:test";
import assert from "node:assert/strict";
import { address, generateKeyPairSigner } from "@solana/kit";
import { transferInstructions } from "../src/sol-funds.ts";
import { SOL_MINT, TOKEN_PROGRAMS, type SolRpc } from "../src/sol-chain.ts";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("SOL 转账指令固定收款人和整数金额，不触发发送", async () => {
  const signer = await generateKeyPairSigner();
  const instructions = await transferInstructions({} as SolRpc, signer, SOL_MINT, SOL_MINT, 1000n);
  assert.equal(instructions.length, 1); assert.equal(instructions[0]?.accounts?.[1]?.address, SOL_MINT);
  assert.equal(Buffer.from(instructions[0]!.data!).readBigUInt64LE(4), 1000n);
  await assert.rejects(transferInstructions({} as SolRpc, signer, signer.address, SOL_MINT, 1000n), /不能是自己/);
});

test("SPL 多账户按总额转出，租金账户幂等创建；冻结/扩展不盲目转出", async () => {
  const signer = await generateKeyPairSigner(); let extension = false; let frozen = false;
  const rpc = { getAccountInfo: () => ({ send: async () => ({ value: { owner: extension ? TOKEN_PROGRAMS.token2022 : TOKEN_PROGRAMS.spl, data: { parsed: { type: "mint", info: { decimals: 6, extensions: extension ? [{ extension: "transferHook" }] : [] } } } } }) }),
    getTokenAccountsByOwner: () => ({ send: async () => ({ value: [3, 7].map((v) => ({ pubkey: address(MINT), account: { data: { parsed: { info: { state: frozen ? "frozen" : "initialized", tokenAmount: { amount: String(v) } } } } } })) }) }) } as unknown as SolRpc;
  const ix = await transferInstructions(rpc, signer, SOL_MINT, MINT, 9n); assert.equal(ix.length, 3);
  assert.equal(Buffer.from(ix[1]!.data!).readBigUInt64LE(1), 3n); assert.equal(Buffer.from(ix[2]!.data!).readBigUInt64LE(1), 6n);
  frozen = true; await assert.rejects(transferInstructions(rpc, signer, SOL_MINT, MINT, 9n), /不足/);
  extension = true; await assert.rejects(transferInstructions(rpc, signer, SOL_MINT, MINT, 9n), /扩展/);
});
