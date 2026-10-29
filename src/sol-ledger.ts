import { signature } from "@solana/kit";
import type { Journal, JournalEntry } from "./journal.ts";
import { SOL_MINT } from "./sol-chain.ts";
import type { SolRpc } from "./sol-chain.ts";

type TokenBalance = { accountIndex: number | bigint; mint: string; owner?: string; uiTokenAmount: { amount: string } };
export type SolReceipt = {
  transaction: { message: { accountKeys: readonly (string | { pubkey: string; signer?: boolean })[] } };
  meta: { err: unknown; fee: number | bigint; preBalances: readonly (number | bigint)[]; postBalances: readonly (number | bigint)[];
    preTokenBalances?: readonly TokenBalance[] | null; postTokenBalances?: readonly TokenBalance[] | null } | null;
};
const key = (k: string | { pubkey: string }) => typeof k === "string" ? k : k.pubkey;

// 将钱包及其代币账户的 SOL 变化相加，抵消新建/关闭账户的租金变化；不把报价当实际成交。
export function solReceiptPatch(receipt: SolReceipt, entry: Pick<JournalEntry, "owner" | "token" | "kind" | "tipLamports" | "outputToken">): Partial<JournalEntry> {
  const m = receipt.meta;
  if (!m || !entry.owner) throw new Error("缺少交易明细，尚不能核算成交");
  const index = receipt.transaction.message.accountKeys.findIndex((k) => key(k) === entry.owner);
  if (index < 0) throw new Error("交易中找不到本钱包");
  const fee = index === 0 ? BigInt(m.fee) : 0n;
  const tip = m.err ? 0n : BigInt(entry.tipLamports ?? "0");
  const patch: Partial<JournalEntry> = { status: m.err ? "failed" : "confirmed", gasCost: (fee + tip).toString(), feeComplete: true };
  if (m.err) return patch;
  const pre = m.preTokenBalances ?? []; const post = m.postTokenBalances ?? [];
  const owned = new Set([index]);
  for (const b of [...pre, ...post]) if (b.owner === entry.owner) owned.add(Number(b.accountIndex));
  let nativeDelta = 0n;
  for (const i of owned) {
    if (m.preBalances[i] === undefined || m.postBalances[i] === undefined) throw new Error("余额明细缺失");
    nativeDelta += BigInt(m.postBalances[i]) - BigInt(m.preBalances[i]);
  }
  const total = (balances: readonly TokenBalance[]) => balances.filter((b) => b.owner === entry.owner && b.mint === entry.token).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  const before = total(pre); const delta = total(post) - before;
  if (entry.kind === "buy" || entry.kind === "sell") {
    const input = entry.kind === "buy" ? -nativeDelta - fee - tip : -delta;
    const output = entry.kind === "buy" ? delta : nativeDelta + fee + tip;
    if (input <= 0n || output < 0n) throw new Error("成交数量与方向不符，需要人工核对");
    Object.assign(patch, { amountIn: input.toString(), amountOut: output.toString(), balanceBefore: before.toString(), amountOutEstimated: false });
  }
  if (entry.kind === "swap") {
    const deltaOf = (mint: string | undefined) => post.filter((b) => b.owner === entry.owner && b.mint === mint).reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n) - pre.filter((b) => b.owner === entry.owner && b.mint === mint).reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
    const input = entry.token === SOL_MINT ? -nativeDelta - fee - tip : -deltaOf(entry.token);
    const output = entry.outputToken === SOL_MINT ? nativeDelta + fee + tip : deltaOf(entry.outputToken);
    if (input <= 0n || output < 0n) throw new Error("兑换成交方向不符，需要核对");
    Object.assign(patch, { amountIn: input.toString(), amountOut: output.toString(), amountOutEstimated: false });
  }
  return patch;
}

export async function reconcileSol(journal: Journal, rpc: SolRpc): Promise<void> {
  const entries = journal.entries(undefined, "sol").filter((e) => ["preparing", "pending", "unknown"].includes(e.status));
  for (const e of entries.slice(0, 30)) {
    // 没有签名的准备记录不能猜测已发送，更不能重发。
    if (!e.signature) continue;
    try {
      const sig = signature(e.signature);
      const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
      const { value } = await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send();
      const status = value[0];
      if (!status) {
        if (e.lastValidBlockHeight && height > BigInt(e.lastValidBlockHeight)) journal.update(e.id, { status: "failed", feeComplete: true, gasCost: "0" });
        continue;
      }
      if (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized") continue;
      const receipt = await rpc.getTransaction(sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }).send();
      if (receipt) journal.update(e.id, solReceiptPatch(receipt as unknown as SolReceipt, e));
    } catch { /* RPC 限流或成交明细暂缺：保留待核对状态，禁止重发。 */ }
  }
}
