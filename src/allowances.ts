import { encodeFunctionData, erc20Abi, isAddress } from "viem";
import type { Address } from "viem";
import { feeBudget } from "./money.ts";
import { queueKey, sendAndWait, serial } from "./trade.ts";
import type { TradeDeps } from "./trade.ts";

export function allowanceOf(d: TradeDeps, token: Address, spender: Address, blockNumber?: bigint): Promise<bigint> {
  return d.clients.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [d.clients.account.address, spender], blockNumber });
}
export function knownSpenders(d: TradeDeps, token: Address): Address[] {
  const found = d.journal?.entries(d.walletId ?? "main", d.chain.key).filter((e) => e.kind === "approve" && e.token?.toLowerCase() === token.toLowerCase()).flatMap((e) => e.recipient && isAddress(e.recipient) ? [e.recipient.toLowerCase() as Address] : []) ?? [];
  return [...new Set(found)];
}
function revokeData(token: Address, spender: Address) {
  if (!isAddress(token) || !isAddress(spender) || /^0x0{40}$/i.test(token) || /^0x0{40}$/i.test(spender)) throw new Error("授权地址无效");
  return { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 0n] }), value: 0n };
}
export async function revokeBudget(d: TradeDeps, token: Address, spender: Address): Promise<bigint> {
  const tx = revokeData(token, spender);
  const [gas, price] = await Promise.all([d.clients.publicClient.estimateGas({ account: d.clients.account.address, ...tx }), d.clients.publicClient.getGasPrice()]);
  return gas * price * 3n;
}
export function revokeAllowance(d: TradeDeps, token: Address, spender: Address, expires: number, budget: bigint) {
  return serial(async () => {
    if (Date.now() >= expires) throw new Error("撤销确认已过期");
    const tx = revokeData(token, spender);
    if (await allowanceOf(d, token, spender) === 0n) return { hash: null, verified: true };
    if (budget <= 0n || await d.clients.publicClient.getBalance({ address: d.clients.account.address }) < budget) throw new Error("Gas 余额或预算不足");
    const result = await sendAndWait(d, tx, feeBudget(expires, budget), { kind: "approve", token, recipient: spender, amountIn: "0" });
    const remaining = await allowanceOf(d, token, spender, result.receipt.blockNumber).catch(() => null);
    return { hash: result.hash, verified: remaining === 0n };
  }, queueKey(d));
}
