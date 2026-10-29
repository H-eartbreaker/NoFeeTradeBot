import {
  address, AccountRole, appendTransactionMessageInstructions, compileTransaction,
  compressTransactionMessageUsingAddressLookupTables, createTransactionMessage,
  getBase64Decoder, getBase64Encoder, getBase64EncodedWireTransaction, getSignatureFromTransaction,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransaction,
} from "@solana/kit";
import type { Instruction, KeyPairSigner, TransactionMessageBytesBase64, Address } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { fetchAddressLookupTable } from "@solana-program/address-lookup-table";
import { parseUnits } from "viem";
import type { SolRpc, Quote } from "./sol-chain.ts";
import type { Journal, JournalEntry } from "./journal.ts";
import { reconcileSol } from "./sol-ledger.ts";
import { awaitLanding, SolPendingError, SolTradeError } from "./sol-trade.ts";

export const JITO_URL = "https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true";
export type SolExecution = { mev?: boolean; jitoTipLamports?: string; maxTxFee?: string | null };
export type SolTransactionContext = { journal: Journal; policy: () => SolExecution };
type WireInstruction = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };

export function decodeSolInstruction(ix: WireInstruction, owner: string): Instruction {
  if (!ix || !Array.isArray(ix.accounts) || typeof ix.data !== "string") throw new Error("交易指令格式无效");
  return { programAddress: address(ix.programId), data: getBase64Encoder().encode(ix.data), accounts: ix.accounts.map((a) => {
    if (a.isSigner && a.pubkey !== owner) throw new Error("交易需要陌生账户签名，已拒绝");
    return { address: address(a.pubkey), role: a.isSigner ? (a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : (a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY) };
  }) };
}

export function jitoTip(policy: SolExecution): bigint {
  if (!policy.mev) return 0n;
  if (!/^\d+$/.test(policy.jitoTipLamports ?? "")) throw new Error("开启 Jito 前请明确设置小费");
  const tip = BigInt(policy.jitoTipLamports!);
  if (tip < 1_000n || tip > 1_000_000n) throw new Error("Jito 小费应在 1000～1000000 lamports 之间");
  return tip;
}
async function tipInstruction(signer: KeyPairSigner, tip: bigint): Promise<Instruction> {
  const res = await fetch("https://mainnet.block-engine.jito.wtf/api/v1/getTipAccounts", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }), signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json() as { result?: unknown };
  if (!res.ok || !Array.isArray(data.result) || !data.result.length || typeof data.result[0] !== "string") throw new Error("Jito 小费账户读取失败；未改用公开发送");
  return getTransferSolInstruction({ source: signer, destination: address(data.result[Math.floor(Math.random() * data.result.length)]), amount: tip });
}

export async function buildSolTransaction(rpc: SolRpc, signer: KeyPairSigner, instructions: readonly Instruction[], lookupAddresses: string[] = [], policy: SolExecution = {}) {
  const tip = jitoTip(policy);
  const finalInstructions = tip ? [...instructions, await tipInstruction(signer, tip)] : instructions;
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = appendTransactionMessageInstructions(finalInstructions,
    setTransactionMessageLifetimeUsingBlockhash(lifetime, setTransactionMessageFeePayerSigner(signer, createTransactionMessage({ version: 0 }))));
  const tables: Record<string, Address[]> = {};
  for (const value of [...new Set(lookupAddresses)]) {
    const table = await fetchAddressLookupTable(rpc, address(value));
    if (table.data.deactivationSlot !== 18_446_744_073_709_551_615n) throw new Error("交易地址表已停用");
    tables[value] = table.data.addresses;
  }
  const transaction = compileTransaction(compressTransactionMessageUsingAddressLookupTables(message, tables));
  const encodedMessage = getBase64Decoder().decode(transaction.messageBytes) as TransactionMessageBytesBase64;
  const { value: fee } = await rpc.getFeeForMessage(encodedMessage, { commitment: "confirmed" }).send();
  if (fee === null) throw new Error("无法核对交易费用，未发送");
  const cap = policy.maxTxFee ? parseUnits(policy.maxTxFee, 9) : null;
  if (cap !== null && (cap <= 0n || fee + tip > cap)) throw new Error("网络费及 Jito 小费超过单笔费用上限");
  return { transaction, lastValidBlockHeight: lifetime.lastValidBlockHeight, fee: fee + tip, tip };
}

export async function jupiterInstructions(q: Quote, owner: string) {
  const res = await fetch("https://lite-api.jup.ag/swap/v1/swap-instructions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }), signal: AbortSignal.timeout(15_000) });
  const data = await res.json() as { error?: string; computeBudgetInstructions?: WireInstruction[]; setupInstructions?: WireInstruction[]; otherInstructions?: WireInstruction[]; tokenLedgerInstruction?: WireInstruction | null; swapInstruction?: WireInstruction; cleanupInstruction?: WireInstruction | null; addressLookupTableAddresses?: string[] };
  if (!res.ok || data.error || !data.swapInstruction) throw new Error("兑换指令生成失败，未发送");
  const list = [...data.computeBudgetInstructions ?? [], ...data.setupInstructions ?? [], ...data.otherInstructions ?? [], ...data.tokenLedgerInstruction ? [data.tokenLedgerInstruction] : [], data.swapInstruction, ...data.cleanupInstruction ? [data.cleanupInstruction] : []];
  return { instructions: list.map((i) => decodeSolInstruction(i, owner)), tables: data.addressLookupTableAddresses ?? [] };
}

export async function sendSolInstructions(rpc: SolRpc, signer: KeyPairSigner, instructions: readonly Instruction[], tables: string[], ctx: SolTransactionContext,
  entry: Omit<JournalEntry, "id" | "at" | "status" | "chain" | "wallet">, ensureCurrent = () => {}) {
  if (ctx.journal.pending("main", "sol")) throw new Error("钱包有待核对交易，请先等结果，避免重复发送");
  const policyVersion = JSON.stringify(ctx.policy());
  const built = await buildSolTransaction(rpc, signer, instructions, tables, ctx.policy());
  ensureCurrent();
  const signed = await signTransaction([signer.keyPair], built.transaction);
  const sig = getSignatureFromTransaction(signed); const wire = getBase64EncodedWireTransaction(signed);
  if (Buffer.from(wire, "base64").length > 1232) throw new Error("交易过大，未发送");
  const simulated = await rpc.simulateTransaction(wire, { encoding: "base64", sigVerify: true, commitment: "confirmed" }).send();
  if (simulated.value.err) throw new SolTradeError("链上预演未通过，未发送交易");
  ensureCurrent();
  if (JSON.stringify(ctx.policy()) !== policyVersion) throw new Error("发送设置已改变，请重新确认");
  const id = ctx.journal.start({ ...entry, chain: "sol", wallet: "main", owner: signer.address, signature: sig, lastValidBlockHeight: built.lastValidBlockHeight.toString(), tipLamports: built.tip.toString() });
  // 先保存签名再广播。网络断开也不能丢掉这笔交易的查账线索。
  ctx.journal.update(id, { status: "pending" });
  try {
    if (ctx.policy().mev) {
      const res = await fetch(JITO_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [wire, { encoding: "base64" }] }), signal: AbortSignal.timeout(15_000) });
      const result = await res.json() as { result?: string; error?: unknown };
      if (!res.ok || result.error || result.result !== sig) throw new Error("Jito 发送结果需要核对");
    } else await rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: false, maxRetries: 0n }).send();
  } catch { /* 请求失败可能已经接收：仅查签名，绝不公开重发。 */ }
  try { await awaitLanding(rpc, sig, built.lastValidBlockHeight); }
  catch (e) { ctx.journal.update(id, { status: "unknown" }); await reconcileSol(ctx.journal, rpc); throw e; }
  await reconcileSol(ctx.journal, rpc);
  return { signature: sig, entry: ctx.journal.entries("main", "sol").find((e) => e.id === id)! };
}
