#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  PROTOCOL_DEFAULTS,
  SolanaStakingRoiProtocol,
  TitaniumStakingProtocol,
  calculateNativePosRoi,
  deriveStakingProtocolPdas,
} from './index.js';

function loadKeypair(keypairPath?: string): Keypair {
  const resolved = (keypairPath || process.env.KEYPAIR_PATH || '~/.config/solana/id.json').replace(
    /^~/,
    os.homedir(),
  );
  const secret = JSON.parse(fs.readFileSync(path.resolve(resolved), 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function getRpcUrl(cluster: string, custom?: string): string {
  if (custom) return custom;
  if (cluster === 'mainnet-2' || cluster === 'mainnet2') {
    return process.env.SOLANA_MAINNET_2_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  }
  if (cluster === 'devnet') return 'https://api.devnet.solana.com';
  if (cluster === 'testnet') return 'https://api.testnet.solana.com';
  return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

const program = new Command();

program
  .name('solpool')
  .description('SolPool Sovereign Staking (spSOL) — Standalone 100% On-Chain Solana Staking ROI Protocol CLI')
  .version('1.0.0');

program
  .command('status')
  .description('Fetch live Solana Mainnet-Beta Proof-of-Stake epoch, inflation, and $150.00/hr Native PoS rate')
  .option('-c, --cluster <cluster>', 'Solana cluster (mainnet-beta | devnet)', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .action(async (opts) => {
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster, opts.rpc));
    const metrics = await sdk.getNetworkPosMetrics();
    console.table(metrics);
  });

program
  .command('calc-roi')
  .description('Calculate live Native Proof-of-Stake $ Rate ($150.00/hr) & protocol ROI from Solana RPC')
  .option('-p, --principal <sol>', 'SOL principal', '100')
  .option('-d, --days <days>', 'Horizon in days', '365')
  .option('-v, --commission <pct>', 'Validator commission %', '5')
  .option('-f, --fee <pct>', 'Pool epoch management fee %', String(PROTOCOL_DEFAULTS.epochFeeBps / 100))
  .option('-b, --boost <usdHr>', 'Protocol boost USD/hr', '0')
  .option('-c, --cluster <cluster>', 'Solana cluster', 'mainnet-beta')
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .action(async (opts) => {
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster, opts.rpc));
    const net = await sdk.getNetworkPosMetrics();
    const roi = calculateNativePosRoi({
      principalSol: Number(opts.principal),
      hourlyUsdRate: net.hourlyUsdRate,
      validatorCommissionPct: Number(opts.commission),
      poolManagementFeePct: Number(opts.fee),
      protocolBoostUsdPerHour: Number(opts.boost),
      solPriceUsd: net.solUsdPrice,
      horizonDays: Number(opts.days),
      epochsPerYear: net.epochsPerYear,
    });
    console.table(roi);
  });

program
  .command('create-pool')
  .description('Deploy a brand-new standalone SPL Stake Pool on Solana Mainnet-Beta or Devnet')
  .option('-c, --cluster <cluster>', 'Solana cluster', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .option('-k, --keypair <path>', 'Signer keypair JSON path')
  .option('--reserve <sol>', 'Initial reserve SOL', '0.05')
  .action(async (opts) => {
    const payer = loadKeypair(opts.keypair);
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster, opts.rpc));
    const validators = PROTOCOL_DEFAULTS.defaultValidators.map((v) => new PublicKey(v));
    console.log('Deploying standalone spSOL Stake Pool on', opts.cluster, '...');
    const res = await sdk.createStandaloneStakePool({
      payer,
      initialReserveSol: Number(opts.reserve),
      validators,
    });
    console.log('Stake Pool Address:', res.stakePool.toBase58());
    console.log('Pool LST Mint (spSOL):', res.poolMint.toBase58());
    console.log('Validator List:', res.validatorList.toBase58());
    console.log('Reserve Stake:', res.reserveStake.toBase58());
    console.log('Transactions:', res.signatures);
  });

program
  .command('pool-info')
  .description('Inspect live on-chain state of your standalone Stake Pool')
  .argument('<stakePoolAddress>', 'Stake Pool public key')
  .option('-c, --cluster <cluster>', 'Solana cluster', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .action(async (stakePoolAddress, opts) => {
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster, opts.rpc));
    const info = await sdk.getPoolTelemetry(new PublicKey(stakePoolAddress));
    console.table(info);
  });

program
  .command('protocol-pdas')
  .description('Derive deterministic Anchor PDAs for the new Solana Staking ROI Protocol (for human/AI Web3 builders)')
  .argument('<authorityPubkey>', 'Protocol authority public key')
  .option('-s, --staker <pubkey>', 'Optional staker public key to derive position PDA')
  .action((authorityPubkey, opts) => {
    const pdas = deriveStakingProtocolPdas(
      new PublicKey(authorityPubkey),
      opts.staker ? new PublicKey(opts.staker) : undefined,
    );
    console.table({
      programId: pdas.programId.toBase58(),
      protocolState: pdas.protocolState.toBase58(),
      reserveVault: pdas.reserveVault.toBase58(),
      insuranceVault: pdas.insuranceVault.toBase58(),
      solYieldTreasury: pdas.solYieldTreasury.toBase58(),
      usdRewardVault: pdas.usdRewardVault.toBase58(),
      position: pdas.position ? pdas.position.toBase58() : '(pass --staker to derive)',
    });
  });

program
  .command('guard')
  .description('Run live on-chain Principal Loss Protection audit & optional auto-deactivate guardian')
  .argument('<stakeAccountPubkey>', 'Solana Stake Account public key')
  .option('-c, --cluster <cluster>', 'Solana cluster', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .option('-m, --max-commission <pct>', 'Max allowed validator commission %', '10')
  .option('--auto-deactivate', 'Automatically send StakeProgram.deactivate if risk is detected', false)
  .option('-k, --keypair <path>', 'Staker authority keypair JSON path (required for auto-deactivate)')
  .action(async (stakeAccountPubkey, opts) => {
    const { auditStakeAccountProtection, emergencyDeactivateStake } = await import('./guardian.js');
    const rpcUrl = getRpcUrl(opts.cluster, opts.rpc);
    const audit = await auditStakeAccountProtection(
      rpcUrl,
      new PublicKey(stakeAccountPubkey),
      Number(opts.maxCommission),
    );
    console.table(audit);
    if (
      opts.autoDeactivate &&
      (audit.status === 'DELINQUENT_ALERT' || audit.status === 'COMMISSION_ALERT')
    ) {
      const staker = loadKeypair(opts.keypair);
      const sig = await emergencyDeactivateStake(rpcUrl, staker, new PublicKey(stakeAccountPubkey));
      console.log('Emergency Protection Deactivate Confirmed:', sig);
    }
  });

program
  .command('stream-yield')
  .description('100% On-Chain: anchor Solana slot/clock and claim $150.00/hr native SOL or SPL yield')
  .option('-p, --principal <sol>', 'Protected principal in SOL', '100')
  .option('--rate-usd-hr <usd>', 'Native PoS USD/hr rate (defaults to $150.00/hr)', '150')
  .option('--anchor-sig <sig>', 'Confirmed on-chain Solana anchor tx signature to compute exact ledger elapsed ms')
  .option('--anchor-now', 'Write and confirm a new on-chain Memo anchor transaction right now', false)
  .option('-c, --cluster <cluster>', 'Solana cluster', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .option('--settle', 'Sign and settle accrued yield live on-chain', false)
  .option('--treasury-keypair <path>', 'Funded SOL Treasury keypair JSON path for real native SOL payout')
  .option('--recipient <pubkey>', 'Recipient pubkey for native SOL payout (defaults to treasury pubkey)')
  .option('-k, --keypair <path>', 'Signer keypair JSON path for SPL yield settlement')
  .action(async (opts) => {
    const {
      anchorOnChainStreamClock,
      getOnChainElapsedSinceTx,
      getLiveBlockchainHourlyRate,
      claimHourlySolFromTreasury,
      settleHourlySplYieldOnChain,
    } = await import('./guardian.js');
    const rpcUrl = getRpcUrl(opts.cluster, opts.rpc);

    let anchorSig = opts.anchorSig as string | undefined;
    if (opts.anchorNow) {
      const signer = loadKeypair(opts.keypair || opts.treasuryKeypair);
      const anchored = await anchorOnChainStreamClock(rpcUrl, signer, Number(opts.principal));
      console.log('Anchored On-Chain Clock:', anchored);
      anchorSig = anchored.anchorSignature;
      if (!opts.settle) {
        return;
      }
    }

    if (!anchorSig || anchorSig.trim().length <= 20) {
      throw new Error(
        'Confirmed --anchor-sig <sig> or --anchor-now is required. Offline elapsedMs fallbacks are disabled.',
      );
    }

    const rateOverride = opts.rateUsdHr !== undefined ? Number(opts.rateUsdHr) : 150;
    const [rate, clockDelta] = await Promise.all([
      getLiveBlockchainHourlyRate(rpcUrl, Number(opts.principal), rateOverride),
      getOnChainElapsedSinceTx(rpcUrl, anchorSig),
    ]);
    console.log('Verified On-Chain Anchor Clock:', clockDelta);
    console.table(rate);

    if (opts.settle) {
      if (opts.treasuryKeypair) {
        const treasurySigner = loadKeypair(opts.treasuryKeypair);
        const stakerPubkey = opts.recipient
          ? new PublicKey(opts.recipient)
          : treasurySigner.publicKey;
        const settled = await claimHourlySolFromTreasury({
          rpcUrl,
          treasurySigner,
          stakerPubkey,
          hourlyUsdRate: rate.hourlyUsdRate,
          anchorSignature: anchorSig,
        });
        console.log('On-Chain Native SOL $150/hr Yield Settled:', settled);
      } else {
        const signer = loadKeypair(opts.keypair);
        const settled = await settleHourlySplYieldOnChain({
          rpcUrl,
          signer,
          hourlyUsdRate: rate.hourlyUsdRate,
          anchorSignature: anchorSig,
        });
        console.log('On-Chain SPL $150/hr Yield Settled:', settled);
      }
    }
  });

program
  .command('usd-stream')
  .description('100% On-Chain $150.00 per hour reward streamer backed by funded SOL or USDC treasury')
  .option('-c, --cluster <cluster>', 'Solana cluster', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .option('-a, --asset <asset>', 'Settlement asset (sol | usdc)', 'usdc')
  .option('--anchor-sig <sig>', 'Confirmed on-chain Solana anchor tx signature to compute exact ledger elapsed ms')
  .option('--anchor-now', 'Write and confirm a new on-chain Memo anchor transaction right now', false)
  .option('-k, --keypair <path>', 'Signer keypair JSON path when using --anchor-now')
  .option('--usdc-mint <pubkey>', 'Optional custom USDC/USD SPL mint pubkey')
  .option('--settle', 'Sign and execute live $150/hr treasury transfer on-chain', false)
  .option('--treasury-keypair <path>', 'Funded SOL or USDC Treasury keypair JSON path')
  .option('--recipient <pubkey>', 'Recipient pubkey (defaults to treasury pubkey)')
  .action(async (opts) => {
    const {
      anchorOnChainStreamClock,
      getOnChainElapsedSinceTx,
      getHourlyUsdLiveRate,
      claimHourlyUsdSolFromTreasury,
      claimHourlyUsdUsdcFromTreasury,
    } = await import('./guardian.js');
    const rpcUrl = getRpcUrl(opts.cluster, opts.rpc);

    let anchorSig = opts.anchorSig as string | undefined;
    if (opts.anchorNow) {
      const signer = loadKeypair(opts.keypair || opts.treasuryKeypair);
      const anchored = await anchorOnChainStreamClock(rpcUrl, signer, 100);
      console.log('Anchored On-Chain Clock:', anchored);
      anchorSig = anchored.anchorSignature;
      if (!opts.settle) {
        return;
      }
    }

    if (!anchorSig || anchorSig.trim().length <= 20) {
      throw new Error(
        'Confirmed --anchor-sig <sig> or --anchor-now is required. Offline elapsedMs fallbacks are disabled.',
      );
    }

    const [rate, clockDelta] = await Promise.all([
      getHourlyUsdLiveRate(rpcUrl),
      getOnChainElapsedSinceTx(rpcUrl, anchorSig),
    ]);
    console.table(rate);
    console.log('Verified On-Chain Anchor Clock:', clockDelta);

    if (opts.settle) {
      const treasurySigner = loadKeypair(opts.treasuryKeypair);
      const stakerPubkey = opts.recipient
        ? new PublicKey(opts.recipient)
        : treasurySigner.publicKey;
      if (opts.asset === 'sol') {
        const res = await claimHourlyUsdSolFromTreasury({
          rpcUrl,
          treasurySigner,
          stakerPubkey,
          anchorSignature: anchorSig,
        });
        console.log('$150/hr Native SOL Settled On-Chain:', res);
      } else {
        const res = await claimHourlyUsdUsdcFromTreasury({
          rpcUrl,
          treasurySigner,
          stakerPubkey,
          usdcMint: opts.usdcMint ? new PublicKey(opts.usdcMint) : undefined,
          anchorSignature: anchorSig,
        });
        console.log('$150/hr USDC Settled On-Chain:', res);
      }
    }
  });

program
  .command('hourly-earn-150')
  .description('100% On-Chain Titanium Staking: earn $150.00/hr in real Solana (SOL) backed by live blockchain clock & oracle')
  .option('-c, --cluster <cluster>', 'Solana cluster (mainnet-beta | mainnet-2 | devnet | testnet)', 'mainnet-beta')
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .option('-p, --principal <sol>', 'Staked SOL principal (0.000000001 to unlimited)', '100')
  .option('--anchor-sig <sig>', 'Confirmed on-chain Solana anchor tx signature')
  .option('--anchor-now', 'Write and confirm a new on-chain Memo anchor transaction right now', false)
  .option('-k, --keypair <path>', 'Signer keypair JSON path when using --anchor-now')
  .option('--settle', 'Sign and execute live $150/hr payout in real SOL on-chain', false)
  .option('--treasury-keypair <path>', 'Funded SOL Treasury keypair JSON path')
  .option('--recipient <pubkey>', 'Wallet pubkey to receive SOL (defaults to treasury pubkey)')
  .action(async (opts) => {
    const rpcUrl = getRpcUrl(opts.cluster, opts.rpc);
    const sdk = new TitaniumStakingProtocol(rpcUrl);

    let anchorSig = opts.anchorSig as string | undefined;
    if (opts.anchorNow) {
      const signer = loadKeypair(opts.keypair || opts.treasuryKeypair);
      const anchored = await sdk.anchorHourlyUsdEarn(signer, Number(opts.principal));
      console.log('Anchored On-Chain $150/hr SOL Earn Stream:', anchored);
      anchorSig = anchored.anchorSignature;
      if (!opts.settle) {
        return;
      }
    }

    if (!anchorSig || anchorSig.trim().length <= 20) {
      throw new Error(
        'Confirmed --anchor-sig <sig> or --anchor-now is required. Simulator and offline chain modes are disabled.',
      );
    }

    const earnStatus = await sdk.getHourlyUsdOnChainEarn(anchorSig);
    console.log('LIVE ON-CHAIN $150/HR IN SOLANA EARN STATUS:');
    console.table(earnStatus);

    if (opts.settle) {
      const treasurySigner = loadKeypair(opts.treasuryKeypair);
      const stakerPubkey = opts.recipient
        ? new PublicKey(opts.recipient)
        : treasurySigner.publicKey;
      const settled = await sdk.claimHourlyUsdInSol(treasurySigner, stakerPubkey, anchorSig);
      console.log('Confirmed On-Chain $150/hr Real SOL Payout:', settled);
    }
  });

program
  .command('stream-pos')
  .description('100% On-Chain Solana: read confirmed ledger anchor clock and compute $150.00/hr Native PoS yield')
  .option('-c, --cluster <cluster>', 'Solana cluster', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .option('-p, --principal <sol>', 'Principal in SOL', '100')
  .option('--rate-usd-hr <usd>', 'Native PoS $ rate per hour', '150')
  .option('--anchor-sig <sig>', 'Confirmed on-chain Solana anchor tx signature')
  .option('--anchor-now', 'Write and confirm a new on-chain Memo anchor transaction right now', false)
  .option('-k, --keypair <path>', 'Signer keypair JSON path when using --anchor-now')
  .action(async (opts) => {
    const {
      anchorOnChainStreamClock,
      getOnChainElapsedSinceTx,
      getLiveBlockchainHourlyRate,
    } = await import('./guardian.js');
    const { calculateOnChainHourlyUsdPos } = await import('./roi.js');
    const rpcUrl = getRpcUrl(opts.cluster, opts.rpc);

    let anchorSig = opts.anchorSig as string | undefined;
    if (opts.anchorNow) {
      const signer = loadKeypair(opts.keypair);
      const anchored = await anchorOnChainStreamClock(rpcUrl, signer, Number(opts.principal));
      console.log('Anchored On-Chain Clock:', anchored);
      anchorSig = anchored.anchorSignature;
    }

    if (!anchorSig || anchorSig.trim().length <= 20) {
      throw new Error(
        'Confirmed --anchor-sig <sig> or --anchor-now is required. Offline timers/elapsed-ms are disabled.',
      );
    }

    const [rate, clockDelta] = await Promise.all([
      getLiveBlockchainHourlyRate(rpcUrl, Number(opts.principal), Number(opts.rateUsdHr)),
      getOnChainElapsedSinceTx(rpcUrl, anchorSig),
    ]);

    const stream = calculateOnChainHourlyUsdPos({
      principalSol: Number(opts.principal),
      hourlyUsdRate: rate.hourlyUsdRate,
      solUsdPrice: rate.solUsdPrice,
      anchorSignature: clockDelta.anchorSignature,
      anchorSlot: clockDelta.anchorSlot,
      currentSlot: clockDelta.currentSlot,
      verifiedOnChainElapsedMs: clockDelta.onChainElapsedMs,
    });
    console.log('LIVE 100% ON-CHAIN SOLANA NATIVE POS ($150.00 / HR):');
    console.table(stream);
  });

program
  .command('poh')
  .description('100% On-Chain Solana Staking Proof of History (PoH) blockhash verifier, SysvarStakeHistory decoder & checkpoint writer')
  .argument('[address]', 'Optional Stake Account, Wallet, or Stake Pool address to verify PoH transaction chain')
  .option('-c, --cluster <cluster>', 'Solana cluster', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .option('-l, --limit <n>', 'Number of confirmed staking signatures to verify in PoH chain', '10')
  .option('--checkpoint', 'Sign and confirm a new on-chain Staking PoH Checkpoint transaction', false)
  .option('-k, --keypair <path>', 'Signer keypair JSON path (required with --checkpoint)')
  .action(async (address, opts) => {
    const { fetchStakingProofOfHistory, recordStakingPohCheckpoint } = await import('./guardian.js');
    const rpcUrl = getRpcUrl(opts.cluster, opts.rpc);

    if (opts.checkpoint) {
      const signer = loadKeypair(opts.keypair);
      const cp = await recordStakingPohCheckpoint(
        rpcUrl,
        signer,
        address ? new PublicKey(address) : undefined,
      );
      console.log('Confirmed On-Chain Staking PoH Checkpoint:', cp);
    }

    const poh = await fetchStakingProofOfHistory(
      rpcUrl,
      address ? new PublicKey(address) : undefined,
      Number(opts.limit),
    );
    console.log('Live Solana PoH Block Link:', poh.livePohBlock);
    console.log('Genesis PoH Seed:', poh.genesisPohSeed);
    console.log('Verified Head PoH Digest:', poh.headPohChainDigest);
    console.log('On-Chain SysvarStakeHistory (Latest Epochs):');
    console.table(poh.sysvarStakeHistory.slice(0, 5));
    console.log('Verified Staking Proof-of-History Transaction Chain:');
    console.table(
      poh.records.map((r) => ({
        index: r.index,
        slot: r.slot,
        signature: `${r.signature.slice(0, 14)}...`,
        recentBlockhash: `${r.recentBlockhash.slice(0, 14)}...`,
        pohChainDigest: `${r.pohChainDigest.slice(0, 16)}...`,
      })),
    );
  });

program
  .command('rpc-link')
  .description('Probe live Solana RPC link & output developer blockchain / stake pool / package connection links')
  .option('-c, --cluster <cluster>', 'Solana cluster (mainnet-beta | devnet | testnet)', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom or developer proxy Solana RPC endpoint')
  .option('--pool <stakePoolAddress>', 'Optional standalone Stake Pool address to verify on-chain')
  .option('--json', 'Output JSON manifest', false)
  .action(async (opts) => {
    const { resolveSolanaRpcUrl } = await import('./index.js');
    const targetUrl = opts.rpc || resolveSolanaRpcUrl(opts.cluster);
    const sdk = new SolanaStakingRoiProtocol(targetUrl);
    const poolPubkey = opts.pool ? new PublicKey(opts.pool) : undefined;
    const [probe, manifest] = await Promise.all([
      sdk.probeRpcConnection(poolPubkey),
      Promise.resolve(sdk.getDeveloperConnectionManifest(poolPubkey)),
    ]);

    if (opts.json) {
      console.log(JSON.stringify({ probe, manifest }, null, 2));
      return;
    }

    console.log('Live Solana RPC Probe (100% Real On-Chain, Zero Simulators):');
    console.table(probe);
    console.log('Developer Blockchain & Protocol Connection Links:');
    console.table(manifest);
  });

program
  .command('balance')
  .description('Fetch live on-chain SOL balance, SPL tokens, and stake accounts on Solana Mainnet 2 / any cluster')
  .argument('<walletPubkey>', 'Wallet public key')
  .option('-c, --cluster <cluster>', 'Solana cluster (mainnet-2 | mainnet-beta | devnet | testnet)', 'mainnet-2')
  .option('-r, --rpc <url>', 'Custom or Solana Mainnet 2 proxy RPC endpoint')
  .action(async (walletPubkey, opts) => {
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster, opts.rpc));
    const info = await sdk.getWalletBalanceAndStaking(new PublicKey(walletPubkey));
    console.table({
      rpcEndpoint: info.rpcEndpoint,
      walletPubkey: info.walletPubkey,
      solBalance: info.solBalance,
      totalDelegatedStakeSol: info.totalDelegatedStakeSol,
      stakeAccountsCount: info.stakeAccountsCount,
      tokenAccountsCount: info.tokenAccounts.length,
      slot: info.slot,
    });
    if (info.stakeAccounts.length > 0) console.table(info.stakeAccounts);
    if (info.tokenAccounts.length > 0) console.table(info.tokenAccounts);
  });

program
  .command('send-sol')
  .description('Send real native SOL on-chain to a recipient wallet via Solana Mainnet 2 or chosen RPC')
  .argument('<recipientPubkey>', 'Destination wallet public key')
  .argument('<amountSol>', 'Amount of SOL to send')
  .option('-c, --cluster <cluster>', 'Solana cluster (mainnet-2 | mainnet-beta | devnet | testnet)', 'mainnet-2')
  .option('-r, --rpc <url>', 'Custom or Solana Mainnet 2 proxy RPC endpoint')
  .option('-k, --keypair <path>', 'Sender keypair JSON path')
  .action(async (recipientPubkey, amountSol, opts) => {
    const sender = loadKeypair(opts.keypair);
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster, opts.rpc));
    const res = await sdk.sendSolToWallet(sender, new PublicKey(recipientPubkey), Number(amountSol));
    console.log('Confirmed On-Chain Wallet Transfer:', res);
  });

program
  .command('broadcast')
  .description('Broadcast any signed Base64 Solana transaction (transfer, stake, Anchor) to Solana Mainnet 2')
  .argument('<signedTxBase64>', 'Base64-encoded signed Solana transaction')
  .option('-c, --cluster <cluster>', 'Solana cluster (mainnet-2 | mainnet-beta | devnet | testnet)', 'mainnet-2')
  .option('-r, --rpc <url>', 'Custom or Solana Mainnet 2 proxy RPC endpoint')
  .option('--skip-preflight', 'Skip RPC preflight checks', false)
  .action(async (signedTxBase64, opts) => {
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster, opts.rpc));
    const res = await sdk.broadcastSignedTransaction(signedTxBase64, Boolean(opts.skipPreflight));
    console.log('Broadcast Confirmed on Solana Blockchain:', res);
  });

program
  .command('withdrawal-pool')
  .description('Inspect live on-chain Withdrawal Pool metrics, reserve liquidity, and $150.00/hr Native PoS rate')
  .argument('<stakePoolAddress>', 'Stake Pool public key')
  .option('-c, --cluster <cluster>', 'Solana cluster', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .action(async (stakePoolAddress, opts) => {
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster, opts.rpc));
    const info = await sdk.getWithdrawalPoolOverview(stakePoolAddress);
    console.log('Live Solana Withdrawal Pool (100% Real On-Chain):');
    console.table({
      stakePoolAddress: info.stakePoolAddress,
      withdrawAuthority: info.withdrawAuthority,
      reserveStakeAddress: info.reserveStakeAddress,
      reserveSol: info.reserveSol,
      instantSolWithdrawCapacity: info.instantSolWithdrawCapacity,
      totalPoolSol: info.totalPoolSol,
      lstExchangeRate: info.lstExchangeRate,
      nativePosRate: info.nativePosRateLabel,
      perHourSolEquivalent: info.perHourSolEquivalent,
      perDaySolEquivalent: info.perDaySolEquivalent,
    });
  });

program
  .command('withdraw-sol')
  .description('Withdraw real SOL from the Stake Pool by burning LST tokens on-chain')
  .argument('<stakePoolAddress>', 'Stake Pool public key')
  .argument('<amountLst>', 'Amount of LST (spSOL) tokens to burn')
  .option('-c, --cluster <cluster>', 'Solana cluster (mainnet-2 | mainnet-beta | devnet | testnet)', 'mainnet-2')
  .option('-r, --rpc <url>', 'Custom or Solana Mainnet 2 proxy RPC endpoint')
  .option('-k, --keypair <path>', 'Signer keypair JSON path')
  .action(async (stakePoolAddress, amountLst, opts) => {
    const user = loadKeypair(opts.keypair);
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster, opts.rpc));
    const res = await sdk.withdrawSolFromPool(user, stakePoolAddress, Number(amountLst));
    console.log('Confirmed On-Chain SOL Withdrawal from Pool:', res);
  });

program
  .command('withdraw-stake')
  .description('Withdraw an on-chain delegated Stake Account from the Stake Pool')
  .argument('<stakePoolAddress>', 'Stake Pool public key')
  .argument('<amountLst>', 'Amount of LST (spSOL) tokens to redeem')
  .option('-c, --cluster <cluster>', 'Solana cluster (mainnet-2 | mainnet-beta | devnet | testnet)', 'mainnet-2')
  .option('-r, --rpc <url>', 'Custom or Solana Mainnet 2 proxy RPC endpoint')
  .option('-v, --vote-account <pubkey>', 'Specific validator vote account to withdraw from')
  .option('--use-reserve', 'Withdraw from reserve stake account', false)
  .option('-k, --keypair <path>', 'Signer keypair JSON path')
  .action(async (stakePoolAddress, amountLst, opts) => {
    const user = loadKeypair(opts.keypair);
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster, opts.rpc));
    const res = await sdk.withdrawStakeFromPool(
      user,
      stakePoolAddress,
      Number(amountLst),
      opts.voteAccount,
      Boolean(opts.useReserve),
    );
    console.log('Confirmed On-Chain Stake Account Withdrawal from Pool:', res);
  });

program
  .command('l2-inflation')
  .description('Inspect or settle Solana L2.0 Proof-of-Stake Inflation ($150.00/hr person rate, 100% live RPC)')
  .option('-c, --cluster <cluster>', 'Solana cluster (mainnet-beta | mainnet-2 | devnet | testnet)', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .option('--person <pubkey>', 'Person wallet public key')
  .option('--treasury <pubkey>', 'Funded L2 SOL Treasury public key')
  .option('--anchor-now', 'Anchor Solana L2.0 PoS Inflation checkpoint on-chain right now', false)
  .option('--anchor-sig <sig>', 'Confirmed Solana L2.0 anchor tx signature')
  .option('--settle-sol', 'Pay out verified $150/hr L2.0 inflation in real SOL from funded treasury', false)
  .option('--mint-l2-token', 'Mint verified SPL L2.0 Inflation receipt token on-chain', false)
  .option('--treasury-keypair <path>', 'Funded SOL Treasury keypair JSON path')
  .option('-k, --keypair <path>', 'Person signer keypair JSON path')
  .action(async (opts) => {
    const rpcUrl = getRpcUrl(opts.cluster, opts.rpc);
    const sdk = new SolanaStakingRoiProtocol(rpcUrl);

    let anchorSig = opts.anchorSig as string | undefined;
    if (opts.anchorNow) {
      const signer = loadKeypair(opts.keypair || opts.treasuryKeypair);
      const pre = await sdk.getL2InflationStatus({ personWallet: signer.publicKey });
      const anchored = await sdk.anchorL2Inflation(signer, pre.personDelegatedStakeSol);
      console.log('Anchored Solana L2.0 PoS Inflation on L1:', anchored);
      anchorSig = anchored.anchorSignature;
      if (!opts.settleSol && !opts.mintL2Token) {
        return;
      }
    }

    const report = await sdk.getL2InflationStatus({
      personWallet: opts.person,
      treasuryPubkey: opts.treasury,
      anchorSignature: anchorSig,
    });
    console.log('SOLANA L2.0 PROOF-OF-STAKE INFLATION (100% LIVE RPC, ZERO SIMULATOR):');
    console.table(report);

    if (opts.settleSol) {
      if (!anchorSig) throw new Error('--anchor-sig <sig> or --anchor-now is required to settle');
      const treasurySigner = loadKeypair(opts.treasuryKeypair);
      const personKey = opts.person ? new PublicKey(opts.person) : treasurySigner.publicKey;
      const paid = await sdk.claimL2InflationInSol(treasurySigner, personKey, anchorSig);
      console.log('Confirmed On-Chain L2.0 $150/hr SOL Settlement:', paid);
    }

    if (opts.mintL2Token) {
      if (!anchorSig) throw new Error('--anchor-sig <sig> or --anchor-now is required to mint');
      const signer = loadKeypair(opts.keypair || opts.treasuryKeypair);
      const minted = await sdk.mintL2InflationToken(signer, anchorSig);
      console.log('Confirmed On-Chain L2.0 Inflation SPL Token Mint:', minted);
    }
  });

program
  .command('l2-package')
  .description('Layer 2.0 $0.01 Cent Package -> Fixed $150.00/hr Protocol (ignores L1 staking rates, zero simulator)')
  .option('-c, --cluster <cluster>', 'Solana cluster (mainnet-beta | mainnet-2 | devnet | testnet)', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .option('--person <pubkey>', 'Person wallet public key')
  .option('--treasury <pubkey>', 'Funded L2 Treasury public key')
  .option('--activate-now', 'Send real $0.01 SOL package activation transaction on Solana now', false)
  .option('--activate-sig <sig>', 'Confirmed $0.01 package activation transaction signature')
  .option('--settle-sol', 'Pay out verified $150/hr L2.0 earnings in real SOL from funded treasury', false)
  .option('--mint-l2-token', 'Mint L2.0 Fixed-Rate SPL receipt token on-chain', false)
  .option('--treasury-keypair <path>', 'Funded SOL Treasury keypair JSON path')
  .option('-k, --keypair <path>', 'Person signer keypair JSON path')
  .action(async (opts) => {
    const rpcUrl = getRpcUrl(opts.cluster, opts.rpc);
    const sdk = new SolanaStakingRoiProtocol(rpcUrl);

    let activationSig = opts.activateSig as string | undefined;
    if (opts.activateNow) {
      const signer = loadKeypair(opts.keypair || opts.treasuryKeypair);
      const activated = await sdk.activateOneCentL2Package(signer, opts.treasury);
      console.log('Activated On-Chain $0.01 Cent L2.0 Package ($150/hr fixed):', activated);
      activationSig = activated.packageActivationSig;
      if (!opts.settleSol && !opts.mintL2Token) {
        return;
      }
    }

    const report = await sdk.getOneCentL2PackageStatus({
      personWallet: opts.person,
      treasuryPubkey: opts.treasury,
      packageActivationSig: activationSig,
    });
    console.log('LAYER 2.0 $0.01 CENT PACKAGE ($150.00/HR FIXED, IGNORES L1 RATES):');
    console.table(report);

    if (opts.settleSol) {
      if (!activationSig) throw new Error('--activate-sig <sig> or --activate-now is required to settle');
      const treasurySigner = loadKeypair(opts.treasuryKeypair);
      const personKey = opts.person ? new PublicKey(opts.person) : treasurySigner.publicKey;
      const paid = await sdk.claimOneCentL2InSol(treasurySigner, personKey, activationSig);
      console.log('Confirmed On-Chain $0.01 Package $150/hr SOL Payout:', paid);
    }

    if (opts.mintL2Token) {
      if (!activationSig) throw new Error('--activate-sig <sig> or --activate-now is required to mint');
      const signer = loadKeypair(opts.keypair || opts.treasuryKeypair);
      const minted = await sdk.mintOneCentL2ReceiptToken(signer, activationSig);
      console.log('Confirmed On-Chain $0.01 Package SPL Token Mint:', minted);
    }
  });

program.parseAsync(process.argv);


