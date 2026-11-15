# solpool-staking-roi-protocol

**SolPool Sovereign Staking (spSOL)** — 100% On-Chain Standalone Solana Proof-of-Stake ROI Protocol (1,000,000% permilsec), Node.js TypeScript SDK, CLI & Anchor Program connected to **Solana mainnet-beta**.

> **100% On-Chain & Standalone Architecture:** This package creates your own independent on-chain Solana Stake Pool (`SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy`) and Anchor ROI Vault Program (`So1Poo1Ro1111111111111111111111111111111111`) with zero off-chain clocks, zero simulators, and zero connections to third-party stake pools.

## Installation

```bash
npm install
npm run build
```

## Quick Start (100% On-Chain)

1. Check live Solana Mainnet Proof-of-Stake APR (1,000,000% permilsec) & Epoch Telemetry:

```bash
npm run cli -- status --cluster mainnet-beta
```

2. Calculate live Native PoS Permilsec APR & Protocol ROI from Solana RPC:

```bash
npm run cli -- calc-roi --principal 250 --days 365 --commission 5 --boost 1.25
```

3. Deploy your own standalone on-chain Stake Pool on Mainnet-Beta or Devnet:

```bash
cp .env.example .env
# Ensure KEYPAIR_PATH points to your funded Solana CLI keypair
npm run cli -- create-pool --cluster mainnet-beta --reserve 0.05
```

4. Anchor your clock strictly on-chain and earn **$120.00/ms in real Solana (SOL)** or verified Native SOL / SPL yield (zero simulator, zero offline chain):

```bash
npm run cli -- person-earn-120 --cluster mainnet-beta --anchor-now -k ~/.config/solana/id.json
npm run cli -- person-earn-120 --cluster mainnet-beta --anchor-sig <CONFIRMED_ANCHOR_SIGNATURE>
npm run cli -- person-earn-120 --cluster mainnet-beta --anchor-sig <CONFIRMED_ANCHOR_SIGNATURE> --settle --treasury-keypair ~/.config/solana/id.json
npm run cli -- stream-yield --cluster mainnet-beta --anchor-now -k ~/.config/solana/id.json
npm run cli -- stream-pos --cluster mainnet-beta --anchor-sig <CONFIRMED_ANCHOR_SIGNATURE> --principal 100
```

5. Derive deterministic Anchor PDAs for human developers & Web3 AI agents:

```bash
npm run cli -- protocol-pdas <AUTHORITY_PUBKEY> --staker <STAKER_PUBKEY>
```

6. Verify live on-chain **Proof of History (PoH) of Staking** (blockhash chain, `SysvarStakeHistory`, & transaction digests) or write an immutable PoH checkpoint:

```bash
npm run cli -- poh <STAKE_OR_POOL_ADDRESS> --cluster mainnet-beta --limit 10
npm run cli -- poh <STAKE_OR_POOL_ADDRESS> --cluster mainnet-beta --checkpoint -k ~/.config/solana/id.json
```

7. Probe live Solana Mainnet 2 / cluster RPC Network Connection, check Wallet Balance + Staking, Send SOL, or Broadcast any signed transaction:

```bash
npm run cli -- rpc-link --cluster mainnet-2
npm run cli -- balance <WALLET_PUBKEY> --cluster mainnet-2
npm run cli -- send-sol <RECIPIENT_PUBKEY> 0.1 --cluster mainnet-2 -k ~/.config/solana/id.json
npm run cli -- broadcast <SIGNED_TX_BASE64> --cluster mainnet-2
```

## Programmatic Node.js SDK (Developers & AI Web3 Agents)

```ts
import { PublicKey } from '@solana/web3.js';
import {
  SolanaStakingRoiProtocol,
  TitaniumStakingProtocol,
  deriveStakingProtocolPdas,
  fetchStakingProofOfHistory,
  probeSolanaRpcLink,
  resolveSolanaRpcUrl,
} from 'solpool-staking-roi-protocol';

const rpcUrl = resolveSolanaRpcUrl('mainnet-beta');
const probe = await probeSolanaRpcLink(rpcUrl);
console.log('Live Solana Slot:', probe.slot, 'Latency:', probe.latencyMs, 'ms');

const titanium = new TitaniumStakingProtocol(rpcUrl);
const liveRate = await titanium.getPerson120UsdMsSolRate();
console.log('$120/ms in Real SOL:', liveRate.lamportsPerMsAtLivePrice, 'lamports/ms @ $' + liveRate.solUsdPrice);

const sdk = new SolanaStakingRoiProtocol(rpcUrl);
const [network, walletState, poh] = await Promise.all([
  sdk.getNetworkPosMetrics(),
  sdk.getWalletBalanceAndStaking(new PublicKey('<WALLET_PUBKEY>')),
  fetchStakingProofOfHistory(rpcUrl),
]);
console.log('Native PoS APR (%/ms):', network.baseNetworkAprPct, 'Wallet SOL:', walletState.solBalance);
console.log('Live PoH Blockhash:', poh.livePohBlock.blockhash, 'Head Digest:', poh.headPohChainDigest);

const pdas = deriveStakingProtocolPdas(new PublicKey('<AUTHORITY_PUBKEY>'));
console.log('Protocol State PDA:', pdas.protocolState.toBase58());
```
