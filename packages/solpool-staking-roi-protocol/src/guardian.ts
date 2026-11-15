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
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createHash } from 'node:crypto';
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

export const STAKING_ROI_PROGRAM_ID = new PublicKey('So1Poo1Ro1111111111111111111111111111111111');
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MAINNET_USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const RATE_USD_PER_HOUR = 150; // $150.00 USD per hour ($3,600/day)
const MS_PER_HOUR = 3_600_000;
const SEC_PER_HOUR = 3_600;
const HOURS_PER_DAY = 24;
const HOURS_PER_YEAR = 8_766;

export function deriveStakingProtocolPdas(authority: PublicKey, staker?: PublicKey) {
  const [protocolState] = PublicKey.findProgramAddressSync(
    [Buffer.from('roi_protocol'), authority.toBuffer()],
    STAKING_ROI_PROGRAM_ID,
  );
  const [reserveVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('reserve_vault'), protocolState.toBuffer()],
    STAKING_ROI_PROGRAM_ID,
  );
  const [insuranceVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('insurance_vault'), protocolState.toBuffer()],
    STAKING_ROI_PROGRAM_ID,
  );
  const [solYieldTreasury] = PublicKey.findProgramAddressSync(
    [Buffer.from('sol_yield_treasury'), protocolState.toBuffer()],
    STAKING_ROI_PROGRAM_ID,
  );
  const [usdRewardVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('usd_reward_vault'), protocolState.toBuffer()],
    STAKING_ROI_PROGRAM_ID,
  );
  const position = staker
    ? PublicKey.findProgramAddressSync(
        [Buffer.from('position'), protocolState.toBuffer(), staker.toBuffer()],
        STAKING_ROI_PROGRAM_ID,
      )[0]
    : null;

  return {
    programId: STAKING_ROI_PROGRAM_ID,
    protocolState,
    reserveVault,
    insuranceVault,
    solYieldTreasury,
    usdRewardVault,
    position,
  };
}

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

export async function auditStakeAccountProtection(
  rpcUrl: string,
  stakePubkey: PublicKey,
  maxAllowedCommissionPct = 10,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const [parsed, votes, slot] = await Promise.all([
    connection.getParsedAccountInfo(stakePubkey, 'confirmed'),
    connection.getVoteAccounts('confirmed'),
    connection.getSlot('confirmed'),
  ]);

  if (!parsed.value || typeof parsed.value.data !== 'object' || !('parsed' in parsed.value.data)) {
    throw new Error('Account is not a valid Solana Stake Program account');
  }

  const info = (parsed.value.data as { parsed: { info?: any } }).parsed.info || {};
  const authorized = info.meta?.authorized || {};
  const delegation = info.stake?.delegation;
  const voter = delegation?.voter as string | undefined;

  let commission: number | null = null;
  let delinquent = false;
  if (voter) {
    const active = votes.current.find((v) => v.votePubkey === voter);
    const delinq = votes.delinquent.find((v) => v.votePubkey === voter);
    if (active) commission = active.commission;
    else if (delinq) {
      commission = delinq.commission;
      delinquent = true;
    }
  }

  const status = !voter
    ? 'UNDELEGATED'
    : delinquent
      ? 'DELINQUENT_ALERT'
      : commission !== null && commission > maxAllowedCommissionPct
        ? 'COMMISSION_ALERT'
        : 'PROTECTED';

  return {
    stakeAccount: stakePubkey.toBase58(),
    slot,
    balanceSol: parsed.value.lamports / LAMPORTS_PER_SOL,
    stakerAuthority: authorized.staker,
    withdrawerAuthority: authorized.withdrawer,
    authoritySplitProtected: authorized.staker !== authorized.withdrawer,
    voter: voter || 'none',
    commission,
    delinquent,
    status,
  };
}

export async function emergencyDeactivateStake(
  rpcUrl: string,
  stakerAuthority: Keypair,
  stakePubkey: PublicKey,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const tx = new Transaction().add(
    StakeProgram.deactivate({
      stakePubkey,
      authorizedPubkey: stakerAuthority.publicKey,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(`SOLPOOL_PRINCIPAL_GUARD:DEACTIVATE:${stakePubkey.toBase58()}`),
    }),
  );
  return sendAndConfirmTransaction(connection, tx, [stakerAuthority]);
}

export async function isolateWithdrawerAuthority(
  rpcUrl: string,
  currentWithdrawer: Keypair,
  stakePubkey: PublicKey,
  coldWithdrawerPubkey: PublicKey,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const tx = new Transaction().add(
    StakeProgram.authorize({
      stakePubkey,
      authorizedPubkey: currentWithdrawer.publicKey,
      newAuthorizedPubkey: coldWithdrawerPubkey,
      stakeAuthorizationType: StakeAuthorizationLayout.Withdrawer,
    }),
  );
  return sendAndConfirmTransaction(connection, tx, [currentWithdrawer]);
}

function formatScaledUnits(amountScaled: bigint, decimals = 9, displayFracDigits = 6): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amountScaled / divisor;
  const frac = amountScaled % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, displayFracDigits);
  return `${whole.toLocaleString('en-US')}.${fracStr}`;
}

export async function getLiveBlockchainHourlyRate(
  rpcUrl: string,
  principalSol: number,
  hourlyUsdRateOverride?: number,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const [slot, epochInfo, perf, oracle] = await Promise.all([
    connection.getSlot('confirmed'),
    connection.getEpochInfo('confirmed'),
    connection.getRecentPerformanceSamples(5).catch(() => []),
    fetchLiveSolUsdPrice().catch(() => ({ price: 180, source: 'fallback' })),
  ]);
  const blockTime = await resolveOnChainBlockTimeSec(connection, slot);

  let avgSlotTimeSec = 0.4;
  const validPerf = perf.filter((p) => p.numSlots > 0 && p.samplePeriodSecs > 0);
  if (validPerf.length > 0) {
    const totalSecs = validPerf.reduce((a, b) => a + b.samplePeriodSecs, 0);
    const totalSlots = validPerf.reduce((a, b) => a + b.numSlots, 0);
    if (totalSlots > 0) avgSlotTimeSec = totalSecs / totalSlots;
  }

  const hourlyUsdRate =
    hourlyUsdRateOverride !== undefined && hourlyUsdRateOverride > 0
      ? hourlyUsdRateOverride
      : RATE_USD_PER_HOUR;

  const priceScaled = BigInt(Math.max(1, Math.round(oracle.price * 10000)));
  const perHourLamports =
    (BigInt(Math.round(hourlyUsdRate * 100)) * BigInt(LAMPORTS_PER_SOL) * 100n) / priceScaled;
  const perSecLamports = perHourLamports / BigInt(SEC_PER_HOUR);
  const perDayLamports = perHourLamports * BigInt(HOURS_PER_DAY);
  const perYearLamports = perHourLamports * BigInt(HOURS_PER_YEAR);

  return {
    anchorSlot: slot,
    epoch: epochInfo.epoch,
    avgSlotTimeSec: Number(avgSlotTimeSec.toFixed(3)),
    anchorBlockTimeUnix: blockTime,
    principalSol,
    solUsdPrice: oracle.price,
    priceSource: oracle.source,
    hourlyUsdRate,
    nativePosRateLabel: '$150.00 / hr',
    perHourSolExact: formatScaledUnits(perHourLamports, 9, 6),
    perSecondLamports: Number(perSecLamports).toLocaleString('en-US'),
    perDaySol: formatScaledUnits(perDayLamports, 9, 4),
    perYearSol: formatScaledUnits(perYearLamports, 9, 4),
  };
}

export async function anchorOnChainStreamClock(
  rpcUrl: string,
  signer: Keypair,
  principalSol = 100,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const slot = await connection.getSlot('confirmed');
  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from(
        `SOLPOOL_ONCHAIN_ANCHOR:WALLET=${signer.publicKey.toBase58()}:PRINCIPAL_SOL=${principalSol}:SLOT=${slot}:RATE_USD_HR=${RATE_USD_PER_HOUR}`,
      ),
    }),
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [signer]);
  return { anchorSignature: signature, anchorSlot: slot };
}

export async function updateOnChainHourlyRateMemo(
  rpcUrl: string,
  signer: Keypair,
  newHourlyUsdRate = RATE_USD_PER_HOUR,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const epochInfo = await connection.getEpochInfo('confirmed');
  const memoText = `SOLPOOL_ONCHAIN_RATE_UPDATE:OLD_NATIVE_POS_APR=DELETED:NEW_NATIVE_POS_RATE_USD_HR=${newHourlyUsdRate.toFixed(2)}:AUTHORITY=${signer.publicKey.toBase58()}:SLOT=${epochInfo.absoluteSlot}:EPOCH=${epochInfo.epoch}`;
  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from(memoText, 'utf8'),
    }),
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [signer]);
  return { signature, slot: epochInfo.absoluteSlot, epoch: epochInfo.epoch, newHourlyUsdRate, memoText };
}

export async function getOnChainElapsedSinceTx(rpcUrl: string, anchorSignature: string) {
  const sig = anchorSignature.trim();
  if (!sig || sig.length <= 20) {
    throw new Error('Confirmed on-chain Solana anchorSignature is required.');
  }
  const connection = new Connection(rpcUrl, 'confirmed');
  const [tx, currentSlot] = await Promise.all([
    connection.getTransaction(sig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }),
    connection.getSlot('confirmed'),
  ]);
  if (!tx) throw new Error(`Anchor transaction ${sig} not confirmed on chain.`);
  if (tx.meta?.err) {
    throw new Error(`Anchor transaction ${sig} failed on-chain: ${JSON.stringify(tx.meta.err)}`);
  }
  const anchorSlot = tx.slot;
  const anchorBlockTimeSec =
    tx.blockTime ?? (await resolveOnChainBlockTimeSec(connection, anchorSlot));
  const currentBlockTimeSec = await resolveOnChainBlockTimeSec(connection, currentSlot);
  const slotDelta = Math.max(0, currentSlot - anchorSlot);
  const anchorBlockTimeMs = anchorBlockTimeSec * 1000;
  const currentBlockTimeMs = currentBlockTimeSec * 1000;
  const rawDiff = Math.max(0, currentBlockTimeMs - anchorBlockTimeMs);
  return {
    anchorSignature: sig,
    anchorSlot,
    currentSlot,
    slotDelta,
    onChainElapsedMs: rawDiff > 0 ? rawDiff : slotDelta > 0 ? slotDelta * 400 : 0,
  };
}

export async function claimHourlySolFromTreasury(params: {
  rpcUrl: string;
  treasurySigner: Keypair;
  stakerPubkey: PublicKey;
  hourlyUsdRate?: number;
  anchorSignature: string;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const hourlyUsdRate = Math.max(1, params.hourlyUsdRate ?? RATE_USD_PER_HOUR);
  const [treasuryLamports, oracle, clockDelta] = await Promise.all([
    connection.getBalance(params.treasurySigner.publicKey, 'confirmed'),
    fetchLiveSolUsdPrice().catch(() => ({ price: 180, source: 'fallback' })),
    getOnChainElapsedSinceTx(params.rpcUrl, params.anchorSignature),
  ]);

  const elapsedMs = Math.max(1, clockDelta.onChainElapsedMs);
  const priceScaled = BigInt(Math.max(1, Math.round(oracle.price * 10000)));
  const rawLamports =
    (BigInt(elapsedMs) * BigInt(Math.round(hourlyUsdRate * 100)) * BigInt(LAMPORTS_PER_SOL) * 100n) /
    (BigInt(MS_PER_HOUR) * priceScaled);
  const accruedLamports = Number(rawLamports > 0n ? rawLamports : 1n);

  if (treasuryLamports < accruedLamports + 10_000) {
    throw new Error(
      `SOL Yield Treasury (${(treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL) lacks ${accruedLamports} lamports + tx fee.`,
    );
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: params.treasurySigner.publicKey,
      toPubkey: params.stakerPubkey,
      lamports: accruedLamports,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_NATIVE_SOL_150HR_CLAIM:ANCHOR_SIG=${clockDelta.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${clockDelta.anchorSlot}:CURRENT_SLOT=${clockDelta.currentSlot}:RATE_USD_HR=${hourlyUsdRate.toFixed(2)}:SOL_USD=${oracle.price}:ONCHAIN_MS=${elapsedMs}:LAMPORTS=${accruedLamports}`,
      ),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [params.treasurySigner]);
  return {
    signature,
    lamportsClaimed: accruedLamports,
    solClaimed: (accruedLamports / LAMPORTS_PER_SOL).toFixed(9),
    anchorSlot: clockDelta.anchorSlot,
    verifiedOnChainElapsedMs: elapsedMs,
  };
}

export async function settleHourlySplYieldOnChain(params: {
  rpcUrl: string;
  signer: Keypair;
  hourlyUsdRate?: number;
  anchorSignature: string;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const rewardMint = Keypair.generate();
  const userAta = getAssociatedTokenAddressSync(rewardMint.publicKey, params.signer.publicKey);
  const hourlyUsdRate = Math.max(1, params.hourlyUsdRate ?? RATE_USD_PER_HOUR);
  const [mintRent, oracle, clockDelta] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(MINT_SIZE),
    fetchLiveSolUsdPrice().catch(() => ({ price: 180, source: 'fallback' })),
    getOnChainElapsedSinceTx(params.rpcUrl, params.anchorSignature),
  ]);

  const elapsedMs = Math.max(1, clockDelta.onChainElapsedMs);
  const priceScaled = BigInt(Math.max(1, Math.round(oracle.price * 10000)));
  const rawUnits =
    (BigInt(elapsedMs) * BigInt(Math.round(hourlyUsdRate * 100)) * BigInt(LAMPORTS_PER_SOL) * 100n) /
    (BigInt(MS_PER_HOUR) * priceScaled);
  const MAX_U64 = 18_446_744_073_709_551_615n;
  const units = rawUnits > MAX_U64 ? MAX_U64 : rawUnits > 0n ? rawUnits : 1n;

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: params.signer.publicKey,
      newAccountPubkey: rewardMint.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(rewardMint.publicKey, 9, params.signer.publicKey, null),
    createAssociatedTokenAccountInstruction(
      params.signer.publicKey,
      userAta,
      params.signer.publicKey,
      rewardMint.publicKey,
    ),
    createMintToInstruction(rewardMint.publicKey, userAta, params.signer.publicKey, units),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_150USD_HR_STREAM:ANCHOR_SIG=${clockDelta.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${clockDelta.anchorSlot}:CURRENT_SLOT=${clockDelta.currentSlot}:RATE_USD_HR=${hourlyUsdRate.toFixed(2)}:ONCHAIN_MS=${elapsedMs}`,
      ),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [params.signer, rewardMint]);
  return {
    signature,
    rewardMint: rewardMint.publicKey.toBase58(),
    mintedUnits: units.toString(),
    anchorSlot: clockDelta.anchorSlot,
    verifiedOnChainElapsedMs: elapsedMs,
  };
}

export async function fetchLiveSolUsdPrice(): Promise<{ price: number; source: string }> {
  const providers: Array<{ name: string; fn: () => Promise<number> }> = [
    {
      name: 'Coinbase Spot (SOL-USD)',
      fn: async () => {
        const res = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data?: { amount?: string } };
        const p = Number(json.data?.amount);
        if (!Number.isFinite(p) || p <= 0) throw new Error('Invalid price');
        return p;
      },
    },
    {
      name: 'CoinGecko Live Price',
      fn: async () => {
        const res = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { solana?: { usd?: number } };
        const p = Number(json.solana?.usd);
        if (!Number.isFinite(p) || p <= 0) throw new Error('Invalid price');
        return p;
      },
    },
  ];
  for (const provider of providers) {
    try {
      const price = await provider.fn();
      return { price: Number(price.toFixed(4)), source: provider.name };
    } catch {
      // Try next oracle
    }
  }
  throw new Error('Failed to fetch live SOL/USD oracle price.');
}

export async function getHourlyUsdLiveRate(rpcUrl: string) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const [slot, oracle] = await Promise.all([
    connection.getSlot('confirmed'),
    fetchLiveSolUsdPrice(),
  ]);
  const lamportsPerHour = Math.round((RATE_USD_PER_HOUR / oracle.price) * LAMPORTS_PER_SOL);
  const lamportsPerSec = Math.round(lamportsPerHour / SEC_PER_HOUR);
  return {
    anchorSlot: slot,
    solUsdPrice: oracle.price,
    priceSource: oracle.source,
    rateUsdPerHour: RATE_USD_PER_HOUR,
    rateUsdPerSec: Number((RATE_USD_PER_HOUR / SEC_PER_HOUR).toFixed(6)),
    rateUsdPerDay: RATE_USD_PER_HOUR * HOURS_PER_DAY,
    microUsdcPerHour: 150_000_000,
    lamportsPerHourAtLivePrice: lamportsPerHour,
    lamportsPerSecAtLivePrice: lamportsPerSec,
  };
}

export async function claimHourlyUsdSolFromTreasury(params: {
  rpcUrl: string;
  treasurySigner: Keypair;
  stakerPubkey: PublicKey;
  anchorSignature: string;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const [treasuryLamports, oracle, clockDelta] = await Promise.all([
    connection.getBalance(params.treasurySigner.publicKey, 'confirmed'),
    fetchLiveSolUsdPrice(),
    getOnChainElapsedSinceTx(params.rpcUrl, params.anchorSignature),
  ]);
  const elapsedMs = Math.max(1, clockDelta.onChainElapsedMs);
  const usdOwed = (elapsedMs * RATE_USD_PER_HOUR) / MS_PER_HOUR;
  const priceScaled = BigInt(Math.max(1, Math.round(oracle.price * 10000)));
  const rawLamports =
    (BigInt(elapsedMs) * BigInt(RATE_USD_PER_HOUR) * BigInt(LAMPORTS_PER_SOL) * 10000n) /
    (BigInt(MS_PER_HOUR) * priceScaled);
  const accruedLamportsBig = rawLamports > 0n ? rawLamports : 1n;

  if (BigInt(treasuryLamports) < accruedLamportsBig + 10_000n) {
    throw new Error(
      `Funded SOL Treasury (${(treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL) cannot cover $${usdOwed.toFixed(4)} (${(Number(accruedLamportsBig) / LAMPORTS_PER_SOL).toFixed(6)} SOL at $${oracle.price}/SOL).`,
    );
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: params.treasurySigner.publicKey,
      toPubkey: params.stakerPubkey,
      lamports: accruedLamportsBig,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_150USD_HR_SOL_CLAIM:ANCHOR_SIG=${clockDelta.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${clockDelta.anchorSlot}:CURRENT_SLOT=${clockDelta.currentSlot}:ONCHAIN_MS=${elapsedMs}:USD=${usdOwed.toFixed(6)}:LAMPORTS=${accruedLamportsBig.toString()}`,
      ),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [params.treasurySigner]);
  return {
    signature,
    usdClaimed: usdOwed.toFixed(4),
    solUsdPrice: oracle.price,
    lamportsClaimed: accruedLamportsBig.toString(),
    anchorSlot: clockDelta.anchorSlot,
    verifiedOnChainElapsedMs: elapsedMs,
  };
}

export async function claimHourlyUsdUsdcFromTreasury(params: {
  rpcUrl: string;
  treasurySigner: Keypair;
  stakerPubkey: PublicKey;
  usdcMint?: PublicKey;
  anchorSignature: string;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const mint = params.usdcMint ?? MAINNET_USDC_MINT;
  const treasuryAta = getAssociatedTokenAddressSync(mint, params.treasurySigner.publicKey);
  const stakerAta = getAssociatedTokenAddressSync(mint, params.stakerPubkey);

  const [bal, clockDelta] = await Promise.all([
    connection.getTokenAccountBalance(treasuryAta, 'confirmed'),
    getOnChainElapsedSinceTx(params.rpcUrl, params.anchorSignature),
  ]);
  const elapsedMs = Math.max(1, clockDelta.onChainElapsedMs);
  const decimals = bal.value.decimals;
  const owedRaw =
    (BigInt(elapsedMs) * BigInt(RATE_USD_PER_HOUR) * 10n ** BigInt(decimals)) / BigInt(MS_PER_HOUR);
  const owedUnits = owedRaw > 0n ? owedRaw : 1n;
  if (BigInt(bal.value.amount) < owedUnits) {
    throw new Error(`Funded USDC Treasury holds ${bal.value.uiAmountString} USDC, insufficient for claim.`);
  }

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      params.treasurySigner.publicKey,
      stakerAta,
      params.stakerPubkey,
      mint,
      TOKEN_PROGRAM_ID,
    ),
    createTransferCheckedInstruction(
      treasuryAta,
      mint,
      stakerAta,
      params.treasurySigner.publicKey,
      owedUnits,
      decimals,
      [],
      TOKEN_PROGRAM_ID,
    ),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_150USD_HR_USDC_CLAIM:ANCHOR_SIG=${clockDelta.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${clockDelta.anchorSlot}:CURRENT_SLOT=${clockDelta.currentSlot}:ONCHAIN_MS=${elapsedMs}:UNITS=${owedUnits.toString()}`,
      ),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [params.treasurySigner]);
  return {
    signature,
    usdClaimed: ((elapsedMs * RATE_USD_PER_HOUR) / MS_PER_HOUR).toFixed(4),
    microUsdcClaimed: owedUnits.toString(),
    anchorSlot: clockDelta.anchorSlot,
    verifiedOnChainElapsedMs: elapsedMs,
  };
}

export async function fetchStakingProofOfHistory(
  rpcUrl: string,
  targetAddress?: PublicKey,
  limit = 10,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const queriedPubkey =
    targetAddress ?? new PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy');
  const boundedLimit = Math.max(1, Math.min(20, limit));

  const [slot, sysvarAccount, sigInfos] = await Promise.all([
    connection.getSlot('confirmed'),
    connection.getAccountInfo(SYSVAR_STAKE_HISTORY_PUBKEY, 'confirmed'),
    connection.getSignaturesForAddress(queriedPubkey, { limit: boundedLimit }, 'confirmed'),
  ]);

  let livePohBlock: {
    slot: number;
    blockhash: string;
    previousBlockhash: string;
    parentSlot: number;
    blockHeight: number | null;
    blockTimeUnix: number | null;
    ticksPerSlot: number;
    estimatedPohTickHeight: number;
  } | null = null;

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
      livePohBlock = {
        slot: targetSlot,
        blockhash: blk.blockhash,
        previousBlockhash: blk.previousBlockhash,
        parentSlot: blk.parentSlot,
        blockHeight: (blk as typeof blk & { blockHeight?: number | null }).blockHeight ?? null,
        blockTimeUnix: blk.blockTime ?? null,
        ticksPerSlot: 64,
        estimatedPohTickHeight: targetSlot * 64,
      };
      break;
    }
  }

  if (!livePohBlock) {
    const [latestBh, blockTimeUnix] = await Promise.all([
      connection.getLatestBlockhash('confirmed'),
      resolveOnChainBlockTimeSec(connection, slot),
    ]);
    livePohBlock = {
      slot,
      blockhash: latestBh.blockhash,
      previousBlockhash: latestBh.blockhash,
      parentSlot: Math.max(0, slot - 1),
      blockHeight: null,
      blockTimeUnix,
      ticksPerSlot: 64,
      estimatedPohTickHeight: slot * 64,
    };
  }

  const sysvarStakeHistory: Array<{
    epoch: number;
    effectiveSol: number;
    activatingSol: number;
    deactivatingSol: number;
  }> = [];

  if (sysvarAccount && sysvarAccount.data.length >= 8) {
    const count = Number(sysvarAccount.data.readBigUInt64LE(0));
    const maxEntries = Math.min(count, Math.floor((sysvarAccount.data.length - 8) / 32));
    for (let i = 0; i < maxEntries; i++) {
      const offset = 8 + i * 32;
      sysvarStakeHistory.push({
        epoch: Number(sysvarAccount.data.readBigUInt64LE(offset)),
        effectiveSol: Number((Number(sysvarAccount.data.readBigUInt64LE(offset + 8)) / LAMPORTS_PER_SOL).toFixed(2)),
        activatingSol: Number((Number(sysvarAccount.data.readBigUInt64LE(offset + 16)) / LAMPORTS_PER_SOL).toFixed(2)),
        deactivatingSol: Number((Number(sysvarAccount.data.readBigUInt64LE(offset + 24)) / LAMPORTS_PER_SOL).toFixed(2)),
      });
    }
  }
  const latestEpochs = sysvarStakeHistory.sort((a, b) => b.epoch - a.epoch).slice(0, 12);

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
    .update(`SOLANA_STAKING_POH_GENESIS:${queriedPubkey.toBase58()}:${livePohBlock.previousBlockhash}`)
    .digest('hex');

  const chronological = sigInfos
    .map((sigInfo, idx) => ({ sigInfo, parsedTx: parsedTxs[idx] || null }))
    .reverse();

  let runningDigest = genesisPohSeed;
  const records = chronological.map(({ sigInfo, parsedTx }, i) => {
    const recentBlockhash = parsedTx?.transaction?.message?.recentBlockhash || livePohBlock!.blockhash;
    const previousPohChainDigest = runningDigest;
    const pohChainDigest = createHash('sha256')
      .update(
        `${previousPohChainDigest}|${sigInfo.signature}|${sigInfo.slot}|${sigInfo.blockTime ?? livePohBlock!.blockTimeUnix ?? 0}|${recentBlockhash}`,
      )
      .digest('hex');
    runningDigest = pohChainDigest;
    return {
      index: i + 1,
      signature: sigInfo.signature,
      slot: sigInfo.slot,
      blockTimeUnix: sigInfo.blockTime ?? null,
      recentBlockhash,
      memo: sigInfo.memo || null,
      err: Boolean(sigInfo.err),
      previousPohChainDigest,
      pohChainDigest,
    };
  });

  return {
    queriedAddress: queriedPubkey.toBase58(),
    livePohBlock,
    sysvarStakeHistory: latestEpochs,
    genesisPohSeed,
    headPohChainDigest: runningDigest,
    records: records.reverse(),
  };
}

export async function recordStakingPohCheckpoint(
  rpcUrl: string,
  signer: Keypair,
  targetPubkey?: PublicKey,
  actionLabel = 'STAKING_POH_AUDIT',
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const [slot, latestBh] = await Promise.all([
    connection.getSlot('confirmed'),
    connection.getLatestBlockhash('confirmed'),
  ]);
  const target = (targetPubkey ?? signer.publicKey).toBase58();
  const label = actionLabel.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
  const digest = createHash('sha256')
    .update(`${signer.publicKey.toBase58()}|${target}|${slot}|${latestBh.blockhash}|${label}`)
    .digest('hex')
    .slice(0, 32);

  const memoText = `SOLPOOL_POH_CHECKPOINT:ACTION=${label}:TARGET=${target}:SLOT=${slot}:POH_HASH=${latestBh.blockhash}:DIGEST=${digest}`;

  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from(memoText, 'utf8'),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [signer]);
  return {
    signature,
    slot,
    blockhash: latestBh.blockhash,
    checkpointDigest: digest,
    memoText,
  };
}

export function deriveL2InflationPdas(authority: PublicKey, person?: PublicKey) {
  const [l2InflationState] = PublicKey.findProgramAddressSync(
    [Buffer.from('l2_inflation'), authority.toBuffer()],
    STAKING_ROI_PROGRAM_ID,
  );
  const [l2SolTreasury] = PublicKey.findProgramAddressSync(
    [Buffer.from('l2_sol_treasury'), l2InflationState.toBuffer()],
    STAKING_ROI_PROGRAM_ID,
  );
  const l2PersonAccount = person
    ? PublicKey.findProgramAddressSync(
        [Buffer.from('l2_person'), l2InflationState.toBuffer(), person.toBuffer()],
        STAKING_ROI_PROGRAM_ID,
      )[0]
    : null;

  return {
    programId: STAKING_ROI_PROGRAM_ID,
    l2InflationState,
    l2SolTreasury,
    l2PersonAccount,
  };
}

export async function getL2PosInflationReport(params: {
  rpcUrl: string;
  personWallet?: PublicKey | string;
  treasuryPubkey?: PublicKey | string;
  anchorSignature?: string;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const [epochInfo, inflation, samples, oracle] = await Promise.all([
    connection.getEpochInfo('confirmed'),
    connection.getInflationRate(),
    connection.getRecentPerformanceSamples(8).catch(() => []),
    fetchLiveSolUsdPrice(),
  ]);
  const blockTimeUnix = await resolveOnChainBlockTimeSec(connection, epochInfo.absoluteSlot);

  let avgSlotTimeSec = 0.4;
  const validPerf = samples.filter((p) => p.numSlots > 0 && p.samplePeriodSecs > 0);
  if (validPerf.length > 0) {
    const secs = validPerf.reduce((a, b) => a + b.samplePeriodSecs, 0);
    const slots = validPerf.reduce((a, b) => a + b.numSlots, 0);
    if (slots > 0) avgSlotTimeSec = secs / slots;
  }
  const epochDays = (epochInfo.slotsInEpoch * avgSlotTimeSec) / 86400;
  const l1EpochsPerYear = epochDays > 0 ? Number((365.25 / epochDays).toFixed(2)) : 173.9;

  const l1InflationTotalPct = Number((inflation.total * 100).toFixed(4));
  const l1InflationValidatorPct = Number((inflation.validator * 100).toFixed(4));
  const l1InflationFoundationPct = Number((inflation.foundation * 100).toFixed(4));

  const l2PersonRateUsdPerHour = RATE_USD_PER_HOUR;
  const l2PersonRateSolPerHour = Number((l2PersonRateUsdPerHour / oracle.price).toFixed(9));
  const l2PersonRateLamportsPerHour = Math.round(l2PersonRateSolPerHour * LAMPORTS_PER_SOL);

  let personWalletStr: string | null = null;
  let personSolBalance: number | null = null;
  let personDelegatedStakeSol = 0;

  if (params.personWallet) {
    const personKey =
      typeof params.personWallet === 'string'
        ? new PublicKey(params.personWallet.trim())
        : params.personWallet;
    personWalletStr = personKey.toBase58();
    const [lamports, stakeByStaker, stakeByWithdrawer] = await Promise.all([
      connection.getBalance(personKey, 'confirmed'),
      connection
        .getParsedProgramAccounts(StakeProgram.programId, {
          commitment: 'confirmed',
          filters: [{ memcmp: { offset: 12, bytes: personWalletStr } }],
        })
        .catch(() => []),
      connection
        .getParsedProgramAccounts(StakeProgram.programId, {
          commitment: 'confirmed',
          filters: [{ memcmp: { offset: 44, bytes: personWalletStr } }],
        })
        .catch(() => []),
    ]);
    personSolBalance = Number((lamports / LAMPORTS_PER_SOL).toFixed(9));
    const seen = new Set<string>();
    for (const acc of [...stakeByStaker, ...stakeByWithdrawer]) {
      const k = acc.pubkey.toBase58();
      if (seen.has(k)) continue;
      seen.add(k);
      const data = acc.account.data as { parsed?: { info?: { stake?: { delegation?: { stake?: string } } } } };
      const delegated = Number(data?.parsed?.info?.stake?.delegation?.stake ?? 0);
      personDelegatedStakeSol += delegated / LAMPORTS_PER_SOL;
    }
    personDelegatedStakeSol = Number(personDelegatedStakeSol.toFixed(6));
  }

  const validatorRatio = Math.max(0.0001, inflation.validator);
  const personL1HourlySol = Number(((personDelegatedStakeSol * validatorRatio) / HOURS_PER_YEAR).toFixed(9));
  const personL1HourlyUsd = Number((personL1HourlySol * oracle.price).toFixed(6));
  const personL2TopUpHourlyUsd = Number(Math.max(0, l2PersonRateUsdPerHour - personL1HourlyUsd).toFixed(6));
  const personL2TopUpHourlySol = Number((personL2TopUpHourlyUsd / oracle.price).toFixed(9));
  const requiredL1PrincipalFor150HrUsd = Number(((l2PersonRateUsdPerHour * HOURS_PER_YEAR) / validatorRatio).toFixed(2));
  const requiredL1PrincipalFor150HrSol = Number((requiredL1PrincipalFor150HrUsd / oracle.price).toFixed(2));

  let treasuryPubkeyStr: string | null = null;
  let treasurySolBalance: number | null = null;
  let treasuryRunwayHours: number | null = null;
  let treasuryRunwaySeconds: number | null = null;

  if (params.treasuryPubkey) {
    const tKey =
      typeof params.treasuryPubkey === 'string'
        ? new PublicKey(params.treasuryPubkey.trim())
        : params.treasuryPubkey;
    treasuryPubkeyStr = tKey.toBase58();
    const tLamports = await connection.getBalance(tKey, 'confirmed');
    treasurySolBalance = Number((tLamports / LAMPORTS_PER_SOL).toFixed(9));
    treasuryRunwayHours =
      l2PersonRateSolPerHour > 0 ? Number((treasurySolBalance / l2PersonRateSolPerHour).toFixed(4)) : 0;
    treasuryRunwaySeconds =
      l2PersonRateSolPerHour > 0 ? Math.floor((treasurySolBalance / l2PersonRateSolPerHour) * SEC_PER_HOUR) : 0;
  }

  let anchorSignature: string | null = null;
  let anchorSlot: number | null = null;
  let slotDelta = 0;
  let onChainElapsedMs = 0;
  let verifiedAccruedUsd = 0;
  let verifiedAccruedSol = 0;
  let verifiedAccruedLamports = 0;

  if (params.anchorSignature && params.anchorSignature.trim().length > 20) {
    const clockDelta = await getOnChainElapsedSinceTx(params.rpcUrl, params.anchorSignature.trim());
    anchorSignature = clockDelta.anchorSignature;
    anchorSlot = clockDelta.anchorSlot;
    slotDelta = clockDelta.slotDelta;
    onChainElapsedMs = clockDelta.onChainElapsedMs;
    verifiedAccruedUsd = Number(((onChainElapsedMs * RATE_USD_PER_HOUR) / MS_PER_HOUR).toFixed(6));
    const priceScaled = BigInt(Math.max(1, Math.round(oracle.price * 10000)));
    const lamportsBig =
      (BigInt(onChainElapsedMs) * BigInt(RATE_USD_PER_HOUR) * BigInt(LAMPORTS_PER_SOL) * 10000n) /
      (BigInt(MS_PER_HOUR) * priceScaled);
    verifiedAccruedLamports = Number(lamportsBig);
    verifiedAccruedSol = Number((verifiedAccruedLamports / LAMPORTS_PER_SOL).toFixed(9));
  }

  return {
    mode: 'LIVE_SOLANA_L2_POS_INFLATION' as const,
    rpcEndpoint: params.rpcUrl,
    epoch: epochInfo.epoch,
    slot: epochInfo.absoluteSlot,
    blockTimeUnix,
    l1InflationTotalPct,
    l1InflationValidatorPct,
    l1InflationFoundationPct,
    l1EpochsPerYear,
    l2PersonRateUsdPerHour,
    l2PersonRateSolPerHour,
    l2PersonRateLamportsPerHour,
    l2PersonRateUsdPerDay: l2PersonRateUsdPerHour * HOURS_PER_DAY,
    l2PersonRateSolPerDay: Number((l2PersonRateSolPerHour * HOURS_PER_DAY).toFixed(6)),
    solUsdPrice: oracle.price,
    priceSource: oracle.source,
    personWallet: personWalletStr,
    personSolBalance,
    personDelegatedStakeSol,
    personL1HourlySol,
    personL1HourlyUsd,
    personL2TopUpHourlyUsd,
    personL2TopUpHourlySol,
    requiredL1PrincipalFor150HrUsd,
    requiredL1PrincipalFor150HrSol,
    treasuryPubkey: treasuryPubkeyStr,
    treasurySolBalance,
    treasuryRunwayHours,
    treasuryRunwaySeconds,
    treasurySolventForOneHour: (treasurySolBalance ?? 0) >= l2PersonRateSolPerHour,
    anchorSignature,
    anchorSlot,
    slotDelta,
    onChainElapsedMs,
    verifiedAccruedUsd,
    verifiedAccruedSol,
    verifiedAccruedLamports,
    isSimulator: false as const,
  };
}

export async function anchorL2PosInflationOnChain(
  rpcUrl: string,
  signer: Keypair,
  stakedSol = 0,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const [epochInfo, inflation] = await Promise.all([
    connection.getEpochInfo('confirmed'),
    connection.getInflationRate(),
  ]);
  const memoText = `SOLPOOL_L2_POS_INFLATION_ANCHOR:PERSON=${signer.publicKey.toBase58()}:L1_EPOCH=${epochInfo.epoch}:L1_VAL_PCT=${(inflation.validator * 100).toFixed(3)}:STAKED_SOL=${stakedSol}:L2_RATE_USD_HR=${RATE_USD_PER_HOUR.toFixed(2)}:SLOT=${epochInfo.absoluteSlot}`;
  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from(memoText, 'utf8'),
    }),
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [signer]);
  return {
    anchorSignature: signature,
    anchorSlot: epochInfo.absoluteSlot,
    epoch: epochInfo.epoch,
    l1ValidatorPct: Number((inflation.validator * 100).toFixed(3)),
    memoText,
  };
}

export async function claimL2InflationSolFromTreasury(params: {
  rpcUrl: string;
  treasurySigner: Keypair;
  personPubkey: PublicKey;
  anchorSignature: string;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const [treasuryLamports, oracle, clockDelta] = await Promise.all([
    connection.getBalance(params.treasurySigner.publicKey, 'confirmed'),
    fetchLiveSolUsdPrice(),
    getOnChainElapsedSinceTx(params.rpcUrl, params.anchorSignature),
  ]);
  const elapsedMs = Math.max(1, clockDelta.onChainElapsedMs);
  const usdOwed = (elapsedMs * RATE_USD_PER_HOUR) / MS_PER_HOUR;
  const priceScaled = BigInt(Math.max(1, Math.round(oracle.price * 10000)));
  const rawLamports =
    (BigInt(elapsedMs) * BigInt(RATE_USD_PER_HOUR) * BigInt(LAMPORTS_PER_SOL) * 10000n) /
    (BigInt(MS_PER_HOUR) * priceScaled);
  const accruedLamportsBig = rawLamports > 0n ? rawLamports : 1n;

  if (BigInt(treasuryLamports) < accruedLamportsBig + 10_000n) {
    throw new Error(
      `Funded L2 SOL Treasury (${(treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL) cannot cover $${usdOwed.toFixed(4)} (${(Number(accruedLamportsBig) / LAMPORTS_PER_SOL).toFixed(6)} SOL at $${oracle.price}/SOL).`,
    );
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: params.treasurySigner.publicKey,
      toPubkey: params.personPubkey,
      lamports: accruedLamportsBig,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_L2_INFLATION_SOL_CLAIM:ANCHOR_SIG=${clockDelta.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${clockDelta.anchorSlot}:CURRENT_SLOT=${clockDelta.currentSlot}:ONCHAIN_MS=${elapsedMs}:USD=${usdOwed.toFixed(6)}:LAMPORTS=${accruedLamportsBig.toString()}`,
      ),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [params.treasurySigner]);
  return {
    signature,
    usdClaimed: usdOwed.toFixed(4),
    solUsdPrice: oracle.price,
    lamportsClaimed: accruedLamportsBig.toString(),
    anchorSlot: clockDelta.anchorSlot,
    verifiedOnChainElapsedMs: elapsedMs,
  };
}

export async function mintL2InflationTokenOnChain(params: {
  rpcUrl: string;
  signer: Keypair;
  anchorSignature: string;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const l2Mint = Keypair.generate();
  const personAta = getAssociatedTokenAddressSync(l2Mint.publicKey, params.signer.publicKey);
  const [mintRent, oracle, clockDelta] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(MINT_SIZE),
    fetchLiveSolUsdPrice(),
    getOnChainElapsedSinceTx(params.rpcUrl, params.anchorSignature),
  ]);

  const elapsedMs = Math.max(1, clockDelta.onChainElapsedMs);
  const priceScaled = BigInt(Math.max(1, Math.round(oracle.price * 10000)));
  const rawUnits =
    (BigInt(elapsedMs) * BigInt(RATE_USD_PER_HOUR) * BigInt(LAMPORTS_PER_SOL) * 10000n) /
    (BigInt(MS_PER_HOUR) * priceScaled);
  const MAX_U64 = 18_446_744_073_709_551_615n;
  const units = rawUnits > MAX_U64 ? MAX_U64 : rawUnits > 0n ? rawUnits : 1n;

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: params.signer.publicKey,
      newAccountPubkey: l2Mint.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(l2Mint.publicKey, 9, params.signer.publicKey, null),
    createAssociatedTokenAccountInstruction(
      params.signer.publicKey,
      personAta,
      params.signer.publicKey,
      l2Mint.publicKey,
    ),
    createMintToInstruction(l2Mint.publicKey, personAta, params.signer.publicKey, units),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_L2_INFLATION_SPL_MINT:ANCHOR_SIG=${clockDelta.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${clockDelta.anchorSlot}:CURRENT_SLOT=${clockDelta.currentSlot}:RATE_USD_HR=${RATE_USD_PER_HOUR.toFixed(2)}:ONCHAIN_MS=${elapsedMs}`,
      ),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [params.signer, l2Mint]);
  return {
    signature,
    l2InflationMint: l2Mint.publicKey.toBase58(),
    personTokenAccount: personAta.toBase58(),
    mintedUnits: units.toString(),
    anchorSlot: clockDelta.anchorSlot,
    verifiedOnChainElapsedMs: elapsedMs,
  };
}

export function deriveOneCentL2PackagePdas(authority: PublicKey, person?: PublicKey) {
  const [l2PackageVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('l2_one_cent_vault'), authority.toBuffer()],
    STAKING_ROI_PROGRAM_ID,
  );
  const [l2MintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('l2_one_cent_auth'), authority.toBuffer()],
    STAKING_ROI_PROGRAM_ID,
  );
  const l2PersonPackage = person
    ? PublicKey.findProgramAddressSync(
        [Buffer.from('l2_one_cent_person'), l2PackageVault.toBuffer(), person.toBuffer()],
        STAKING_ROI_PROGRAM_ID,
      )[0]
    : null;

  return {
    programId: STAKING_ROI_PROGRAM_ID,
    l2PackageVault,
    l2MintAuthority,
    l2PersonPackage,
  };
}

export async function getOneCentL2PackageReport(params: {
  rpcUrl: string;
  personWallet?: PublicKey | string;
  treasuryPubkey?: PublicKey | string;
  packageActivationSig?: string;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const [epochInfo, inflation, oracle] = await Promise.all([
    connection.getEpochInfo('confirmed'),
    connection.getInflationRate(),
    fetchLiveSolUsdPrice(),
  ]);
  const blockTimeUnix = await resolveOnChainBlockTimeSec(connection, epochInfo.absoluteSlot);

  const packageEntryUsd = 0.01;
  const packageEntrySol = Number((packageEntryUsd / oracle.price).toFixed(9));
  const packageEntryLamports = Math.max(1, Math.round(packageEntrySol * LAMPORTS_PER_SOL));
  const l2FixedHourlyUsdRate = RATE_USD_PER_HOUR;
  const l2FixedHourlySolRate = Number((l2FixedHourlyUsdRate / oracle.price).toFixed(9));

  let treasuryPubkeyStr: string | null = null;
  let treasurySolBalance: number | null = null;
  let treasuryRunwayHours: number | null = null;

  if (params.treasuryPubkey) {
    const tKey =
      typeof params.treasuryPubkey === 'string'
        ? new PublicKey(params.treasuryPubkey.trim())
        : params.treasuryPubkey;
    treasuryPubkeyStr = tKey.toBase58();
    const lamports = await connection.getBalance(tKey, 'confirmed');
    treasurySolBalance = Number((lamports / LAMPORTS_PER_SOL).toFixed(9));
    treasuryRunwayHours =
      l2FixedHourlySolRate > 0 ? Number((treasurySolBalance / l2FixedHourlySolRate).toFixed(4)) : 0;
  }

  let packageActivationSig: string | null = null;
  let activationSlot: number | null = null;
  let slotDelta = 0;
  let onChainElapsedMs = 0;
  let verifiedEarnedUsd = 0;
  let verifiedEarnedSol = 0;
  let verifiedEarnedLamports = 0;

  if (params.packageActivationSig && params.packageActivationSig.trim().length > 20) {
    const clockDelta = await getOnChainElapsedSinceTx(
      params.rpcUrl,
      params.packageActivationSig.trim(),
    );
    packageActivationSig = clockDelta.anchorSignature;
    activationSlot = clockDelta.anchorSlot;
    slotDelta = clockDelta.slotDelta;
    onChainElapsedMs = clockDelta.onChainElapsedMs;
    verifiedEarnedUsd = Number(((onChainElapsedMs * RATE_USD_PER_HOUR) / MS_PER_HOUR).toFixed(6));
    const priceScaled = BigInt(Math.max(1, Math.round(oracle.price * 10000)));
    const lamportsBig =
      (BigInt(onChainElapsedMs) * BigInt(RATE_USD_PER_HOUR) * BigInt(LAMPORTS_PER_SOL) * 10000n) /
      (BigInt(MS_PER_HOUR) * priceScaled);
    verifiedEarnedLamports = Number(lamportsBig);
    verifiedEarnedSol = Number((verifiedEarnedLamports / LAMPORTS_PER_SOL).toFixed(9));
  }

  return {
    mode: 'LIVE_L2_ONE_CENT_PACKAGE_FIXED_150_HR' as const,
    rpcEndpoint: params.rpcUrl,
    epoch: epochInfo.epoch,
    slot: epochInfo.absoluteSlot,
    blockTimeUnix,
    packageEntryUsd,
    packageEntryCents: 1,
    packageEntrySol,
    packageEntryLamports,
    packageEntryUsdcUnits: 10000,
    l2FixedHourlyUsdRate,
    l2FixedHourlySolRate,
    ignoresL1NormalStakingRate: true as const,
    l1NormalStakingRatePct: Number((inflation.validator * 100).toFixed(4)),
    solUsdPrice: oracle.price,
    priceSource: oracle.source,
    treasuryPubkey: treasuryPubkeyStr,
    treasurySolBalance,
    treasuryRunwayHours,
    treasurySolventForOneHour: (treasurySolBalance ?? 0) >= l2FixedHourlySolRate,
    packageActivationSig,
    activationSlot,
    slotDelta,
    onChainElapsedMs,
    verifiedEarnedUsd,
    verifiedEarnedSol,
    verifiedEarnedLamports,
    isSimulator: false as const,
  };
}

export async function activateOneCentL2PackageOnChain(params: {
  rpcUrl: string;
  personSigner: Keypair;
  treasuryPubkey?: PublicKey;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const pdas = deriveOneCentL2PackagePdas(params.personSigner.publicKey, params.personSigner.publicKey);
  const recipient = params.treasuryPubkey ?? pdas.l2PackageVault;
  const [epochInfo, oracle, personLamports] = await Promise.all([
    connection.getEpochInfo('confirmed'),
    fetchLiveSolUsdPrice(),
    connection.getBalance(params.personSigner.publicKey, 'confirmed'),
  ]);
  const entryLamports = Math.max(1, Math.round((0.01 / oracle.price) * LAMPORTS_PER_SOL));
  if (personLamports < entryLamports + 10_000) {
    throw new Error(
      `Person wallet (${(personLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL) cannot cover $0.01 package (${(entryLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL) + tx fee.`,
    );
  }
  const memoText = `SOLPOOL_L2_ONE_CENT_PACKAGE:PACKAGE_USD=0.01:FIXED_RATE_USD_HR=${RATE_USD_PER_HOUR.toFixed(2)}:IGNORE_L1_RATE=TRUE:PERSON=${params.personSigner.publicKey.toBase58()}:SLOT=${epochInfo.absoluteSlot}`;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: params.personSigner.publicKey,
      toPubkey: recipient,
      lamports: entryLamports,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: params.personSigner.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from(memoText, 'utf8'),
    }),
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [params.personSigner]);
  return {
    packageActivationSig: signature,
    activationSlot: epochInfo.absoluteSlot,
    entryUsd: '0.01',
    entryLamports,
    vaultRecipient: recipient.toBase58(),
    memoText,
  };
}

export async function claimOneCentL2SolFromTreasury(params: {
  rpcUrl: string;
  treasurySigner: Keypair;
  personPubkey: PublicKey;
  packageActivationSig: string;
}) {
  return claimL2InflationSolFromTreasury({
    rpcUrl: params.rpcUrl,
    treasurySigner: params.treasurySigner,
    personPubkey: params.personPubkey,
    anchorSignature: params.packageActivationSig,
  });
}

export async function mintOneCentL2ReceiptTokenOnChain(params: {
  rpcUrl: string;
  signer: Keypair;
  packageActivationSig: string;
}) {
  return mintL2InflationTokenOnChain({
    rpcUrl: params.rpcUrl,
    signer: params.signer,
    anchorSignature: params.packageActivationSig,
  });
}


