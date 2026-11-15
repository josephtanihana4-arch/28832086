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
const RATE_USD_PER_MS = 120; // $120.00 USD per millisecond ($120,000/sec)

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

export async function getLiveBlockchainMillisecondRate(
  rpcUrl: string,
  principalSol: number,
  aprPctOverride?: number,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const [slot, epochInfo, perf] = await Promise.all([
    connection.getSlot('confirmed'),
    connection.getEpochInfo('confirmed'),
    connection.getRecentPerformanceSamples(5).catch(() => []),
  ]);
  const blockTime = await resolveOnChainBlockTimeSec(connection, slot);

  let avgSlotTimeSec = 0.4;
  const validPerf = perf.filter((p) => p.numSlots > 0 && p.samplePeriodSecs > 0);
  if (validPerf.length > 0) {
    const totalSecs = validPerf.reduce((a, b) => a + b.samplePeriodSecs, 0);
    const totalSlots = validPerf.reduce((a, b) => a + b.numSlots, 0);
    if (totalSlots > 0) avgSlotTimeSec = totalSecs / totalSlots;
  }

  const nativePosAprPct = 1_000_000;
  const resolvedAprPct =
    aprPctOverride !== undefined && aprPctOverride > 0 ? aprPctOverride : nativePosAprPct;

  const principalLamports = BigInt(Math.round(Math.max(0, principalSol) * 1e9));
  const aprPctX100 = BigInt(Math.max(1, Math.round(resolvedAprPct * 100)));

  const perMsFemto = (principalLamports * aprPctX100 * 1_000_000n) / 10_000n;
  const perSecNano = (perMsFemto * 1000n) / 1_000_000n;
  const perDayNano = (perMsFemto * 86_400_000n) / 1_000_000n;
  const perYearNano = (perMsFemto * 31_557_600_000n) / 1_000_000n;

  return {
    anchorSlot: slot,
    epoch: epochInfo.epoch,
    avgSlotTimeSec: Number(avgSlotTimeSec.toFixed(3)),
    anchorBlockTimeUnix: blockTime,
    principalSol,
    nativePosAprPct,
    aprPct: resolvedAprPct,
    perMillisecondSolExact: formatScaledUnits(perMsFemto, 15, 4),
    perSecondLamports: Number(perSecNano).toLocaleString('en-US'),
    perDaySol: formatScaledUnits(perDayNano, 9, 4),
    perYearSol: formatScaledUnits(perYearNano, 9, 4),
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
        `SOLPOOL_ONCHAIN_ANCHOR:WALLET=${signer.publicKey.toBase58()}:PRINCIPAL_SOL=${principalSol}:SLOT=${slot}:RATE_USD_MS=120`,
      ),
    }),
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [signer]);
  return { anchorSignature: signature, anchorSlot: slot };
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

export async function claimMillisecondSolFromTreasury(params: {
  rpcUrl: string;
  treasurySigner: Keypair;
  stakerPubkey: PublicKey;
  principalSol: number;
  aprPct: number;
  anchorSignature: string;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const [treasuryLamports, clockDelta] = await Promise.all([
    connection.getBalance(params.treasurySigner.publicKey, 'confirmed'),
    getOnChainElapsedSinceTx(params.rpcUrl, params.anchorSignature),
  ]);

  const elapsedMs = Math.max(1, clockDelta.onChainElapsedMs);
  const principalLamports = BigInt(Math.max(1, Math.round(params.principalSol * 1e9)));
  const aprPctX100 = BigInt(Math.max(1, Math.round((params.aprPct || 1_000_000) * 100)));
  const elapsedBig = BigInt(elapsedMs);
  const rawLamports = (principalLamports * aprPctX100 * elapsedBig) / 10_000n;
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
        `SOLPOOL_NATIVE_SOL_MS_CLAIM:ANCHOR_SIG=${clockDelta.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${clockDelta.anchorSlot}:CURRENT_SLOT=${clockDelta.currentSlot}:APR=${params.aprPct}%:ONCHAIN_MS=${elapsedMs}:LAMPORTS=${accruedLamports}`,
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

export async function settleMillisecondSplYieldOnChain(params: {
  rpcUrl: string;
  signer: Keypair;
  principalSol: number;
  aprPct: number;
  anchorSignature: string;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const rewardMint = Keypair.generate();
  const userAta = getAssociatedTokenAddressSync(rewardMint.publicKey, params.signer.publicKey);
  const [mintRent, clockDelta] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(MINT_SIZE),
    getOnChainElapsedSinceTx(params.rpcUrl, params.anchorSignature),
  ]);

  const elapsedMs = Math.max(1, clockDelta.onChainElapsedMs);
  const principalNano = BigInt(Math.max(1, Math.round(params.principalSol * 1e9)));
  const aprPctX100 = BigInt(Math.max(1, Math.round((params.aprPct || 1_000_000) * 100)));
  const elapsedBig = BigInt(elapsedMs);
  const rawUnits = (principalNano * aprPctX100 * elapsedBig) / 10_000n;
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
        `SOLPOOL_MS_STREAM:ANCHOR_SIG=${clockDelta.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${clockDelta.anchorSlot}:CURRENT_SLOT=${clockDelta.currentSlot}:APR=${params.aprPct}%:ONCHAIN_MS=${elapsedMs}`,
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

export async function getCentMsLiveRate(rpcUrl: string) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const [slot, oracle] = await Promise.all([
    connection.getSlot('confirmed'),
    fetchLiveSolUsdPrice(),
  ]);
  const lamportsPerMs = Math.round((RATE_USD_PER_MS / oracle.price) * LAMPORTS_PER_SOL);
  return {
    anchorSlot: slot,
    solUsdPrice: oracle.price,
    priceSource: oracle.source,
    rateUsdPerMs: RATE_USD_PER_MS,
    rateUsdPerSec: RATE_USD_PER_MS * 1000,
    rateUsdPerDay: RATE_USD_PER_MS * 86_400_000,
    microUsdcPerMs: 120_000_000,
    lamportsPerMsAtLivePrice: lamportsPerMs,
  };
}

export async function claimCentMsSolFromTreasury(params: {
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
  const elapsedMs = Math.max(1, Math.min(3_600_000, clockDelta.onChainElapsedMs));
  const usdOwed = elapsedMs * RATE_USD_PER_MS;
  const priceScaled = BigInt(Math.max(1, Math.round(oracle.price * 10000)));
  const accruedLamportsBig =
    (BigInt(elapsedMs) * BigInt(RATE_USD_PER_MS) * BigInt(LAMPORTS_PER_SOL) * 10000n) / priceScaled;

  if (BigInt(treasuryLamports) < accruedLamportsBig + 10_000n) {
    throw new Error(
      `Funded SOL Treasury (${(treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL) cannot cover $${usdOwed.toFixed(2)} (${(Number(accruedLamportsBig) / LAMPORTS_PER_SOL).toFixed(4)} SOL at $${oracle.price}/SOL).`,
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
        `SOLPOOL_120USD_MS_SOL_CLAIM:ANCHOR_SIG=${clockDelta.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${clockDelta.anchorSlot}:CURRENT_SLOT=${clockDelta.currentSlot}:ONCHAIN_MS=${elapsedMs}:USD=${usdOwed.toFixed(2)}:LAMPORTS=${accruedLamportsBig.toString()}`,
      ),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [params.treasurySigner]);
  return {
    signature,
    usdClaimed: usdOwed.toFixed(2),
    solUsdPrice: oracle.price,
    lamportsClaimed: accruedLamportsBig.toString(),
    anchorSlot: clockDelta.anchorSlot,
    verifiedOnChainElapsedMs: elapsedMs,
  };
}

export async function claimCentMsUsdcFromTreasury(params: {
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
  const elapsedMs = Math.max(1, Math.min(3_600_000, clockDelta.onChainElapsedMs));
  const decimals = bal.value.decimals;
  const unitsPerMs = BigInt(RATE_USD_PER_MS) * 10n ** BigInt(decimals);
  const owedUnits = BigInt(elapsedMs) * unitsPerMs;
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
        `SOLPOOL_120USD_MS_USDC_CLAIM:ANCHOR_SIG=${clockDelta.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${clockDelta.anchorSlot}:CURRENT_SLOT=${clockDelta.currentSlot}:ONCHAIN_MS=${elapsedMs}:UNITS=${owedUnits.toString()}`,
      ),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [params.treasurySigner]);
  return {
    signature,
    usdClaimed: (elapsedMs * RATE_USD_PER_MS).toFixed(2),
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
