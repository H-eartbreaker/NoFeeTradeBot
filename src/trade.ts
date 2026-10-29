import { erc20Abi, maxUint256 } from "viem";
import type { Address, Hex } from "viem";
import type { ChainConfig } from "./chains.ts";
import { NATIVE, buildSwap, getRoute, routeIdentity } from "./kyber.ts";
import type { Clients } from "./wallet.ts";

export type TradeDeps = { clients: Clients; chain: ChainConfig };
export type BuyResult = { hash: Hex; received: bigint; blockNumber: bigint };
export type SellResult = { hash: Hex; soldAmount: bigint; receivedNative: bigint; approveHash: Hex | null; blockNumber: bigint };
export type BuyConfirmation = { route: string; minimumOutput: bigint; expiresAt?: number };

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
  validate?: () => void,
) {
  const { account, publicClient, walletClient } = clients;
  // gas 估算、nonce、手续费并行取回，再一次发出
  const req = await walletClient.prepareTransactionRequest({ account, chain: walletClient.chain, ...tx });
  validate?.();
  const hash = await walletClient.sendTransaction({ ...req, gas: ((req.gas ?? 0n) * 12n) / 10n } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`交易在链上失败: ${hash}`);
  return { hash, receipt };
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
    const { hash, receipt } = await sendAndWait(d, { to: swap.routerAddress, data: swap.data, value: swap.transactionValue }, validate);
    const after = await balanceOf(d, token, receipt.blockNumber);
    // 买入后在后台预先授权，之后卖出就省一笔交易；失败不影响买入，卖出时会自动补授权
    void serial(() => ensureAllowance(d, token, swap.routerAddress, after)).catch((e) =>
      console.log("后台预授权失败（卖出时会自动重试）:", e instanceof Error ? e.message.split("\n")[0] : e),
    );
    return { hash, received: after - before, blockNumber: receipt.blockNumber };
  });
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
    const { hash, receipt } = await sendAndWait(d, {
      to: swap.routerAddress,
      data: swap.data,
      value: swap.transactionValue,
    });
    const nativeAfter = await publicClient.getBalance({ address: account.address, blockNumber: receipt.blockNumber });
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    return { hash, soldAmount: amount, receivedNative: nativeAfter - nativeBefore + gasCost, approveHash, blockNumber: receipt.blockNumber };
  });
}
