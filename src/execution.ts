import { createWalletClient, http, parseEther, parseGwei } from "viem";
import type { Hex } from "viem";
import type { TradeDeps, PreparedGas } from "./trade.ts";

export type ExecutionSettings = { mev?: boolean; gasPriceGwei?: string | null; maxTxFee?: string | null };
export const PRIVATE_EVM: Record<string, { label: string; url: string; chainId: number }> = {
  eth: { label: "Flashbots Protect", url: "https://rpc.flashbots.net?hint=hash", chainId: 1 },
  bsc: { label: "48 Club", url: "https://rpc.48.club", chainId: 56 },
};

export function gasOverrides(policy: ExecutionSettings): { gasPrice?: bigint } {
  if (!policy.gasPriceGwei) return {};
  const gasPrice = parseGwei(policy.gasPriceGwei);
  if (gasPrice <= 0n) throw new Error("自定义 Gas 单价必须大于 0");
  return { gasPrice };
}

export function validateExecution(d: TradeDeps, request: PreparedGas): void {
  const policy = d.execution?.() ?? {};
  if (policy.mev && !PRIVATE_EVM[d.chain.key]) throw new Error("本链尚无已验证的私有发送通道，未发送交易");
  if (policy.mev && PRIVATE_EVM[d.chain.key].chainId !== d.chain.viemChain.id) throw new Error("私有发送通道与链 ID 不符");
  if (policy.mev && d.chain.key === "eth" && request.gasPrice === undefined && (request.maxPriorityFeePerGas ?? 0n) <= 0n) {
    throw new Error("Flashbots 要求优先费大于 0，未发送交易");
  }
  if (!policy.maxTxFee) return;
  const cap = parseEther(policy.maxTxFee);
  const price = request.maxFeePerGas ?? request.gasPrice;
  if (cap <= 0n || !request.gas || !price || price <= 0n) throw new Error("无法核对发送费用，未发送交易");
  const buffered = (request.gas * 12n + 9n) / 10n;
  if (buffered * price > cap) throw new Error("预计链上 Gas 超过设置的单笔上限，未发送交易");
  // Base/RH 的额外 L1 数据费目前不在基础 prepareTransactionRequest 中，不能假装有完整费用保证。
  if (["base", "rh"].includes(d.chain.key)) throw new Error("本链额外数据费暂无法完整核对，开启严格费用上限时停止发送");
}

export async function broadcastEvm(
  d: TradeDeps, request: object,
  privateSend?: (url: string, request: object) => Promise<Hex>,
): Promise<Hex> {
  const policy = d.execution?.() ?? {};
  if (!policy.mev) return d.clients.walletClient.sendTransaction(request as never);
  const provider = PRIVATE_EVM[d.chain.key];
  if (!provider || provider.chainId !== d.chain.viemChain.id) throw new Error("本链没有已验证的私有通道；不会转到公开节点发送");
  // 仅一次私有发送；任何失败交给账本待核对逻辑，不公开广播、不更换渠道。
  if (privateSend) return privateSend(provider.url, request);
  const wallet = createWalletClient({ account: d.clients.account, chain: d.chain.viemChain, transport: http(provider.url, { retryCount: 0, timeout: 15_000 }) });
  return wallet.sendTransaction(request as never);
}
