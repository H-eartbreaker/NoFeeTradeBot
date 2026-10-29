import { erc20Abi, maxUint256 } from "viem";
import type { Address, Hex } from "viem";
import type { ChainConfig } from "./chains.ts";
import { NATIVE, buildSwap, getRoute, routeIdentity } from "./kyber.ts";
import type { Clients } from "./wallet.ts";
import type { Journal, JournalKind } from "./journal.ts";

export type TradeDeps = { clients: Clients; chain: ChainConfig; walletId?: string; journal?: Journal };
export type BuyResult = { hash: Hex; received: bigint; blockNumber: bigint };
export type SellResult = { hash: Hex; soldAmount: bigint; receivedNative: bigint; approveHash: Hex | null; blockNumber: bigint };
export type BuyConfirmation = { route: string; minimumOutput: bigint; expiresAt?: number };

const queues = new Map<string, Promise<unknown>>();
// 同一钱包的交易必须串行，否则连点按钮会产生 nonce 冲突
export function serial<T>(fn: () => Promise<T>, key = "default"): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}
export const queueKey = (d: TradeDeps) => `${d.chain.viemChain.id}:${d.clients.account.address.toLowerCase()}`;

export class PendingTransactionError extends Error {
  hash?: Hex;
  constructor(hash?: Hex) { super(`交易提交结果待确认，请勿重复操作${hash ? `：${hash}` : "，请先核对钱包交易记录"}`); this.hash = hash; }
}
export class ConfirmedTransactionError extends Error {
  hash: Hex;
  constructor(hash: Hex) { super(`交易已在链上成功，但到账数据暂未读全，请勿重复操作：${hash}`); this.hash = hash; }
}

export function receiptFee(receipt: { gasUsed: bigint; effectiveGasPrice: bigint; l1Fee?: bigint | string }): { gasCost: bigint; feeComplete: boolean } {
  return { gasCost: receipt.gasUsed * receipt.effectiveGasPrice + BigInt(receipt.l1Fee ?? 0), feeComplete: receipt.l1Fee !== undefined };
}

function slug(chain: ChainConfig): string {
  if (!chain.kyberSlug) throw new Error(`${chain.label} 暂不支持聚合器报价`);
  return chain.kyberSlug;
}

export async function sendAndWait(
  d: TradeDeps,
  tx: { to: Address; data: Hex; value: bigint },
  validate?: (request: { gas?: bigint; maxFeePerGas?: bigint; gasPrice?: bigint }) => void,
  details?: { kind: JournalKind; token?: string; amountIn?: string; recipient?: string; destinationChain?: string; requestId?: string; sellPct?: number },
) {
  const { clients, journal } = d;
  const { account, publicClient, walletClient } = clients;
  if (journal?.pending(d.walletId ?? "main", d.chain.key)) throw new PendingTransactionError();
  // gas 估算、nonce、手续费并行取回，再一次发出
  const req = await walletClient.prepareTransactionRequest({ account, chain: walletClient.chain, ...tx });
  validate?.(req);
  const journalId = journal && details ? journal.start({ chain: d.chain.key, wallet: d.walletId ?? "main", ...details }) : undefined;
  let hash: Hex | undefined;
  let reverted = false;
  try {
    hash = await walletClient.sendTransaction({ ...req, gas: ((req.gas ?? 0n) * 12n) / 10n } as never);
    if (journalId) journal!.update(journalId, { hash, status: "pending" });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
    reverted = receipt.status !== "success";
    const fee = receiptFee(receipt);
    if (journalId) journal!.update(journalId, { status: receipt.status === "success" ? "confirmed" : "failed", gasCost: fee.gasCost.toString(), feeComplete: d.chain.key === "base" || d.chain.key === "rh" ? fee.feeComplete : true });
    if (receipt.status !== "success") throw new Error(`交易在链上失败: ${hash}`);
    return { hash, receipt, journalId };
  } catch (error) {
    if (reverted) throw error;
    if (journalId) {
      try { journal!.update(journalId, { hash, status: hash ? "pending" : "unknown" }); } catch { console.error("交易账本更新失败，请先核对链上记录，勿重复操作"); }
    }
    throw new PendingTransactionError(hash);
  }
}

export function balanceOf(d: TradeDeps, token: Address, blockNumber?: bigint): Promise<bigint> {
  return d.clients.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [d.clients.account.address],
    blockNumber,
  });
}

// 授权无限额度给聚合器路由合约（只影响该代币）；已有足够额度则不发交易
export async function ensureAllowance(d: TradeDeps, token: Address, spender: Address, needed: bigint): Promise<Hex | null> {
  const { account, publicClient, walletClient } = d.clients;
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, spender],
  });
  if (allowance >= needed) return null;
  const { encodeFunctionData } = await import("viem");
  const { hash } = await sendAndWait(d, { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] }), value: 0n }, undefined, { kind: "approve", token, recipient: spender });
  return hash;
}

// gate: 发送交易前必须通过的检查（如貔貅检测），和报价、生成交易数据并行进行以省时间
export function buy(d: TradeDeps, token: Address, amountWei: bigint, slippageBps: number, gate?: Promise<unknown> | (() => Promise<unknown>), confirmation?: BuyConfirmation): Promise<BuyResult> {
  return serial(async () => {
    if (amountWei <= 0n) throw new Error("买入金额必须大于 0");
    const validate = () => {
      if (confirmation?.expiresAt !== undefined && Date.now() >= confirmation.expiresAt) throw new Error("买入确认已过期，请重新确认");
    };
    validate();
    const { account, publicClient } = d.clients;
    const validation = typeof gate === "function" ? gate() : gate;
    validation?.catch(() => undefined);
    const prep = (async () => {
      const route = await getRoute(slug(d.chain), NATIVE, token, amountWei);
      if (confirmation && routeIdentity(route) !== confirmation.route) {
        throw new Error("交易池或路由已变化，请重新点买入并确认");
      }
      const out = BigInt(route.routeSummary.amountOut);
      if (out <= 0n || BigInt(route.routeSummary.amountIn) !== amountWei) throw new Error("报价金额不正确，请重新报价");
      if (confirmation && out < confirmation.minimumOutput) throw new Error("价格已超出确认时的滑点范围，请重新确认");
      // 新报价也不能把确认页的最低可接受数量进一步降低。
      const effectiveSlippage = confirmation ? Math.min(slippageBps, Number((out - confirmation.minimumOutput) * 10_000n / out)) : slippageBps;
      const swap = await buildSwap(slug(d.chain), route, account.address, effectiveSlippage);
      if (swap.transactionValue !== amountWei || swap.routerAddress.toLowerCase() !== route.routerAddress.toLowerCase()) throw new Error("构建交易的金额或路由不一致，已拒绝发送");
      if (swap.amountOut <= 0n || (confirmation && swap.amountOut < confirmation.minimumOutput)) throw new Error("构建交易的输出低于确认范围，已拒绝发送");
      return swap;
    })();
    const [native, before, swap] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      balanceOf(d, token),
      prep,
      validation,
    ]).then(([a, b, c]) => [a, b, c] as const);
    if (native < amountWei + d.chain.gasReserve) {
      throw new Error(`${d.chain.nativeSymbol} 余额不足（需要买入金额 + 少量 gas）`);
    }
    const { hash, receipt, journalId } = await sendAndWait(d, { to: swap.routerAddress, data: swap.data, value: swap.transactionValue }, validate, { kind: "buy", token, amountIn: amountWei.toString() });
    let after: bigint;
    try {
      after = await balanceOf(d, token, receipt.blockNumber);
      if (journalId) d.journal!.update(journalId, { amountOut: (after - before).toString() });
    } catch { throw new ConfirmedTransactionError(hash); }
    // 买入后在后台预先授权，之后卖出就省一笔交易；失败不影响买入，卖出时会自动补授权
    void serial(() => ensureAllowance(d, token, swap.routerAddress, after), queueKey(d)).catch((e) =>
      console.log("后台预授权失败（卖出时会自动重试）:", e instanceof Error ? e.message.split("\n")[0] : e),
    );
    return { hash, received: after - before, blockNumber: receipt.blockNumber };
  }, queueKey(d));
}

export function sell(d: TradeDeps, token: Address, pct: number, slippageBps: number): Promise<SellResult> {
  return serial(async () => {
    if (!Number.isFinite(pct) || pct < 0.01 || pct > 100) throw new Error("卖出比例必须在 0.01～100% 之间");
    const { account, publicClient } = d.clients;
    // 免费节点可能落后一个区块，刚买完查到 0 时稍等重试几次
    let balance = await balanceOf(d, token);
    for (let i = 0; i < 3 && balance === 0n; i++) {
      await new Promise((r) => setTimeout(r, 500));
      balance = await balanceOf(d, token);
    }
    const amount = (balance * BigInt(Math.round(pct * 100))) / 10_000n;
    if (amount <= 0n) throw new Error("没有可卖出的持仓");

    let route = await getRoute(slug(d.chain), token, NATIVE, amount);
    const approveHash = await ensureAllowance(d, token, route.routerAddress, amount);
    if (approveHash) route = await getRoute(slug(d.chain), token, NATIVE, amount);

    const [swap, nativeBefore] = await Promise.all([
      buildSwap(slug(d.chain), route, account.address, slippageBps),
      publicClient.getBalance({ address: account.address }),
    ]);
    if (swap.transactionValue !== 0n || swap.routerAddress.toLowerCase() !== route.routerAddress.toLowerCase()) throw new Error("卖出交易金额或路由不一致，已拒绝发送");
    const { hash, receipt, journalId } = await sendAndWait(d, {
      to: swap.routerAddress,
      data: swap.data,
      value: swap.transactionValue,
    }, undefined, { kind: "sell", token, amountIn: amount.toString(), sellPct: pct });
    let nativeAfter: bigint;
    try { nativeAfter = await publicClient.getBalance({ address: account.address, blockNumber: receipt.blockNumber }); }
    catch { throw new ConfirmedTransactionError(hash); }
    const gasCost = receiptFee(receipt).gasCost;
    if (journalId) d.journal!.update(journalId, { amountOut: (nativeAfter - nativeBefore + gasCost).toString() });
    return { hash, soldAmount: amount, receivedNative: nativeAfter - nativeBefore + gasCost, approveHash, blockNumber: receipt.blockNumber };
  }, queueKey(d));
}
