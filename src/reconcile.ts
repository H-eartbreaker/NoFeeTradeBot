import type { Journal, JournalEntry } from "./journal.ts";
import type { State } from "./state.ts";
import { receiptFee } from "./trade.ts";
import type { TradeDeps } from "./trade.ts";

export function applyJournalEntry(state: State, e: JournalEntry): void {
  const id = e.signature ?? e.hash;
  if (e.status !== "confirmed" || !e.token || !id) return;
  if (e.kind === "buy" && e.amountIn) state.recordBuy(e.chain, e.token, BigInt(e.amountIn), e.wallet, id);
  if (e.kind === "sell" && e.sellPct !== undefined) state.recordSell(e.chain, e.token, e.sellPct, e.wallet, id,
    e.balanceBefore && e.amountIn ? { sold: BigInt(e.amountIn), balance: BigInt(e.balanceBefore) } : undefined);
}

// 只读查询已广播交易；不重新签名或广播。hash 去重让 UI 与恢复流程可以安全地同时记账。
export async function reconcile(journal: Journal, state: State, deps: (wallet: string, chain: string) => TradeDeps | undefined): Promise<void> {
  const pending = journal.entries().filter((e) => ["pending", "unknown"].includes(e.status) && e.hash).slice(0, 20);
  await Promise.all(pending.map(async (entry) => {
    const d = deps(entry.wallet, entry.chain); if (!d) return;
    const receipt = await d.clients.publicClient.getTransactionReceipt({ hash: entry.hash! }).catch(() => null);
    if (!receipt) return;
    const fee = receiptFee(receipt);
    journal.update(entry.id, { status: receipt.status === "success" ? "confirmed" : "failed", gasCost: fee.gasCost.toString(), feeComplete: entry.chain === "base" || entry.chain === "rh" ? fee.feeComplete : true });
  }));
  for (const e of journal.entries().reverse()) {
    applyJournalEntry(state, e);
  }
}
