import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// cost 是买入花费的原生币（wei，字符串存储）；tp/sl 是百分比，null 表示不启用
export type Position = { wallet: string; chain: string; token: string; cost: bigint; tp: number | null; sl: number | null };
export type Rule = { tp: number | null; sl: number | null };

type StoredPosition = { cost: string; tp: number | null; sl: number | null };
export type ChainSettings = {
  buySlippageBps?: number;
  sellSlippageBps?: number;
  buyAmounts?: string[];
  sellPercentages?: number[];
  buyConfirmation?: boolean;
  quickBuy?: boolean;
};
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
};

const posKey = (chain: string, token: string, wallet = "main") => `${wallet === "main" ? "" : `${wallet}:`}${chain}:${token.toLowerCase()}`;

export class State {
  private data: StateData;
  private file: string;
  private committed: StateData;

  constructor(file: string) {
    this.file = file;
    this.data = { tokens: {}, slippageBps: null, activeChain: null, defaultRule: { tp: null, sl: null }, positions: {}, chainSettings: {}, display: defaultDisplay(), activeWallet: "main", walletTokens: {}, appliedTransactions: [] };
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

  resetChainSettings(chain: string): void {
    delete this.data.chainSettings[chain];
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

  position(chain: string, token: string, wallet = "main"): Position | null {
    const p = this.data.positions[posKey(chain, token, wallet)];
    return p ? { wallet, chain, token: token.toLowerCase(), cost: BigInt(p.cost), tp: p.tp, sl: p.sl } : null;
  }

  positions(): Position[] {
    return Object.entries(this.data.positions).map(([k, p]) => {
      const parts = k.split(":");
      const [wallet, chain, token] = parts.length === 2 ? ["main", ...parts] : parts;
      return { wallet, chain, token, cost: BigInt(p.cost), tp: p.tp, sl: p.sl };
    });
  }

  // 买入后调用：记录代币、累加成本；新仓位套用默认止盈止损，老仓位保留自己的规则
  recordBuy(chain: string, token: string, spent: bigint, wallet = "main", hash?: string): void {
    if (this.applied(chain, wallet, hash)) return;
    token = token.toLowerCase();
    const tokens = wallet === "main" ? this.data.tokens : (this.data.walletTokens[wallet] ??= {});
    const list = (tokens[chain] ??= []);
    if (!list.includes(token)) list.push(token);
    const key = posKey(chain, token, wallet);
    const old = this.data.positions[key];
    this.data.positions[key] = old
      ? { ...old, cost: (BigInt(old.cost) + spent).toString() }
      : { cost: spent.toString(), tp: this.data.defaultRule.tp, sl: this.data.defaultRule.sl };
    this.markApplied(chain, wallet, hash); this.save();
  }

  // 卖出后调用：按比例扣减成本，卖光则删除仓位
  recordSell(chain: string, token: string, pct: number, wallet = "main", hash?: string, fraction?: { sold: bigint; balance: bigint }): void {
    if (this.applied(chain, wallet, hash)) return;
    if (fraction && (fraction.balance <= 0n || fraction.sold <= 0n || fraction.sold > fraction.balance)) throw new Error("卖出数量与余额不符");
    const key = posKey(chain, token, wallet);
    const old = this.data.positions[key];
    if (fraction ? fraction.sold === fraction.balance : pct >= 100) delete this.data.positions[key];
    else if (old) old.cost = (fraction ? BigInt(old.cost) * (fraction.balance - fraction.sold) / fraction.balance : (BigInt(old.cost) * BigInt(10_000 - Math.round(pct * 100))) / 10_000n).toString();
    this.markApplied(chain, wallet, hash); this.save();
  }

  private applied(chain: string, wallet: string, hash?: string): boolean {
    return !!hash && this.data.appliedTransactions.includes(`${wallet}:${chain}:${hash.toLowerCase()}`);
  }
  private markApplied(chain: string, wallet: string, hash?: string): void {
    if (hash) this.data.appliedTransactions.push(`${wallet}:${chain}:${hash.toLowerCase()}`);
  }

  removePosition(chain: string, token: string, wallet = "main"): void {
    if (delete this.data.positions[posKey(chain, token, wallet)]) this.save();
  }

  setRule(chain: string, token: string, rule: Rule, wallet = "main"): void {
    const p = this.data.positions[posKey(chain, token, wallet)];
    if (!p) return;
    p.tp = rule.tp;
    p.sl = rule.sl;
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
