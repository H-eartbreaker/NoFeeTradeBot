import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type OrderKind = "limit-buy" | "limit-sell" | "mcap-buy" | "mcap-sell" | "dca";
export type OrderStatus = "active" | "paused" | "executing" | "needs-check" | "done" | "cancelled" | "failed";
export type Order = {
  id: string;
  kind: OrderKind;
  wallet: string;
  chain: string;
  token: string;
  symbol: string;
  decimals: number;
  status: OrderStatus;
  createdAt: number;
  expiresAt: number | null;
  // 限价和市值单：单价为原生币 wei / 每个完整代币；市值为原生币 wei
  target: string | null;
  // 买入和定投：每次花费的原生币 wei；卖出单为 "0"
  amount: string;
  pct: number | null;
  intervalMs: number | null;
  runsLeft: number | null;
  nextRunAt: number | null;
  spent: string;
  runs: number;
  skipped: number;
  failures: number;
  note: string;
  lastHash: string | null;
};

export const MAX_OPEN_ORDERS = 20;
export const ORDER_TTL_MS = 7 * 24 * 60 * 60_000;
export const TERMINAL: OrderStatus[] = ["done", "cancelled", "failed"];
export const isOpen = (o: Order) => !TERMINAL.includes(o.status);
export const isBuyKind = (k: OrderKind) => k === "limit-buy" || k === "mcap-buy" || k === "dca";
export const isMcapKind = (k: OrderKind) => k === "mcap-buy" || k === "mcap-sell";
export const KIND_LABEL: Record<OrderKind, string> = {
  "limit-buy": "限价买入", "limit-sell": "限价卖出", "mcap-buy": "市值买入", "mcap-sell": "市值卖出", "dca": "定投买入",
};
export const STATUS_LABEL: Record<OrderStatus, string> = {
  active: "运行中", paused: "已暂停", executing: "执行中", "needs-check": "待核对链上结果", done: "已完成", cancelled: "已取消", failed: "失败",
};

const scale = (decimals: number) => 10n ** BigInt(decimals);

// 当前值：市值单用市值，其他用单价（都是原生币 wei）
export function metricValue(kind: OrderKind, price: bigint, supply: bigint, decimals: number): bigint {
  return isMcapKind(kind) ? (price * supply) / scale(decimals) : price;
}

// 把用户输入的目标（单价或市值）换算成单价，用来计算最低可接受数量
export function targetPrice(kind: OrderKind, target: bigint, supply: bigint, decimals: number): bigint {
  if (!isMcapKind(kind)) return target;
  if (supply <= 0n) throw new Error("无法读取代币总量，不能按市值下单");
  const numerator = target * scale(decimals);
  return isBuyKind(kind) ? numerator / supply : (numerator + supply - 1n) / supply;
}

export function triggered(kind: OrderKind, current: bigint, target: bigint): boolean {
  return isBuyKind(kind) ? current <= target : current >= target;
}

export function minimumTokensOut(amount: bigint, price: bigint, decimals: number): bigint {
  return price > 0n ? (amount * scale(decimals) + price - 1n) / price : 0n;
}

export function minimumNativeOut(sold: bigint, price: bigint, decimals: number): bigint {
  const unit = scale(decimals);
  return (sold * price + unit - 1n) / unit;
}

export function nextSlot(from: number, intervalMs: number, now: number): number {
  let next = from + intervalMs;
  while (next <= now) next += intervalMs;
  return next;
}

export class OrderStore {
  private data: Order[];
  private file: string;
  private committed: Order[];

  constructor(file: string) {
    this.file = file;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { orders?: Order[] };
      this.data = Array.isArray(parsed.orders) ? parsed.orders : [];
    } catch (error) {
      if (existsSync(file)) throw new Error("订单文件无法读取或已损坏，请保留原文件并检查，未自动改写");
      this.data = [];
    }
    this.committed = structuredClone(this.data);
  }

  list(): Order[] {
    return structuredClone(this.data);
  }

  get(id: string): Order | undefined {
    const found = this.data.find((o) => o.id === id);
    return found ? structuredClone(found) : undefined;
  }

  openCount(): number {
    return this.data.filter(isOpen).length;
  }

  add(order: Order): void {
    if (this.data.some((o) => o.id === order.id)) throw new Error("订单 ID 已存在，不能重复创建");
    if (this.openCount() >= MAX_OPEN_ORDERS) throw new Error(`进行中的订单已达 ${MAX_OPEN_ORDERS} 个上限，请先取消或完成部分订单`);
    this.data.push(structuredClone(order));
    this.save();
  }

  update(id: string, patch: Partial<Order>): void {
    const found = this.data.find((o) => o.id === id);
    if (!found) throw new Error("订单不存在");
    Object.assign(found, structuredClone(patch));
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ orders: this.data }, null, 2));
      renameSync(tmp, this.file);
      this.committed = structuredClone(this.data);
    } catch (error) {
      this.data = structuredClone(this.committed);
      throw error;
    }
  }
}
