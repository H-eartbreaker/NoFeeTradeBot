import { encodeFunctionData, erc20Abi, isAddress } from "viem";
import type { Address } from "viem";
import type { Asset } from "./assets.ts";
import { assetBalance, verifyAsset } from "./assets.ts";
import { NATIVE, buildSwap, getRoute, routeIdentity } from "./kyber.ts";
import type { Route } from "./kyber.ts";
import { ConfirmedTransactionError, ensureAllowance, executionFee, queueKey, receiptFee, sendAndWait, serial } from "./trade.ts";
import type { PreparedGas, TradeDeps } from "./trade.ts";

export function feeBudget(expires: number, max: bigint): (req: PreparedGas) => void {
  let remaining = max;
  return (req) => {
    if (Date.now() >= expires) throw new Error("资金操作确认已过期，请重新确认");
    const fee = executionFee(req);
    if (fee > remaining) throw new Error("Gas 费用超过确认预算，请重新确认");
    remaining -= fee;
  };
}
export async function swapBudget(d: TradeDeps, route: Route, input: Asset): Promise<bigint> {
  const gas = BigInt(route.routeSummary.gas);
  if (gas <= 0n || gas > 30_000_000n) throw new Error("兑换 Gas 报价无效");
  // 包含执行缓冲和稳定币最多两笔授权；预算不是预扣费用。
  return (gas * 2n + (input.address === NATIVE ? 0n : 200_000n)) * await d.clients.publicClient.getGasPrice() * 2n;
}

export function transferData(asset: Asset, recipient: Address, amount: bigint) {
  if (!isAddress(recipient) || /^0x0{40}$/i.test(recipient)) throw new Error("收款地址无效");
  if (amount <= 0n || amount >= 2n ** 256n) throw new Error("金额无效");
  return asset.address === NATIVE ? { to: recipient, value: amount, data: "0x" as const }
    : { to: asset.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, amount] }) };
}
export async function transferEstimate(d: TradeDeps, asset: Asset, recipient: Address, amount: bigint) {
  await verifyAsset(d, asset);
  const tx = transferData(asset, recipient, amount);
  const [gas, gasPrice] = await Promise.all([d.clients.publicClient.estimateGas({ account: d.clients.account.address, ...tx }), d.clients.publicClient.getGasPrice()]);
  return { tx, gasCost: gas * gasPrice * 3n };
}
export function transfer(d: TradeDeps, asset: Asset, recipient: Address, amount: bigint, expires: number, maxGasCost: bigint) {
  return serial(async () => {
    if (Date.now() >= expires) throw new Error("转账确认已过期");
    const [balance, native] = await Promise.all([assetBalance(d, asset), d.clients.publicClient.getBalance({ address: d.clients.account.address })]);
    if (balance < amount || native < (asset.address === NATIVE ? amount : 0n) + maxGasCost) throw new Error("余额不足，需保留 gas");
    await verifyAsset(d, asset);
    return sendAndWait(d, transferData(asset, recipient, amount), feeBudget(expires, maxGasCost), { kind: "transfer", token: asset.address, amountIn: amount.toString(), recipient, symbol: asset.symbol, decimals: asset.decimals });
  }, queueKey(d));
}
export function swapCurrency(d: TradeDeps, input: Asset, output: Asset, amount: bigint, slip: number, route: Route, expires: number, maxGasCost: bigint) {
  return serial(async () => {
    if (amount <= 0n || !Number.isInteger(slip) || slip < 1 || slip > 9999 || input.address === output.address) throw new Error("兑换参数无效");
    if (Date.now() >= expires) throw new Error("兑换确认已过期");
    const validate = feeBudget(expires, maxGasCost);
    await Promise.all([verifyAsset(d, input), verifyAsset(d, output)]);
    if (await assetBalance(d, input) < amount) throw new Error("兑换余额不足");
    if (await d.clients.publicClient.getBalance({ address: d.clients.account.address }) < (input.address === NATIVE ? amount : 0n) + maxGasCost) throw new Error("原生币余额不足，需保留 Gas 预算");
    const minimum = BigInt(route.routeSummary.amountOut) * BigInt(10000 - slip) / 10000n;
    let fresh = await getRoute(d.chain.kyberSlug!, input.address, output.address, amount);
    if (routeIdentity(fresh) !== routeIdentity(route) || BigInt(fresh.routeSummary.amountOut) < minimum || minimum <= 0n) throw new Error("交易池或报价已变化，请重新确认兑换");
    if (BigInt(fresh.routeSummary.amountIn) !== amount || BigInt(route.routeSummary.amountIn) !== amount) throw new Error("兑换报价输入金额不符");
    if (input.address !== NATIVE) await ensureAllowance(d, input.address, fresh.routerAddress, amount, { exact: true, validate });
    fresh = await getRoute(d.chain.kyberSlug!, input.address, output.address, amount);
    const quoted = BigInt(fresh.routeSummary.amountOut);
    if (routeIdentity(fresh) !== routeIdentity(route) || BigInt(fresh.routeSummary.amountIn) !== amount || quoted < minimum || quoted <= 0n || minimum <= 0n) throw new Error("兑换报价已变化，请重新确认");
    const effectiveSlip = Math.min(slip, Number((quoted - minimum) * 10000n / quoted));
    const built = await buildSwap(d.chain.kyberSlug!, fresh, d.clients.account.address, effectiveSlip);
    if (built.transactionValue !== (input.address === NATIVE ? amount : 0n) || built.routerAddress.toLowerCase() !== fresh.routerAddress.toLowerCase() || built.amountOut < minimum) throw new Error("兑换构建的金额、路由或输出不一致");
    const before = await assetBalance(d, output);
    const result = await sendAndWait(d, { to: built.routerAddress, data: built.data, value: built.transactionValue }, validate,
      { kind: "swap", token: input.address, amountIn: amount.toString(), decimals: input.decimals, symbol: input.symbol, outputToken: output.address, outputDecimals: output.decimals, outputSymbol: output.symbol });
    try {
      const after = await assetBalance(d, output, result.receipt.blockNumber);
      const received = after - before + (output.address === NATIVE ? receiptFee(result.receipt).gasCost : 0n);
      if (received <= 0n) throw new Error("balance lag");
      if (result.journalId) d.journal!.update(result.journalId, { amountOut: received.toString(), amountOutEstimated: output.address === NATIVE });
      return { ...result, received };
    } catch { throw new ConfirmedTransactionError(result.hash); }
  }, queueKey(d));
}
