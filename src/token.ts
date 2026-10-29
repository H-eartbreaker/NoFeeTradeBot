import { erc20Abi, parseAbi } from "viem";
import type { Address } from "viem";
import type { Clients } from "./wallet.ts";

export type TokenInfo = { address: Address; name: string; symbol: string; decimals: number; balance: bigint };

export async function readToken(c: Clients, token: Address, blockNumber?: bigint): Promise<TokenInfo | null> {
  const code = await c.publicClient.getCode({ address: token, blockNumber });
  if (!code || code === "0x") return null;

  const [name, symbol, decimals, balance] = await c.publicClient.multicall({
    allowFailure: true,
    blockNumber,
    contracts: [
      { address: token, abi: erc20Abi, functionName: "name" },
      { address: token, abi: erc20Abi, functionName: "symbol" },
      { address: token, abi: erc20Abi, functionName: "decimals" },
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [c.account.address] },
    ],
  });
  if (decimals.status !== "success" || balance.status !== "success") return null;

  return {
    address: token,
    name: name.status === "success" ? name.result : "?",
    symbol: symbol.status === "success" ? symbol.result : "?",
    decimals: decimals.result,
    balance: balance.result,
  };
}

const ownerAbi = parseAbi(["function owner() view returns (address)"]);
// 没有 owner() 或读取失败时返回 null；权限已放弃时返回零地址
export async function readOwner(c: Clients, token: Address, blockNumber?: bigint): Promise<string | null> {
  try {
    return await c.publicClient.readContract({ address: token, abi: ownerAbi, functionName: "owner", blockNumber });
  } catch {
    return null;
  }
}
