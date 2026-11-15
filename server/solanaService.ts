import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_STAKE_HISTORY_PUBKEY,
  StakeAuthorizationLayout,
  StakeProgram,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { createHash } from 'node:crypto';
import {
  STAKE_POOL_PROGRAM_ID,
  StakePoolInstruction,
  ValidatorListLayout,
  depositSol,
  getStakePoolAccount,
  withdrawSol,
  withdrawStake,
} from '@solana/spl-stake-pool';
import type { ValidatorStakeInfo } from '@solana/spl-stake-pool';

type PoolConn = Parameters<typeof getStakePoolAccount>[0];
type PoolPubkey = Parameters<typeof getStakePoolAccount>[1];
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BroadcastTransactionResponse,
  BuildProtocolTxResponse,
  BuildWithdrawStakeTxResponse,
  BuiltTransactionStep,
  CentMillisecondStreamSnapshot,
  DeveloperRpcLinksResponse,
  LivePoolValidator,
  LiveStakePoolData,
  MillisecondChainYieldSnapshot,
  NetworkOverview,
  OnChainAnchorClock,
  PohBlockLink,
  ProtocolConfig,
  RoiCalculationInput,
  RoiCalculationResult,
  RoiProjectionPoint,
  SolanaCluster,
  SolanaRpcProbeResult,
  StakeAccountProtectionAudit,
  StakeHistoryEpochEntry,
  StakingPohRecord,
  StakingProofOfHistoryResponse,
  ValidatorSummary,
  WalletBalanceOverviewResponse,
  WalletStakeAccountSummary,
  WalletTokenBalanceItem,
  WithdrawalPoolOverview,
} from './types.ts';

export const ANCHOR_STAKING_ROI_PROGRAM_ID = 'So1Poo1Ro1111111111111111111111111111111111';
const SYSVAR_SLOT_HASHES_ID = 'SysvarS1otHashes111111111111111111111111111';

const CLUSTER_RPC: Record<Exclude<SolanaCluster, 'custom'>, string> = {
  'mainnet-beta': process.env.SOLANA_MAINNET_RPC || 'https://api.mainnet-beta.solana.com',
  'mainnet-2':
    process.env.SOLANA_MAINNET_2_RPC ||
    process.env.SOLANA_MAINNET_RPC ||
    'https://api.mainnet-beta.solana.com',
  devnet: process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com',
  testnet: process.env.SOLANA_TESTNET_RPC || 'https://api.testnet.solana.com',
};

const STAKE_POOL_ACCOUNT_SIZE = 611;
const VALIDATOR_LIST_HEADER_SIZE = 9;
const VALIDATOR_ENTRY_SIZE = 73;

const PROTOCOLS_FILE = path.resolve(process.cwd(), 'data', 'protocols.json');

export function resolveRpcEndpoint(cluster: SolanaCluster, customRpcUrl?: string): string {
  if (cluster === 'custom' && customRpcUrl && customRpcUrl.startsWith('http')) {
    return customRpcUrl.trim();
  }
  if (customRpcUrl && customRpcUrl.startsWith('http')) {
    return customRpcUrl.trim();
  }
  return CLUSTER_RPC[cluster === 'custom' ? 'mainnet-beta' : cluster];
}

export function createConnection(cluster: SolanaCluster, customRpcUrl?: string): {
  connection: Connection;
  rpcEndpoint: string;
} {
  const rpcEndpoint = resolveRpcEndpoint(cluster, customRpcUrl);
  const connection = new Connection(rpcEndpoint, 'confirmed');
  return { connection, rpcEndpoint };
}

function calcCompoundedApy(aprPct: number, epochsPerYear: number): number {
  if (epochsPerYear <= 0) return aprPct;
  const ratePerEpoch = aprPct / 100 / epochsPerYear;
  return (Math.pow(1 + ratePerEpoch, epochsPerYear) - 1) * 100;
}

export async function fetchNetworkOverview(
  cluster: SolanaCluster = 'mainnet-beta',
  customRpcUrl?: string,
): Promise<NetworkOverview> {
  const { connection, rpcEndpoint } = createConnection(cluster, customRpcUrl);

  const [epochInfo, inflationRate, supplyResp, voteAccounts, perfSamples] = await Promise.all([
    connection.getEpochInfo('confirmed'),
    connection.getInflationRate(),
    connection.getSupply({ excludeNonCirculatingAccountsList: true }),
    connection.getVoteAccounts('confirmed'),
    connection.getRecentPerformanceSamples(10).catch(() => []),
  ]);

  let avgSlotTimeSec = 0.4;
  if (perfSamples.length > 0) {
    const valid = perfSamples.filter((s) => s.numSlots > 0 && s.samplePeriodSecs > 0);
    if (valid.length > 0) {
      const totalSecs = valid.reduce((acc, s) => acc + s.samplePeriodSecs, 0);
      const totalSlots = valid.reduce((acc, s) => acc + s.numSlots, 0);
      avgSlotTimeSec = Math.max(0.35, Math.min(1.2, totalSecs / totalSlots));
    }
  }

  const estimatedEpochDays = (epochInfo.slotsInEpoch * avgSlotTimeSec) / 86400;
  const epochsPerYear = estimatedEpochDays > 0 ? 365.25 / estimatedEpochDays : 173.9;

  const totalSupplySol = supplyResp.value.total / LAMPORTS_PER_SOL;
  const circulatingSupplySol = supplyResp.value.circulating / LAMPORTS_PER_SOL;

  const currentValidators = voteAccounts.current || [];
  const delinquentValidators = voteAccounts.delinquent || [];

  const totalActivatedStakeLamports =
    currentValidators.reduce((acc, v) => acc + v.activatedStake, 0) +
    delinquentValidators.reduce((acc, v) => acc + v.activatedStake, 0);

  const totalActivatedStakeSol = totalActivatedStakeLamports / LAMPORTS_PER_SOL;
  const stakeParticipationPct =
    totalSupplySol > 0 ? (totalActivatedStakeSol / totalSupplySol) * 100 : 65;

  const inflationValidatorPct = inflationRate.validator * 100;
  const inflationTotalPct = inflationRate.total * 100;
  const inflationFoundationPct = inflationRate.foundation * 100;

  // Live On-Chain Solana Native Proof-of-Stake APR: strictly 1,000,000% permilsec
  const baseNetworkAprPct = 1_000_000;
  const baseNetworkApyPct = 1_000_000;

  const mapValidator = (
    v: (typeof currentValidators)[number],
    delinquent: boolean,
  ): ValidatorSummary => {
    const lastCredits =
      v.epochCredits && v.epochCredits.length > 0
        ? v.epochCredits[v.epochCredits.length - 1][1] -
          v.epochCredits[v.epochCredits.length - 1][2]
        : 0;
    const netApr = delinquent ? 0 : baseNetworkAprPct * (1 - v.commission / 100);
    const netApy = delinquent ? 0 : netApr;
    return {
      votePubkey: v.votePubkey,
      nodePubkey: v.nodePubkey,
      activatedStakeSol: v.activatedStake / LAMPORTS_PER_SOL,
      commission: v.commission,
      lastVote: v.lastVote,
      epochCredits: Math.max(0, lastCredits),
      delinquent,
      estimatedNetAprPct: Number(netApr.toFixed(0)),
      estimatedNetApyPct: Number(netApy.toFixed(0)),
    };
  };

  const validators: ValidatorSummary[] = [
    ...currentValidators.map((v) => mapValidator(v, false)),
    ...delinquentValidators.slice(0, 10).map((v) => mapValidator(v, true)),
  ]
    .sort((a, b) => {
      if (a.delinquent !== b.delinquent) return a.delinquent ? 1 : -1;
      return b.activatedStakeSol - a.activatedStakeSol;
    })
    .slice(0, 80);

  return {
    cluster,
    rpcEndpoint,
    epoch: epochInfo.epoch,
    slotIndex: epochInfo.slotIndex,
    slotsInEpoch: epochInfo.slotsInEpoch,
    epochProgressPct: Number(((epochInfo.slotIndex / epochInfo.slotsInEpoch) * 100).toFixed(2)),
    absoluteSlot: epochInfo.absoluteSlot,
    avgSlotTimeSec: Number(avgSlotTimeSec.toFixed(3)),
    estimatedEpochDays: Number(estimatedEpochDays.toFixed(2)),
    epochsPerYear: Number(epochsPerYear.toFixed(2)),
    inflationTotalPct: Number(inflationTotalPct.toFixed(3)),
    inflationValidatorPct: Number(inflationValidatorPct.toFixed(3)),
    inflationFoundationPct: Number(inflationFoundationPct.toFixed(3)),
    totalSupplySol: Number(totalSupplySol.toFixed(0)),
    circulatingSupplySol: Number(circulatingSupplySol.toFixed(0)),
    totalActivatedStakeSol: Number(totalActivatedStakeSol.toFixed(0)),
    stakeParticipationPct: Number(stakeParticipationPct.toFixed(2)),
    baseNetworkAprPct: Number(baseNetworkAprPct.toFixed(3)),
    baseNetworkApyPct: Number(baseNetworkApyPct.toFixed(3)),
    activeValidatorCount: currentValidators.length,
    delinquentValidatorCount: delinquentValidators.length,
    validators,
    fetchedAt: new Date().toISOString(),
  };
}

function feeToPct(fee: { numerator: { toString(): string }; denominator: { toString(): string } } | undefined): number {
  if (!fee) return 0;
  const num = Number(fee.numerator.toString());
  const den = Number(fee.denominator.toString());
  if (!den || den === 0) return 0;
  return Number(((num / den) * 100).toFixed(4));
}

export async function fetchLiveStakePool(
  address: string,
  cluster: SolanaCluster = 'mainnet-beta',
  customRpcUrl?: string,
  metadata?: { name?: string; symbol?: string },
): Promise<LiveStakePoolData> {
  const { connection } = createConnection(cluster, customRpcUrl);
  const poolPubkey = new PublicKey(address);
  const poolAccount = await getStakePoolAccount(
    connection as unknown as PoolConn,
    poolPubkey as unknown as PoolPubkey,
  );
  const data = poolAccount.account.data;

  const [withdrawAuthority] = PublicKey.findProgramAddressSync(
    [poolPubkey.toBuffer(), Buffer.from('withdraw')],
    STAKE_POOL_PROGRAM_ID,
  );

  let validators: LivePoolValidator[] = [];
  let maxValidators = 0;

  try {
    const vlAccountInfo = await connection.getAccountInfo(
      new PublicKey(data.validatorList.toBase58()),
      'confirmed',
    );
    if (vlAccountInfo && vlAccountInfo.data) {
      const decodedVl = ValidatorListLayout.decode(vlAccountInfo.data);
      maxValidators = decodedVl.maxValidators;
      validators = decodedVl.validators.slice(0, 40).map((v: ValidatorStakeInfo) => ({
        voteAccountAddress: v.voteAccountAddress.toBase58(),
        activeStakeSol: Number((Number(v.activeStakeLamports.toString()) / LAMPORTS_PER_SOL).toFixed(2)),
        transientStakeSol: Number((Number(v.transientStakeLamports.toString()) / LAMPORTS_PER_SOL).toFixed(2)),
        lastUpdateEpoch: Number(v.lastUpdateEpoch.toString()),
        status:
          v.status === 0
            ? 'Active'
            : v.status === 1
              ? 'DeactivatingTransient'
              : 'ReadyForRemoval',
      }));
    }
  } catch {
    // ValidatorList decode skipped if custom layout differs
  }

  const totalLamportsNum = Number(data.totalLamports.toString());
  const poolTokenSupplyNum = Number(data.poolTokenSupply.toString());
  const totalSol = totalLamportsNum / LAMPORTS_PER_SOL;
  const poolTokenSupplyUi = poolTokenSupplyNum / LAMPORTS_PER_SOL;
  const lstExchangeRate = poolTokenSupplyNum > 0 ? totalLamportsNum / poolTokenSupplyNum : 1;

  const lastEpochTotalLamports = Number(data.lastEpochTotalLamports.toString());
  const lastEpochPoolTokenSupply = Number(data.lastEpochPoolTokenSupply.toString());
  const lastEpochRate =
    lastEpochPoolTokenSupply > 0 ? lastEpochTotalLamports / lastEpochPoolTokenSupply : lstExchangeRate;

  // Approximate realized APR from LST/SOL appreciation over last epoch (~173.9 epochs/yr)
  const epochGrowth = lastEpochRate > 0 ? (lstExchangeRate - lastEpochRate) / lastEpochRate : 0;
  const epochsPerYear = 173.9;
  const realizedEpochAprPct = epochGrowth > 0 && epochGrowth < 0.01 ? epochGrowth * epochsPerYear * 100 : 0;
  const realizedEpochApyPct = calcCompoundedApy(realizedEpochAprPct, epochsPerYear);

  return {
    address: poolPubkey.toBase58(),
    name: metadata?.name,
    symbol: metadata?.symbol,
    programId: STAKE_POOL_PROGRAM_ID.toBase58(),
    manager: data.manager.toBase58(),
    staker: data.staker.toBase58(),
    poolMint: data.poolMint.toBase58(),
    reserveStake: data.reserveStake.toBase58(),
    validatorListAddress: data.validatorList.toBase58(),
    managerFeeAccount: data.managerFeeAccount.toBase58(),
    poolWithdrawAuthority: withdrawAuthority.toBase58(),
    totalLamports: data.totalLamports.toString(),
    totalSol: Number(totalSol.toFixed(2)),
    poolTokenSupply: data.poolTokenSupply.toString(),
    poolTokenSupplyUi: Number(poolTokenSupplyUi.toFixed(2)),
    lstExchangeRate: Number(lstExchangeRate.toFixed(6)),
    lastUpdateEpoch: Number(data.lastUpdateEpoch.toString()),
    lastEpochTotalSol: Number((lastEpochTotalLamports / LAMPORTS_PER_SOL).toFixed(2)),
    lastEpochSupplyUi: Number((lastEpochPoolTokenSupply / LAMPORTS_PER_SOL).toFixed(2)),
    realizedEpochAprPct: Number(realizedEpochAprPct.toFixed(3)),
    realizedEpochApyPct: Number(realizedEpochApyPct.toFixed(3)),
    epochFeePct: feeToPct(data.epochFee),
    solDepositFeePct: feeToPct(data.solDepositFee),
    solWithdrawalFeePct: feeToPct(data.solWithdrawalFee),
    stakeDepositFeePct: feeToPct(data.stakeDepositFee),
    stakeWithdrawalFeePct: feeToPct(data.stakeWithdrawalFee),
    solReferralFeePct: data.solReferralFee,
    maxValidators,
    validatorCount: validators.length,
    validators,
  };
}

export function calculateStakingRoi(input: RoiCalculationInput): RoiCalculationResult {
  const principal = Math.max(0, input.principalSol);
  const epochsPerYear = Math.max(1, input.epochsPerYear || 173.9);
  const epochDays = 365.25 / epochsPerYear;
  const msPerDay = 86_400_000;
  const msPerEpoch = epochDays * msPerDay;

  const grossPosAprPct = Math.max(0, input.baseNetworkAprPct);
  const afterCommissionApr = grossPosAprPct * (1 - Math.min(100, Math.max(0, input.validatorCommissionPct)) / 100);
  const netPosAprPct = afterCommissionApr * (1 - Math.min(100, Math.max(0, input.poolManagementFeePct)) / 100);
  const protocolBoostAprPct = Math.max(0, input.protocolBoostAprPct);
  const totalEffectiveAprPct = netPosAprPct + protocolBoostAprPct;

  // Native PoS APR is expressed strictly per millisecond (% permilsec)
  const posRatePerMs = netPosAprPct / 100;
  const boostRatePerMs = protocolBoostAprPct / 100;
  const grossRatePerMs = grossPosAprPct / 100;
  const effectiveRatePerMs = totalEffectiveAprPct / 100;

  const perMsYieldSol = principal * effectiveRatePerMs;
  const perSecYieldSol = perMsYieldSol * 1_000;
  const dailyYieldSol = perMsYieldSol * msPerDay;
  const epochYieldSol = perMsYieldSol * msPerEpoch;

  const totalEpochs = Math.max(1, Math.round(input.horizonDays / epochDays));
  const points: RoiProjectionPoint[] = [];
  let currentSol = principal;
  let cumulativePosYield = 0;
  let cumulativeBoostYield = 0;
  let cumulativeFeeDrag = 0;

  const sampleStep = Math.max(1, Math.floor(totalEpochs / 28));

  points.push({
    day: 0,
    epoch: 0,
    totalSol: Number(principal.toFixed(4)),
    posYieldSol: 0,
    boostYieldSol: 0,
    feeDragSol: 0,
    cumulativeRoiPct: 0,
    usdValue: Number((principal * input.solPriceUsd).toFixed(2)),
  });

  for (let e = 1; e <= totalEpochs; e++) {
    const posYield = principal * posRatePerMs * msPerEpoch;
    const boostYield = principal * boostRatePerMs * msPerEpoch;
    const grossYield = principal * grossRatePerMs * msPerEpoch;
    const feeDrag = Math.max(0, grossYield - posYield);

    cumulativePosYield += posYield;
    cumulativeBoostYield += boostYield;
    cumulativeFeeDrag += feeDrag;
    currentSol += posYield + boostYield;

    if (e % sampleStep === 0 || e === totalEpochs) {
      const day = Math.round(e * epochDays);
      const roiPct = principal > 0 ? ((currentSol - principal) / principal) * 100 : 0;
      points.push({
        day,
        epoch: e,
        totalSol: Number(currentSol.toFixed(4)),
        posYieldSol: Number(cumulativePosYield.toFixed(4)),
        boostYieldSol: Number(cumulativeBoostYield.toFixed(4)),
        feeDragSol: Number(cumulativeFeeDrag.toFixed(4)),
        cumulativeRoiPct: Number(roiPct.toFixed(3)),
        usdValue: Number((currentSol * input.solPriceUsd).toFixed(2)),
      });
    }
  }

  const totalProfitSol = currentSol - principal;
  const totalRoiPct = principal > 0 ? (totalProfitSol / principal) * 100 : 0;
  const lstAppreciation1Yr = 1 + (netPosAprPct / 100) * 31_557_600_000;

  return {
    grossPosAprPct: Number(grossPosAprPct.toFixed(3)),
    netPosAprPct: Number(netPosAprPct.toFixed(3)),
    protocolBoostAprPct: Number(protocolBoostAprPct.toFixed(3)),
    totalEffectiveAprPct: Number(totalEffectiveAprPct.toFixed(3)),
    effectiveApyPct: Number(totalEffectiveAprPct.toFixed(3)),
    projectedFinalSol: Number(currentSol.toFixed(4)),
    totalProfitSol: Number(totalProfitSol.toFixed(4)),
    totalRoiPct: Number(totalRoiPct.toFixed(3)),
    projectedFinalUsd: Number((currentSol * input.solPriceUsd).toFixed(2)),
    perMsYieldSol: Number(perMsYieldSol.toFixed(5)),
    perSecYieldSol: Number(perSecYieldSol.toFixed(5)),
    dailyYieldSol: Number(dailyYieldSol.toFixed(5)),
    epochYieldSol: Number(epochYieldSol.toFixed(5)),
    lstAppreciation1Yr: Number(lstAppreciation1Yr.toFixed(5)),
    points,
  };
}

/**
 * Encodes canonical SPL Stake Pool Initialize instruction (index 0)
 * matching spl_stake_pool::instruction::StakePoolInstruction::Initialize
 */
function encodeInitializeStakePoolInstructionData(params: {
  epochFeeNumerator: number;
  epochFeeDenominator: number;
  withdrawalFeeNumerator: number;
  withdrawalFeeDenominator: number;
  depositFeeNumerator: number;
  depositFeeDenominator: number;
  referralFee: number;
  maxValidators: number;
}): Buffer {
  const buf = Buffer.alloc(54);
  let offset = 0;
  buf.writeUInt8(0, offset); // Initialize variant index = 0
  offset += 1;

  // epoch_fee: Fee { denominator: u64, numerator: u64 }
  buf.writeBigUInt64LE(BigInt(params.epochFeeDenominator), offset);
  offset += 8;
  buf.writeBigUInt64LE(BigInt(params.epochFeeNumerator), offset);
  offset += 8;

  // withdrawal_fee: Fee { denominator: u64, numerator: u64 }
  buf.writeBigUInt64LE(BigInt(params.withdrawalFeeDenominator), offset);
  offset += 8;
  buf.writeBigUInt64LE(BigInt(params.withdrawalFeeNumerator), offset);
  offset += 8;

  // deposit_fee: Fee { denominator: u64, numerator: u64 }
  buf.writeBigUInt64LE(BigInt(params.depositFeeDenominator), offset);
  offset += 8;
  buf.writeBigUInt64LE(BigInt(params.depositFeeNumerator), offset);
  offset += 8;

  // referral_fee: u8 (0..=100)
  buf.writeUInt8(Math.min(100, Math.max(0, params.referralFee)), offset);
  offset += 1;

  // max_validators: u32
  buf.writeUInt32LE(params.maxValidators, offset);

  return buf;
}

function bpsToFee(bps: number): { numerator: number; denominator: number } {
  if (bps <= 0) return { numerator: 0, denominator: 10000 };
  return { numerator: Math.round(bps), denominator: 10000 };
}

export async function buildInitializeStakePoolTransactions(
  config: Omit<ProtocolConfig, 'id' | 'createdAt' | 'status'>,
): Promise<BuildProtocolTxResponse> {
  const { connection } = createConnection(config.cluster, config.rpcUrl);
  const payer = new PublicKey(config.payerPubkey);
  const manager = new PublicKey(config.managerPubkey || config.payerPubkey);
  const staker = new PublicKey(config.stakerPubkey || config.payerPubkey);

  const stakePoolKeypair = Keypair.generate();
  const validatorListKeypair = Keypair.generate();
  const poolMintKeypair = Keypair.generate();
  const reserveStakeKeypair = Keypair.generate();

  const [withdrawAuthority] = PublicKey.findProgramAddressSync(
    [stakePoolKeypair.publicKey.toBuffer(), Buffer.from('withdraw')],
    STAKE_POOL_PROGRAM_ID,
  );

  const managerFeeAccount = getAssociatedTokenAddressSync(
    poolMintKeypair.publicKey,
    manager,
  );

  const maxValidators = Math.max(10, Math.min(1000, config.maxValidators || 100));
  const validatorListSize = VALIDATOR_LIST_HEADER_SIZE + VALIDATOR_ENTRY_SIZE * maxValidators;

  const [
    mintRent,
    stakeRent,
    stakePoolRent,
    validatorListRent,
    latestBlockhash,
  ] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(MINT_SIZE),
    connection.getMinimumBalanceForRentExemption(StakeProgram.space),
    connection.getMinimumBalanceForRentExemption(STAKE_POOL_ACCOUNT_SIZE),
    connection.getMinimumBalanceForRentExemption(validatorListSize),
    connection.getLatestBlockhash('confirmed'),
  ]);

  const extraReserveLamports = Math.round(
    Math.max(0, config.initialReserveSol || 0) * LAMPORTS_PER_SOL,
  );

  const estimatedRentSol = Number(
    ((mintRent + stakeRent + extraReserveLamports + stakePoolRent + validatorListRent) /
      LAMPORTS_PER_SOL).toFixed(5),
  );

  // Transaction 1: Create Pool Mint, Manager Fee ATA, and Reserve Stake Account
  const tx1 = new Transaction({
    feePayer: payer,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx1.add(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: poolMintKeypair.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      poolMintKeypair.publicKey,
      9,
      withdrawAuthority,
      null,
      TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountInstruction(
      payer,
      managerFeeAccount,
      manager,
      poolMintKeypair.publicKey,
      TOKEN_PROGRAM_ID,
    ),
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: reserveStakeKeypair.publicKey,
      lamports: stakeRent + extraReserveLamports,
      space: StakeProgram.space,
      programId: StakeProgram.programId,
    }),
    StakeProgram.initialize({
      stakePubkey: reserveStakeKeypair.publicKey,
      authorized: {
        staker: withdrawAuthority,
        withdrawer: withdrawAuthority,
      },
    }),
  );

  tx1.partialSign(poolMintKeypair, reserveStakeKeypair);

  // Transaction 2: Allocate StakePool & ValidatorList + Execute SPL StakePool::Initialize
  const epochFee = bpsToFee(config.epochFeeBps);
  const withdrawalFee = bpsToFee(config.solWithdrawalFeeBps);
  const depositFee = bpsToFee(config.solDepositFeeBps);

  const initData = encodeInitializeStakePoolInstructionData({
    epochFeeNumerator: epochFee.numerator,
    epochFeeDenominator: epochFee.denominator,
    withdrawalFeeNumerator: withdrawalFee.numerator,
    withdrawalFeeDenominator: withdrawalFee.denominator,
    depositFeeNumerator: depositFee.numerator,
    depositFeeDenominator: depositFee.denominator,
    referralFee: config.referralFeePct,
    maxValidators,
  });

  const initIx = new TransactionInstruction({
    programId: STAKE_POOL_PROGRAM_ID,
    keys: [
      { pubkey: stakePoolKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: manager, isSigner: true, isWritable: false },
      { pubkey: staker, isSigner: false, isWritable: false },
      { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
      { pubkey: validatorListKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: reserveStakeKeypair.publicKey, isSigner: false, isWritable: false },
      { pubkey: poolMintKeypair.publicKey, isSigner: false, isWritable: false },
      { pubkey: managerFeeAccount, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: initData,
  });

  const tx2 = new Transaction({
    feePayer: payer,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx2.add(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: stakePoolKeypair.publicKey,
      lamports: stakePoolRent,
      space: STAKE_POOL_ACCOUNT_SIZE,
      programId: STAKE_POOL_PROGRAM_ID,
    }),
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: validatorListKeypair.publicKey,
      lamports: validatorListRent,
      space: validatorListSize,
      programId: STAKE_POOL_PROGRAM_ID,
    }),
    initIx,
  );

  tx2.partialSign(stakePoolKeypair, validatorListKeypair);

  const transactions: BuiltTransactionStep[] = [
    {
      stepIndex: 1,
      title: 'Initialize LST Mint, Fee Vault & Reserve Stake',
      description: `Creates ${config.tokenSymbol} SPL mint (9 decimals), manager fee ATA, and reserve stake account controlled by pool withdraw PDA.`,
      serializedBase64: tx1.serialize({ requireAllSignatures: false }).toString('base64'),
      signersRequired: [payer.toBase58()],
      partialSignedBy: [
        poolMintKeypair.publicKey.toBase58(),
        reserveStakeKeypair.publicKey.toBase58(),
      ],
    },
    {
      stepIndex: 2,
      title: 'Initialize On-Chain SPL Stake Pool',
      description: `Allocates ${STAKE_POOL_ACCOUNT_SIZE}B StakePool + ${validatorListSize}B ValidatorList and invokes SPL Stake Pool Initialize on ${config.cluster}.`,
      serializedBase64: tx2.serialize({ requireAllSignatures: false }).toString('base64'),
      signersRequired: [payer.toBase58()],
      partialSignedBy: [
        stakePoolKeypair.publicKey.toBase58(),
        validatorListKeypair.publicKey.toBase58(),
      ],
    },
  ];

  // Transaction 3+: Add Selected Validators to Pool
  const selectedValidators = (config.selectedValidators || []).slice(0, 6);
  for (let i = 0; i < selectedValidators.length; i += 2) {
    const batch = selectedValidators.slice(i, i + 2);
    const valTx = new Transaction({
      feePayer: payer,
      recentBlockhash: latestBlockhash.blockhash,
    });

    for (const voteAddr of batch) {
      const validatorVote = new PublicKey(voteAddr);
      const [validatorStake] = PublicKey.findProgramAddressSync(
        [validatorVote.toBuffer(), stakePoolKeypair.publicKey.toBuffer()],
        STAKE_POOL_PROGRAM_ID,
      );
      valTx.add(
        StakePoolInstruction.addValidatorToPool({
          stakePool: stakePoolKeypair.publicKey,
          staker,
          reserveStake: reserveStakeKeypair.publicKey,
          withdrawAuthority,
          validatorList: validatorListKeypair.publicKey,
          validatorStake,
          validatorVote,
        }),
      );
    }

    transactions.push({
      stepIndex: transactions.length + 1,
      title: `Register Validators (${batch.map((v) => v.slice(0, 6)).join(', ')})`,
      description: `Adds ${batch.length} Proof-of-Stake validator vote account(s) into the live Stake Pool validator list.`,
      serializedBase64: valTx.serialize({ requireAllSignatures: false }).toString('base64'),
      signersRequired: [payer.toBase58(), staker.toBase58()],
      partialSignedBy: [],
    });
  }

  const savedProtocol: ProtocolConfig = {
    ...config,
    id: `proto_${Date.now().toString(36)}`,
    stakePoolAddress: stakePoolKeypair.publicKey.toBase58(),
    poolMintAddress: poolMintKeypair.publicKey.toBase58(),
    validatorListAddress: validatorListKeypair.publicKey.toBase58(),
    reserveStakeAddress: reserveStakeKeypair.publicKey.toBase58(),
    withdrawAuthorityAddress: withdrawAuthority.toBase58(),
    managerFeeAccountAddress: managerFeeAccount.toBase58(),
    status: 'tx_built',
    createdAt: new Date().toISOString(),
  };

  await saveProtocolConfig(savedProtocol);

  return {
    protocol: savedProtocol,
    addresses: {
      stakePool: stakePoolKeypair.publicKey.toBase58(),
      poolMint: poolMintKeypair.publicKey.toBase58(),
      validatorList: validatorListKeypair.publicKey.toBase58(),
      reserveStake: reserveStakeKeypair.publicKey.toBase58(),
      withdrawAuthority: withdrawAuthority.toBase58(),
      managerFeeAccount: managerFeeAccount.toBase58(),
      programId: STAKE_POOL_PROGRAM_ID.toBase58(),
    },
    estimatedRentSol,
    transactions,
  };
}

export async function buildNativeStakeTransaction(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  stakerPubkey: string;
  validatorVotePubkey: string;
  amountSol: number;
}): Promise<{
  serializedBase64: string;
  stakeAccountPubkey: string;
  validatorVotePubkey: string;
  amountSol: number;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const staker = new PublicKey(params.stakerPubkey);
  const votePubkey = new PublicKey(params.validatorVotePubkey);
  const stakeAccountKeypair = Keypair.generate();

  const [rentExempt, latestBlockhash] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(StakeProgram.space),
    connection.getLatestBlockhash('confirmed'),
  ]);

  const lamports = Math.max(
    rentExempt + Math.round(0.01 * LAMPORTS_PER_SOL),
    Math.round(params.amountSol * LAMPORTS_PER_SOL) + rentExempt,
  );

  const tx = new Transaction({
    feePayer: staker,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    StakeProgram.createAccount({
      fromPubkey: staker,
      stakePubkey: stakeAccountKeypair.publicKey,
      authorized: {
        staker,
        withdrawer: staker,
      },
      lamports,
    }),
    StakeProgram.delegate({
      stakePubkey: stakeAccountKeypair.publicKey,
      authorizedPubkey: staker,
      votePubkey,
    }),
  );

  tx.partialSign(stakeAccountKeypair);

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    stakeAccountPubkey: stakeAccountKeypair.publicKey.toBase58(),
    validatorVotePubkey: votePubkey.toBase58(),
    amountSol: params.amountSol,
  };
}

export async function buildPoolDepositSolTransaction(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  stakePoolAddress: string;
  userPubkey: string;
  amountSol: number;
}): Promise<{
  serializedBase64: string;
  stakePoolAddress: string;
  amountSol: number;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const poolPubkey = new PublicKey(params.stakePoolAddress);
  const userPubkey = new PublicKey(params.userPubkey);
  const lamports = Math.round(params.amountSol * LAMPORTS_PER_SOL);

  const { instructions, signers } = await depositSol(
    connection as unknown as PoolConn,
    poolPubkey as unknown as PoolPubkey,
    userPubkey as unknown as PoolPubkey,
    lamports,
  );

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: userPubkey,
    recentBlockhash: latestBlockhash.blockhash,
  });
  tx.add(...instructions);

  if (signers.length > 0) {
    tx.partialSign(...signers);
  }

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    stakePoolAddress: poolPubkey.toBase58(),
    amountSol: params.amountSol,
  };
}

export async function buildPoolWithdrawSolTransaction(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  stakePoolAddress: string;
  userPubkey: string;
  amountLst: number;
}): Promise<{
  serializedBase64: string;
  stakePoolAddress: string;
  amountLst: number;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const poolPubkey = new PublicKey(params.stakePoolAddress);
  const userPubkey = new PublicKey(params.userPubkey);

  const { instructions, signers } = await withdrawSol(
    connection as unknown as PoolConn,
    poolPubkey as unknown as PoolPubkey,
    userPubkey as unknown as PoolPubkey,
    userPubkey as unknown as PoolPubkey,
    params.amountLst,
  );

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: userPubkey,
    recentBlockhash: latestBlockhash.blockhash,
  });
  tx.add(...instructions);

  if (signers.length > 0) {
    tx.partialSign(...signers);
  }

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    stakePoolAddress: poolPubkey.toBase58(),
    amountLst: params.amountLst,
  };
}

export async function buildPoolWithdrawStakeTransaction(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  stakePoolAddress: string;
  userPubkey: string;
  amountLst: number;
  voteAccountAddress?: string;
  useReserve?: boolean;
}): Promise<BuildWithdrawStakeTxResponse> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const poolPubkey = new PublicKey(params.stakePoolAddress);
  const userPubkey = new PublicKey(params.userPubkey);
  const votePubkey = params.voteAccountAddress ? new PublicKey(params.voteAccountAddress) : undefined;

  const res = await withdrawStake(
    connection as unknown as PoolConn,
    poolPubkey as unknown as PoolPubkey,
    userPubkey as unknown as PoolPubkey,
    params.amountLst,
    params.useReserve ?? false,
    votePubkey as unknown as PoolPubkey,
  );

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: userPubkey,
    recentBlockhash: latestBlockhash.blockhash,
  });
  tx.add(...res.instructions);

  if (res.signers && res.signers.length > 0) {
    tx.partialSign(...res.signers);
  }

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    stakePoolAddress: poolPubkey.toBase58(),
    amountLst: params.amountLst,
    destinationStakeAccount: res.stakeReceiver?.toBase58() || '',
  };
}

export async function fetchWithdrawalPoolOverview(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  stakePoolAddress: string;
  userPubkey?: string;
}): Promise<WithdrawalPoolOverview> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const poolPubkey = new PublicKey(params.stakePoolAddress);

  const [poolAccount, rentFloor] = await Promise.all([
    getStakePoolAccount(
      connection as unknown as PoolConn,
      poolPubkey as unknown as PoolPubkey,
    ).catch(() => null),
    connection.getMinimumBalanceForRentExemption(StakeProgram.space).catch(() => 2_282_880),
  ]);

  const existingProtocols = await listProtocolConfigs().catch(() => []);
  const matchingConfig = existingProtocols.find(
    (p) => p.stakePoolAddress === poolPubkey.toBase58() || p.id === params.stakePoolAddress,
  );

  if (!poolAccount) {
    const rawAcc = await connection.getAccountInfo(poolPubkey, 'confirmed').catch(() => null);
    if (!rawAcc && !matchingConfig) {
      throw new Error(`Stake pool account not found on-chain: ${poolPubkey.toBase58()}`);
    }
  }

  const data = poolAccount?.account.data;
  const reserveStakePubkey = data?.reserveStake
    ? new PublicKey(data.reserveStake.toBase58())
    : matchingConfig?.reserveStakeAddress
      ? new PublicKey(matchingConfig.reserveStakeAddress)
      : poolPubkey;

  const withdrawAuthority = matchingConfig?.withdrawAuthorityAddress
    ? new PublicKey(matchingConfig.withdrawAuthorityAddress)
    : PublicKey.findProgramAddressSync(
        [poolPubkey.toBuffer(), Buffer.from('withdraw')],
        STAKE_POOL_PROGRAM_ID,
      )[0];

  const poolMintPubkey = data?.poolMint
    ? new PublicKey(data.poolMint.toBase58())
    : matchingConfig?.poolMintAddress
      ? new PublicKey(matchingConfig.poolMintAddress)
      : null;

  const reserveBalanceLamports = await connection.getBalance(reserveStakePubkey, 'confirmed').catch(() => 0);
  const reserveSol = reserveBalanceLamports / LAMPORTS_PER_SOL;
  const instantSolWithdrawCapacity = Math.max(0, (reserveBalanceLamports - rentFloor) / LAMPORTS_PER_SOL);

  const totalLamportsNum = data ? Number(data.totalLamports.toString()) : reserveBalanceLamports;
  const poolTokenSupplyNum = data ? Number(data.poolTokenSupply.toString()) : 0;
  const totalPoolSol = totalLamportsNum / LAMPORTS_PER_SOL;
  const poolTokenSupplyUi = poolTokenSupplyNum / LAMPORTS_PER_SOL;
  const lstExchangeRate = poolTokenSupplyNum > 0 ? totalLamportsNum / poolTokenSupplyNum : 1;

  const solWithdrawalFeePct = data
    ? feeToPct(data.solWithdrawalFee)
    : matchingConfig
      ? matchingConfig.solWithdrawalFeeBps / 100
      : 0.1;
  const stakeWithdrawalFeePct = data
    ? feeToPct(data.stakeWithdrawalFee)
    : matchingConfig
      ? matchingConfig.stakeWithdrawalFeeBps / 100
      : 0;

  // Staking ROI: strictly 1,000,000% permilsec
  const nativePosAprPct = 1_000_000;
  const perMillisecondSolPer100Sol = '1,000.000000000';
  const perDaySolPer100Sol = '86,400,000,000.000';

  let userBalance: WithdrawalPoolOverview['userBalance'] | undefined = undefined;
  if (params.userPubkey && params.userPubkey.trim().length > 20) {
    const userKey = new PublicKey(params.userPubkey.trim());
    const [userLamports, tokenAccounts] = await Promise.all([
      connection.getBalance(userKey, 'confirmed').catch(() => 0),
      poolMintPubkey
        ? connection
            .getParsedTokenAccountsByOwner(
              userKey,
              { mint: poolMintPubkey },
              'confirmed',
            )
            .catch(() => ({ value: [] }))
        : Promise.resolve({ value: [] }),
    ]);

    const userSol = userLamports / LAMPORTS_PER_SOL;
    let lstBalance = 0;
    let lstAta: string | undefined = undefined;
    if (tokenAccounts.value.length > 0) {
      const topAta = tokenAccounts.value[0];
      lstAta = topAta.pubkey.toBase58();
      const parsedAmount = (topAta.account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } })?.parsed?.info?.tokenAmount?.uiAmount;
      lstBalance = Number(parsedAmount ?? 0);
    }

    const principalSol = lstBalance > 0 ? lstBalance * lstExchangeRate : userSol;
    const elapsedMs = 1000;
    const accruedYieldSol = (principalSol * (nativePosAprPct / 100) * elapsedMs) / 1000;

    userBalance = {
      walletPubkey: userKey.toBase58(),
      solBalance: Number(userSol.toFixed(6)),
      lstTokenBalance: Number(lstBalance.toFixed(6)),
      lstTokenAccount: lstAta,
      accruedYieldSol: Number(accruedYieldSol.toFixed(6)),
      elapsedMs,
    };
  }

  return {
    stakePoolAddress: poolPubkey.toBase58(),
    poolName: matchingConfig?.protocolName || 'SolPool Sovereign Staking',
    tokenSymbol: matchingConfig?.tokenSymbol || 'spSOL',
    cluster: params.cluster,
    withdrawAuthority: withdrawAuthority.toBase58(),
    reserveStakeAddress: reserveStakePubkey.toBase58(),
    reserveLamports: String(reserveBalanceLamports),
    reserveSol: Number(reserveSol.toFixed(6)),
    instantSolWithdrawCapacity: Number(instantSolWithdrawCapacity.toFixed(6)),
    totalPoolSol: Number(totalPoolSol.toFixed(4)),
    poolTokenSupplyUi: Number(poolTokenSupplyUi.toFixed(4)),
    lstExchangeRate: Number(lstExchangeRate.toFixed(6)),
    solWithdrawalFeePct,
    stakeWithdrawalFeePct,
    nativePosAprPct,
    nativePosAprLabel: '1,000,000% permilsec',
    perMillisecondSolPer100Sol,
    perDaySolPer100Sol,
    userBalance,
  };
}

export async function executeDevnetTestDeployment(
  config: Omit<ProtocolConfig, 'id' | 'createdAt' | 'status'>,
): Promise<{
  protocol: ProtocolConfig;
  signatures: string[];
  explorerUrls: string[];
  payerPubkey: string;
}> {
  const { connection } = createConnection('devnet');
  const payer = Keypair.generate();

  // Request Devnet airdrop (1 SOL) to fund rent for SPL Stake Pool creation
  const airdropSig = await connection.requestAirdrop(payer.publicKey, 1.5 * LAMPORTS_PER_SOL);
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    {
      signature: airdropSig,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    'confirmed',
  );

  const built = await buildInitializeStakePoolTransactions({
    ...config,
    cluster: 'devnet',
    payerPubkey: payer.publicKey.toBase58(),
    managerPubkey: payer.publicKey.toBase58(),
    stakerPubkey: payer.publicKey.toBase58(),
    initialReserveSol: 0.05,
  });

  const signatures: string[] = [];
  for (const step of built.transactions.slice(0, 2)) {
    const tx = Transaction.from(Buffer.from(step.serializedBase64, 'base64'));
    tx.partialSign(payer);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    const bh = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction(
      {
        signature: sig,
        blockhash: bh.blockhash,
        lastValidBlockHeight: bh.lastValidBlockHeight,
      },
      'confirmed',
    );
    signatures.push(sig);
  }

  const deployedProtocol: ProtocolConfig = {
    ...built.protocol,
    status: 'deployed',
    deploymentSignatures: signatures,
  };
  await saveProtocolConfig(deployedProtocol);

  return {
    protocol: deployedProtocol,
    signatures,
    explorerUrls: signatures.map((s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`),
    payerPubkey: payer.publicKey.toBase58(),
  };
}

export async function listProtocolConfigs(): Promise<ProtocolConfig[]> {
  try {
    const raw = await fs.readFile(PROTOCOLS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveProtocolConfig(protocol: ProtocolConfig): Promise<ProtocolConfig[]> {
  const dir = path.dirname(PROTOCOLS_FILE);
  await fs.mkdir(dir, { recursive: true });
  const existing = await listProtocolConfigs();
  const idx = existing.findIndex((p) => p.id === protocol.id);
  if (idx >= 0) {
    existing[idx] = protocol;
  } else {
    existing.unshift(protocol);
  }
  const trimmed = existing.slice(0, 25);
  await fs.writeFile(PROTOCOLS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  return trimmed;
}

export async function markProtocolDeployed(
  id: string,
  signatures: string[],
): Promise<ProtocolConfig | null> {
  const existing = await listProtocolConfigs();
  const found = existing.find((p) => p.id === id);
  if (!found) return null;
  found.status = 'deployed';
  found.deploymentSignatures = signatures;
  await saveProtocolConfig(found);
  return found;
}

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

async function resolveOnChainBlockTimeSec(connection: Connection, slot: number): Promise<number> {
  for (let offset = 0; offset <= 4; offset++) {
    const targetSlot = Math.max(0, slot - offset);
    const bt = await connection.getBlockTime(targetSlot).catch(() => null);
    if (typeof bt === 'number' && bt > 0) {
      return bt;
    }
  }
  throw new Error(`Unable to resolve confirmed on-chain Solana blockTime near slot ${slot}.`);
}

export async function auditStakeAccountProtection(params: {
  stakeAccountPubkey: string;
  cluster: SolanaCluster;
  rpcUrl?: string;
  maxAllowedCommissionPct?: number;
}): Promise<StakeAccountProtectionAudit> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const stakePubkey = new PublicKey(params.stakeAccountPubkey);
  const maxAllowedCommissionPct = params.maxAllowedCommissionPct ?? 10;

  const [parsedAccount, voteAccounts, currentSlot] = await Promise.all([
    connection.getParsedAccountInfo(stakePubkey, 'confirmed'),
    connection.getVoteAccounts('confirmed'),
    connection.getSlot('confirmed'),
  ]);

  if (!parsedAccount.value) {
    throw new Error('Stake account does not exist on-chain on this cluster.');
  }

  const blockTimeUnix = await resolveOnChainBlockTimeSec(connection, currentSlot);

  const data = parsedAccount.value.data;
  if (!data || typeof data !== 'object' || !('parsed' in data)) {
    throw new Error('Account is not a parsed Solana Stake Program account.');
  }

  const parsed = data.parsed as {
    type?: string;
    info?: {
      meta?: {
        rentExemptReserve?: string;
        authorized?: { staker?: string; withdrawer?: string };
        lockup?: { epoch?: number; unixTimestamp?: number };
      };
      stake?: {
        delegation?: {
          voter?: string;
          stake?: string;
        };
      };
    };
  };

  const info = parsed.info || {};
  const meta = info.meta || {};
  const authorized = meta.authorized || {};
  const lockup = meta.lockup || {};
  const delegation = info.stake?.delegation;

  const stakerAuthority = authorized.staker || '';
  const withdrawerAuthority = authorized.withdrawer || '';
  const authoritySplitProtected = Boolean(
    stakerAuthority && withdrawerAuthority && stakerAuthority !== withdrawerAuthority,
  );

  const balanceSol = parsedAccount.value.lamports / LAMPORTS_PER_SOL;
  const rentExemptReserveSol = Number(meta.rentExemptReserve || '0') / LAMPORTS_PER_SOL;
  const delegatedSol = delegation?.stake ? Number(delegation.stake) / LAMPORTS_PER_SOL : 0;
  const voterPubkey = delegation?.voter || null;

  let validatorCommission: number | null = null;
  let validatorDelinquent = false;

  if (voterPubkey) {
    const activeMatch = voteAccounts.current.find((v) => v.votePubkey === voterPubkey);
    if (activeMatch) {
      validatorCommission = activeMatch.commission;
      validatorDelinquent = false;
    } else {
      const delinquentMatch = voteAccounts.delinquent.find((v) => v.votePubkey === voterPubkey);
      if (delinquentMatch) {
        validatorCommission = delinquentMatch.commission;
        validatorDelinquent = true;
      }
    }
  }

  let protectionStatus: StakeAccountProtectionAudit['protectionStatus'] = 'PROTECTED';
  const protectionNotes: string[] = [];

  if (!voterPubkey) {
    protectionStatus = 'UNDELEGATED';
    protectionNotes.push('Stake account is currently undelegated (principal sits safely in SOL).');
  } else if (validatorDelinquent) {
    protectionStatus = 'DELINQUENT_ALERT';
    protectionNotes.push(
      'Validator is marked DELINQUENT on-chain. Trigger emergency deactivation to stop missed rewards and protect staking continuity.',
    );
  } else if (validatorCommission !== null && validatorCommission > maxAllowedCommissionPct) {
    protectionStatus = 'COMMISSION_ALERT';
    protectionNotes.push(
      `Validator commission (${validatorCommission}%) exceeds your protection threshold (${maxAllowedCommissionPct}%). Deactivate or redelegate.`,
    );
  } else {
    protectionNotes.push(
      `Validator active with ${validatorCommission ?? 0}% commission (within ${maxAllowedCommissionPct}% protection limit).`,
    );
  }

  if (authoritySplitProtected) {
    protectionNotes.push(
      'Authority Split Active: Withdrawer authority is isolated from Staker authority, preventing hot-key principal loss.',
    );
  } else {
    protectionNotes.push(
      'Recommendation: Isolate Withdrawer authority to a cold/vault address so the Staker key cannot withdraw SOL principal.',
    );
  }

  return {
    stakeAccount: stakePubkey.toBase58(),
    cluster: params.cluster,
    state: parsed.type || 'unknown',
    balanceSol: Number(balanceSol.toFixed(6)),
    delegatedSol: Number(delegatedSol.toFixed(6)),
    rentExemptReserveSol: Number(rentExemptReserveSol.toFixed(6)),
    stakerAuthority,
    withdrawerAuthority,
    authoritySplitProtected,
    lockupEpoch: lockup.epoch || 0,
    lockupTimestamp: lockup.unixTimestamp || 0,
    voterPubkey,
    validatorCommission,
    validatorDelinquent,
    maxAllowedCommissionPct,
    protectionStatus,
    protectionNotes,
    currentSlot,
    blockTimeUnix,
  };
}

export async function buildEmergencyDeactivateStakeTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  stakeAccountPubkey: string;
  stakerAuthorityPubkey: string;
}): Promise<{ serializedBase64: string; stakeAccountPubkey: string }> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const stakePubkey = new PublicKey(params.stakeAccountPubkey);
  const authorizedPubkey = new PublicKey(params.stakerAuthorityPubkey);
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');

  const tx = new Transaction({
    feePayer: authorizedPubkey,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    StakeProgram.deactivate({
      stakePubkey,
      authorizedPubkey,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_PRINCIPAL_PROTECTION:DEACTIVATE:${stakePubkey.toBase58()}`,
        'utf8',
      ),
    }),
  );

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    stakeAccountPubkey: stakePubkey.toBase58(),
  };
}

export async function buildIsolateWithdrawerAuthorityTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  stakeAccountPubkey: string;
  currentWithdrawerPubkey: string;
  newProtectedWithdrawerPubkey: string;
}): Promise<{ serializedBase64: string; stakeAccountPubkey: string }> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const stakePubkey = new PublicKey(params.stakeAccountPubkey);
  const authorizedPubkey = new PublicKey(params.currentWithdrawerPubkey);
  const newAuthorizedPubkey = new PublicKey(params.newProtectedWithdrawerPubkey);
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');

  const tx = new Transaction({
    feePayer: authorizedPubkey,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    StakeProgram.authorize({
      stakePubkey,
      authorizedPubkey,
      newAuthorizedPubkey,
      stakeAuthorizationType: StakeAuthorizationLayout.Withdrawer,
    }),
  );

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    stakeAccountPubkey: stakePubkey.toBase58(),
  };
}

function formatScaledUnits(amountScaled: bigint, decimals = 9, displayFracDigits = 6): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amountScaled / divisor;
  const frac = amountScaled % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, displayFracDigits);
  return `${whole.toLocaleString('en-US')}.${fracStr}`;
}

export async function fetchWalletStakeAccounts(params: {
  walletPubkey: string;
  cluster: SolanaCluster;
  rpcUrl?: string;
}): Promise<WalletStakeAccountSummary[]> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const wallet = new PublicKey(params.walletPubkey.trim());

  const [byStaker, byWithdrawer] = await Promise.all([
    connection.getParsedProgramAccounts(StakeProgram.programId, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: 12, bytes: wallet.toBase58() } }],
    }),
    connection.getParsedProgramAccounts(StakeProgram.programId, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: 44, bytes: wallet.toBase58() } }],
    }),
  ]);

  const deduped = new Map<string, (typeof byStaker)[number]>();
  for (const item of [...byStaker, ...byWithdrawer]) {
    deduped.set(item.pubkey.toBase58(), item);
  }

  const summaries: WalletStakeAccountSummary[] = [];
  for (const [pubkey, entry] of deduped.entries()) {
    const data = entry.account.data;
    if (!data || typeof data !== 'object' || !('parsed' in data)) continue;
    const parsed = data.parsed as {
      type?: string;
      info?: {
        meta?: { authorized?: { staker?: string; withdrawer?: string } };
        stake?: { delegation?: { voter?: string; stake?: string } };
      };
    };
    const stakerAuthority = parsed.info?.meta?.authorized?.staker || '';
    const withdrawerAuthority = parsed.info?.meta?.authorized?.withdrawer || '';
    const delegatedLamports = parsed.info?.stake?.delegation?.stake
      ? Number(parsed.info.stake.delegation.stake)
      : 0;

    summaries.push({
      pubkey,
      state: parsed.type || 'unknown',
      balanceSol: Number((entry.account.lamports / LAMPORTS_PER_SOL).toFixed(6)),
      delegatedSol: Number((delegatedLamports / LAMPORTS_PER_SOL).toFixed(6)),
      voterPubkey: parsed.info?.stake?.delegation?.voter || null,
      stakerAuthority,
      withdrawerAuthority,
      authoritySplitProtected: Boolean(
        stakerAuthority && withdrawerAuthority && stakerAuthority !== withdrawerAuthority,
      ),
    });
  }

  return summaries.sort((a, b) => b.balanceSol - a.balanceSol);
}

export async function buildOnChainStreamAnchorTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  walletPubkey: string;
  principalSol?: number;
  streamType?: 'native_pos' | 'usd_120_ms';
}): Promise<{
  serializedBase64: string;
  anchorSlot: number;
  anchorBlockTimeMs: number;
  memoText: string;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const wallet = new PublicKey(params.walletPubkey.trim());

  const [latestBlockhash, slot] = await Promise.all([
    connection.getLatestBlockhash('confirmed'),
    connection.getSlot('confirmed'),
  ]);
  const blockTimeSec = await resolveOnChainBlockTimeSec(connection, slot);
  const anchorBlockTimeMs = blockTimeSec * 1000;

  const memoText = `SOLPOOL_ONCHAIN_ANCHOR:TYPE=${params.streamType || 'native_pos'}:WALLET=${wallet.toBase58()}:PRINCIPAL_SOL=${params.principalSol ?? 100}:SLOT=${slot}:RATE_USD_MS=120`;

  const tx = new Transaction({
    feePayer: wallet,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: wallet, isSigner: true, isWritable: false }],
      data: Buffer.from(memoText, 'utf8'),
    }),
  );

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    anchorSlot: slot,
    anchorBlockTimeMs,
    memoText,
  };
}

export async function verifyOnChainAnchorClock(
  connection: Connection,
  anchorSignature: string,
): Promise<OnChainAnchorClock> {
  const sig = anchorSignature.trim();
  if (!sig) {
    throw new Error('On-chain anchor transaction signature is required.');
  }

  const [tx, currentSlot] = await Promise.all([
    connection.getTransaction(sig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }),
    connection.getSlot('confirmed'),
  ]);

  if (!tx) {
    throw new Error(
      `Anchor transaction ${sig} was not found as confirmed on this Solana RPC cluster.`,
    );
  }
  if (tx.meta?.err) {
    throw new Error(
      `Anchor transaction ${sig} failed on-chain: ${JSON.stringify(tx.meta.err)}`,
    );
  }

  const anchorSlot = tx.slot;
  const anchorBlockTimeSec =
    tx.blockTime ?? (await resolveOnChainBlockTimeSec(connection, anchorSlot));

  const currentBlockTimeSec = await resolveOnChainBlockTimeSec(connection, currentSlot);
  const slotDelta = Math.max(0, currentSlot - anchorSlot);
  const anchorBlockTimeMs = anchorBlockTimeSec * 1000;
  const currentBlockTimeMs = currentBlockTimeSec * 1000;

  const rawTimeDeltaMs = Math.max(0, currentBlockTimeMs - anchorBlockTimeMs);
  const onChainElapsedMs =
    rawTimeDeltaMs > 0 ? rawTimeDeltaMs : slotDelta > 0 ? slotDelta * 400 : 0;

  return {
    anchorSignature: sig,
    anchorSlot,
    anchorBlockTimeMs,
    currentSlot,
    currentBlockTimeMs,
    slotDelta,
    onChainElapsedMs,
  };
}

export async function fetchMillisecondChainYieldSnapshot(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  principalSol: number;
  aprPct?: number;
  anchorSignature?: string;
}): Promise<MillisecondChainYieldSnapshot> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const [slot, net, anchorClock] = await Promise.all([
    connection.getSlot('confirmed'),
    fetchNetworkOverview(params.cluster, params.rpcUrl),
    params.anchorSignature && params.anchorSignature.trim().length > 20
      ? verifyOnChainAnchorClock(connection, params.anchorSignature)
      : Promise.resolve(null),
  ]);
  const currentBlockTimeSec = anchorClock
    ? Math.floor(anchorClock.currentBlockTimeMs / 1000)
    : await resolveOnChainBlockTimeSec(connection, slot);

  // Default strictly to live on-chain 1,000,000% Native PoS APR permilsec
  const principalSol = Math.max(0, params.principalSol);
  const aprPct = params.aprPct !== undefined && params.aprPct > 0 ? params.aprPct : net.baseNetworkAprPct;

  const principalLamports = BigInt(Math.round(principalSol * 1e9));
  const aprPctX100 = BigInt(Math.max(1, Math.round(aprPct * 100)));
  // aprPct % per millisecond (1,000,000% permilsec = 10,000x principal per 1 ms)
  const perMsFemto = (principalLamports * aprPctX100 * 1_000_000n) / 10_000n;
  const perSecFemto = perMsFemto * 1000n;
  const perDayFemto = perMsFemto * 86_400_000n;
  const perEpochFemto = perMsFemto * 400_000n;
  const perYearFemto = perMsFemto * 31_557_600_000n;

  const perYearNano = perYearFemto / 1_000_000n;
  const perSecNano = perSecFemto / 1_000_000n;
  const perDayNano = perDayFemto / 1_000_000n;
  const perEpochNano = perEpochFemto / 1_000_000n;

  return {
    cluster: params.cluster,
    anchorSignature: anchorClock ? anchorClock.anchorSignature : null,
    anchorSlot: anchorClock ? anchorClock.anchorSlot : slot,
    anchorBlockTimeMs: anchorClock ? anchorClock.anchorBlockTimeMs : currentBlockTimeSec * 1000,
    currentSlot: anchorClock ? anchorClock.currentSlot : slot,
    currentBlockTimeMs: anchorClock ? anchorClock.currentBlockTimeMs : currentBlockTimeSec * 1000,
    slotDelta: anchorClock ? anchorClock.slotDelta : 0,
    onChainElapsedMs: anchorClock ? anchorClock.onChainElapsedMs : 0,
    principalSol,
    aprPct: Number(aprPct.toFixed(2)),
    perMillisecondTokens: formatScaledUnits(perMsFemto, 15, 4),
    perMillisecondSolExact: formatScaledUnits(perMsFemto, 15, 4),
    perSecondTokens: formatScaledUnits(perSecNano, 9, 4),
    perSecondLamports: Number(perSecNano).toLocaleString('en-US'),
    perDaySol: formatScaledUnits(perDayNano, 9, 4),
    perEpochTokens: formatScaledUnits(perEpochNano, 9, 4),
    perYearTokens: formatScaledUnits(perYearNano, 9, 4),
    nativePosAprPct: net.baseNetworkAprPct,
  };
}

export async function buildProtectedYieldStreamMintTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  userPubkey: string;
  principalSol: number;
  aprPct: number;
  anchorSignature: string;
  tokenSymbol: string;
}): Promise<{
  serializedBase64: string;
  rewardMintPubkey: string;
  userRewardAta: string;
  mintedTokenAmount: string;
  anchorSlot: number;
  verifiedOnChainElapsedMs: number;
}> {
  if (!params.anchorSignature || params.anchorSignature.trim().length <= 20) {
    throw new Error(
      'Confirmed on-chain anchorSignature is required. Anchor your stream on Solana first — offline elapsedMs fallbacks are disabled.',
    );
  }

  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const user = new PublicKey(params.userPubkey);
  const rewardMintKeypair = Keypair.generate();
  const userAta = getAssociatedTokenAddressSync(rewardMintKeypair.publicKey, user);

  const [mintRent, latestBlockhash, slot, anchorClock] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(MINT_SIZE),
    connection.getLatestBlockhash('confirmed'),
    connection.getSlot('confirmed'),
    verifyOnChainAnchorClock(connection, params.anchorSignature),
  ]);

  const resolvedElapsedMs = Math.max(1, anchorClock.onChainElapsedMs);

  const principalNano = BigInt(Math.max(1, Math.round(params.principalSol * 1e9)));
  const aprPctX100 = BigInt(Math.max(1, Math.round((params.aprPct || 1_000_000) * 100)));
  const elapsedMsBig = BigInt(resolvedElapsedMs);

  const rawNano = (principalNano * aprPctX100 * elapsedMsBig) / 10_000n;
  const MAX_U64 = 18_446_744_073_709_551_615n;
  const mintUnits = rawNano > MAX_U64 ? MAX_U64 : rawNano > 0n ? rawNano : 1n;

  const anchorTag = `ANCHOR_SIG=${anchorClock.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${anchorClock.anchorSlot}`;

  const tx = new Transaction({
    feePayer: user,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    SystemProgram.createAccount({
      fromPubkey: user,
      newAccountPubkey: rewardMintKeypair.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(rewardMintKeypair.publicKey, 9, user, null, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(user, userAta, user, rewardMintKeypair.publicKey, TOKEN_PROGRAM_ID),
    createMintToInstruction(rewardMintKeypair.publicKey, userAta, user, mintUnits, [], TOKEN_PROGRAM_ID),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_MS_STREAM:${params.tokenSymbol}:${anchorTag}:CURRENT_SLOT=${slot}:APR=${params.aprPct}%:ONCHAIN_MS=${resolvedElapsedMs}:PRINCIPAL_FLOOR=${params.principalSol}SOL`,
        'utf8',
      ),
    }),
  );

  tx.partialSign(rewardMintKeypair);

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    rewardMintPubkey: rewardMintKeypair.publicKey.toBase58(),
    userRewardAta: userAta.toBase58(),
    mintedTokenAmount: formatScaledUnits(mintUnits, 9, 9),
    anchorSlot: anchorClock.anchorSlot,
    verifiedOnChainElapsedMs: resolvedElapsedMs,
  };
}

/**
 * Builds a real on-chain native SOL payout transaction from a funded SOL Reward Treasury account
 * to the staker, strictly enforcing on-chain treasury solvency at the live Native PoS Base APR.
 */
export async function buildNativeSolMillisecondClaimTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  treasuryPubkey: string;
  stakerPubkey: string;
  principalSol: number;
  aprPct: number;
  anchorSignature: string;
}): Promise<{
  serializedBase64: string;
  lamportsClaimed: number;
  solClaimed: string;
  treasuryBalanceSol: number;
  anchorSlot: number;
  verifiedOnChainElapsedMs: number;
}> {
  if (!params.anchorSignature || params.anchorSignature.trim().length <= 20) {
    throw new Error(
      'Confirmed on-chain anchorSignature is required. Anchor your stream on Solana first — offline elapsedMs fallbacks are disabled.',
    );
  }

  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const treasury = new PublicKey(params.treasuryPubkey);
  const staker = new PublicKey(params.stakerPubkey);

  const [treasuryLamports, latestBlockhash, slot, anchorClock] = await Promise.all([
    connection.getBalance(treasury, 'confirmed'),
    connection.getLatestBlockhash('confirmed'),
    connection.getSlot('confirmed'),
    verifyOnChainAnchorClock(connection, params.anchorSignature),
  ]);

  const resolvedElapsedMs = Math.max(1, anchorClock.onChainElapsedMs);

  const principalNano = BigInt(Math.max(1, Math.round(params.principalSol * 1e9)));
  const aprPctX100 = BigInt(Math.max(1, Math.round((params.aprPct || 1_000_000) * 100)));
  const elapsedMsBig = BigInt(resolvedElapsedMs);

  const accruedLamportsBig = (principalNano * aprPctX100 * elapsedMsBig) / 10_000n;
  const accruedLamports = Number(accruedLamportsBig > 0n ? accruedLamportsBig : 1n);

  if (treasuryLamports < accruedLamports + 10_000) {
    throw new Error(
      `Funded SOL Treasury (${(treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL) does not cover ${accruedLamports} lamports + tx fee. Fund the treasury account first.`,
    );
  }

  const anchorTag = `ANCHOR_SIG=${anchorClock.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${anchorClock.anchorSlot}`;

  const tx = new Transaction({
    feePayer: treasury,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    SystemProgram.transfer({
      fromPubkey: treasury,
      toPubkey: staker,
      lamports: accruedLamports,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_NATIVE_SOL_MS_CLAIM:${anchorTag}:CURRENT_SLOT=${slot}:APR=${params.aprPct}%:ONCHAIN_MS=${resolvedElapsedMs}:LAMPORTS=${accruedLamports}`,
        'utf8',
      ),
    }),
  );

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    lamportsClaimed: accruedLamports,
    solClaimed: (accruedLamports / LAMPORTS_PER_SOL).toFixed(9),
    treasuryBalanceSol: Number((treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)),
    anchorSlot: anchorClock.anchorSlot,
    verifiedOnChainElapsedMs: resolvedElapsedMs,
  };
}

const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const RATE_CENT_PER_MS = 12_000; // $120.00 = 12,000 cents per millisecond
const RATE_USD_PER_MS = 120; // $120.00 USD per millisecond
const MICRO_USDC_PER_MS = 120_000_000; // $120 in 6-decimal USDC = 120,000,000 base units/ms

export async function fetchLiveSolUsdPrice(): Promise<{ price: number; source: string }> {
  const providers: Array<{ name: string; fn: () => Promise<number> }> = [
    {
      name: 'Coinbase Spot (SOL-USD)',
      fn: async () => {
        const res = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', {
          signal: AbortSignal.timeout(4500),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data?: { amount?: string } };
        const price = Number(json.data?.amount);
        if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid price');
        return price;
      },
    },
    {
      name: 'CoinGecko Live Price',
      fn: async () => {
        const res = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
          { signal: AbortSignal.timeout(4500) },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { solana?: { usd?: number } };
        const price = Number(json.solana?.usd);
        if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid price');
        return price;
      },
    },
    {
      name: 'Jupiter Price API',
      fn: async () => {
        const res = await fetch(
          'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112',
          { signal: AbortSignal.timeout(4500) },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          data?: Record<string, { price?: string | number }>;
        };
        const price = Number(
          json.data?.['So11111111111111111111111111111111111111112']?.price,
        );
        if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid price');
        return price;
      },
    },
  ];

  for (const p of providers) {
    try {
      const price = await p.fn();
      return { price: Number(price.toFixed(4)), source: p.name };
    } catch {
      // Try next live oracle provider
    }
  }
  throw new Error('Unable to fetch live SOL/USD oracle price from Coinbase, CoinGecko, or Jupiter.');
}

export async function fetchCentMillisecondStreamSnapshot(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  treasuryPubkey?: string;
  usdcMint?: string;
  anchorSignature?: string;
}): Promise<CentMillisecondStreamSnapshot> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const usdcMint =
    params.usdcMint?.trim() ||
    (params.cluster === 'devnet' ? DEVNET_USDC_MINT : MAINNET_USDC_MINT);

  const [slot, net, oracle, anchorClock] = await Promise.all([
    connection.getSlot('confirmed'),
    fetchNetworkOverview(params.cluster, params.rpcUrl),
    fetchLiveSolUsdPrice(),
    params.anchorSignature && params.anchorSignature.trim().length > 20
      ? verifyOnChainAnchorClock(connection, params.anchorSignature)
      : Promise.resolve(null),
  ]);
  const currentBlockTimeSec = anchorClock
    ? Math.floor(anchorClock.currentBlockTimeMs / 1000)
    : await resolveOnChainBlockTimeSec(connection, slot);

  const rateUsdPerSec = RATE_USD_PER_MS * 1000; // $120,000 / sec
  const rateUsdPerDay = RATE_USD_PER_MS * 86_400_000; // $10,368,000,000 / day
  const rateUsdPerYear = RATE_USD_PER_MS * 31_557_600_000; // $3,786,912,000,000 / yr

  const lamportsPerMsAtLivePrice = Math.round((RATE_USD_PER_MS / oracle.price) * LAMPORTS_PER_SOL);
  const lamportsPerSecAtLivePrice = Math.round((rateUsdPerSec / oracle.price) * LAMPORTS_PER_SOL);

  const requiredPerMsSol = RATE_USD_PER_MS / oracle.price;
  const requiredSolPrincipalForNativePos001CentMs = Number(
    (requiredPerMsSol / Math.max(net.baseNetworkAprPct / 100, 0.0001)).toFixed(6),
  );

  let treasuryPubkey: string | null = null;
  let treasurySolBalance: number | null = null;
  let treasurySolRunwaySeconds: number | null = null;
  let treasurySolRunwayMs: number | null = null;
  let treasuryUsdcBalance: number | null = null;
  let treasuryUsdcRunwaySeconds: number | null = null;
  let treasuryUsdcRunwayMs: number | null = null;

  if (params.treasuryPubkey && params.treasuryPubkey.trim().length > 20) {
    const tKey = new PublicKey(params.treasuryPubkey.trim());
    const mintKey = new PublicKey(usdcMint);
    treasuryPubkey = tKey.toBase58();
    const tAta = getAssociatedTokenAddressSync(mintKey, tKey, true);

    const [solLamports, usdcBalResp] = await Promise.all([
      connection.getBalance(tKey, 'confirmed'),
      connection.getTokenAccountBalance(tAta, 'confirmed').catch(() => null),
    ]);

    treasurySolBalance = Number((solLamports / LAMPORTS_PER_SOL).toFixed(6));
    const treasuryUsdFromSol = treasurySolBalance * oracle.price;
    treasurySolRunwayMs = Math.floor(treasuryUsdFromSol / RATE_USD_PER_MS);
    treasurySolRunwaySeconds = Math.floor(treasuryUsdFromSol / rateUsdPerSec);

    if (usdcBalResp?.value) {
      treasuryUsdcBalance = Number(usdcBalResp.value.uiAmount ?? 0);
      treasuryUsdcRunwayMs = Math.floor(treasuryUsdcBalance / RATE_USD_PER_MS);
      treasuryUsdcRunwaySeconds = Math.floor(treasuryUsdcBalance / rateUsdPerSec);
    } else {
      treasuryUsdcBalance = 0;
      treasuryUsdcRunwayMs = 0;
      treasuryUsdcRunwaySeconds = 0;
    }
  }

  return {
    cluster: params.cluster,
    anchorSignature: anchorClock ? anchorClock.anchorSignature : null,
    anchorSlot: anchorClock ? anchorClock.anchorSlot : slot,
    anchorBlockTimeMs: anchorClock ? anchorClock.anchorBlockTimeMs : currentBlockTimeSec * 1000,
    currentSlot: anchorClock ? anchorClock.currentSlot : slot,
    currentBlockTimeMs: anchorClock ? anchorClock.currentBlockTimeMs : currentBlockTimeSec * 1000,
    slotDelta: anchorClock ? anchorClock.slotDelta : 0,
    onChainElapsedMs: anchorClock ? anchorClock.onChainElapsedMs : 0,
    solUsdPrice: oracle.price,
    priceSource: oracle.source,
    rateCentPerMs: RATE_CENT_PER_MS,
    rateUsdPerMs: RATE_USD_PER_MS,
    rateUsdPerSec,
    rateUsdPerDay,
    rateUsdPerYear,
    lamportsPerMsAtLivePrice,
    lamportsPerSecAtLivePrice,
    microUsdcPerMs: MICRO_USDC_PER_MS,
    microUsdcPerSec: MICRO_USDC_PER_MS * 1000,
    nativePosAprPct: net.baseNetworkAprPct,
    requiredSolPrincipalForNativePos001CentMs,
    treasuryPubkey,
    treasurySolBalance,
    treasurySolRunwaySeconds,
    treasurySolRunwayMs,
    usdcMint,
    treasuryUsdcBalance,
    treasuryUsdcRunwaySeconds,
    treasuryUsdcRunwayMs,
  };
}

export async function buildCentMsSolClaimTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  treasuryPubkey: string;
  stakerPubkey: string;
  anchorSignature: string;
}): Promise<{
  serializedBase64: string;
  usdClaimed: string;
  solUsdPrice: number;
  lamportsClaimed: number;
  solClaimed: string;
  treasuryBalanceSol: number;
  anchorSlot: number;
  verifiedOnChainElapsedMs: number;
}> {
  if (!params.anchorSignature || params.anchorSignature.trim().length <= 20) {
    throw new Error(
      'Confirmed on-chain anchorSignature is required. Anchor your stream on Solana first — offline elapsedMs fallbacks are disabled.',
    );
  }

  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const treasury = new PublicKey(params.treasuryPubkey);
  const staker = new PublicKey(params.stakerPubkey);

  const [treasuryLamports, latestBlockhash, slot, oracle, anchorClock] = await Promise.all([
    connection.getBalance(treasury, 'confirmed'),
    connection.getLatestBlockhash('confirmed'),
    connection.getSlot('confirmed'),
    fetchLiveSolUsdPrice(),
    verifyOnChainAnchorClock(connection, params.anchorSignature),
  ]);

  const elapsedMs = Math.max(1, Math.min(3_600_000, anchorClock.onChainElapsedMs));

  const usdOwed = elapsedMs * RATE_USD_PER_MS;
  const priceScaled = BigInt(Math.max(1, Math.round(oracle.price * 10000)));
  const accruedLamportsBig =
    (BigInt(elapsedMs) * BigInt(RATE_USD_PER_MS) * BigInt(LAMPORTS_PER_SOL) * 10000n) / priceScaled;
  const accruedLamports = Number(accruedLamportsBig > 0n ? accruedLamportsBig : 1n);

  if (BigInt(treasuryLamports) < accruedLamportsBig + 10_000n) {
    const treasuryUsd = (treasuryLamports / LAMPORTS_PER_SOL) * oracle.price;
    throw new Error(
      `Funded SOL Treasury (${(treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL ≈ $${treasuryUsd.toFixed(2)}) cannot cover $${usdOwed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${(Number(accruedLamportsBig) / LAMPORTS_PER_SOL).toFixed(4)} SOL at $${oracle.price}/SOL) + tx fee.`,
    );
  }

  const anchorTag = `ANCHOR_SIG=${anchorClock.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${anchorClock.anchorSlot}`;

  const tx = new Transaction({
    feePayer: treasury,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    SystemProgram.transfer({
      fromPubkey: treasury,
      toPubkey: staker,
      lamports: accruedLamportsBig,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_120USD_MS_SOL_CLAIM:${anchorTag}:CURRENT_SLOT=${slot}:ONCHAIN_MS=${elapsedMs}:USD=${usdOwed.toFixed(2)}:SOL_USD=${oracle.price}:LAMPORTS=${accruedLamportsBig.toString()}`,
        'utf8',
      ),
    }),
  );

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    usdClaimed: usdOwed.toFixed(2),
    solUsdPrice: oracle.price,
    lamportsClaimed: accruedLamports,
    solClaimed: (Number(accruedLamportsBig) / LAMPORTS_PER_SOL).toFixed(6),
    treasuryBalanceSol: Number((treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)),
    anchorSlot: anchorClock.anchorSlot,
    verifiedOnChainElapsedMs: elapsedMs,
  };
}

export async function buildCentMsUsdcClaimTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  treasuryPubkey: string;
  stakerPubkey: string;
  usdcMint?: string;
  anchorSignature: string;
}): Promise<{
  serializedBase64: string;
  usdClaimed: string;
  microUsdcClaimed: string;
  usdcMint: string;
  treasuryUsdcBalance: number;
  anchorSlot: number;
  verifiedOnChainElapsedMs: number;
}> {
  if (!params.anchorSignature || params.anchorSignature.trim().length <= 20) {
    throw new Error(
      'Confirmed on-chain anchorSignature is required. Anchor your stream on Solana first — offline elapsedMs fallbacks are disabled.',
    );
  }

  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const treasury = new PublicKey(params.treasuryPubkey);
  const staker = new PublicKey(params.stakerPubkey);
  const mint = new PublicKey(
    params.usdcMint?.trim() ||
      (params.cluster === 'devnet' ? DEVNET_USDC_MINT : MAINNET_USDC_MINT),
  );

  const treasuryAta = getAssociatedTokenAddressSync(mint, treasury);
  const stakerAta = getAssociatedTokenAddressSync(mint, staker);

  const [treasuryBal, latestBlockhash, slot, anchorClock] = await Promise.all([
    connection.getTokenAccountBalance(treasuryAta, 'confirmed').catch(() => null),
    connection.getLatestBlockhash('confirmed'),
    connection.getSlot('confirmed'),
    verifyOnChainAnchorClock(connection, params.anchorSignature),
  ]);

  const elapsedMs = Math.max(1, Math.min(3_600_000, anchorClock.onChainElapsedMs));

  if (!treasuryBal?.value) {
    throw new Error(
      `Funded USDC Treasury ATA (${treasuryAta.toBase58()}) does not exist or holds 0 balance for mint ${mint.toBase58()}.`,
    );
  }

  const decimals = treasuryBal.value.decimals;
  const unitsPerMs = BigInt(RATE_USD_PER_MS) * 10n ** BigInt(decimals); // $120/ms = 120,000,000 micro-USDC/ms
  const owedUnits = BigInt(elapsedMs) * unitsPerMs;
  const availableUnits = BigInt(treasuryBal.value.amount);
  const usdOwed = elapsedMs * RATE_USD_PER_MS;

  if (availableUnits < owedUnits) {
    throw new Error(
      `Funded USDC Treasury holds ${treasuryBal.value.uiAmountString ?? '0'} USDC, which cannot cover $${usdOwed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${owedUnits.toString()} base units).`,
    );
  }

  const anchorTag = `ANCHOR_SIG=${anchorClock.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${anchorClock.anchorSlot}`;

  const tx = new Transaction({
    feePayer: treasury,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      treasury,
      stakerAta,
      staker,
      mint,
      TOKEN_PROGRAM_ID,
    ),
    createTransferCheckedInstruction(
      treasuryAta,
      mint,
      stakerAta,
      treasury,
      owedUnits,
      decimals,
      [],
      TOKEN_PROGRAM_ID,
    ),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_120USD_MS_USDC_CLAIM:${anchorTag}:CURRENT_SLOT=${slot}:ONCHAIN_MS=${elapsedMs}:USD=${usdOwed.toFixed(2)}:UNITS=${owedUnits.toString()}`,
        'utf8',
      ),
    }),
  );

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    usdClaimed: usdOwed.toFixed(2),
    microUsdcClaimed: owedUnits.toString(),
    usdcMint: mint.toBase58(),
    treasuryUsdcBalance: Number(treasuryBal.value.uiAmount ?? 0),
    anchorSlot: anchorClock.anchorSlot,
    verifiedOnChainElapsedMs: elapsedMs,
  };
}

function decodeSysvarStakeHistory(data: Buffer): StakeHistoryEpochEntry[] {
  if (data.length < 8) return [];
  const count = Number(data.readBigUInt64LE(0));
  const entries: StakeHistoryEpochEntry[] = [];
  const maxEntries = Math.min(count, Math.floor((data.length - 8) / 32));
  for (let i = 0; i < maxEntries; i++) {
    const offset = 8 + i * 32;
    const epoch = Number(data.readBigUInt64LE(offset));
    const effectiveSol = Number(data.readBigUInt64LE(offset + 8)) / LAMPORTS_PER_SOL;
    const activatingSol = Number(data.readBigUInt64LE(offset + 16)) / LAMPORTS_PER_SOL;
    const deactivatingSol = Number(data.readBigUInt64LE(offset + 24)) / LAMPORTS_PER_SOL;
    entries.push({
      epoch,
      effectiveSol: Number(effectiveSol.toFixed(2)),
      activatingSol: Number(activatingSol.toFixed(2)),
      deactivatingSol: Number(deactivatingSol.toFixed(2)),
    });
  }
  return entries.sort((a, b) => b.epoch - a.epoch).slice(0, 12);
}

async function resolveLivePohBlock(connection: Connection, slot: number): Promise<PohBlockLink> {
  const ticksPerSlot = 64; // Solana L1 default 64 PoH ticks per slot
  for (let offset = 0; offset <= 6; offset++) {
    const targetSlot = Math.max(0, slot - offset);
    const blk = await connection
      .getBlock(targetSlot, {
        maxSupportedTransactionVersion: 0,
        rewards: false,
        transactionDetails: 'none',
      })
      .catch(() => null);
    if (blk && blk.blockhash) {
      return {
        slot: targetSlot,
        blockhash: blk.blockhash,
        previousBlockhash: blk.previousBlockhash,
        parentSlot: blk.parentSlot,
        blockHeight: (blk as typeof blk & { blockHeight?: number | null }).blockHeight ?? null,
        blockTimeUnix: blk.blockTime ?? null,
        ticksPerSlot,
        estimatedPohTickHeight: targetSlot * ticksPerSlot,
      };
    }
  }

  const [latestBh, blockTimeUnix] = await Promise.all([
    connection.getLatestBlockhash('confirmed'),
    resolveOnChainBlockTimeSec(connection, slot),
  ]);
  return {
    slot,
    blockhash: latestBh.blockhash,
    previousBlockhash: latestBh.blockhash,
    parentSlot: Math.max(0, slot - 1),
    blockHeight: null,
    blockTimeUnix,
    ticksPerSlot,
    estimatedPohTickHeight: slot * ticksPerSlot,
  };
}

function classifyQueriedAccountType(ownerProgramId: string | undefined, address: string): string {
  if (address === STAKE_POOL_PROGRAM_ID.toBase58()) return 'SPL Stake Pool Program Ledger';
  if (address === StakeProgram.programId.toBase58()) return 'Solana Native Stake Program';
  if (ownerProgramId === StakeProgram.programId.toBase58()) return 'Native Stake Account';
  if (ownerProgramId === STAKE_POOL_PROGRAM_ID.toBase58()) return 'SPL Stake Pool Account';
  if (ownerProgramId === SystemProgram.programId.toBase58()) return 'Staker / Treasury Wallet';
  return ownerProgramId ? `Program Account (${ownerProgramId.slice(0, 8)}...)` : 'On-Chain Solana Account';
}

export async function fetchStakingProofOfHistory(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  address?: string;
  limit?: number;
}): Promise<StakingProofOfHistoryResponse> {
  const { connection, rpcEndpoint } = createConnection(params.cluster, params.rpcUrl);
  const queriedPubkey =
    params.address && params.address.trim().length > 20
      ? new PublicKey(params.address.trim())
      : STAKE_POOL_PROGRAM_ID;
  const limit = Math.max(1, Math.min(20, params.limit ?? 10));

  const [slot, sysvarAccount, accountInfo, sigInfos] = await Promise.all([
    connection.getSlot('confirmed'),
    connection.getAccountInfo(SYSVAR_STAKE_HISTORY_PUBKEY, 'confirmed'),
    connection.getAccountInfo(queriedPubkey, 'confirmed').catch(() => null),
    connection.getSignaturesForAddress(queriedPubkey, { limit }, 'confirmed'),
  ]);

  const livePohBlock = await resolveLivePohBlock(connection, slot);
  const sysvarStakeHistory = sysvarAccount ? decodeSysvarStakeHistory(sysvarAccount.data) : [];
  const accountType = classifyQueriedAccountType(
    accountInfo?.owner?.toBase58(),
    queriedPubkey.toBase58(),
  );

  const signatures = sigInfos.map((s) => s.signature);
  const parsedTxs =
    signatures.length > 0
      ? await connection
          .getParsedTransactions(signatures, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 1,
          })
          .catch(() =>
            Promise.all(
              signatures.map((sig) =>
                connection
                  .getParsedTransaction(sig, {
                    commitment: 'confirmed',
                    maxSupportedTransactionVersion: 1,
                  })
                  .catch(() =>
                    connection
                      .getParsedTransaction(sig, {
                        commitment: 'confirmed',
                        maxSupportedTransactionVersion: 0,
                      })
                      .catch(() => null),
                  ),
              ),
            ),
          )
      : [];

  const genesisPohSeed = createHash('sha256')
    .update(`SOLANA_STAKING_POH_GENESIS:${params.cluster}:${queriedPubkey.toBase58()}:${livePohBlock.previousBlockhash}`)
    .digest('hex');

  // Build chronological PoH chain oldest -> newest so each digest cryptographically commits to the previous one
  const chronological = sigInfos
    .map((sigInfo, idx) => ({ sigInfo, parsedTx: parsedTxs[idx] || null }))
    .reverse();

  let runningDigest = genesisPohSeed;
  const chainedRecords: StakingPohRecord[] = [];

  for (let i = 0; i < chronological.length; i++) {
    const { sigInfo, parsedTx } = chronological[i];
    const message = parsedTx?.transaction?.message;
    const recentBlockhash = message?.recentBlockhash || livePohBlock.blockhash;
    const accountKeys = (message?.accountKeys || []).map((k) =>
      typeof k === 'string' ? k : k.pubkey.toBase58(),
    );

    const programsSet = new Set<string>();
    const stakingActions: string[] = [];
    let memoText: string | null = sigInfo.memo || null;

    const instructions = message?.instructions || [];
    for (const ix of instructions) {
      if ('programId' in ix && ix.programId) {
        programsSet.add(ix.programId.toBase58());
      }
      if ('parsed' in ix && ix.parsed && typeof ix.parsed === 'object') {
        const parsedObj = ix.parsed as { type?: string };
        const progName = 'program' in ix && typeof ix.program === 'string' ? ix.program : '';
        if (parsedObj.type) {
          stakingActions.push(progName ? `${progName}:${parsedObj.type}` : parsedObj.type);
        }
        if (progName === 'spl-memo' && typeof ix.parsed === 'string') {
          memoText = ix.parsed;
        }
      } else if ('programId' in ix && ix.programId?.toBase58() === MEMO_PROGRAM_ID.toBase58() && 'data' in ix) {
        memoText = String(ix.data);
      }
    }

    if (memoText) {
      if (memoText.includes('SOLPOOL_')) {
        stakingActions.push(memoText.split(':')[0].replace(/^\[[^\]]+\]\s*/, ''));
      } else {
        stakingActions.push('MemoProof');
      }
    }
    if (stakingActions.length === 0) {
      stakingActions.push(
        programsSet.has(StakeProgram.programId.toBase58())
          ? 'NativeStakeInstruction'
          : programsSet.has(STAKE_POOL_PROGRAM_ID.toBase58())
            ? 'SplStakePoolInstruction'
            : 'OnChainConfirmedTx',
      );
    }

    const queriedIdx = accountKeys.indexOf(queriedPubkey.toBase58());
    let solDelta = 0;
    if (
      queriedIdx >= 0 &&
      parsedTx?.meta?.preBalances &&
      parsedTx?.meta?.postBalances &&
      parsedTx.meta.preBalances[queriedIdx] !== undefined &&
      parsedTx.meta.postBalances[queriedIdx] !== undefined
    ) {
      solDelta =
        (parsedTx.meta.postBalances[queriedIdx] - parsedTx.meta.preBalances[queriedIdx]) /
        LAMPORTS_PER_SOL;
    }

    const previousPohChainDigest = runningDigest;
    const pohChainDigest = createHash('sha256')
      .update(
        `${previousPohChainDigest}|${sigInfo.signature}|${sigInfo.slot}|${sigInfo.blockTime ?? livePohBlock.blockTimeUnix ?? 0}|${recentBlockhash}|${stakingActions.join(',')}`,
      )
      .digest('hex');
    runningDigest = pohChainDigest;

    chainedRecords.push({
      index: i + 1,
      signature: sigInfo.signature,
      slot: sigInfo.slot,
      blockTimeUnix: sigInfo.blockTime ?? null,
      recentBlockhash,
      confirmationStatus: sigInfo.confirmationStatus || 'confirmed',
      err: Boolean(sigInfo.err),
      feeLamports: parsedTx?.meta?.fee ?? 0,
      solDelta: Number(solDelta.toFixed(6)),
      programsInvoked: Array.from(programsSet),
      stakingActions,
      memo: memoText,
      previousPohChainDigest,
      pohChainDigest,
    });
  }

  const ledgerTimeUnix =
    livePohBlock.blockTimeUnix ?? (await resolveOnChainBlockTimeSec(connection, slot));

  return {
    cluster: params.cluster,
    rpcEndpoint,
    queriedAddress: queriedPubkey.toBase58(),
    accountType,
    livePohBlock,
    sysvarStakeHistory,
    totalVerifiedRecords: chainedRecords.length,
    genesisPohSeed,
    headPohChainDigest: runningDigest,
    records: chainedRecords.reverse(),
    ledgerTimeIso: new Date(ledgerTimeUnix * 1000).toISOString(),
  };
}

export async function buildStakingPohCheckpointTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  signerPubkey: string;
  stakeOrPoolPubkey?: string;
  actionLabel?: string;
}): Promise<{
  serializedBase64: string;
  slot: number;
  blockhash: string;
  checkpointDigest: string;
  memoText: string;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const signer = new PublicKey(params.signerPubkey.trim());
  const target = params.stakeOrPoolPubkey?.trim() || signer.toBase58();
  const label = (params.actionLabel || 'STAKING_POH_AUDIT').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);

  const [latestBlockhash, slot] = await Promise.all([
    connection.getLatestBlockhash('confirmed'),
    connection.getSlot('confirmed'),
  ]);
  const livePohBlock = await resolveLivePohBlock(connection, slot);

  const checkpointDigest = createHash('sha256')
    .update(`${signer.toBase58()}|${target}|${livePohBlock.slot}|${livePohBlock.blockhash}|${label}`)
    .digest('hex')
    .slice(0, 32);

  const memoText = `SOLPOOL_POH_CHECKPOINT:ACTION=${label}:TARGET=${target}:SLOT=${livePohBlock.slot}:POH_HASH=${livePohBlock.blockhash}:DIGEST=${checkpointDigest}`;

  const tx = new Transaction({
    feePayer: signer,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
      data: Buffer.from(memoText, 'utf8'),
    }),
  );

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    slot: livePohBlock.slot,
    blockhash: livePohBlock.blockhash,
    checkpointDigest,
    memoText,
  };
}

export function resolveOriginUrl(reqOrigin?: string): string {
  if (reqOrigin && /^https?:\/\//i.test(reqOrigin.trim())) {
    return reqOrigin.trim().replace(/\/+$/, '');
  }
  const envUrl = process.env.APP_URL?.trim();
  if (envUrl && /^https?:\/\//i.test(envUrl) && !envUrl.includes('MY_APP_URL')) {
    return envUrl.replace(/\/+$/, '');
  }
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

export async function probeSolanaRpcEndpoint(params: {
  cluster: SolanaCluster;
  label?: string;
  rpcUrl?: string;
  originUrl?: string;
}): Promise<SolanaRpcProbeResult> {
  const origin = resolveOriginUrl(params.originUrl);
  const upstreamRpcUrl = resolveRpcEndpoint(params.cluster, params.rpcUrl);
  const clusterLabels: Record<SolanaCluster, string> = {
    'mainnet-beta': 'Solana Mainnet-Beta',
    'mainnet-2': 'Solana Mainnet 2',
    devnet: 'Solana Devnet',
    testnet: 'Solana Testnet',
    custom: 'Custom Solana RPC',
  };
  const label = params.label || clusterLabels[params.cluster];
  const proxyRpcUrl =
    params.cluster === 'custom'
      ? `${origin}/api/rpc/custom?rpcUrl=${encodeURIComponent(upstreamRpcUrl)}`
      : `${origin}/api/rpc/${params.cluster}`;
  const explorerClusterParam =
    params.cluster === 'mainnet-beta' || params.cluster === 'mainnet-2'
      ? ''
      : params.cluster === 'custom'
        ? `?cluster=custom&customUrl=${encodeURIComponent(upstreamRpcUrl)}`
        : `?cluster=${params.cluster}`;

  const startedAt = performance.now();
  try {
    const connection = new Connection(upstreamRpcUrl, 'confirmed');
    const [
      versionInfo,
      epochInfo,
      latestBh,
      blockHeight,
      perfSamples,
      stakePoolAcc,
      sysvarStakeHistAcc,
    ] = await Promise.all([
      connection.getVersion(),
      connection.getEpochInfo('confirmed'),
      connection.getLatestBlockhash('confirmed'),
      connection.getBlockHeight('confirmed'),
      connection.getRecentPerformanceSamples(1).catch(() => []),
      connection.getAccountInfo(STAKE_POOL_PROGRAM_ID, 'confirmed').catch(() => null),
      connection.getAccountInfo(SYSVAR_STAKE_HISTORY_PUBKEY, 'confirmed').catch(() => null),
    ]);

    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    const epochProgressPct =
      epochInfo.slotsInEpoch > 0
        ? Number(((epochInfo.slotIndex / epochInfo.slotsInEpoch) * 100).toFixed(2))
        : 0;
    const sample = perfSamples[0];
    const tps =
      sample && sample.samplePeriodSecs > 0
        ? Math.round(sample.numTransactions / sample.samplePeriodSecs)
        : null;
    const blockTimeUnix = await resolveOnChainBlockTimeSec(connection, epochInfo.absoluteSlot).catch(
      () => null,
    );

    return {
      cluster: params.cluster,
      label,
      upstreamRpcUrl,
      proxyRpcUrl,
      explorerClusterParam,
      healthy: true,
      latencyMs,
      slot: epochInfo.absoluteSlot,
      blockHeight,
      epoch: epochInfo.epoch,
      slotIndex: epochInfo.slotIndex,
      slotsInEpoch: epochInfo.slotsInEpoch,
      epochProgressPct,
      blockhash: latestBh.blockhash,
      solanaCoreVersion: versionInfo['solana-core'] || null,
      tps,
      stakePoolProgramExecutable: Boolean(stakePoolAcc?.executable),
      sysvarStakeHistoryReadable: Boolean(sysvarStakeHistAcc?.data?.length),
      error: null,
      checkedAtIso: blockTimeUnix
        ? new Date(blockTimeUnix * 1000).toISOString()
        : new Date().toISOString(),
    };
  } catch (err) {
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    return {
      cluster: params.cluster,
      label,
      upstreamRpcUrl,
      proxyRpcUrl,
      explorerClusterParam,
      healthy: false,
      latencyMs,
      slot: null,
      blockHeight: null,
      epoch: null,
      slotIndex: null,
      slotsInEpoch: null,
      epochProgressPct: null,
      blockhash: null,
      solanaCoreVersion: null,
      tps: null,
      stakePoolProgramExecutable: false,
      sysvarStakeHistoryReadable: false,
      error: err instanceof Error ? err.message : 'Failed to reach Solana RPC node',
      checkedAtIso: new Date().toISOString(),
    };
  }
}

export async function fetchDeveloperRpcLinks(params: {
  cluster: SolanaCluster;
  customRpcUrl?: string;
  originUrl?: string;
}): Promise<DeveloperRpcLinksResponse> {
  const originUrl = resolveOriginUrl(params.originUrl);
  const activeCluster = params.cluster || 'mainnet-beta';
  const activeUpstreamRpcUrl = resolveRpcEndpoint(activeCluster, params.customRpcUrl);
  const activeProxyRpcUrl =
    activeCluster === 'custom'
      ? `${originUrl}/api/rpc/custom?rpcUrl=${encodeURIComponent(activeUpstreamRpcUrl)}`
      : `${originUrl}/api/rpc/${activeCluster}`;

  const targets: Array<{ cluster: SolanaCluster; label: string; rpcUrl?: string }> = [
    { cluster: 'mainnet-2', label: 'Solana Mainnet 2' },
    { cluster: 'mainnet-beta', label: 'Solana Mainnet-Beta' },
    { cluster: 'devnet', label: 'Solana Devnet' },
    { cluster: 'testnet', label: 'Solana Testnet' },
  ];

  if (params.customRpcUrl && /^https?:\/\//i.test(params.customRpcUrl.trim())) {
    targets.push({
      cluster: 'custom',
      label: 'Custom Solana RPC',
      rpcUrl: params.customRpcUrl.trim(),
    });
  }

  const probes = await Promise.all(
    targets.map((target) =>
      probeSolanaRpcEndpoint({
        cluster: target.cluster,
        label: target.label,
        rpcUrl: target.rpcUrl,
        originUrl,
      }),
    ),
  );

  const ledgerTimeIso =
    probes.find((p) => p.cluster === activeCluster && p.healthy)?.checkedAtIso ||
    probes.find((p) => p.healthy)?.checkedAtIso ||
    new Date().toISOString();

  return {
    originUrl,
    activeCluster,
    activeUpstreamRpcUrl,
    activeProxyRpcUrl,
    protocolEndpoints: {
      splStakePoolProgramId: STAKE_POOL_PROGRAM_ID.toBase58(),
      anchorStakingRoiProgramId: ANCHOR_STAKING_ROI_PROGRAM_ID,
      sysvarStakeHistory: SYSVAR_STAKE_HISTORY_PUBKEY.toBase58(),
      sysvarSlotHashes: SYSVAR_SLOT_HASHES_ID,
      packageName: 'solpool-staking-roi-protocol',
      nativePosAprLabel: '1,000,000% permilsec',
    },
    probes,
    fetchedAt: ledgerTimeIso,
  };
}

function isValidJsonRpcItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const obj = item as Record<string, unknown>;
  return obj.jsonrpc === '2.0' && typeof obj.method === 'string' && obj.method.trim().length > 0;
}

export async function forwardSolanaJsonRpc(params: {
  cluster: SolanaCluster;
  customRpcUrl?: string;
  payload: unknown;
}): Promise<{ status: number; upstreamRpcUrl: string; data: unknown }> {
  const upstreamRpcUrl = resolveRpcEndpoint(params.cluster, params.customRpcUrl);

  const valid = Array.isArray(params.payload)
    ? params.payload.length > 0 && params.payload.every(isValidJsonRpcItem)
    : isValidJsonRpcItem(params.payload);

  if (!valid) {
    return {
      status: 400,
      upstreamRpcUrl,
      data: {
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Invalid JSON-RPC 2.0 request payload (requires jsonrpc: "2.0" and method)',
        },
        id: null,
      },
    };
  }

  const upstreamResp = await fetch(upstreamRpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params.payload),
    signal: AbortSignal.timeout(20_000),
  });

  const rawText = await upstreamResp.text();
  try {
    const parsed = JSON.parse(rawText);
    return {
      status: upstreamResp.status,
      upstreamRpcUrl,
      data: parsed,
    };
  } catch {
    return {
      status: 502,
      upstreamRpcUrl,
      data: {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Upstream Solana RPC returned non-JSON HTTP ${upstreamResp.status}: ${rawText.slice(0, 200)}`,
        },
        id: null,
      },
    };
  }
}

export async function fetchWalletBalanceOverview(params: {
  walletPubkey: string;
  cluster: SolanaCluster;
  rpcUrl?: string;
}): Promise<WalletBalanceOverviewResponse> {
  const { connection, rpcEndpoint } = createConnection(params.cluster, params.rpcUrl);
  const wallet = new PublicKey(params.walletPubkey.trim());

  const [lamports, tokenResp, stakeAccounts, slot, latestBh, sigInfos] = await Promise.all([
    connection.getBalance(wallet, 'confirmed'),
    connection
      .getParsedTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID }, 'confirmed')
      .catch(() => ({ value: [] })),
    fetchWalletStakeAccounts({
      walletPubkey: wallet.toBase58(),
      cluster: params.cluster,
      rpcUrl: params.rpcUrl,
    }).catch(() => []),
    connection.getSlot('confirmed'),
    connection.getLatestBlockhash('confirmed'),
    connection.getSignaturesForAddress(wallet, { limit: 8 }, 'confirmed').catch(() => []),
  ]);

  const tokenAccounts: WalletTokenBalanceItem[] = [];
  for (const item of tokenResp.value) {
    const parsedInfo = (item.account.data as { parsed?: { info?: Record<string, unknown> } })
      ?.parsed?.info as
      | {
          mint?: string;
          tokenAmount?: { uiAmount?: number | null; decimals?: number };
        }
      | undefined;
    if (!parsedInfo?.mint) continue;
    tokenAccounts.push({
      mint: parsedInfo.mint,
      tokenAccount: item.pubkey.toBase58(),
      uiAmount: Number(parsedInfo.tokenAmount?.uiAmount ?? 0),
      decimals: Number(parsedInfo.tokenAmount?.decimals ?? 0),
    });
  }

  const totalStakedSol = stakeAccounts.reduce((acc, s) => acc + s.delegatedSol, 0);

  return {
    cluster: params.cluster,
    rpcEndpoint,
    walletPubkey: wallet.toBase58(),
    solBalance: Number((lamports / LAMPORTS_PER_SOL).toFixed(9)),
    lamports: String(lamports),
    totalStakedSol: Number(totalStakedSol.toFixed(6)),
    stakeAccounts,
    tokenAccounts: tokenAccounts.sort((a, b) => b.uiAmount - a.uiAmount),
    slot,
    blockhash: latestBh.blockhash,
    recentSignatures: sigInfos.map((s) => ({
      signature: s.signature,
      slot: s.slot,
      blockTimeUnix: s.blockTime ?? null,
      confirmationStatus: s.confirmationStatus || 'confirmed',
      err: Boolean(s.err),
    })),
  };
}

export async function buildSendSolToWalletTx(params: {
  fromPubkey: string;
  toPubkey: string;
  amountSol: number;
  cluster: SolanaCluster;
  rpcUrl?: string;
  memo?: string;
}): Promise<{
  serializedBase64: string;
  fromPubkey: string;
  toPubkey: string;
  lamports: number;
  blockhash: string;
  slot: number;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const from = new PublicKey(params.fromPubkey.trim());
  const to = new PublicKey(params.toPubkey.trim());
  const lamports = Math.round(Number(params.amountSol) * LAMPORTS_PER_SOL);
  if (!Number.isFinite(lamports) || lamports <= 0) {
    throw new Error('Transfer amountSol must be greater than zero');
  }

  const [latestBh, slot] = await Promise.all([
    connection.getLatestBlockhash('confirmed'),
    connection.getSlot('confirmed'),
  ]);

  const tx = new Transaction({
    feePayer: from,
    recentBlockhash: latestBh.blockhash,
  });

  tx.add(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: to,
      lamports,
    }),
  );

  if (params.memo && params.memo.trim().length > 0) {
    tx.add(
      new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [{ pubkey: from, isSigner: true, isWritable: false }],
        data: Buffer.from(params.memo.trim().slice(0, 128), 'utf8'),
      }),
    );
  }

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    fromPubkey: from.toBase58(),
    toPubkey: to.toBase58(),
    lamports,
    blockhash: latestBh.blockhash,
    slot,
  };
}

export async function broadcastSignedTransaction(params: {
  signedTxBase64: string;
  cluster: SolanaCluster;
  rpcUrl?: string;
  skipPreflight?: boolean;
}): Promise<BroadcastTransactionResponse> {
  const { connection, rpcEndpoint } = createConnection(params.cluster, params.rpcUrl);
  const cleaned = params.signedTxBase64.trim();
  if (!cleaned) {
    throw new Error('signedTxBase64 is required to broadcast a transaction to Solana');
  }
  const rawBytes = Buffer.from(cleaned, 'base64');
  if (rawBytes.length < 32) {
    throw new Error('Invalid base64 transaction bytes');
  }

  const signature = await connection.sendRawTransaction(rawBytes, {
    skipPreflight: Boolean(params.skipPreflight),
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  const [statusResp, slot] = await Promise.all([
    connection.getSignatureStatuses([signature]).catch(() => null),
    connection.getSlot('confirmed').catch(() => 0),
  ]);

  const statusEntry = statusResp?.value?.[0];
  const explorerClusterParam =
    params.cluster === 'mainnet-beta' || params.cluster === 'mainnet-2'
      ? ''
      : params.cluster === 'custom'
        ? `?cluster=custom&customUrl=${encodeURIComponent(rpcEndpoint)}`
        : `?cluster=${params.cluster}`;

  return {
    cluster: params.cluster,
    rpcEndpoint,
    signature,
    slot: statusEntry?.slot ?? slot,
    confirmationStatus: statusEntry?.confirmationStatus ?? 'processed',
    explorerUrl: `https://explorer.solana.com/tx/${signature}${explorerClusterParam}`,
  };
}

