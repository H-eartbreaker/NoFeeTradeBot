import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { ChainConfig } from "./chains.ts";
import type { TradeDeps } from "./trade.ts";
import { createClients } from "./wallet.ts";
import type { Journal } from "./journal.ts";
import type { ExecutionSettings } from "./execution.ts";

export type WalletProfile = { id: string; label: string; address: `0x${string}` };

// 私钥沿用项目已有的本地 .env 存储方式，不通过 Telegram 输入或输出。
export class Wallets {
  private profiles = new Map<string, { key: Hex; profile: WalletProfile }>();
  private clients = new Map<string, Map<string, TradeDeps>>();
  private chains: ChainConfig[];
  private file: string;
  private journal?: Journal;
  private execution?: (chain: string) => ExecutionSettings;

  constructor(primary: Hex, chains: ChainConfig[], file = ".env", journal?: Journal, execution?: (chain: string) => ExecutionSettings) {
    this.chains = chains; this.file = file; this.journal = journal;
    this.execution = execution;
    this.addToMemory("main", primary, "主钱包");
    const env = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
    for (const [name, value] of Object.entries(env)) {
      const match = /^WALLET_KEY_(W\d{3})$/.exec(name);
      if (!match) continue;
      if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`钱包配置 ${match[1]} 格式错误，请在本地检查`);
      this.addToMemory(match[1].toLowerCase(), value as Hex, env[`WALLET_LABEL_${match[1]}`] || match[1]);
    }
  }
  private addToMemory(id: string, key: Hex, label: string) {
    let address: `0x${string}`;
    try { address = privateKeyToAccount(key).address; } catch { throw new Error("钱包私钥无效，请在本地检查，勿发送到聊天"); }
    if (this.list().some((p) => p.address.toLowerCase() === address.toLowerCase())) throw new Error("该钱包已经存在");
    this.profiles.set(id, { key, profile: { id, label: label.slice(0, 30), address } });
  }
  list(): WalletProfile[] { return [...this.profiles.values()].map((v) => ({ ...v.profile })); }
  get(id: string, chain: string): TradeDeps | undefined {
    const entry = this.profiles.get(id);
    const config = this.chains.find((c) => c.key === chain);
    if (!entry || !config) return undefined;
    let map = this.clients.get(id);
    if (!map) { map = new Map(); this.clients.set(id, map); }
    let d = map.get(chain);
    if (!d) { d = { chain: config, clients: createClients(entry.key, config), walletId: id, journal: this.journal, execution: this.execution ? () => this.execution!(chain) : undefined }; map.set(chain, d); }
    return d;
  }
  depsFor(id: string): Map<string, TradeDeps> {
    return new Map(this.chains.map((c) => [c.key, this.get(id, c.key)!]));
  }
  create(): WalletProfile { return this.importKey(generatePrivateKey()); }
  importKey(key: Hex): WalletProfile {
    let address: string;
    try { address = privateKeyToAccount(key).address; } catch { throw new Error("私钥格式无效"); }
    if (this.list().some((p) => p.address.toLowerCase() === address.toLowerCase())) throw new Error("该钱包已经存在");
    if (!existsSync(this.file)) throw new Error("本地配置文件不存在，未保存钱包");
    const data = join(dirname(this.file), "data");
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const lock = join(data, "wallet-env.lock");
    let descriptor: number;
    try { descriptor = openSync(lock, "wx", 0o600); }
    catch { throw new Error("另一个钱包保存操作正在进行，请稍后重试；若程序异常退出，请在本地检查 data/wallet-env.lock"); }
    let temporary: string | undefined;
    try {
    const env = readFileSync(this.file, "utf8");
    const parsed = parseEnv(env);
    for (const [name, value] of Object.entries(parsed)) {
      if ((name === "PRIVATE_KEY" || /^WALLET_KEY_W\d{3}$/.test(name)) && value) {
        let saved: string;
        try { saved = privateKeyToAccount(value as Hex).address; } catch { throw new Error("已有钱包配置无效，未修改配置文件"); }
        if (saved.toLowerCase() === address.toLowerCase()) throw new Error("该钱包已经存在");
      }
    }
    let number = 1;
    while (this.profiles.has(`w${String(number).padStart(3, "0")}`) || parsed[`WALLET_KEY_W${String(number).padStart(3, "0")}`]) number++;
    if (number > 999) throw new Error("钱包数量已达上限");
    const id = `w${String(number).padStart(3, "0")}`;
    const label = `钱包 ${number + 1}`;
    const content = `${env.replace(/\n?$/, "\n")}\nWALLET_KEY_${id.toUpperCase()}=${key}\nWALLET_LABEL_${id.toUpperCase()}=${label}\n`;
    temporary = join(data, `env-${randomUUID()}.tmp`);
    writeFileSync(temporary, content, { mode: 0o600, flush: true });
    renameSync(temporary, this.file); chmodSync(this.file, 0o600);
    this.addToMemory(id, key, label);
    return this.profiles.get(id)!.profile;
    } finally {
      if (temporary && existsSync(temporary)) unlinkSync(temporary);
      closeSync(descriptor); unlinkSync(lock);
    }
  }
}
