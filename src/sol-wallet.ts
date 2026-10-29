import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createKeyPairSignerFromBytes, getAddressDecoder, getBase58Decoder, getBase58Encoder } from "@solana/kit";
import type { KeyPairSigner } from "@solana/kit";

const SECRET_BYTES = 64;

// Solana 私钥为 64 字节（32 字节种子 + 32 字节公钥），以 base58 保存
function decodeSecret(secret: string): Uint8Array {
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(getBase58Encoder().encode(secret)); }
  catch { throw new Error("SOLANA_PRIVATE_KEY 格式不对：需要 base58 编码的 64 字节私钥，请在本地检查"); }
  if (bytes.length !== SECRET_BYTES) throw new Error("SOLANA_PRIVATE_KEY 格式不对：需要 base58 编码的 64 字节私钥，请在本地检查");
  return bytes;
}

function addressOf(secret: string): string {
  return getAddressDecoder().decode(decodeSecret(secret).subarray(32));
}

function newSecret(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const publicBytes = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return getBase58Decoder().decode(new Uint8Array([...seed, ...publicBytes]));
}

// 私钥只保存在本地 .env（权限 600），不通过 Telegram 输入或输出
export class SolanaWallet {
  private secret: string | null;
  private file: string;
  private signerCache: Promise<KeyPairSigner> | null = null;

  constructor(file = ".env") {
    this.file = file;
    this.secret = process.env.SOLANA_PRIVATE_KEY?.trim() || null;
    if (this.secret) addressOf(this.secret);
  }

  address(): string | null {
    return this.secret ? addressOf(this.secret) : null;
  }

  signer(): Promise<KeyPairSigner> {
    if (!this.secret) throw new Error("还没有 Solana 钱包，请先生成");
    this.signerCache ??= createKeyPairSignerFromBytes(getBase58Encoder().encode(this.secret));
    return this.signerCache;
  }

  generate(): string {
    if (this.secret) throw new Error("已有 Solana 钱包，不会覆盖");
    if (!existsSync(this.file)) throw new Error("本地配置文件 .env 不存在，未生成钱包");
    const data = join(dirname(this.file), "data");
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const lock = join(data, "wallet-env.lock");
    let descriptor: number;
    try { descriptor = openSync(lock, "wx", 0o600); }
    catch { throw new Error("另一个钱包保存操作正在进行，请稍后重试；若程序异常退出，请在本地检查 data/wallet-env.lock"); }
    let temporary: string | undefined;
    try {
      const env = readFileSync(this.file, "utf8");
      if (parseEnv(env).SOLANA_PRIVATE_KEY) throw new Error("本地 .env 已有 Solana 私钥，未覆盖");
      const kept = env.split("\n").filter((line) => !/^\s*SOLANA_PRIVATE_KEY\s*=\s*$/.test(line)).join("\n");
      const secret = newSecret();
      const address = addressOf(secret);
      temporary = join(data, `env-${randomUUID()}.tmp`);
      writeFileSync(temporary, `${kept.replace(/\n?$/, "\n")}\nSOLANA_PRIVATE_KEY=${secret}\n`, { mode: 0o600, flush: true });
      renameSync(temporary, this.file); chmodSync(this.file, 0o600);
      this.secret = secret; this.signerCache = null;
      return address;
    } finally {
      if (temporary && existsSync(temporary)) unlinkSync(temporary);
      closeSync(descriptor); unlinkSync(lock);
    }
  }
}
