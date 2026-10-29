# Trading Bot (Telegram Multi-Chain Trading Terminal)

English | [中文](README.zh-CN.md)

A Telegram trading bot that runs on your own computer. Send a token contract address in Telegram, tap buttons to buy or sell, and set take-profit, stop-loss and automatic orders. It supports BNB Chain, Base, Ethereum mainnet, Robinhood Chain and Solana.

> **Risk notice**: This is a personal tool, not investment advice and not a custodial service. On-chain trading can lose money, and tokens may be scams, honeypots or have very thin liquidity. Use a dedicated small hot wallet, and test with small amounts first. The author is not responsible for any loss of funds.

## Contents

- [About](#about)
- [Features](#features)
- [Not implemented or not verified](#not-implemented-or-not-verified)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commands](#commands)
- [FAQ](#faq)
- [Testing](#testing)
- [Security](#security)
- [License](#license)

## About

The bot runs locally, with your own Telegram account and your own wallet. It is not a hosted platform and charges no platform fee.

- **Single user**: Only the Telegram user ID set as `ALLOWED_USER_ID` in `.env` can operate it. Messages and button callbacks from anyone else are rejected.
- **Keys stay local**: The private key is stored in the project's `.env` file (permissions 600). It is not sent to chats or logs.
- **Confirm before trading**: You can enable a pre-buy confirmation page to check the chain, token address, pool, taxes and slippage before submitting.
- **Automation needs the bot running**: Take-profit, stop-loss and automatic orders are executed by the local process. Nothing runs while the computer is off, asleep, or the bot is stopped.

## Features

| Area | Description | Status |
| --- | --- | --- |
| Multi-chain buy/sell | BNB, Base, Ethereum and Robinhood Chain via Kyber routing; Solana via Jupiter routing. Card-based buys, custom amounts, sells by percentage or amount, and selling back principal | Implemented; real fills not verified in this round |
| Pre-buy confirmation and risk checks | Optional confirmation page; tax and slippage limits; honeypot detection on BNB / Base / Ethereum; option to refuse buys when data is unavailable | Implemented and tested |
| Take-profit / stop-loss | Fixed take-profit, fixed stop-loss, tiered take-profit, trailing stop; per-chain defaults; global pause | Implemented and tested |
| Automatic orders (`/orders`) | Limit orders, market-cap orders, dollar-cost averaging; cancel, pause, expiry; unknown results are never resubmitted automatically | Implemented and tested |
| Positions and PnL (`/positions`) | Holdings, cost basis and profit/loss; PnL image card | Implemented and tested |
| Approvals (`/approvals`) | Check Kyber allowances for locally tracked tokens and revoke them to zero | Implemented; real revocation not verified in this round |
| Wallets and records (`/wallets`, `/deposit`, `/history`) | Manage the default wallet, show deposit addresses, view transaction status and gas | Implemented |
| Funds (`/funds`) | Transfers, stablecoin swaps, cross-chain transfers (Relay) | Implemented; this round verified quotes and unsigned builds only |
| Solana | Balances and holdings, signed ledger, PnL, automatic take-profit/stop-loss, automatic orders; optional Jito protection (tip must be set manually, off by default) | Implemented and tested; mainnet real trades not verified |
| Tracked wallets (`/track`) | Stores addresses and notes only | Record-keeping only; no buying, selling or copying |

## Not implemented or not verified

**Not implemented** (planned, not in the code yet):

- Copy trading that follows other wallets' buys and sells
- Launchpad trading on Four.meme, Flap and Pump.fun
- Private transaction routing for Ethereum and BNB (Flashbots Protect, 48 Club)
- Faster custom RPC / indexing service integration
- Web UI, X social copy trading, launch sniping

**Not verified** (code and tests exist, but not fully exercised on a real environment):

- Real buys, sells, transfers, swaps and cross-chain arrivals with real funds, including final fees and slippage
- Solana mainnet real trades, and whether Jito tips actually land in practice
- The on-chain result of real allowance revocations
- Clicking through every Telegram page with a real account (most tests use fake RPCs and mocked trade functions)
- The full Mac double-click launcher flow (first launch, repeated double-clicks, paths with spaces or Chinese characters, background run after closing the dialog)
- Running `npm start` directly on Windows or Linux (only tested on macOS)
- Long-running high-frequency operation, chain reorgs, and malformed API responses
- Robinhood Chain has no honeypot detection; Ethereum mainnet gas can exceed the value of a small trade

Free test results are in `docs/test-results-2026-10-29.md`, and the test guide is in `docs/test-guide.md`.

## Installation

### 1. Prerequisites

- **Node.js**: Tested on Node 26. The project runs TypeScript directly with `node src/index.ts`, so use a recent Node version that supports type stripping.
- **Telegram bot token**: Create a bot with [@BotFather](https://t.me/BotFather) and get a token like `123456:ABC...`.
- **Your Telegram numeric ID**: Get it from [@userinfobot](https://t.me/userinfobot).
- **A dedicated wallet**: Keep only small amounts in it, and never use your main wallet. The setup script can generate one, or you can import an existing key.
- **Gas tokens**: Each chain needs its native token (BNB, ETH) for gas.

### 2. Clone and install dependencies

```bash
git clone <repository-url> trading-bot
cd trading-bot
npm install
```

### 3. Generate `.env`

```bash
node scripts/setup.ts
```

Enter the Telegram token and your numeric ID when prompted. For the private key, press Enter to have the script generate a new wallet. It prints the wallet address; send funds to that address.

If `.env` already exists, the script exits without overwriting it. Delete or rename the file first if you want to start over.

You can also copy `.env.example` to `.env` and fill it in manually.

### 4. Start

```bash
npm start
```

Then send `/start` to your bot in Telegram.

### 5. Mac double-click launcher (optional)

```bash
zsh scripts/build-mac-apps.zsh
```

This creates "启动机器人.app" (start) and "停止机器人.app" (stop) in the project folder. Starting runs the bot in the background; errors are written to `data/mac-bot.log`. Keep both apps inside the project folder. The launcher does not enable start at login.

## Configuration

Main settings in `.env` (see `.env.example` for the full list):

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Token from BotFather |
| `ALLOWED_USER_ID` | Yes | Telegram numeric ID allowed to operate the bot |
| `PRIVATE_KEY` | Yes | Dedicated hot-wallet private key (`0x` plus 64 hex characters) |
| `CHAINS` | No | Enabled chains, comma-separated: `bsc`, `base`, `eth`, `rh`. The first one is the default |
| `RPC_URL` | No | Custom RPC for the first chain; per-chain `RPC_URL_BSC` etc. also work |
| `BUY_AMOUNTS_BSC` etc. | No | Override buy presets for a chain, e.g. `0.001,0.002,0.003` |
| `DEFAULT_SLIPPAGE_PCT` | No | Default slippage percentage; default 10; range 0.01–99.99 |
| `SOLANA_RPC_URL` | No | Solana RPC; defaults to the official public node |
| `SOLANA_PRIVATE_KEY` | No | Solana key, generated by the bot from its Solana page and written here. Do not paste it into chat |
| `HTTPS_PROXY` | No | Local proxy, e.g. `http://127.0.0.1:7897`. Set it if your network needs a proxy to reach Telegram |

## Commands

| Command | Purpose |
| --- | --- |
| `/start` | Open the trading terminal |
| `/chain` | Switch chain |
| `/positions` | Holdings, PnL, sell back principal, sell by amount |
| `/orders` | Automatic orders: limit, market cap, DCA |
| `/tpsl` | Set take-profit and stop-loss |
| `/slippage` | Set slippage |
| `/settings` | Trade parameters, pre-buy confirmation, display settings |
| `/approvals` | Check and revoke token allowances |
| `/wallets` | Manage and select the default wallet |
| `/deposit` | Show deposit addresses |
| `/history` | Transaction records, status and gas |
| `/funds` | Transfers, stablecoin swaps, cross-chain |
| `/track` | Track wallets (records only, no copying) |
| `/help` | Usage guide |

## FAQ

**Q: Will the bot trade for me automatically?**
A: No by default. Buys require you to confirm in Telegram. Automatic rules (take-profit, stop-loss, automatic orders) require you to set them up and enable them explicitly.

**Q: Do take-profit and stop-loss still run when the computer is off or asleep?**
A: No. The bot is a local process, and rules do not run while it is stopped. After a restart, enabled rules are restored.

**Q: Is the private key safe?**
A: The key is stored in plain text in `.env`, with file permissions 600, so only your user account can read it. It is not sent to Telegram, logs or the repository. However, any program that can read your files can also read it. Keep only small amounts in this wallet and never reuse your main wallet's key.

**Q: Why is there no honeypot check on Robinhood Chain?**
A: There is no usable detection service for it at the moment, so the honeypot status shows as unknown. Judge the risk yourself.

**Q: Why was a buy refused with "data unknown"?**
A: If you enabled a risk check in the buy settings (such as tax or honeypot checks), the bot refuses the buy when that data is unavailable, so it does not trade blind. Disable that check to allow such buys, and accept the risk yourself.

**Q: The bot doesn't reply in Telegram. What should I do?**
A: Check the `npm start` output for connection errors. If your network needs a proxy, set `HTTPS_PROXY` in `.env` and restart the bot.

**Q: Is there a platform fee or subscription?**
A: No. You only pay on-chain gas and DEX or router fees, plus cross-chain fees or a Jito tip if you enable them.

**Q: Does it support copy trading?**
A: Not yet. `/track` only stores addresses and notes. Planned wallet-monitoring copy trading is not implemented.

**Q: Does it support launchpad tokens (Four.meme, Flap, Pump.fun)?**
A: Not yet. There is no implementation in the code.

**Q: Does it work on Windows or Linux?**
A: Untested. The double-click launcher is macOS only. `npm start` should work in principle, but it has not been verified on those systems.

**Q: I shared my `.env` file with someone. What now?**
A: Move the funds from that wallet to a new wallet right away, regenerate the Telegram token in BotFather, and replace the private key in `.env`.

## Testing

```bash
npm run check                          # type check
env -u SOLANA_PRIVATE_KEY npm test     # unit and interaction tests, no real chain access
```

Tests use fake keys and mocked trade functions, so they never send real transactions. The `scripts/*-smoke.ts` files are read-only checks against real networks. They need network access, may need a proxy, and their results depend on node availability and rate limits.

## Security

- Do not commit `.env`, the `data/` directory or any private key. Both are listed in `.gitignore`.
- Do not paste real private keys into Telegram chats.
- Run the bot only on a computer you trust, and keep the system and Node up to date.
- If a private key or token leaks, move funds immediately, then rotate the token and key.

## License

No license has been chosen yet. Until a LICENSE file is added, all rights are reserved, and others should not copy, distribute or use the code commercially.
