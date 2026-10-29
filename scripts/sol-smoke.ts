// Solana 真实只读验收：不读 .env，不创建私钥或签名器，不发送 Telegram 或链上交易。
import assert from "node:assert/strict";
import { address, getBase64Encoder, getTransactionDecoder } from "@solana/kit";
import { enableKeepAlive } from "../src/http.ts";
import { openRpc, solBalance, holdings, mintInfo, tokenMeta, quote, swapTransaction, SOL_MINT } from "../src/sol-chain.ts";
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const owner = address("CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8"); // 固定测试公钥，无私钥
const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
enableKeepAlive([rpcUrl, "https://lite-api.jup.ag"]);
const rpc = openRpc(rpcUrl);
let failed = false;
async function stage(name: string, work: () => Promise<void>) {
  const start = performance.now();
  try { await work(); console.log(JSON.stringify({ check: name, passed: true, elapsedMs: Math.round(performance.now() - start) })); }
  catch (error) { failed = true; console.log(JSON.stringify({ check: name, passed: false, error: error instanceof Error ? error.message.split("\n")[0] : "unknown" })); }
}
await stage("Solana 原生余额与 SPL/Token-2022 持仓", async () => {
  assert.ok(await solBalance(rpc, owner) >= 0n); assert.ok(Array.isArray(await holdings(rpc, owner)));
});
await stage("USDC Mint 与名称", async () => {
  const info = await mintInfo(rpc, mint); assert.equal(info.decimals, 6); const meta = await tokenMeta(mint); assert.equal(meta?.symbol, "USDC");
});
await stage("Jupiter 双向报价与未签名交易构建", async () => {
  const q = await quote(SOL_MINT, mint, 10000000n, 100); assert.ok(BigInt(q.outAmount) > 0n);
  const back = await quote(mint, SOL_MINT, BigInt(q.outAmount), 100); assert.ok(BigInt(back.outAmount) > 0n);
  for (const route of [q, back]) {
    const built = await swapTransaction(route, owner); assert.ok(built.lastValidBlockHeight > 0n);
    assert.ok(getTransactionDecoder().decode(getBase64Encoder().encode(built.transaction)).messageBytes.length > 0);
  }
});
console.log(JSON.stringify({ signingCalls: 0, sendTransactionCalls: 0, loadedEnvFile: false }));
process.exitCode = failed ? 1 : 0;
