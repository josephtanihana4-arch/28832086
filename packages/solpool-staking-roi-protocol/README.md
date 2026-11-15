# solpool-staking-roi-protocol

**SolPool Sovereign Staking (spSOL)** — 100% On-Chain Standalone Solana Proof-of-Stake ROI Protocol ($150.00 / hour Native PoS $ Rate), Node.js TypeScript SDK, CLI & Anchor Program connected to **Solana mainnet-beta**.

> **100% On-Chain & Standalone Architecture:** This package creates your own independent on-chain Solana Stake Pool (`SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy`) and Anchor ROI Vault Program (`So1Poo1Ro1111111111111111111111111111111111`) with zero off-chain clocks, zero simulators, and zero connections to third-party stake pools.

## Installation

```bash
npm install
npm run build
```

## Quick Start (100% On-Chain)

1. Check live Solana Mainnet Proof-of-Stake **$150.00 / hour** rate & Epoch Telemetry:

```bash
npm run cli -- status --cluster mainnet-beta
```

2. Calculate live Native PoS Per-Hourly $ Rate ($150.00/hr) & Protocol ROI from Solana RPC:

```bash
npm run cli -- calc-roi --principal 250 --days 365 --commission 5
```

3. Deploy your own standalone on-chain Stake Pool on Mainnet-Beta or Devnet:

```bash
cp .env.example .env
# Ensure KEYPAIR_PATH points to your funded Solana CLI keypair
npm run cli -- create-pool --cluster mainnet-beta --reserve 0.05
```

4. Anchor your clock strictly on-chain and earn **$150.00/hr in real Solana (SOL)** or verified Native SOL / SPL yield (zero simulator, zero offline chain):

```bash
npm run cli -- hourly-earn-150 --cluster mainnet-beta --anchor-now -k ~/.config/solana/id.json
npm run cli -- hourly-earn-150 --cluster mainnet-beta --anchor-sig <CONFIRMED_ANCHOR_SIGNATURE>
npm run cli -- hourly-earn-150 --cluster mainnet-beta --anchor-sig <CONFIRMED_ANCHOR_SIGNATURE> --settle --treasury-keypair ~/.config/solana/id.json
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

8. Run **Solana L2.0 Proof-of-Stake Inflation ($150.00/hr Person Earning Rate — 100% Live RPC, Zero Simulator)**:

```bash
npm run cli -- l2-inflation --cluster mainnet-beta --person <PERSON_WALLET> --treasury <TREASURY_PUBKEY>
npm run cli -- l2-inflation --cluster mainnet-beta --anchor-now -k ~/.config/solana/id.json
npm run cli -- l2-inflation --cluster mainnet-beta --anchor-sig <CONFIRMED_ANCHOR_SIGNATURE> --settle-sol --treasury-keypair ~/.config/solana/id.json --person <PERSON_WALLET>
```

9. Activate & Settle **Layer 2.0 $0.01 Cent Package -> Fixed $150.00/hr Protocol (Ignores L1 Normal Staking Rates, Zero Simulator)**:

```bash
npm run cli -- l2-package --cluster mainnet-beta --person <PERSON_WALLET> --treasury <TREASURY_PUBKEY>
npm run cli -- l2-package --cluster mainnet-beta --activate-now --treasury <TREASURY_PUBKEY> -k ~/.config/solana/id.json
npm run cli -- l2-package --cluster mainnet-beta --activate-sig <CONFIRMED_ACTIVATION_SIG> --settle-sol --treasury-keypair ~/.config/solana/id.json --person <PERSON_WALLET>
```

## Programmatic Node.js SDK (Developers & AI Web3 Agents)

```ts
import { PublicKey } from '@solana/web3.js';
import {
  SolanaStakingRoiProtocol,
  TitaniumStakingProtocol,
  deriveL2InflationPdas,
  deriveOneCentL2PackagePdas,
  deriveStakingProtocolPdas,
  fetchStakingProofOfHistory,
  probeSolanaRpcLink,
  resolveSolanaRpcUrl,
} from 'solpool-staking-roi-protocol';

const rpcUrl = resolveSolanaRpcUrl('mainnet-beta');
const probe = await probeSolanaRpcLink(rpcUrl);
console.log('Live Solana Slot:', probe.slot, 'Latency:', probe.latencyMs, 'ms');

const titanium = new TitaniumStakingProtocol(rpcUrl);
const liveRate = await titanium.getHourlyUsdSolRate();
console.log('$150.00/hr in Real SOL:', liveRate.lamportsPerHourAtLivePrice, 'lamports/hr @ $' + liveRate.solUsdPrice);

const sdk = new SolanaStakingRoiProtocol(rpcUrl);
const [network, walletState, poh, l2Status, pkgStatus] = await Promise.all([
  sdk.getNetworkPosMetrics(),
  sdk.getWalletBalanceAndStaking(new PublicKey('<WALLET_PUBKEY>')),
  fetchStakingProofOfHistory(rpcUrl),
  sdk.getL2InflationStatus({ personWallet: '<WALLET_PUBKEY>' }),
  sdk.getOneCentL2PackageStatus({ personWallet: '<WALLET_PUBKEY>' }),
]);
console.log('Native PoS $ Rate ($/hr):', network.hourlyUsdRate, 'Wallet SOL:', walletState.solBalance);
console.log('L2.0 Inflation ($150/hr):', l2Status.l2PersonRateUsdPerHour, 'L1 Inflation:', l2Status.l1InflationTotalPct + '%');
console.log('L2.0 $0.01 Package Fixed Rate ($/hr):', pkgStatus.l2FixedHourlyUsdRate, 'Ignores L1:', pkgStatus.ignoresL1NormalStakingRate);
console.log('Live PoH Blockhash:', poh.livePohBlock.blockhash, 'Head Digest:', poh.headPohChainDigest);

const pdas = deriveStakingProtocolPdas(new PublicKey('<AUTHORITY_PUBKEY>'));
const l2Pdas = deriveL2InflationPdas(new PublicKey('<AUTHORITY_PUBKEY>'));
const pkgPdas = deriveOneCentL2PackagePdas(new PublicKey('<AUTHORITY_PUBKEY>'));
console.log('Protocol PDA:', pdas.protocolState.toBase58(), 'L2 Inflation PDA:', l2Pdas.l2InflationState.toBase58(), 'L2 $0.01 Vault PDA:', pkgPdas.l2PackageVault.toBase58());
```
