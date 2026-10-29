import type { JournalEntry } from "./journal.ts";
import { NATIVE } from "./kyber.ts";

export type TokenBook = { quantity: bigint | null; cost: bigint | null; spent: bigint | null; returned: bigint | null };
const empty = (): TokenBook => ({ quantity: 0n, cost: 0n, spent: 0n, returned: 0n });
function number(s?: string): bigint | null { try { return s !== undefined && /^\d+$/.test(s) ? BigInt(s) : null; } catch { return null; } }

// 输入与 Journal.entries 相同：最新在前。只核算有完整数量与成本链条的部分，不推测旧历史。
export function calculatePnl(entries: readonly JournalEntry[]) {
  const books = new Map<string, TokenBook>();
  const seen = new Set<string>();
  let realized = 0n; let realizedTrades = 0; let unknownSales = 0; let estimated = false; let gas = 0n; let feeComplete = true; let unresolved = 0;
  for (const e of [...entries].reverse()) {
    if (["confirmed", "failed"].includes(e.status) && e.hash) {
      const key = `${e.wallet}:${e.chain}:${e.hash.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (["preparing", "pending", "unknown"].includes(e.status)) unresolved++;
    if (["confirmed", "failed"].includes(e.status)) {
      const fee = number(e.gasCost); if (fee !== null) gas += fee;
      if (fee === null || e.feeComplete !== true) feeComplete = false;
    }
    if (e.status !== "confirmed") continue;
    const isBuy = e.kind === "buy" || (e.kind === "swap" && e.token?.toLowerCase() === NATIVE);
    const isSell = e.kind === "sell" || (e.kind === "swap" && e.outputToken?.toLowerCase() === NATIVE);
    const token = (isBuy && e.kind === "swap" ? e.outputToken : e.token)?.toLowerCase();
    if (!token || token === NATIVE || (!isBuy && !isSell && e.kind !== "transfer")) continue;
    const before = number(isBuy && e.kind === "swap" ? e.outputBalanceBefore : e.balanceBefore);
    let book = books.get(token);
    if (before === 0n) book = empty();
    else if (!book || before === null || book.quantity !== before) book = { quantity: before, cost: null, spent: null, returned: null };
    const input = number(e.amountIn); const output = number(e.amountOut);
    if (isBuy) {
      book.quantity = before !== null && output !== null && output > 0n ? before + output : null;
      if (input !== null && input > 0n && output !== null && output > 0n) {
        if (book.cost !== null) book.cost += input;
        if (book.spent !== null) book.spent += input;
      } else { book.cost = null; book.spent = null; }
    } else {
      const valid = before !== null && before > 0n && input !== null && input > 0n && input <= before;
      const basis = valid && book.cost !== null ? book.cost * input / before : null;
      if (isSell) {
        if (basis !== null && output !== null) { realized += output - basis; realizedTrades++; estimated ||= !!e.amountOutEstimated; }
        else unknownSales++;
        book.returned = book.returned !== null && output !== null ? book.returned + output : null;
      } else { book.spent = null; book.returned = null; }
      book.quantity = valid ? before - input : null;
      book.cost = basis !== null && book.cost !== null ? book.cost - basis : null;
      if (book.quantity === 0n) book = empty();
    }
    books.set(token, book);
  }
  return { books, realized, realizedTrades, unknownSales, estimated, gas, feeComplete, unresolved };
}

export function floatingPnl(book: TokenBook | undefined, balance: bigint, quote: bigint | null): bigint | null {
  return book?.cost !== null && book?.cost !== undefined && book.quantity === balance && quote !== null ? quote - book.cost : null;
}
export function unrecoveredPrincipal(book: TokenBook | undefined, balance: bigint): bigint | null {
  return book && book.quantity === balance && book.spent !== null && book.returned !== null ? (book.spent > book.returned ? book.spent - book.returned : 0n) : null;
}
