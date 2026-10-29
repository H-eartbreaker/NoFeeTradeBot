import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Hex } from "viem";

export type JournalKind = "buy" | "sell" | "approve" | "transfer" | "swap" | "bridge";
export type JournalEntry = {
  id: string; at: string; chain: string; wallet: string; kind: JournalKind;
  token?: string; hash?: Hex; status: "preparing" | "pending" | "confirmed" | "failed" | "unknown";
  signature?: string; owner?: string; lastValidBlockHeight?: string; tipLamports?: string;
  orderId?: string; autoProgress?: { done: number; peak: string };
  amountIn?: string; amountOut?: string; gasCost?: string; feeComplete?: boolean; recipient?: string;
  destinationChain?: string; requestId?: string; bridgeStatus?: string; decimals?: number; symbol?: string;
  sellPct?: number;
  outputToken?: string; outputSymbol?: string; outputDecimals?: number;
  quotedAmountOut?: string; minimumOut?: string; amountOutEstimated?: boolean;
  balanceBefore?: string;
  outputBalanceBefore?: string;
};

// 只记录公开交易数据和交易编号；不记录私钥、RPC 凭据或已签名交易字节。
export class Journal {
  private records = new Map<string, JournalEntry>();
  private file: string;
  private confirmed?: (entry: JournalEntry) => void;
  constructor(file = "data/trades.jsonl", confirmed?: (entry: JournalEntry) => void) {
    this.file = file;
    this.confirmed = confirmed;
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          const record = JSON.parse(lines[i]) as JournalEntry;
          if (!record.id || !record.chain || !record.wallet) throw new Error("invalid");
          this.records.set(record.id, record);
        } catch {
          throw new Error("交易账本不完整或损坏，请保留原文件并检查，未自动改写");
        }
      }
    }
  }
  start(data: Omit<JournalEntry, "id" | "at" | "status">): string {
    const entry: JournalEntry = { ...data, id: randomUUID(), at: new Date().toISOString(), status: "preparing" };
    this.persist(entry); return entry.id;
  }
  update(id: string, patch: Partial<Omit<JournalEntry, "id">>): void {
    const old = this.records.get(id);
    if (!old) throw new Error("找不到交易记录");
    this.persist({ ...old, ...patch, id });
  }
  entries(wallet?: string, chain?: string): JournalEntry[] {
    return [...this.records.values()].filter((e) => (!wallet || e.wallet === wallet) && (!chain || e.chain === chain)).map((e) => ({ ...e })).reverse();
  }
  pending(wallet: string, chain: string, token?: string): boolean {
    return this.entries(wallet, chain).some((e) => ["pending", "unknown", "preparing"].includes(e.status) && (!token || (chain === "sol" ? e.token === token : e.token?.toLowerCase() === token.toLowerCase())));
  }
  private persist(entry: JournalEntry) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600, flush: true });
    this.records.set(entry.id, entry);
    if (entry.status === "confirmed") this.confirmed?.({ ...entry });
  }
}
