import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
console.log("地址（往这里充值）:", privateKeyToAccount(key).address);
console.log("私钥（填进 .env 的 PRIVATE_KEY，不要发给任何人）:", key);
