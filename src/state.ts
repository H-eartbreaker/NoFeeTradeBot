import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RuleKind, Tier } from "./auto-rules.ts";
import type { RiskFilter } from "./risk-policy.ts";
import type { ExecutionSettings } from "./execution.ts";

// cost 是买入花费的原生币（wei，字符串存储）；tp/sl/trail 是百分比，null 表示不启用
// tiers 是分档止盈（at 为涨幅%，pct 为卖出当前余额的%）；done 为已执行档数；peak 为观察到的最高价值（wei）
export type Position = { wallet: string; chain: string; token: string; cost: bigint; tp: number | null; sl: number | null; tiers: Tier[]; trail: number | null; done: number; peak: bigint; paused: RuleKind[] };
export type Rule = { tp: number | null; sl: number | null; tiers?: Tier[]; trail?: number | null };

type StoredPosition = { cost: string; tp: number | null; sl: number | null; tiers?: Tier[]; trail?: number | null; done?: number; peak?: string; paused?: RuleKind[] };
export type ChainSettings = {
  buySlippageBps?: number;
  sellSlippageBps?: number;
  buyAmounts?: string[];
  sellPercentages?: number[];
  buyConfirmation?: boolean;
  quickBuy?: boolean;
  risk?: RiskFilter;
  execution?: ExecutionSettings;
  autoRule?: Rule;
};
export type Blacklist = { tokens: string[]; developers: string[] };
export type TrackedWallet = { address: string; label: string };
export type DisplaySettings = { showChart: boolean; showExplorer: boolean; timeZone: string; hour12: boolean };
export type ChainLogo = { chain?: string; native?: string };
const defaultDisplay = (): DisplaySettings => ({ showChart: true, showExplorer: true, timeZone: "Asia/Shanghai", hour12: false });
type StateData = {
  tokens: Record<string, string[]>;
  slippageBps: number | null;
  activeChain: string | null;
  defaultRule: Rule;
  positions: Record<string, StoredPosition>;
  chainSettings: Record<string, ChainSettings>;
  display: DisplaySettings;
  activeWallet: string;
  walletTokens: Record<string, Record<string, string[]>>;
  appliedTransactions: string[];
  logos?: { enabled: boolean; chains: Record<string, ChainLogo> };
  autoPaused?: boolean;
  blacklist: Blacklist;
  tracked?: TrackedWallet[];
  solanaSlippageBps: number;
};

const legacyTiers = (tp: number | null): Tier[] => (tp === null ? [] : [{ at: tp, pct: 100 }]);
const toPosition = (wallet: string, chain: string, token: string, p: StoredPosition): Position => ({
  wallet, chain, token, cost: BigInt(p.cost), tp: p.tp, sl: p.sl, tiers: p.tiers ?? legacyTiers(p.tp), trail: p.trail ?? null, done: p.done ?? 0, peak: BigInt(p.peak ?? "0"), paused: p.paused ?? [],
});

export const chainKey = (chain: string, value: string) => chain === "sol" ? value : value.toLowerCase();
const posKey = (chain: string, token: string, wallet = "main") => `${wallet === "main" ? "" : `${wallet}:`}${chain}:${chainKey(chain, token)}`;

export class State {
  private data: StateData;
  private file: string;
  private committed: StateData;

  constructor(file: string) {
    this.file = file;
    this.data = { tokens: {}, slippageBps: null, activeChain: null, defaultRule: { tp: null, sl: null }, positions: {}, chainSettings: {}, display: defaultDisplay(), activeWallet: "main", walletTokens: {}, appliedTransactions: [], autoPaused: false, blacklist: { tokens: [], developers: [] }, tracked: [], solanaSlippageBps: 100 };
    try {
      const p = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      // 旧版本的 tokens 是数组（只有 BSC）
      const tokens = Array.isArray(p.tokens) ? { bsc: p.tokens as string[] } : ((p.tokens ?? {}) as Record<string, string[]>);
      this.data = {
        tokens,
        slippageBps: (p.slippageBps as number | null) ?? null,
        activeChain: (p.activeChain as string | null) ?? null,
        defaultRule: (p.defaultRule as Rule | undefined) ?? { tp: null, sl: null },
        positions: (p.positions as Record<string, StoredPosition> | undefined) ?? {},
        chainSettings: (p.chainSettings as Record<string, ChainSettings> | undefined) ?? {},
        display: { ...defaultDisplay(), ...(p.display as Partial<DisplaySettings> | undefined) },
        activeWallet: typeof p.activeWallet === "string" ? p.activeWallet : "main",
        walletTokens: (p.walletTokens as StateData["walletTokens"] | undefined) ?? {},
        appliedTransactions: (p.appliedTransactions as string[] | undefined) ?? [],
        logos: p.logos as StateData["logos"],
        autoPaused: p.autoPaused === true,
        blacklist: { tokens: [], developers: [], ...(p.blacklist as Partial<Blacklist> | undefined) },
        tracked: Array.isArray(p.tracked) ? (p.tracked as TrackedWallet[]) : [],
        solanaSlippageBps: Number.isInteger(p.solanaSlippageBps) ? (p.solanaSlippageBps as number) : 100,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("本地状态文件无法读取或已损坏，请保留原文件并检查，未自动改写");
    }
    this.committed = structuredClone(this.data);
  }

  get slippageBps(): number | null {
    return this.data.slippageBps;
  }

  setSlippage(bps: number): void {
    this.data.slippageBps = bps;
    this.save();
  }

  chainSettings(chain: string): ChainSettings {
    return structuredClone(this.data.chainSettings[chain] ?? {});
  }

  setChainSettings(chain: string, patch: Partial<ChainSettings>): void {
    this.data.chainSettings[chain] = { ...this.data.chainSettings[chain], ...structuredClone(patch) };
    this.save();
  }

  // 风控过滤属于安全设置，不随“恢复本链默认”一起清除
  resetChainSettings(chain: string): void {
    const { risk, execution } = this.data.chainSettings[chain] ?? {};
    delete this.data.chainSettings[chain];
    if (risk || execution) this.data.chainSettings[chain] = { ...(risk ? { risk } : {}), ...(execution ? { execution } : {}) };
    this.save();
  }

  isBlacklisted(kind: "token" | "developer", chain: string, address: string): boolean {
    const list = kind === "token" ? this.data.blacklist.tokens : this.data.blacklist.developers;
    return list.includes(`${chain}:${chainKey(chain, address)}`);
  }

  setBlacklisted(kind: "token" | "developer", chain: string, address: string, on: boolean): void {
    const list = kind === "token" ? this.data.blacklist.tokens : this.data.blacklist.developers;
    const key = `${chain}:${chainKey(chain, address)}`;
    const next = list.filter((x) => x !== key);
    if (on) next.push(key);
    if (kind === "token") this.data.blacklist.tokens = next; else this.data.blacklist.developers = next;
    this.save();
  }

  trackedWallets(): TrackedWallet[] {
    return structuredClone(this.data.tracked ?? []);
  }

  setTracked(list: TrackedWallet[]): void {
    this.data.tracked = structuredClone(list);
    this.save();
  }

  get solanaSlippageBps(): number {
    return this.data.solanaSlippageBps;
  }

  setSolanaSlippageBps(bps: number): void {
    this.data.solanaSlippageBps = bps;
    this.save();
  }

  get display(): DisplaySettings {
    return { ...this.data.display };
  }

  setDisplay(patch: Partial<DisplaySettings>): void {
    this.data.display = { ...this.data.display, ...patch };
    this.save();
  }

  get activeChain(): string | null {
    return this.data.activeChain;
  }

  setActiveChain(key: string): void {
    this.data.activeChain = key;
    this.save();
  }
  get activeWallet(): string { return this.data.activeWallet; }
  setActiveWallet(id: string): void { this.data.activeWallet = id; this.save(); }

  get logos(): { enabled: boolean; chains: Record<string, ChainLogo> } {
    return structuredClone(this.data.logos ?? { enabled: true, chains: {} });
  }
  setLogos(patch: { enabled?: boolean; chains?: Record<string, ChainLogo> }): void {
    this.data.logos = { ...this.logos, ...structuredClone(patch) }; this.save();
  }

  get defaultRule(): Rule {
    return this.data.defaultRule;
  }

  setDefaultRule(rule: Rule): void {
    this.data.defaultRule = rule;
    this.save();
  }

  tokens(chain: string, wallet = "main"): string[] {
    return (wallet === "main" ? this.data.tokens : this.data.walletTokens[wallet])?.[chain] ?? [];
  }

  get autoPaused(): boolean {
    return this.data.autoPaused === true;
  }

  setAutoPaused(paused: boolean): void {
    this.data.autoPaused = paused;
    this.save();
  }

  position(chain: string, token: string, wallet = "main"): Position | null {
    const p = this.data.positions[posKey(chain, token, wallet)];
    return p ? toPosition(wallet, chain, chainKey(chain, token), p) : null;
  }

  positions(): Position[] {
    return Object.entries(this.data.positions).map(([k, p]) => {
      const parts = k.split(":");
      const [wallet, chain, token] = parts.length === 2 ? ["main", ...parts] : parts;
      return toPosition(wallet, chain, token, p);
    });
  }

  // 买入后调用：记录代币、累加成本；新仓位套用默认止盈止损，老仓位保留自己的规则
  recordBuy(chain: string, token: string, spent: bigint, wallet = "main", hash?: string): void {
    if (this.applied(chain, wallet, hash)) return;
    token = chainKey(chain, token);
    const tokens = wallet === "main" ? this.data.tokens : (this.data.walletTokens[wallet] ??= {});
    const list = (tokens[chain] ??= []);
    if (!list.includes(token)) list.push(token);
    const key = posKey(chain, token, wallet);
    const old = this.data.positions[key];
    const rule = this.data.chainSettings[chain]?.autoRule ?? (chain === "sol" ? { tp: null, sl: null } : this.data.defaultRule);
    this.data.positions[key] = old
      ? { ...old, cost: (BigInt(old.cost) + spent).toString() }
      : { cost: spent.toString(), tp: rule.tp, sl: rule.sl, tiers: rule.tiers ?? legacyTiers(rule.tp), trail: rule.trail ?? null, done: 0, paused: [] };
    this.markApplied(chain, wallet, hash); this.save();
  }

  // 卖出后调用：按比例扣减成本，卖光则删除仓位
  // progress 与成本扣减一起保存，避免崩溃后同一档止盈被重复执行
  recordSell(chain: string, token: string, pct: number, wallet = "main", hash?: string, fraction?: { sold: bigint; balance: bigint }, progress?: { done: number; peak: bigint }): void {
    if (this.applied(chain, wallet, hash)) return;
    if (fraction && (fraction.balance <= 0n || fraction.sold <= 0n || fraction.sold > fraction.balance)) throw new Error("卖出数量与余额不符");
    const key = posKey(chain, token, wallet);
    const old = this.data.positions[key];
    if (fraction ? fraction.sold === fraction.balance : pct >= 100) delete this.data.positions[key];
    else if (old) {
      old.cost = (fraction ? BigInt(old.cost) * (fraction.balance - fraction.sold) / fraction.balance : (BigInt(old.cost) * BigInt(10_000 - Math.round(pct * 100))) / 10_000n).toString();
      if (progress) { old.done = progress.done; old.peak = progress.peak.toString(); }
    }
    this.markApplied(chain, wallet, hash); this.save();
  }

  setAutoProgress(chain: string, token: string, wallet: string, progress: { done?: number; peak?: bigint }): void {
    const old = this.data.positions[posKey(chain, token, wallet)];
    if (!old) return;
    if (progress.done !== undefined) old.done = progress.done;
    if (progress.peak !== undefined) old.peak = progress.peak.toString();
    this.save();
  }

  private applied(chain: string, wallet: string, hash?: string): boolean {
    return !!hash && this.data.appliedTransactions.includes(`${wallet}:${chain}:${chainKey(chain, hash)}`);
  }
  private markApplied(chain: string, wallet: string, hash?: string): void {
    if (hash) this.data.appliedTransactions.push(`${wallet}:${chain}:${chainKey(chain, hash)}`);
  }

  removePosition(chain: string, token: string, wallet = "main"): void {
    if (delete this.data.positions[posKey(chain, token, wallet)]) this.save();
  }

  setRule(chain: string, token: string, rule: Rule, wallet = "main"): void {
    const p = this.data.positions[posKey(chain, token, wallet)];
    if (!p) return;
    p.tp = rule.tp;
    p.sl = rule.sl;
    p.tiers = rule.tiers ?? legacyTiers(rule.tp);
    p.trail = rule.trail ?? null;
    p.done = 0;
    p.peak = "0";
    p.paused = [];
    this.save();
  }

  setRulePaused(chain: string, token: string, wallet: string, kind: RuleKind, paused: boolean): void {
    const stored = this.data.positions[posKey(chain, token, wallet)];
    if (!stored) return;
    const current = new Set(stored.paused ?? []);
    if (paused) current.add(kind); else current.delete(kind);
    stored.paused = [...current];
    this.save();
  }

  private save(): void {
    try {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
    this.committed = structuredClone(this.data);
    } catch (error) { this.data = structuredClone(this.committed); throw error; }
  }
}
