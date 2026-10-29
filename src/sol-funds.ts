import { address } from "@solana/kit";
import type { Instruction, KeyPairSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { holdings, mintInfo, quote, SOL_MINT, TOKEN_PROGRAMS } from "./sol-chain.ts";
import type { SolRpc, Quote } from "./sol-chain.ts";
import { jupiterInstructions, sendSolInstructions } from "./sol-execution.ts";
import type { SolTransactionContext } from "./sol-execution.ts";

export const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export async function transferInstructions(rpc: SolRpc, signer: KeyPairSigner, recipient: string, mint: string, amount: bigint): Promise<Instruction[]> {
  const destination = address(recipient);
  if (destination === signer.address || amount <= 0n) throw new Error("收款地址不能是自己，金额必须大于 0");
  if (mint === SOL_MINT) return [getTransferSolInstruction({ source: signer, destination, amount })];
  const { value: account } = await rpc.getAccountInfo(address(mint), { encoding: "jsonParsed" }).send();
  if (!account || !Object.values(TOKEN_PROGRAMS).some((p) => p === account.owner)) throw new Error("不是支持的 SPL 代币");
  const parsed = account.data as unknown as { parsed?: { info?: { extensions?: unknown[] } } };
  const extensions = parsed.parsed?.info?.extensions ?? [];
  // Hook/转账税/保密账户会改变到账或需要额外账户，不能按普通 SPL 转账静默处理。
  if (account.owner === TOKEN_PROGRAMS.token2022 && extensions.some((v) => !v || typeof v !== "object" || !["metadataPointer", "tokenMetadata"].includes(String((v as { extension?: unknown }).extension)))) throw new Error("该 Token-2022 扩展暂不能安全转账，请使用支持它的钱包");
  const info = await mintInfo(rpc, mint); const program = address(account.owner);
  const [ata] = await findAssociatedTokenPda({ owner: destination, tokenProgram: program, mint: address(mint) });
  const { value: sources } = await rpc.getTokenAccountsByOwner(signer.address, { mint: address(mint) }, { encoding: "jsonParsed" }).send();
  const instructions: Instruction[] = [getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata, owner: destination, mint: address(mint), tokenProgram: program })];
  let remaining = amount;
  for (const source of sources) {
    const data = source.account.data as unknown as { parsed?: { info?: { state?: string; tokenAmount?: { amount?: string }; extensions?: unknown[] } } };
    const details = data.parsed?.info;
    if (details?.state === "frozen") continue;
    if ((details?.extensions?.length ?? 0) > 0) throw new Error("来源代币账户有扩展，需要专门核对，未转出");
    const balance = BigInt(details?.tokenAmount?.amount ?? "0"); const take = balance < remaining ? balance : remaining;
    if (take > 0n) instructions.push(getTransferCheckedInstruction({ source: source.pubkey, mint: address(mint), destination: ata, authority: signer, amount: take, decimals: info.decimals }, { programAddress: program }));
    remaining -= take; if (remaining === 0n) break;
  }
  if (remaining > 0n) throw new Error("代币余额不足，或代币处于冻结状态");
  return instructions;
}

export async function transferSolAsset(rpc: SolRpc, signer: KeyPairSigner, ctx: SolTransactionContext, recipient: string, mint: string, amount: bigint, ensureCurrent = () => {}) {
  const before = mint === SOL_MINT ? undefined : (await holdings(rpc, signer.address)).find((h) => h.mint === mint)?.amount;
  const instructions = await transferInstructions(rpc, signer, recipient, mint, amount);
  return sendSolInstructions(rpc, signer, instructions, [], ctx, { kind: "transfer", token: mint, recipient, amountIn: amount.toString(), balanceBefore: before?.toString() }, ensureCurrent);
}

export async function swapSolAssets(rpc: SolRpc, signer: KeyPairSigner, ctx: SolTransactionContext, input: string, output: string, amount: bigint, slippage: number, ensureCurrent = () => {}, approvedQuote?: Quote) {
  if (input === output || amount <= 0n) throw new Error("兑换币种或金额无效");
  const q = approvedQuote ?? await quote(input, output, amount, slippage);
  if (q.inputMint !== input || q.outputMint !== output || BigInt(q.inAmount) !== amount) throw new Error("报价币种或金额不符");
  const built = await jupiterInstructions(q, signer.address);
  const before = await holdings(rpc, signer.address);
  return sendSolInstructions(rpc, signer, built.instructions, built.tables, ctx, { kind: "swap", token: input, outputToken: output,
    balanceBefore: before.find((h) => h.mint === input)?.amount.toString() ?? "0", outputBalanceBefore: before.find((h) => h.mint === output)?.amount.toString() ?? "0",
    quotedAmountOut: q.outAmount, minimumOut: q.otherAmountThreshold }, ensureCurrent);
}
