import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type StateData = { tokens: string[]; slippageBps: number | null };

export class State {
  private data: StateData;
  private file: string;

  constructor(file: string) {
    this.file = file;
    this.data = { tokens: [], slippageBps: null };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StateData>;
      this.data = { tokens: parsed.tokens ?? [], slippageBps: parsed.slippageBps ?? null };
    } catch {
      // 首次运行或文件损坏：从空状态开始
    }
  }

  get tokens(): string[] {
    return this.data.tokens;
  }

  get slippageBps(): number | null {
    return this.data.slippageBps;
  }

  setSlippage(bps: number): void {
    this.data.slippageBps = bps;
    this.save();
  }

  addToken(addr: string): void {
    if (this.data.tokens.includes(addr)) return;
    this.data.tokens.push(addr);
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }
}
