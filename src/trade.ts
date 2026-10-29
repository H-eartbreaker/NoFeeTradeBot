import { erc20Abi, maxUint256 } from "viem";
import type { Address, Hex } from "viem";
import type { ChainConfig } from "./chains.ts";
import { NATIVE, buildSwap, getRoute } from "./kyber.ts";
import type { Clients } from "./wallet.ts";

export type TradeDeps = { clients: Clients; chain: ChainConfig };
export type BuyResult = { hash: Hex; received: bigint };
export type SellResult = { hash: Hex; soldAmount: bigint; receivedNative: bigint; approveHash: Hex | null };

let queue: Promise<unknown> = Promise.resolve();
// 同一钱包的交易必须串行，否则连点按钮会产生 nonce 冲突
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
}

function slug(chain: ChainConfig): string {
  if (!chain.kyberSlug) throw new Error(`${chain.label} 暂不支持聚合器报价`);
  return chain.kyberSlug;
}

async function sendAndWait(
  { clients }: TradeDeps,
  tx: { to: Address; data: Hex; value: bigint },
) {
  const { account, publicClient, walletClient } = clients;
  const estimate = await publicClient.estimateGas({ account, ...tx });
  const hash = await walletClient.sendTransaction({ ...tx, gas: (estimate * 12n) / 10n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`交易在链上失败: ${hash}`);
  return { hash, receipt };
}

export function balanceOf(d: TradeDeps, token: Address): Promise<bigint> {
  return d.clients.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [d.clients.account.address],
  });
}

// 授权无限额度给聚合器路由合约（只影响该代币）；已有足够额度则不发交易
async function ensureAllowance(d: TradeDeps, token: Address, spender: Address, needed: bigint): Promise<Hex | null> {
  const { account, publicClient, walletClient } = d.clients;
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, spender],
  });
  if (allowance >= needed) return null;
  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxUint256],
  });
  const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (r.status !== "success") throw new Error(`授权交易失败: ${hash}`);
  return hash;
}

export function buy(d: TradeDeps, token: Address, amountWei: bigint, slippageBps: number): Promise<BuyResult> {
  return serial(async () => {
    const { account, publicClient } = d.clients;
    const native = await publicClient.getBalance({ address: account.address });
    if (native < amountWei + d.chain.gasReserve) {
      throw new Error(`${d.chain.nativeSymbol} 余额不足（需要买入金额 + 少量 gas）`);
    }
    const route = await getRoute(slug(d.chain), NATIVE, token, amountWei);
    const swap = await buildSwap(slug(d.chain), route, account.address, slippageBps);
    const before = await balanceOf(d, token);
    const { hash } = await sendAndWait(d, { to: swap.routerAddress, data: swap.data, value: swap.transactionValue });
    const after = await balanceOf(d, token);
    // 买入后在后台预先授权，之后卖出就省一笔交易；失败不影响买入，卖出时会自动补授权
    void serial(() => ensureAllowance(d, token, swap.routerAddress, after)).catch((e) =>
      console.log("后台预授权失败（卖出时会自动重试）:", e instanceof Error ? e.message.split("\n")[0] : e),
    );
    return { hash, received: after - before };
  });
}

export function sell(d: TradeDeps, token: Address, pct: number, slippageBps: number): Promise<SellResult> {
  return serial(async () => {
    const { account, publicClient } = d.clients;
    const balance = await balanceOf(d, token);
    const amount = (balance * BigInt(pct)) / 100n;
    if (amount <= 0n) throw new Error("没有可卖出的持仓");

    let route = await getRoute(slug(d.chain), token, NATIVE, amount);
    const approveHash = await ensureAllowance(d, token, route.routerAddress, amount);
    if (approveHash) route = await getRoute(slug(d.chain), token, NATIVE, amount);

    const swap = await buildSwap(slug(d.chain), route, account.address, slippageBps);
    const nativeBefore = await publicClient.getBalance({ address: account.address });
    const { hash, receipt } = await sendAndWait(d, {
      to: swap.routerAddress,
      data: swap.data,
      value: swap.transactionValue,
    });
    const nativeAfter = await publicClient.getBalance({ address: account.address });
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    return { hash, soldAmount: amount, receivedNative: nativeAfter - nativeBefore + gasCost, approveHash };
  });
}
