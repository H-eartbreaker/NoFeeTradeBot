import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// cost 是买入花费的原生币（wei，字符串存储）；tp/sl 是百分比，null 表示不启用
export type Position = { chain: string; token: string; cost: bigint; tp: number | null; sl: number | null };
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
const defaultDisplay = (): DisplaySettings => ({ showChart: true, showExplorer: true, timeZone: "Asia/Shanghai", hour12: false });
type StateData = {
  tokens: Record<string, string[]>;
  slippageBps: number | null;
  activeChain: string | null;
  defaultRule: Rule;
  positions: Record<string, StoredPosition>;
  chainSettings: Record<string, ChainSettings>;
  display: DisplaySettings;
};

const posKey = (chain: string, token: string) => `${chain}:${token.toLowerCase()}`;

export class State {
  private data: StateData;
  private file: string;

  constructor(file: string) {
    this.file = file;
    this.data = { tokens: {}, slippageBps: null, activeChain: null, defaultRule: { tp: null, sl: null }, positions: {}, chainSettings: {}, display: defaultDisplay() };
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
      };
    } catch {
      // 首次运行或文件损坏：从空状态开始
    }
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

  get defaultRule(): Rule {
    return this.data.defaultRule;
  }

  setDefaultRule(rule: Rule): void {
    this.data.defaultRule = rule;
    this.save();
  }

  tokens(chain: string): string[] {
    return this.data.tokens[chain] ?? [];
  }

  position(chain: string, token: string): Position | null {
    const p = this.data.positions[posKey(chain, token)];
    return p ? { chain, token: token.toLowerCase(), cost: BigInt(p.cost), tp: p.tp, sl: p.sl } : null;
  }

  positions(): Position[] {
    return Object.entries(this.data.positions).map(([k, p]) => {
      const i = k.indexOf(":");
      return { chain: k.slice(0, i), token: k.slice(i + 1), cost: BigInt(p.cost), tp: p.tp, sl: p.sl };
    });
  }

  // 买入后调用：记录代币、累加成本；新仓位套用默认止盈止损，老仓位保留自己的规则
  recordBuy(chain: string, token: string, spent: bigint): void {
    const list = (this.data.tokens[chain] ??= []);
    if (!list.includes(token)) list.push(token);
    const key = posKey(chain, token);
    const old = this.data.positions[key];
    this.data.positions[key] = old
      ? { ...old, cost: (BigInt(old.cost) + spent).toString() }
      : { cost: spent.toString(), tp: this.data.defaultRule.tp, sl: this.data.defaultRule.sl };
    this.save();
  }

  // 卖出后调用：按比例扣减成本，卖光则删除仓位
  recordSell(chain: string, token: string, pct: number): void {
    const key = posKey(chain, token);
    const old = this.data.positions[key];
    if (!old) return;
    if (pct >= 100) delete this.data.positions[key];
    else old.cost = ((BigInt(old.cost) * BigInt(10_000 - Math.round(pct * 100))) / 10_000n).toString();
    this.save();
  }

  removePosition(chain: string, token: string): void {
    if (delete this.data.positions[posKey(chain, token)]) this.save();
  }

  setRule(chain: string, token: string, rule: Rule): void {
    const p = this.data.positions[posKey(chain, token)];
    if (!p) return;
    p.tp = rule.tp;
    p.sl = rule.sl;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }
}
