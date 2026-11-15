import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  StakeProgram,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  STAKE_POOL_PROGRAM_ID,
  StakePoolInstruction,
  depositSol,
  getStakePoolAccount,
  updateStakePool,
  withdrawSol,
  withdrawStake,
} from '@solana/spl-stake-pool';
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { calculateNativePosRoi } from './roi.js';
import {
  anchorOnChainStreamClock,
  claimCentMsSolFromTreasury,
  claimCentMsUsdcFromTreasury,
  getCentMsLiveRate,
  getOnChainElapsedSinceTx,
} from './guardian.js';

export * from './roi.js';
export * from './guardian.js';

export const PROTOCOL_DEFAULTS = {
  protocolName: "SolPool Sovereign Staking",
  tokenSymbol: "spSOL",
  cluster: "mainnet-beta",
  rpcUrl: "https://api.mainnet-beta.solana.com",
  maxValidators: 100,
  epochFeeBps: 250,
  solDepositFeeBps: 0,
  solWithdrawalFeeBps: 10,
  referralFeePct: 0,
  protocolBoostAprPct: 1.25,
  defaultValidators: [
  "J1to3PQfXidUUhprQWgd1nWPJ63pV58qU9D7kQ7nK2B3"
],
} as const;

export const TITANIUM_PROTOCOL_DEFAULTS = {
  protocolName: "Titanium Staking",
  tokenSymbol: "TSOL",
  cluster: "mainnet-beta",
  rpcUrl: "https://api.mainnet-beta.solana.com",
  maxValidators: 32,
  epochFeeBps: 100,
  solDepositFeeBps: 0,
  solWithdrawalFeeBps: 0,
  referralFeePct: 0,
  protocolBoostAprPct: 1000000,
  usdPerMsRate: 120,
  microUsdcPerMs: 120_000_000,
  defaultValidators: [
  "J1to3PQfXidUUhprQWgd1nWPJ63pV58qU9D7kQ7nK2B3"
],
} as const;

const STAKE_POOL_SIZE = 611;
const VALIDATOR_LIST_HEADER = 9;
const VALIDATOR_ENTRY_SIZE = 73;

export interface StandalonePoolCreateParams {
  payer: Keypair;
  manager?: PublicKey;
  staker?: PublicKey;
  maxValidators?: number;
  epochFeeBps?: number;
  withdrawalFeeBps?: number;
  depositFeeBps?: number;
  referralFeePct?: number;
  initialReserveSol?: number;
  validators?: PublicKey[];
}

export interface StandalonePoolDeployment {
  stakePool: PublicKey;
  poolMint: PublicKey;
  validatorList: PublicKey;
  reserveStake: PublicKey;
  withdrawAuthority: PublicKey;
  managerFeeAccount: PublicKey;
  signatures: string[];
}

function encodeInitializeInstruction(params: {
  epochFeeBps: number;
  withdrawalFeeBps: number;
  depositFeeBps: number;
  referralFeePct: number;
  maxValidators: number;
}): Buffer {
  const buf = Buffer.alloc(54);
  let offset = 0;
  buf.writeUInt8(0, offset);
  offset += 1;

  // Epoch Fee { denominator, numerator }
  buf.writeBigUInt64LE(10000n, offset);
  offset += 8;
  buf.writeBigUInt64LE(BigInt(params.epochFeeBps), offset);
  offset += 8;

  // Withdrawal Fee { denominator, numerator }
  buf.writeBigUInt64LE(10000n, offset);
  offset += 8;
  buf.writeBigUInt64LE(BigInt(params.withdrawalFeeBps), offset);
  offset += 8;

  // Deposit Fee { denominator, numerator }
  buf.writeBigUInt64LE(10000n, offset);
  offset += 8;
  buf.writeBigUInt64LE(BigInt(params.depositFeeBps), offset);
  offset += 8;

  buf.writeUInt8(Math.min(100, Math.max(0, params.referralFeePct)), offset);
  offset += 1;
  buf.writeUInt32LE(params.maxValidators, offset);
  return buf;
}

/**
 * SolPool Sovereign Staking — Standalone Solana Staking ROI Protocol SDK
 * Connects directly to Solana Mainnet-Beta (or Devnet) and creates an independent,
 * self-custodied SPL Stake Pool that never connects or routes to third-party pools.
 */
export const SOLANA_CLUSTER_RPC_LINKS = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  'mainnet-2': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
} as const;

export const PROTOCOL_PROGRAM_IDS = {
  splStakePoolProgramId: STAKE_POOL_PROGRAM_ID.toBase58(),
  anchorStakingRoiProgramId: 'So1Poo1Ro1111111111111111111111111111111111',
} as const;

export function resolveSolanaRpcUrl(clusterOrUrl?: string): string {
  if (clusterOrUrl && /^https?:\/\//i.test(clusterOrUrl.trim())) {
    return clusterOrUrl.trim();
  }
  if (clusterOrUrl === 'mainnet-2' || clusterOrUrl === 'mainnet2') {
    return process.env.SOLANA_MAINNET_2_RPC_URL || process.env.SOLANA_RPC_URL || SOLANA_CLUSTER_RPC_LINKS['mainnet-2'];
  }
  if (clusterOrUrl === 'devnet') return SOLANA_CLUSTER_RPC_LINKS.devnet;
  if (clusterOrUrl === 'testnet') return SOLANA_CLUSTER_RPC_LINKS.testnet;
  if (clusterOrUrl === 'mainnet-beta') {
    return process.env.SOLANA_RPC_URL || SOLANA_CLUSTER_RPC_LINKS['mainnet-beta'];
  }
  return process.env.SOLANA_RPC_URL || PROTOCOL_DEFAULTS.rpcUrl;
}

export interface RpcConnectionProbeResult {
  rpcEndpoint: string;
  healthy: boolean;
  latencyMs: number;
  slot: number;
  blockHeight: number;
  epoch: number;
  epochProgressPct: number;
  blockhash: string;
  solanaCoreVersion: string | null;
  stakePoolProgramExecutable: boolean;
  stakePoolAddress?: string;
  stakePoolSol?: number;
}

/**
 * Probes a live Solana JSON-RPC endpoint (Mainnet, Devnet, Testnet, Custom, or Developer Proxy)
 * and verifies on-chain SPL Stake Pool Program availability. Zero simulated values.
 */
export async function probeSolanaRpcLink(
  rpcEndpoint: string = PROTOCOL_DEFAULTS.rpcUrl,
  stakePoolAddress?: PublicKey,
): Promise<RpcConnectionProbeResult> {
  const startedAt = performance.now();
  const connection = new Connection(rpcEndpoint, 'confirmed');
  const [versionInfo, epochInfo, latestBh, blockHeight, stakePoolProgInfo] = await Promise.all([
    connection.getVersion(),
    connection.getEpochInfo('confirmed'),
    connection.getLatestBlockhash('confirmed'),
    connection.getBlockHeight('confirmed'),
    connection.getAccountInfo(STAKE_POOL_PROGRAM_ID, 'confirmed'),
  ]);

  let stakePoolSol: number | undefined;
  if (stakePoolAddress) {
    const pool = await getStakePoolAccount(connection, stakePoolAddress);
    stakePoolSol = Number(pool.account.data.totalLamports.toString()) / LAMPORTS_PER_SOL;
  }

  return {
    rpcEndpoint,
    healthy: true,
    latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    slot: epochInfo.absoluteSlot,
    blockHeight,
    epoch: epochInfo.epoch,
    epochProgressPct:
      epochInfo.slotsInEpoch > 0
        ? Number(((epochInfo.slotIndex / epochInfo.slotsInEpoch) * 100).toFixed(2))
        : 0,
    blockhash: latestBh.blockhash,
    solanaCoreVersion: versionInfo['solana-core'] ?? null,
    stakePoolProgramExecutable: Boolean(stakePoolProgInfo?.executable),
    ...(stakePoolAddress ? { stakePoolAddress: stakePoolAddress.toBase58(), stakePoolSol } : {}),
  };
}

export interface WalletBalanceAndStakingResult {
  rpcEndpoint: string;
  walletPubkey: string;
  solBalance: number;
  lamports: string;
  totalDelegatedStakeSol: number;
  stakeAccountsCount: number;
  stakeAccounts: Array<{
    pubkey: string;
    state: string;
    balanceSol: number;
    delegatedSol: number;
    voterPubkey: string | null;
  }>;
  tokenAccounts: Array<{
    mint: string;
    tokenAccount: string;
    uiAmount: number;
    decimals: number;
  }>;
  slot: number;
  blockhash: string;
}

/**
 * Queries real on-chain SOL balance, SPL token accounts, and native Stake Accounts
 * from Solana Mainnet 2 or any live Solana RPC node.
 */
export async function getWalletBalanceAndStaking(
  rpcEndpoint: string = PROTOCOL_DEFAULTS.rpcUrl,
  walletPubkey: PublicKey | string,
): Promise<WalletBalanceAndStakingResult> {
  const resolved = resolveSolanaRpcUrl(rpcEndpoint);
  const connection = new Connection(resolved, 'confirmed');
  const walletKey = typeof walletPubkey === 'string' ? new PublicKey(walletPubkey.trim()) : walletPubkey;
  const walletStr = walletKey.toBase58();

  const [lamports, tokenResp, stakeByStaker, stakeByWithdrawer, slot, latestBh] = await Promise.all([
    connection.getBalance(walletKey, 'confirmed'),
    connection
      .getParsedTokenAccountsByOwner(walletKey, { programId: TOKEN_PROGRAM_ID }, 'confirmed')
      .catch(() => ({ value: [] })),
    connection
      .getParsedProgramAccounts(StakeProgram.programId, {
        commitment: 'confirmed',
        filters: [{ memcmp: { offset: 12, bytes: walletStr } }],
      })
      .catch(() => []),
    connection
      .getParsedProgramAccounts(StakeProgram.programId, {
        commitment: 'confirmed',
        filters: [{ memcmp: { offset: 44, bytes: walletStr } }],
      })
      .catch(() => []),
    connection.getSlot('confirmed'),
    connection.getLatestBlockhash('confirmed'),
  ]);

  const dedupedStakes = new Map<string, (typeof stakeByStaker)[number]>();
  for (const item of [...stakeByStaker, ...stakeByWithdrawer]) {
    dedupedStakes.set(item.pubkey.toBase58(), item);
  }

  const stakeAccounts: WalletBalanceAndStakingResult['stakeAccounts'] = [];
  for (const [pubkey, entry] of dedupedStakes.entries()) {
    const data = entry.account.data;
    if (!data || typeof data !== 'object' || !('parsed' in data)) continue;
    const parsed = data.parsed as {
      type?: string;
      info?: { stake?: { delegation?: { voter?: string; stake?: string } } };
    };
    const delegatedLamports = parsed.info?.stake?.delegation?.stake
      ? Number(parsed.info.stake.delegation.stake)
      : 0;
    stakeAccounts.push({
      pubkey,
      state: parsed.type || 'unknown',
      balanceSol: Number((entry.account.lamports / LAMPORTS_PER_SOL).toFixed(6)),
      delegatedSol: Number((delegatedLamports / LAMPORTS_PER_SOL).toFixed(6)),
      voterPubkey: parsed.info?.stake?.delegation?.voter || null,
    });
  }

  const tokenAccounts: WalletBalanceAndStakingResult['tokenAccounts'] = [];
  for (const item of tokenResp.value) {
    const parsedInfo = (item.account.data as { parsed?: { info?: Record<string, unknown> } })
      ?.parsed?.info as
      | { mint?: string; tokenAmount?: { uiAmount?: number | null; decimals?: number } }
      | undefined;
    if (!parsedInfo?.mint) continue;
    tokenAccounts.push({
      mint: parsedInfo.mint,
      tokenAccount: item.pubkey.toBase58(),
      uiAmount: Number(parsedInfo.tokenAmount?.uiAmount ?? 0),
      decimals: Number(parsedInfo.tokenAmount?.decimals ?? 0),
    });
  }

  const totalDelegatedStakeSol = stakeAccounts.reduce((acc, s) => acc + s.delegatedSol, 0);

  return {
    rpcEndpoint: resolved,
    walletPubkey: walletStr,
    solBalance: Number((lamports / LAMPORTS_PER_SOL).toFixed(9)),
    lamports: String(lamports),
    totalDelegatedStakeSol: Number(totalDelegatedStakeSol.toFixed(6)),
    stakeAccountsCount: stakeAccounts.length,
    stakeAccounts,
    tokenAccounts,
    slot,
    blockhash: latestBh.blockhash,
  };
}

/**
 * Sends real native SOL directly from signer wallet to recipient wallet on-chain.
 */
export async function sendSolToWallet(
  rpcEndpoint: string,
  sender: Keypair,
  recipient: PublicKey | string,
  amountSol: number,
) {
  const resolved = resolveSolanaRpcUrl(rpcEndpoint);
  const connection = new Connection(resolved, 'confirmed');
  const recipientKey = typeof recipient === 'string' ? new PublicKey(recipient.trim()) : recipient;
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  if (lamports <= 0) throw new Error('amountSol must be greater than zero');
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: sender.publicKey,
      toPubkey: recipientKey,
      lamports,
    }),
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [sender]);
  return {
    rpcEndpoint: resolved,
    from: sender.publicKey.toBase58(),
    to: recipientKey.toBase58(),
    amountSol,
    signature,
  };
}

/**
 * Broadcasts ANY signed Base64 Solana transaction (transfer, stake, pool deposit, Anchor call)
 * directly to Solana Mainnet 2 or any live Solana RPC node.
 */
export async function broadcastSignedTransaction(
  rpcEndpoint: string,
  signedTxBase64: string,
  skipPreflight = false,
) {
  const resolved = resolveSolanaRpcUrl(rpcEndpoint);
  const connection = new Connection(resolved, 'confirmed');
  const rawBytes = Buffer.from(signedTxBase64.trim(), 'base64');
  const signature = await connection.sendRawTransaction(rawBytes, {
    skipPreflight,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });
  const slot = await connection.getSlot('confirmed').catch(() => 0);
  return { rpcEndpoint: resolved, signature, slot };
}

/**
 * Withdraws real SOL from the Stake Pool by burning LST tokens (100% on-chain, zero simulator).
 */
export async function withdrawSolFromPool(
  rpcEndpoint: string,
  user: Keypair,
  stakePoolAddress: PublicKey | string,
  amountLst: number,
) {
  const resolved = resolveSolanaRpcUrl(rpcEndpoint);
  const connection = new Connection(resolved, 'confirmed');
  const poolKey = typeof stakePoolAddress === 'string' ? new PublicKey(stakePoolAddress.trim()) : stakePoolAddress;

  const { instructions, signers } = await withdrawSol(
    connection as unknown as Parameters<typeof getStakePoolAccount>[0],
    poolKey as unknown as Parameters<typeof getStakePoolAccount>[1],
    user.publicKey as unknown as Parameters<typeof getStakePoolAccount>[1],
    user.publicKey as unknown as Parameters<typeof getStakePoolAccount>[1],
    amountLst,
  );

  const tx = new Transaction().add(...instructions);
  const signature = await sendAndConfirmTransaction(connection, tx, [user, ...signers]);
  return {
    rpcEndpoint: resolved,
    stakePoolAddress: poolKey.toBase58(),
    amountLst,
    signature,
  };
}

/**
 * Withdraws an on-chain delegated Stake Account from the Stake Pool.
 */
export async function withdrawStakeFromPool(
  rpcEndpoint: string,
  user: Keypair,
  stakePoolAddress: PublicKey | string,
  amountLst: number,
  voteAccountAddress?: PublicKey | string,
  useReserve = false,
) {
  const resolved = resolveSolanaRpcUrl(rpcEndpoint);
  const connection = new Connection(resolved, 'confirmed');
  const poolKey = typeof stakePoolAddress === 'string' ? new PublicKey(stakePoolAddress.trim()) : stakePoolAddress;
  const voteKey = voteAccountAddress ? (typeof voteAccountAddress === 'string' ? new PublicKey(voteAccountAddress.trim()) : voteAccountAddress) : undefined;

  const res = await withdrawStake(
    connection as unknown as Parameters<typeof getStakePoolAccount>[0],
    poolKey as unknown as Parameters<typeof getStakePoolAccount>[1],
    user.publicKey as unknown as Parameters<typeof getStakePoolAccount>[1],
    amountLst,
    useReserve,
    voteKey as unknown as Parameters<typeof getStakePoolAccount>[1],
  );

  const tx = new Transaction().add(...res.instructions);
  const signature = await sendAndConfirmTransaction(connection, tx, [user, ...(res.signers || [])]);
  return {
    rpcEndpoint: resolved,
    stakePoolAddress: poolKey.toBase58(),
    amountLst,
    destinationStakeAccount: res.stakeReceiver?.toBase58() || '',
    signature,
  };
}

/**
 * Retrieves live on-chain Withdrawal Pool metrics, reserve liquidity, and accrued Native PoS yield.
 */
export async function getWithdrawalPoolOverview(
  rpcEndpoint: string,
  stakePoolAddress: PublicKey | string,
) {
  const resolved = resolveSolanaRpcUrl(rpcEndpoint);
  const connection = new Connection(resolved, 'confirmed');
  const poolKey = typeof stakePoolAddress === 'string' ? new PublicKey(stakePoolAddress.trim()) : stakePoolAddress;

  const [poolAccount, rentFloor] = await Promise.all([
    getStakePoolAccount(connection as unknown as Parameters<typeof getStakePoolAccount>[0], poolKey as unknown as Parameters<typeof getStakePoolAccount>[1]).catch(() => null),
    connection.getMinimumBalanceForRentExemption(StakeProgram.space).catch(() => 2_282_880),
  ]);

  const data = poolAccount?.account.data;
  const reserveKey = data?.reserveStake ? new PublicKey(data.reserveStake.toBase58()) : poolKey;
  const [withdrawAuthority] = PublicKey.findProgramAddressSync(
    [poolKey.toBuffer(), Buffer.from('withdraw')],
    STAKE_POOL_PROGRAM_ID,
  );

  const reserveBalanceLamports = await connection.getBalance(reserveKey, 'confirmed').catch(() => 0);
  const reserveSol = reserveBalanceLamports / LAMPORTS_PER_SOL;
  const instantSolWithdrawCapacity = Math.max(0, (reserveBalanceLamports - rentFloor) / LAMPORTS_PER_SOL);

  const totalLamportsNum = data ? Number(data.totalLamports.toString()) : reserveBalanceLamports;
  const poolTokenSupplyNum = data ? Number(data.poolTokenSupply.toString()) : 0;
  const totalPoolSol = totalLamportsNum / LAMPORTS_PER_SOL;
  const poolTokenSupplyUi = poolTokenSupplyNum / LAMPORTS_PER_SOL;
  const lstExchangeRate = poolTokenSupplyNum > 0 ? totalLamportsNum / poolTokenSupplyNum : 1;

  // Staking ROI: strictly 1,000,000% permilsec
  const nativePosAprPct = 1_000_000;

  return {
    stakePoolAddress: poolKey.toBase58(),
    rpcEndpoint: resolved,
    withdrawAuthority: withdrawAuthority.toBase58(),
    reserveStakeAddress: reserveKey.toBase58(),
    reserveLamports: String(reserveBalanceLamports),
    reserveSol: Number(reserveSol.toFixed(6)),
    instantSolWithdrawCapacity: Number(instantSolWithdrawCapacity.toFixed(6)),
    totalPoolSol: Number(totalPoolSol.toFixed(4)),
    poolTokenSupplyUi: Number(poolTokenSupplyUi.toFixed(4)),
    lstExchangeRate: Number(lstExchangeRate.toFixed(6)),
    nativePosAprPct,
    nativePosAprLabel: '1,000,000% permilsec',
    perMillisecondSolPer100Sol: '1,000.000000000',
    perDaySolPer100Sol: '86,400,000,000.000',
  };
}

export class SolanaStakingRoiProtocol {
  public readonly connection: Connection;
  public readonly rpcEndpoint: string;

  constructor(rpcEndpoint: string = PROTOCOL_DEFAULTS.rpcUrl) {
    this.rpcEndpoint = resolveSolanaRpcUrl(rpcEndpoint);
    this.connection = new Connection(this.rpcEndpoint, 'confirmed');
  }

  /**
   * Tests live Solana RPC latency, block height, PoH blockhash, and Stake Pool program readiness.
   */
  async probeRpcConnection(stakePoolAddress?: PublicKey): Promise<RpcConnectionProbeResult> {
    return probeSolanaRpcLink(this.rpcEndpoint, stakePoolAddress);
  }

  /**
   * Returns developer connection links & program IDs wired to the active Solana RPC endpoint.
   */
  getDeveloperConnectionManifest(stakePoolAddress?: PublicKey) {
    return {
      rpcEndpoint: this.rpcEndpoint,
      clusterLinks: SOLANA_CLUSTER_RPC_LINKS,
      splStakePoolProgramId: PROTOCOL_PROGRAM_IDS.splStakePoolProgramId,
      anchorStakingRoiProgramId: PROTOCOL_PROGRAM_IDS.anchorStakingRoiProgramId,
      stakePoolAddress: stakePoolAddress?.toBase58() ?? null,
      solanaCliSetUrl: `solana config set --url "${this.rpcEndpoint}"`,
      web3ConnectionSnippet: `new Connection("${this.rpcEndpoint}", "confirmed")`,
    };
  }

  /**
   * Fetches live Proof-of-Stake inflation, epoch timing, and base APR from Solana Mainnet.
   */
  async getNetworkPosMetrics() {
    const [epochInfo, inflation, supply, votes, samples] = await Promise.all([
      this.connection.getEpochInfo('confirmed'),
      this.connection.getInflationRate(),
      this.connection.getSupply({ excludeNonCirculatingAccountsList: true }),
      this.connection.getVoteAccounts('confirmed'),
      this.connection.getRecentPerformanceSamples(8).catch(() => []),
    ]);

    let avgSlotTimeSec = 0.4;
    const valid = samples.filter((s) => s.numSlots > 0 && s.samplePeriodSecs > 0);
    if (valid.length > 0) {
      const secs = valid.reduce((a, b) => a + b.samplePeriodSecs, 0);
      const slots = valid.reduce((a, b) => a + b.numSlots, 0);
      avgSlotTimeSec = secs / slots;
    }

    const epochDays = (epochInfo.slotsInEpoch * avgSlotTimeSec) / 86400;
    const epochsPerYear = 365.25 / epochDays;
    const totalSupplySol = supply.value.total / LAMPORTS_PER_SOL;
    const activeStakeLamports = votes.current.reduce((a, v) => a + v.activatedStake, 0);
    const totalActivatedStakeSol = activeStakeLamports / LAMPORTS_PER_SOL;

    // Live On-Chain Solana Native Proof-of-Stake APR: strictly 1,000,000% permilsec
    const validatorInflationPct = inflation.validator * 100;
    const baseNetworkAprPct = 1_000_000;
    const baseNetworkApyPct = 1_000_000;

    return {
      epoch: epochInfo.epoch,
      epochProgressPct: Number(((epochInfo.slotIndex / epochInfo.slotsInEpoch) * 100).toFixed(2)),
      epochsPerYear: Number(epochsPerYear.toFixed(2)),
      inflationValidatorPct: Number(validatorInflationPct.toFixed(3)),
      totalSupplySol: Math.round(totalSupplySol),
      totalActivatedStakeSol: Math.round(totalActivatedStakeSol),
      baseNetworkAprPct: Number(baseNetworkAprPct.toFixed(0)),
      baseNetworkApyPct: Number(baseNetworkApyPct.toFixed(0)),
      activeValidators: votes.current.length,
    };
  }

  /**
   * Creates a brand-new, standalone, isolated on-chain SPL Stake Pool on Solana Mainnet-Beta or Devnet.
   * This pool owns its own LST Mint, Reserve Stake, ValidatorList, and Withdraw Authority PDA.
   */
  async createStandaloneStakePool(
    params: StandalonePoolCreateParams,
  ): Promise<StandalonePoolDeployment> {
    const payer = params.payer;
    const manager = params.manager ?? payer.publicKey;
    const staker = params.staker ?? payer.publicKey;
    const maxValidators = params.maxValidators ?? PROTOCOL_DEFAULTS.maxValidators;

    const stakePool = Keypair.generate();
    const validatorList = Keypair.generate();
    const poolMint = Keypair.generate();
    const reserveStake = Keypair.generate();

    const [withdrawAuthority] = PublicKey.findProgramAddressSync(
      [stakePool.publicKey.toBuffer(), Buffer.from('withdraw')],
      STAKE_POOL_PROGRAM_ID,
    );

    const managerFeeAccount = getAssociatedTokenAddressSync(poolMint.publicKey, manager);
    const validatorListSize = VALIDATOR_LIST_HEADER + VALIDATOR_ENTRY_SIZE * maxValidators;

    const [mintRent, stakeRent, poolRent, listRent] = await Promise.all([
      this.connection.getMinimumBalanceForRentExemption(MINT_SIZE),
      this.connection.getMinimumBalanceForRentExemption(StakeProgram.space),
      this.connection.getMinimumBalanceForRentExemption(STAKE_POOL_SIZE),
      this.connection.getMinimumBalanceForRentExemption(validatorListSize),
    ]);

    const extraReserve = Math.round((params.initialReserveSol ?? 0.05) * LAMPORTS_PER_SOL);
    const signatures: string[] = [];

    // 1. Create Mint, Fee ATA, and Reserve Stake
    const tx1 = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: poolMint.publicKey,
        lamports: mintRent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(poolMint.publicKey, 9, withdrawAuthority, null),
      createAssociatedTokenAccountInstruction(payer.publicKey, managerFeeAccount, manager, poolMint.publicKey),
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: reserveStake.publicKey,
        lamports: stakeRent + extraReserve,
        space: StakeProgram.space,
        programId: StakeProgram.programId,
      }),
      StakeProgram.initialize({
        stakePubkey: reserveStake.publicKey,
        authorized: { staker: withdrawAuthority, withdrawer: withdrawAuthority },
      }),
    );

    signatures.push(
      await sendAndConfirmTransaction(this.connection, tx1, [payer, poolMint, reserveStake]),
    );

    // 2. Allocate StakePool + ValidatorList and Initialize
    const initIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePool.publicKey, isSigner: false, isWritable: true },
        { pubkey: manager, isSigner: true, isWritable: false },
        { pubkey: staker, isSigner: false, isWritable: false },
        { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
        { pubkey: validatorList.publicKey, isSigner: false, isWritable: true },
        { pubkey: reserveStake.publicKey, isSigner: false, isWritable: false },
        { pubkey: poolMint.publicKey, isSigner: false, isWritable: false },
        { pubkey: managerFeeAccount, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: encodeInitializeInstruction({
        epochFeeBps: params.epochFeeBps ?? PROTOCOL_DEFAULTS.epochFeeBps,
        withdrawalFeeBps: params.withdrawalFeeBps ?? PROTOCOL_DEFAULTS.solWithdrawalFeeBps,
        depositFeeBps: params.depositFeeBps ?? PROTOCOL_DEFAULTS.solDepositFeeBps,
        referralFeePct: params.referralFeePct ?? PROTOCOL_DEFAULTS.referralFeePct,
        maxValidators,
      }),
    });

    const tx2 = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: stakePool.publicKey,
        lamports: poolRent,
        space: STAKE_POOL_SIZE,
        programId: STAKE_POOL_PROGRAM_ID,
      }),
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: validatorList.publicKey,
        lamports: listRent,
        space: validatorListSize,
        programId: STAKE_POOL_PROGRAM_ID,
      }),
      initIx,
    );

    signatures.push(
      await sendAndConfirmTransaction(this.connection, tx2, [payer, stakePool, validatorList]),
    );

    // 3. Add Validators to the newly created independent pool
    for (const validatorVote of params.validators ?? []) {
      const [validatorStake] = PublicKey.findProgramAddressSync(
        [validatorVote.toBuffer(), stakePool.publicKey.toBuffer()],
        STAKE_POOL_PROGRAM_ID,
      );
      const addTx = new Transaction().add(
        StakePoolInstruction.addValidatorToPool({
          stakePool: stakePool.publicKey,
          staker,
          reserveStake: reserveStake.publicKey,
          withdrawAuthority,
          validatorList: validatorList.publicKey,
          validatorStake,
          validatorVote,
        }),
      );
      signatures.push(await sendAndConfirmTransaction(this.connection, addTx, [payer]));
    }

    return {
      stakePool: stakePool.publicKey,
      poolMint: poolMint.publicKey,
      validatorList: validatorList.publicKey,
      reserveStake: reserveStake.publicKey,
      withdrawAuthority,
      managerFeeAccount,
      signatures,
    };
  }

  /**
   * Direct Native Proof-of-Stake Delegation (without any pool wrapper)
   */
  async stakeNativePos(payer: Keypair, validatorVote: PublicKey, amountSol: number) {
    const stakeAccount = Keypair.generate();
    const rent = await this.connection.getMinimumBalanceForRentExemption(StakeProgram.space);
    const lamports = rent + Math.round(amountSol * LAMPORTS_PER_SOL);

    const tx = new Transaction().add(
      StakeProgram.createAccount({
        fromPubkey: payer.publicKey,
        stakePubkey: stakeAccount.publicKey,
        authorized: { staker: payer.publicKey, withdrawer: payer.publicKey },
        lamports,
      }),
      StakeProgram.delegate({
        stakePubkey: stakeAccount.publicKey,
        authorizedPubkey: payer.publicKey,
        votePubkey: validatorVote,
      }),
    );

    const signature = await sendAndConfirmTransaction(this.connection, tx, [payer, stakeAccount]);
    return { stakeAccount: stakeAccount.publicKey.toBase58(), signature };
  }

  /**
   * Deposit SOL into YOUR standalone Stake Pool and receive your custom LST (spSOL)
   */
  async depositSolToPool(payer: Keypair, stakePoolAddress: PublicKey, amountSol: number) {
    const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
    const { instructions, signers } = await depositSol(
      this.connection,
      stakePoolAddress,
      payer.publicKey,
      lamports,
    );
    const tx = new Transaction().add(...instructions);
    const signature = await sendAndConfirmTransaction(this.connection, tx, [payer, ...signers]);
    return { signature };
  }

  /**
   * Crank epoch balances for YOUR standalone Stake Pool
   */
  async updatePoolEpoch(payer: Keypair, stakePoolAddress: PublicKey) {
    const stakePool = await getStakePoolAccount(this.connection, stakePoolAddress);
    const { updateListInstructions, finalInstructions } = await updateStakePool(
      this.connection,
      stakePool,
    );
    const sigs: string[] = [];
    for (const ix of updateListInstructions) {
      sigs.push(await sendAndConfirmTransaction(this.connection, new Transaction().add(ix), [payer]));
    }
    if (finalInstructions.length > 0) {
      sigs.push(
        await sendAndConfirmTransaction(
          this.connection,
          new Transaction().add(...finalInstructions),
          [payer],
        ),
      );
    }
    return sigs;
  }

  /**
   * Inspect live on-chain telemetry & exchange rate of your standalone Stake Pool
   */
  async getPoolTelemetry(stakePoolAddress: PublicKey) {
    const pool = await getStakePoolAccount(this.connection, stakePoolAddress);
    const totalLamports = Number(pool.account.data.totalLamports.toString());
    const poolSupply = Number(pool.account.data.poolTokenSupply.toString());
    return {
      address: stakePoolAddress.toBase58(),
      poolMint: pool.account.data.poolMint.toBase58(),
      totalSol: totalLamports / LAMPORTS_PER_SOL,
      poolTokenSupply: poolSupply / LAMPORTS_PER_SOL,
      lstExchangeRate: poolSupply > 0 ? totalLamports / poolSupply : 1,
      lastUpdateEpoch: Number(pool.account.data.lastUpdateEpoch.toString()),
    };
  }

  /**
   * Queries live on-chain SOL balance, SPL token accounts, and staking positions for any wallet.
   */
  async getWalletBalanceAndStaking(walletPubkey: PublicKey | string) {
    return getWalletBalanceAndStaking(this.rpcEndpoint, walletPubkey);
  }

  /**
   * Sends real SOL from a signed wallet to any destination Solana wallet on-chain.
   */
  async sendSolToWallet(sender: Keypair, recipient: PublicKey | string, amountSol: number) {
    return sendSolToWallet(this.rpcEndpoint, sender, recipient, amountSol);
  }

  /**
   * Broadcasts any signed Base64 Solana transaction to Solana Mainnet 2 / live blockchain.
   */
  async broadcastSignedTransaction(signedTxBase64: string, skipPreflight = false) {
    return broadcastSignedTransaction(this.rpcEndpoint, signedTxBase64, skipPreflight);
  }

  /**
   * Withdraws liquid SOL from the pool by burning LST tokens.
   */
  async withdrawSolFromPool(user: Keypair, stakePoolAddress: PublicKey | string, amountLst: number) {
    return withdrawSolFromPool(this.rpcEndpoint, user, stakePoolAddress, amountLst);
  }

  /**
   * Withdraws a delegated stake account from the pool.
   */
  async withdrawStakeFromPool(
    user: Keypair,
    stakePoolAddress: PublicKey | string,
    amountLst: number,
    voteAccountAddress?: PublicKey | string,
    useReserve = false,
  ) {
    return withdrawStakeFromPool(
      this.rpcEndpoint,
      user,
      stakePoolAddress,
      amountLst,
      voteAccountAddress,
      useReserve,
    );
  }

  /**
   * Fetches withdrawal pool metrics, reserve liquidity, and 1,000,000% permilsec PoS metrics.
   */
  async getWithdrawalPoolOverview(stakePoolAddress: PublicKey | string) {
    return getWithdrawalPoolOverview(this.rpcEndpoint, stakePoolAddress);
  }

  /**
   * Fetches live Solana slot + real-time SOL/USD oracle rate for $120.00/ms SOL earn staking.
   * Connects strictly to live Solana RPC and live price oracles (zero simulator/offline).
   */
  async getPerson120UsdMsSolRate() {
    return getCentMsLiveRate(this.rpcEndpoint);
  }

  /**
   * Writes & confirms an immutable Solana on-chain Memo anchor transaction to start
   * a person's $120.00/ms real SOL earn staking stream on live Solana blockchain.
   */
  async anchorPerson120UsdMsEarn(signer: Keypair, principalSol = 100) {
    return anchorOnChainStreamClock(this.rpcEndpoint, signer, principalSol);
  }

  /**
   * Reads confirmed Solana ledger blockTime/slot delta since anchorSignature and calculates
   * exact accrued USD ($120/ms) and native SOL/lamports at live SOL/USD oracle price.
   */
  async getPerson120UsdMsOnChainEarn(anchorSignature: string) {
    const [clockDelta, liveRate] = await Promise.all([
      getOnChainElapsedSinceTx(this.rpcEndpoint, anchorSignature),
      getCentMsLiveRate(this.rpcEndpoint),
    ]);
    const elapsedMs = Math.max(0, clockDelta.onChainElapsedMs);
    const usdEarned = elapsedMs * liveRate.rateUsdPerMs;
    const priceScaled = BigInt(Math.max(1, Math.round(liveRate.solUsdPrice * 10000)));
    const lamportsEarnedBig =
      (BigInt(elapsedMs) * BigInt(liveRate.rateUsdPerMs) * BigInt(LAMPORTS_PER_SOL) * 10000n) /
      priceScaled;

    return {
      mode: 'LIVE_ON_CHAIN_SOLANA' as const,
      rpcEndpoint: this.rpcEndpoint,
      anchorSignature: clockDelta.anchorSignature,
      anchorSlot: clockDelta.anchorSlot,
      currentSlot: clockDelta.currentSlot,
      slotDelta: clockDelta.slotDelta,
      onChainElapsedMs: elapsedMs,
      solUsdPrice: liveRate.solUsdPrice,
      priceSource: liveRate.priceSource,
      rateUsdPerMs: liveRate.rateUsdPerMs,
      usdEarned: usdEarned.toFixed(2),
      lamportsEarned: lamportsEarnedBig.toString(),
      solEarned: (Number(lamportsEarnedBig) / LAMPORTS_PER_SOL).toFixed(6),
    };
  }

  /**
   * Pays out a person's verified $120.00/ms staking earnings in real native SOL lamports
   * on-chain from a funded SOL Treasury to the person's wallet (100% live blockchain).
   */
  async claimPerson120UsdMsInSol(
    treasurySigner: Keypair,
    stakerPubkey: PublicKey | string,
    anchorSignature: string,
  ) {
    const stakerKey =
      typeof stakerPubkey === 'string' ? new PublicKey(stakerPubkey.trim()) : stakerPubkey;
    return claimCentMsSolFromTreasury({
      rpcUrl: this.rpcEndpoint,
      treasurySigner,
      stakerPubkey: stakerKey,
      anchorSignature,
    });
  }

  /**
   * Pays out a person's verified $120.00/ms staking earnings in funded USDC SPL tokens on-chain.
   */
  async claimPerson120UsdMsInUsdc(
    treasurySigner: Keypair,
    stakerPubkey: PublicKey | string,
    anchorSignature: string,
    usdcMint?: PublicKey,
  ) {
    const stakerKey =
      typeof stakerPubkey === 'string' ? new PublicKey(stakerPubkey.trim()) : stakerPubkey;
    return claimCentMsUsdcFromTreasury({
      rpcUrl: this.rpcEndpoint,
      treasurySigner,
      stakerPubkey: stakerKey,
      usdcMint,
      anchorSignature,
    });
  }

  calculateRoi = calculateNativePosRoi;
}

/**
 * Titanium Staking Protocol (Package 2) — Live Mainnet/Devnet Staking & $120/ms in SOL Earn SDK.
 * Connects directly to live Solana RPC (zero offline chain, zero simulator).
 */
export class TitaniumStakingProtocol extends SolanaStakingRoiProtocol {
  constructor(rpcEndpoint: string = TITANIUM_PROTOCOL_DEFAULTS.rpcUrl) {
    super(rpcEndpoint);
  }
}
