import {
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signTransaction,
} from "@solana/kit";
import type { KeyPairSigner, Signature } from "@solana/kit";
import { holdings, quote, SOL_MINT, solBalance, swapTransaction } from "./sol-chain.ts";
import type { Quote, SolRpc } from "./sol-chain.ts";

export const RESERVE_LAMPORTS = 10_000_000n;
const FEE_FLOOR_LAMPORTS = 5_000_000n;
const CONFIRM_TIMEOUT_MS = 120_000;
const POLL_MS = 2_000;

export class SolTradeError extends Error {}

export class SolPendingError extends Error {
  readonly signature: string;
  constructor(signature: string) {
    super("交易已发出，但在等待时间内没有确认结果");
    this.signature = signature;
  }
}

export type TradeResult = { signature: string; quote: Quote };

const tails = new Map<string, Promise<void>>();

// 同一个钱包的买卖按顺序执行，避免两笔交易抢同一份余额
export function serial<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(task);
  tails.set(key, run.then(() => undefined, () => undefined));
  return run;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execute(rpc: SolRpc, signer: KeyPairSigner, swapQuote: Quote, ensureCurrent: () => void): Promise<Signature> {
  const built = await swapTransaction(swapQuote, signer.address);
  ensureCurrent();
  const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(built.transaction));
  const signed = await signTransaction([signer.keyPair], decoded);
  const signature = getSignatureFromTransaction(signed);
  const wire = getBase64EncodedWireTransaction(signed);
  ensureCurrent();
  try {
    await rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: false, maxRetries: 0n }).send();
  } catch {
    // 发送报错不代表没上链，以签名状态为准
  }
  await awaitLanding(rpc, signature, built.lastValidBlockHeight);
  return signature;
}

// 区块高度在读取签名状态之前读取：过期后仍查不到状态，才能确定交易不会再上链
export async function awaitLanding(rpc: SolRpc, signature: Signature, lastValidBlockHeight: bigint): Promise<void> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let height: bigint;
    let value;
    try {
      height = await rpc.getBlockHeight().send();
      ({ value } = await rpc.getSignatureStatuses([signature]).send());
    } catch {
      // 已广播后的查询失败不等于交易失败，必须保留签名，禁止引导重复发送。
      throw new SolPendingError(signature);
    }
    const status = value[0];
    if (status) {
      if (status.err) throw new SolTradeError("链上交易执行失败，资金基本未变化（可能扣了手续费）");
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return;
    } else if (height > lastValidBlockHeight) {
      throw new SolTradeError("交易已过期未上链，没有成交，可以重新买卖");
    }
    await sleep(POLL_MS);
  }
  throw new SolPendingError(signature);
}

export async function buySol(rpc: SolRpc, signer: KeyPairSigner, mint: string, lamports: bigint, slippageBps: number, approvedQuote?: Quote, ensureCurrent = () => {}): Promise<TradeResult> {
  const balance = await solBalance(rpc, signer.address);
  if (balance < lamports + RESERVE_LAMPORTS) throw new SolTradeError("SOL 余额不足（需要留 0.01 SOL 作为手续费和账户租金）");
  const swapQuote = approvedQuote ?? await quote(SOL_MINT, mint, lamports, slippageBps);
  if (BigInt(swapQuote.inAmount) !== lamports) throw new SolTradeError("报价金额已变化，请重新确认");
  const signature = await execute(rpc, signer, swapQuote, ensureCurrent);
  return { signature, quote: swapQuote };
}

export async function sellToken(rpc: SolRpc, signer: KeyPairSigner, mint: string, pct: number, slippageBps: number, approvedQuote?: Quote, ensureCurrent = () => {}): Promise<TradeResult> {
  if (!Number.isFinite(pct) || pct < 0.01 || pct > 100 || Math.abs(pct * 100 - Math.round(pct * 100)) > 1e-8) throw new SolTradeError("卖出比例无效");
  const balance = await solBalance(rpc, signer.address);
  if (balance < FEE_FLOOR_LAMPORTS) throw new SolTradeError("SOL 余额不足以支付交易费用");
  const held = (await holdings(rpc, signer.address)).find((h) => h.mint === mint);
  if (!held) throw new SolTradeError("当前钱包没有这个代币的余额");
  const amount = (held.amount * BigInt(Math.round(pct * 100))) / 10_000n;
  if (amount <= 0n) throw new SolTradeError("卖出数量为 0");
  const swapQuote = approvedQuote ?? await quote(mint, SOL_MINT, amount, slippageBps);
  if (BigInt(swapQuote.inAmount) !== amount) throw new SolTradeError("持仓数量已变化，请重新确认卖出");
  const signature = await execute(rpc, signer, swapQuote, ensureCurrent);
  return { signature, quote: swapQuote };
}
