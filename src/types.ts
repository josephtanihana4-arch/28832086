export type SolanaCluster = 'mainnet-beta' | 'mainnet-2' | 'devnet' | 'testnet' | 'custom';

export interface ValidatorSummary {
  votePubkey: string;
  nodePubkey: string;
  activatedStakeSol: number;
  commission: number;
  lastVote: number;
  epochCredits: number;
  delinquent: boolean;
  estimatedNetAprPct: number;
  estimatedNetApyPct: number;
}

export interface NetworkOverview {
  cluster: SolanaCluster;
  rpcEndpoint: string;
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  epochProgressPct: number;
  absoluteSlot: number;
  avgSlotTimeSec: number;
  estimatedEpochDays: number;
  epochsPerYear: number;
  inflationTotalPct: number;
  inflationValidatorPct: number;
  inflationFoundationPct: number;
  totalSupplySol: number;
  circulatingSupplySol: number;
  totalActivatedStakeSol: number;
  stakeParticipationPct: number;
  baseNetworkAprPct: number;
  baseNetworkApyPct: number;
  activeValidatorCount: number;
  delinquentValidatorCount: number;
  validators: ValidatorSummary[];
  fetchedAt: string;
}

export interface LivePoolValidator {
  voteAccountAddress: string;
  activeStakeSol: number;
  transientStakeSol: number;
  lastUpdateEpoch: number;
  status: string;
}

export interface LiveStakePoolData {
  address: string;
  name?: string;
  symbol?: string;
  programId: string;
  manager: string;
  staker: string;
  poolMint: string;
  reserveStake: string;
  validatorListAddress: string;
  managerFeeAccount: string;
  poolWithdrawAuthority: string;
  totalLamports: string;
  totalSol: number;
  poolTokenSupply: string;
  poolTokenSupplyUi: number;
  lstExchangeRate: number;
  lastUpdateEpoch: number;
  lastEpochTotalSol: number;
  lastEpochSupplyUi: number;
  realizedEpochAprPct: number;
  realizedEpochApyPct: number;
  epochFeePct: number;
  solDepositFeePct: number;
  solWithdrawalFeePct: number;
  stakeDepositFeePct: number;
  stakeWithdrawalFeePct: number;
  solReferralFeePct: number;
  maxValidators: number;
  validatorCount: number;
  validators: LivePoolValidator[];
}

export interface RoiProjectionPoint {
  day: number;
  epoch: number;
  totalSol: number;
  posYieldSol: number;
  boostYieldSol: number;
  feeDragSol: number;
  cumulativeRoiPct: number;
  usdValue: number;
}

export interface RoiCalculationResult {
  grossPosAprPct: number;
  netPosAprPct: number;
  protocolBoostAprPct: number;
  totalEffectiveAprPct: number;
  effectiveApyPct: number;
  projectedFinalSol: number;
  totalProfitSol: number;
  totalRoiPct: number;
  projectedFinalUsd: number;
  perMsYieldSol: number;
  perSecYieldSol: number;
  dailyYieldSol: number;
  epochYieldSol: number;
  lstAppreciation1Yr: number;
  points: RoiProjectionPoint[];
}

export interface ProtocolConfig {
  id: string;
  packageName: string;
  protocolName: string;
  tokenSymbol: string;
  tokenName: string;
  cluster: SolanaCluster;
  rpcUrl?: string;
  roiMode: 'native_pos_lst' | 'native_direct_stake' | 'hybrid_boosted_pool';
  payerPubkey: string;
  managerPubkey: string;
  stakerPubkey: string;
  maxValidators: number;
  epochFeeBps: number;
  solDepositFeeBps: number;
  solWithdrawalFeeBps: number;
  stakeDepositFeeBps: number;
  stakeWithdrawalFeeBps: number;
  referralFeePct: number;
  protocolBoostAprPct: number;
  initialReserveSol: number;
  selectedValidators: string[];
  stakePoolAddress?: string;
  poolMintAddress?: string;
  validatorListAddress?: string;
  reserveStakeAddress?: string;
  withdrawAuthorityAddress?: string;
  managerFeeAccountAddress?: string;
  status: 'draft' | 'tx_built' | 'deployed';
  deploymentSignatures?: string[];
  createdAt: string;
}

export interface BuiltTransactionStep {
  stepIndex: number;
  title: string;
  description: string;
  serializedBase64: string;
  signersRequired: string[];
  partialSignedBy: string[];
}

export interface BuildProtocolTxResponse {
  protocol: ProtocolConfig;
  addresses: {
    stakePool: string;
    poolMint: string;
    validatorList: string;
    reserveStake: string;
    withdrawAuthority: string;
    managerFeeAccount: string;
    programId: string;
  };
  estimatedRentSol: number;
  transactions: BuiltTransactionStep[];
}

export interface GeneratedPackageFile {
  path: string;
  language: string;
  content: string;
}

export interface StakeAccountProtectionAudit {
  stakeAccount: string;
  cluster: SolanaCluster;
  state: string;
  balanceSol: number;
  delegatedSol: number;
  rentExemptReserveSol: number;
  stakerAuthority: string;
  withdrawerAuthority: string;
  authoritySplitProtected: boolean;
  lockupEpoch: number;
  lockupTimestamp: number;
  voterPubkey: string | null;
  validatorCommission: number | null;
  validatorDelinquent: boolean;
  maxAllowedCommissionPct: number;
  protectionStatus: 'PROTECTED' | 'COMMISSION_ALERT' | 'DELINQUENT_ALERT' | 'UNDELEGATED';
  protectionNotes: string[];
  currentSlot: number;
  blockTimeUnix: number;
}

export interface OnChainAnchorClock {
  anchorSignature: string;
  anchorSlot: number;
  anchorBlockTimeMs: number;
  currentSlot: number;
  currentBlockTimeMs: number;
  slotDelta: number;
  onChainElapsedMs: number;
}

export interface WalletStakeAccountSummary {
  pubkey: string;
  state: string;
  balanceSol: number;
  delegatedSol: number;
  voterPubkey: string | null;
  stakerAuthority: string;
  withdrawerAuthority: string;
  authoritySplitProtected: boolean;
}

export interface MillisecondChainYieldSnapshot {
  cluster: SolanaCluster;
  anchorSignature?: string | null;
  anchorSlot: number;
  anchorBlockTimeMs: number;
  currentSlot?: number;
  currentBlockTimeMs?: number;
  slotDelta?: number;
  onChainElapsedMs?: number;
  principalSol: number;
  aprPct: number;
  perMillisecondTokens: string;
  perMillisecondSolExact: string;
  perSecondTokens: string;
  perSecondLamports: string;
  perDaySol: string;
  perEpochTokens: string;
  perYearTokens: string;
  nativePosAprPct: number;
}

export interface CentMillisecondStreamSnapshot {
  cluster: SolanaCluster;
  anchorSignature?: string | null;
  anchorSlot: number;
  anchorBlockTimeMs: number;
  currentSlot?: number;
  currentBlockTimeMs?: number;
  slotDelta?: number;
  onChainElapsedMs?: number;
  solUsdPrice: number;
  priceSource: string;
  rateCentPerMs: number;
  rateUsdPerMs: number;
  rateUsdPerSec: number;
  rateUsdPerDay: number;
  rateUsdPerYear: number;
  lamportsPerMsAtLivePrice: number;
  lamportsPerSecAtLivePrice: number;
  microUsdcPerMs: number;
  microUsdcPerSec: number;
  nativePosAprPct: number;
  requiredSolPrincipalForNativePos001CentMs: number;
  treasuryPubkey: string | null;
  treasurySolBalance: number | null;
  treasurySolRunwaySeconds: number | null;
  treasurySolRunwayMs: number | null;
  usdcMint: string;
  treasuryUsdcBalance: number | null;
  treasuryUsdcRunwaySeconds: number | null;
  treasuryUsdcRunwayMs: number | null;
}

export interface PohBlockLink {
  slot: number;
  blockhash: string;
  previousBlockhash: string;
  parentSlot: number;
  blockHeight: number | null;
  blockTimeUnix: number | null;
  ticksPerSlot: number;
  estimatedPohTickHeight: number;
}

export interface StakeHistoryEpochEntry {
  epoch: number;
  effectiveSol: number;
  activatingSol: number;
  deactivatingSol: number;
}

export interface StakingPohRecord {
  index: number;
  signature: string;
  slot: number;
  blockTimeUnix: number | null;
  recentBlockhash: string;
  confirmationStatus: string;
  err: boolean;
  feeLamports: number;
  solDelta: number;
  programsInvoked: string[];
  stakingActions: string[];
  memo: string | null;
  previousPohChainDigest: string;
  pohChainDigest: string;
}

export interface StakingProofOfHistoryResponse {
  cluster: SolanaCluster;
  rpcEndpoint: string;
  queriedAddress: string;
  accountType: string;
  livePohBlock: PohBlockLink;
  sysvarStakeHistory: StakeHistoryEpochEntry[];
  totalVerifiedRecords: number;
  genesisPohSeed: string;
  headPohChainDigest: string;
  records: StakingPohRecord[];
  ledgerTimeIso: string;
}

export interface SolanaRpcProbeResult {
  cluster: SolanaCluster;
  label: string;
  upstreamRpcUrl: string;
  proxyRpcUrl: string;
  explorerClusterParam: string;
  healthy: boolean;
  latencyMs: number;
  slot: number | null;
  blockHeight: number | null;
  epoch: number | null;
  slotIndex: number | null;
  slotsInEpoch: number | null;
  epochProgressPct: number | null;
  blockhash: string | null;
  solanaCoreVersion: string | null;
  tps: number | null;
  stakePoolProgramExecutable: boolean;
  sysvarStakeHistoryReadable: boolean;
  error: string | null;
  checkedAtIso: string;
}

export interface DeveloperRpcLinksResponse {
  originUrl: string;
  activeCluster: SolanaCluster;
  activeUpstreamRpcUrl: string;
  activeProxyRpcUrl: string;
  protocolEndpoints: {
    splStakePoolProgramId: string;
    anchorStakingRoiProgramId: string;
    sysvarStakeHistory: string;
    sysvarSlotHashes: string;
    packageName: string;
    nativePosAprLabel: string;
  };
  probes: SolanaRpcProbeResult[];
  fetchedAt: string;
}

export interface WalletTokenBalanceItem {
  mint: string;
  tokenAccount: string;
  uiAmount: number;
  decimals: number;
}

export interface WalletBalanceOverviewResponse {
  cluster: SolanaCluster;
  rpcEndpoint: string;
  walletPubkey: string;
  solBalance: number;
  lamports: string;
  totalStakedSol: number;
  stakeAccounts: WalletStakeAccountSummary[];
  tokenAccounts: WalletTokenBalanceItem[];
  slot: number;
  blockhash: string;
  recentSignatures: Array<{
    signature: string;
    slot: number;
    blockTimeUnix: number | null;
    confirmationStatus: string;
    err: boolean;
  }>;
}

export interface BroadcastTransactionResponse {
  cluster: SolanaCluster;
  rpcEndpoint: string;
  signature: string;
  slot: number;
  confirmationStatus: string;
  explorerUrl: string;
}

export interface WithdrawalPoolOverview {
  stakePoolAddress: string;
  poolName?: string;
  tokenSymbol?: string;
  cluster: SolanaCluster;
  withdrawAuthority: string;
  reserveStakeAddress: string;
  reserveLamports: string;
  reserveSol: number;
  instantSolWithdrawCapacity: number;
  totalPoolSol: number;
  poolTokenSupplyUi: number;
  lstExchangeRate: number;
  solWithdrawalFeePct: number;
  stakeWithdrawalFeePct: number;
  nativePosAprPct: number;
  nativePosAprLabel: string;
  perMillisecondSolPer100Sol: string;
  perDaySolPer100Sol: string;
  userBalance?: {
    walletPubkey: string;
    solBalance: number;
    lstTokenBalance: number;
    lstTokenAccount?: string;
    accruedYieldSol: number;
    elapsedMs: number;
  };
}

export interface BuildWithdrawStakeTxResponse {
  serializedBase64: string;
  stakePoolAddress: string;
  amountLst: number;
  destinationStakeAccount: string;
}

