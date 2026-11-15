import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Coins,
  DollarSign,
  Layers,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import type {
  CentMillisecondStreamSnapshot,
  MillisecondChainYieldSnapshot,
  ProtocolConfig,
  SolanaCluster,
  StakeAccountProtectionAudit,
  WalletStakeAccountSummary,
} from '../types';
import {
  type SolanaWalletProvider,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  signAndBroadcastBase64Tx,
} from '../utils/solanaWallet';

interface ProtectionGuardianProps {
  cluster: SolanaCluster;
  customRpcUrl?: string;
  protocols: ProtocolConfig[];
  tokenSymbol: string;
  walletPubkey: string | null;
  walletProvider: SolanaWalletProvider | null;
  onConnectWallet: () => void;
  onInspectPoh?: (address: string) => void;
}

interface OnChainSettlementEntry {
  signature: string;
  kind: 'NATIVE_SOL_CLAIM' | 'SPL_YIELD_SETTLEMENT';
  amountDetail: string;
  anchorSlot: number;
  verifiedOnChainElapsedMs: number;
  timestampIso: string;
}

function formatLamportsAsSol(lamports: bigint, fracDigits = 4): string {
  const safe = lamports < 0n ? 0n : lamports;
  const whole = safe / 1_000_000_000n;
  if (fracDigits <= 0) return whole.toLocaleString('en-US');
  const frac = (safe % 1_000_000_000n).toString().padStart(9, '0').slice(0, fracDigits);
  return `${whole.toLocaleString('en-US')}.${frac}`;
}

export function ProtectionGuardian({
  cluster,
  customRpcUrl,
  protocols,
  tokenSymbol,
  walletPubkey,
  walletProvider,
  onConnectWallet,
  onInspectPoh,
}: ProtectionGuardianProps) {
  // Principal Loss Protection Audit State
  const [stakeAccountInput, setStakeAccountInput] = useState('');
  const [maxCommissionPct, setMaxCommissionPct] = useState(10);
  const [coldWithdrawerInput, setColdWithdrawerInput] = useState('');
  const [audit, setAudit] = useState<StakeAccountProtectionAudit | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [guardTxSig, setGuardTxSig] = useState<string | null>(null);
  const [guardBusy, setGuardBusy] = useState(false);
  const [walletStakes, setWalletStakes] = useState<WalletStakeAccountSummary[]>([]);
  const [walletStakesLoading, setWalletStakesLoading] = useState(false);

  // 100% On-Chain Native PoS $ Rate Per-Hourly Stream State ($150.00 / hour)
  const [posPrincipalInput, setPosPrincipalInput] = useState<string>('100');
  const [posHourlyUsdRate, setPosHourlyUsdRate] = useState<number>(150);
  const [updatingRate, setUpdatingRate] = useState(false);
  const [rateUpdateSig, setRateUpdateSig] = useState<string | null>(null);
  const [posTreasuryInput, setPosTreasuryInput] = useState<string>('');
  const [posAnchorSigInput, setPosAnchorSigInput] = useState<string>('');
  const [anchoringPos, setAnchoringPos] = useState(false);
  const [chainSnapshot, setChainSnapshot] = useState<MillisecondChainYieldSnapshot | null>(null);
  const [chainLoading, setChainLoading] = useState(false);
  const [chainError, setChainError] = useState<string | null>(null);
  const [posClaimBusy, setPosClaimBusy] = useState(false);
  const [onChainLedger, setOnChainLedger] = useState<OnChainSettlementEntry[]>([]);

  // Live On-Chain $150.00/hr Funded Reward Stream State (100% Ledger-Anchored, Zero Off-Chain Timers)
  const [centAsset, setCentAsset] = useState<'usdc' | 'sol'>('usdc');
  const [centTreasuryInput, setCentTreasuryInput] = useState<string>('');
  const [centUsdcMintInput, setCentUsdcMintInput] = useState<string>('');
  const [centAnchorSigInput, setCentAnchorSigInput] = useState<string>('');
  const [anchoringCent, setAnchoringCent] = useState(false);
  const [centSnapshot, setCentSnapshot] = useState<CentMillisecondStreamSnapshot | null>(null);
  const [centLoading, setCentLoading] = useState(false);
  const [centError, setCentError] = useState<string | null>(null);
  const [centClaimBusy, setCentClaimBusy] = useState(false);
  const [centClaimResult, setCentClaimResult] = useState<{
    signature: string;
    asset: 'usdc' | 'sol';
    usdClaimed: string;
    unitDetail: string;
    anchorSlot: number;
    verifiedOnChainElapsedMs: number;
  } | null>(null);

  useEffect(() => {
    if (walletPubkey && !posTreasuryInput) {
      setPosTreasuryInput(walletPubkey);
    }
    if (walletPubkey && !centTreasuryInput) {
      setCentTreasuryInput(walletPubkey);
    }
  }, [walletPubkey, posTreasuryInput, centTreasuryInput]);

  const loadChainSnapshot = useCallback(
    async (silent = false) => {
      if (!silent) setChainLoading(true);
      setChainError(null);
      try {
        const principalNum = Math.max(0, Number(posPrincipalInput) || 0);
        const qs = new URLSearchParams({
          cluster,
          principalSol: String(principalNum),
          hourlyUsdRate: String(posHourlyUsdRate),
        });
        if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
        if (posAnchorSigInput.trim().length > 20) {
          qs.set('anchorSignature', posAnchorSigInput.trim());
        }
        const res = await fetch(`/api/stream/chain-snapshot?${qs.toString()}`);
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.error || 'Failed to fetch on-chain Native PoS snapshot');
        }
        setChainSnapshot(json);
      } catch (err) {
        setChainError(
          err instanceof Error ? err.message : 'On-chain Native PoS snapshot failed',
        );
      } finally {
        if (!silent) setChainLoading(false);
      }
    },
    [cluster, customRpcUrl, posPrincipalInput, posHourlyUsdRate, posAnchorSigInput],
  );

  useEffect(() => {
    loadChainSnapshot();
  }, [loadChainSnapshot]);

  // Poll confirmed Solana slot & blockTime delta when an on-chain anchor signature is active
  useEffect(() => {
    if (posAnchorSigInput.trim().length <= 20) return;
    const timer = setInterval(() => {
      loadChainSnapshot(true);
    }, 2200);
    return () => clearInterval(timer);
  }, [posAnchorSigInput, loadChainSnapshot]);

  const loadCentSnapshot = useCallback(
    async (silent = false) => {
      if (!silent) setCentLoading(true);
      setCentError(null);
      try {
        const qs = new URLSearchParams({ cluster });
        if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
        if (centTreasuryInput.trim().length > 20) {
          qs.set('treasuryPubkey', centTreasuryInput.trim());
        }
        if (centUsdcMintInput.trim().length > 20) {
          qs.set('usdcMint', centUsdcMintInput.trim());
        }
        if (centAnchorSigInput.trim().length > 20) {
          qs.set('anchorSignature', centAnchorSigInput.trim());
        }
        const res = await fetch(`/api/usd-stream/snapshot?${qs.toString()}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to fetch live $150/hr on-chain snapshot');
        setCentSnapshot(json);
      } catch (err) {
        setCentError(err instanceof Error ? err.message : 'On-chain snapshot failed');
      } finally {
        if (!silent) setCentLoading(false);
      }
    },
    [cluster, customRpcUrl, centTreasuryInput, centUsdcMintInput, centAnchorSigInput],
  );

  useEffect(() => {
    loadCentSnapshot();
  }, [loadCentSnapshot]);

  // Poll live Solana blockchain blockTime/slots whenever a confirmed on-chain anchor signature is active
  useEffect(() => {
    if (centAnchorSigInput.trim().length <= 20) return;
    const timer = setInterval(() => {
      loadCentSnapshot(true);
    }, 2200);
    return () => clearInterval(timer);
  }, [centAnchorSigInput, loadCentSnapshot]);

  const handleAnchorOnChain = async (streamType: 'native_pos' | 'hourly_150_usd') => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    const isPos = streamType === 'native_pos';
    if (isPos) {
      setAnchoringPos(true);
      setChainError(null);
    } else {
      setAnchoringCent(true);
      setCentError(null);
    }

    try {
      const principalSol = isPos ? Math.max(0.000000001, Number(posPrincipalInput) || 100) : Math.max(0.000000001, Number(posPrincipalInput) || 100);
      const res = await fetch('/api/stream/anchor-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl,
          walletPubkey,
          principalSol,
          streamType,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to build on-chain anchor tx');
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      if (isPos) {
        setPosAnchorSigInput(sig);
      } else {
        setCentAnchorSigInput(sig);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to broadcast on-chain anchor tx';
      if (isPos) {
        setChainError(msg);
      } else {
        setCentError(msg);
      }
    } finally {
      if (isPos) {
        setAnchoringPos(false);
      } else {
        setAnchoringCent(false);
      }
    }
  };

  const handleUpdateRateOnChain = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    setUpdatingRate(true);
    setChainError(null);
    setRateUpdateSig(null);
    try {
      const res = await fetch('/api/stream/update-rate-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl,
          walletPubkey,
          hourlyUsdRate: posHourlyUsdRate,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to build on-chain $150/hr rate update tx');
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setRateUpdateSig(sig);
      loadChainSnapshot(true);
    } catch (err) {
      setChainError(err instanceof Error ? err.message : 'On-chain rate update failed');
    } finally {
      setUpdatingRate(false);
    }
  };

  const handleClaimNativeSolOnChain = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    const anchorSig = posAnchorSigInput.trim();
    if (anchorSig.length <= 20) {
      setChainError(
        'Anchor your stream on-chain first (click "Anchor On-Chain Clock" or paste a confirmed Solana tx signature). Off-chain timers are disabled.',
      );
      return;
    }
    const treasuryPubkey = (posTreasuryInput || walletPubkey).trim();
    setPosClaimBusy(true);
    setChainError(null);
    try {
      const res = await fetch('/api/stream/claim-native-sol-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl,
          treasuryPubkey,
          stakerPubkey: walletPubkey,
          principalSol: Math.max(0.01, Number(posPrincipalInput) || 100),
          hourlyUsdRate: posHourlyUsdRate,
          anchorSignature: anchorSig,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to build on-chain Native SOL claim tx');
      }
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setOnChainLedger((prev) => [
        {
          signature: sig,
          kind: 'NATIVE_SOL_CLAIM',
          amountDetail: `+${json.solClaimed} SOL (${Number(json.lamportsClaimed).toLocaleString()} lamports)`,
          anchorSlot: json.anchorSlot,
          verifiedOnChainElapsedMs: json.verifiedOnChainElapsedMs,
          timestampIso: new Date().toISOString(),
        },
        ...prev.slice(0, 11),
      ]);
      loadChainSnapshot();
    } catch (err) {
      setChainError(err instanceof Error ? err.message : 'On-chain Native SOL claim failed');
    } finally {
      setPosClaimBusy(false);
    }
  };

  const handleSettleSplYieldOnChain = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    const anchorSig = posAnchorSigInput.trim();
    if (anchorSig.length <= 20) {
      setChainError(
        'Anchor your stream on-chain first (click "Anchor On-Chain Clock" or paste a confirmed Solana tx signature). Off-chain timers are disabled.',
      );
      return;
    }
    setPosClaimBusy(true);
    setChainError(null);
    try {
      const res = await fetch('/api/stream/settle-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl,
          userPubkey: walletPubkey,
          principalSol: Math.max(0.01, Number(posPrincipalInput) || 100),
          hourlyUsdRate: posHourlyUsdRate,
          anchorSignature: anchorSig,
          tokenSymbol,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to build on-chain yield settlement tx');
      }
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setOnChainLedger((prev) => [
        {
          signature: sig,
          kind: 'SPL_YIELD_SETTLEMENT',
          amountDetail: `+${json.mintedTokenAmount} ${tokenSymbol}`,
          anchorSlot: json.anchorSlot,
          verifiedOnChainElapsedMs: json.verifiedOnChainElapsedMs,
          timestampIso: new Date().toISOString(),
        },
        ...prev.slice(0, 11),
      ]);
      loadChainSnapshot();
    } catch (err) {
      setChainError(err instanceof Error ? err.message : 'On-chain yield settlement failed');
    } finally {
      setPosClaimBusy(false);
    }
  };

  const loadWalletStakes = useCallback(async () => {
    if (!walletPubkey) return;
    setWalletStakesLoading(true);
    try {
      const qs = new URLSearchParams({ wallet: walletPubkey, cluster });
      if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
      const res = await fetch(`/api/wallet/stakes?${qs.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setWalletStakes(json.stakes || []);
      }
    } finally {
      setWalletStakesLoading(false);
    }
  }, [walletPubkey, cluster, customRpcUrl]);

  useEffect(() => {
    if (walletPubkey) {
      loadWalletStakes();
    } else {
      setWalletStakes([]);
    }
  }, [walletPubkey, loadWalletStakes]);

  // Verified On-Chain BigInt lamport math for Native PoS ($150.00 / hour per-hourly rate)
  const liveSolPriceForPos = chainSnapshot?.solUsdPrice || centSnapshot?.solUsdPrice || 180;
  const rateUsdScaled = BigInt(Math.max(0, Math.round(posHourlyUsdRate * 100)));
  const priceScaled = BigInt(Math.max(1, Math.round(liveSolPriceForPos * 10000)));
  const posPerSecLamports = (rateUsdScaled * 1_000_000_000n * 100n) / (3_600n * priceScaled);
  const posPerHourLamports = (rateUsdScaled * 1_000_000_000n * 100n) / priceScaled;
  const posElapsedMsLive = chainSnapshot?.onChainElapsedMs ?? 0;
  const posAccruedLamports =
    (BigInt(Math.max(0, posElapsedMsLive)) * rateUsdScaled * 1_000_000_000n * 100n) /
    (3_600_000n * priceScaled);
  const posAccruedUsd = (Math.max(0, posElapsedMsLive) * posHourlyUsdRate) / 3_600_000;

  const centElapsedMsLive = centSnapshot?.onChainElapsedMs ?? 0;

  const handleAuditStakeAccount = async (overrideAddr?: string) => {
    const addr = (overrideAddr ?? stakeAccountInput).trim();
    if (!addr) return;
    setStakeAccountInput(addr);
    setAuditLoading(true);
    setAuditError(null);
    setGuardTxSig(null);
    try {
      const qs = new URLSearchParams({
        stakeAccount: addr,
        cluster,
        maxCommission: String(maxCommissionPct),
      });
      if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
      const res = await fetch(`/api/protection/audit?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Audit failed');
      setAudit(json);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'Unable to audit stake account');
      setAudit(null);
    } finally {
      setAuditLoading(false);
    }
  };

  const handleEmergencyDeactivate = async () => {
    if (!audit) return;
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    setGuardBusy(true);
    setAuditError(null);
    try {
      const res = await fetch('/api/protection/emergency-deactivate-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl,
          stakeAccountPubkey: audit.stakeAccount,
          stakerAuthorityPubkey: walletPubkey,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to build deactivate tx');
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setGuardTxSig(sig);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'Deactivate failed');
    } finally {
      setGuardBusy(false);
    }
  };

  const handleIsolateWithdrawer = async () => {
    if (!audit) return;
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    if (!coldWithdrawerInput.trim()) {
      setAuditError('Enter a separate Cold/Vault Withdrawer public key first.');
      return;
    }
    setGuardBusy(true);
    setAuditError(null);
    try {
      const res = await fetch('/api/protection/isolate-withdrawer-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl,
          stakeAccountPubkey: audit.stakeAccount,
          currentWithdrawerPubkey: walletPubkey,
          newProtectedWithdrawerPubkey: coldWithdrawerInput.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to build authority lock tx');
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setGuardTxSig(sig);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'Authority lock failed');
    } finally {
      setGuardBusy(false);
    }
  };

  const handleClaimCentMsOnChain = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    const anchorSig = centAnchorSigInput.trim();
    if (anchorSig.length <= 20) {
      setCentError(
        'Anchor your stream on-chain first (click "Anchor On-Chain Clock" or paste a confirmed Solana tx signature). Off-chain timers are disabled.',
      );
      return;
    }
    const treasuryPubkey = (centTreasuryInput || walletPubkey).trim();
    setCentClaimBusy(true);
    setCentError(null);
    setCentClaimResult(null);
    try {
      if (centAsset === 'sol') {
        const res = await fetch('/api/usd-stream/claim-sol-tx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cluster,
            rpcUrl: customRpcUrl,
            treasuryPubkey,
            stakerPubkey: walletPubkey,
            anchorSignature: anchorSig,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to build $150/hr SOL claim tx');
        const sig = await signAndBroadcastBase64Tx(
          walletProvider,
          json.serializedBase64,
          cluster,
          customRpcUrl,
        );
        setCentClaimResult({
          signature: sig,
          asset: 'sol',
          usdClaimed: json.usdClaimed,
          unitDetail: `${json.solClaimed} SOL (${json.lamportsClaimed} lamports @ $${json.solUsdPrice}/SOL)`,
          anchorSlot: json.anchorSlot,
          verifiedOnChainElapsedMs: json.verifiedOnChainElapsedMs,
        });
      } else {
        const res = await fetch('/api/usd-stream/claim-usdc-tx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cluster,
            rpcUrl: customRpcUrl,
            treasuryPubkey,
            stakerPubkey: walletPubkey,
            usdcMint: centUsdcMintInput.trim() || undefined,
            anchorSignature: anchorSig,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to build $150/hr USDC claim tx');
        const sig = await signAndBroadcastBase64Tx(
          walletProvider,
          json.serializedBase64,
          cluster,
          customRpcUrl,
        );
        setCentClaimResult({
          signature: sig,
          asset: 'usdc',
          usdClaimed: json.usdClaimed,
          unitDetail: `${json.microUsdcClaimed} micro-USDC`,
          anchorSlot: json.anchorSlot,
          verifiedOnChainElapsedMs: json.verifiedOnChainElapsedMs,
        });
      }
      loadCentSnapshot();
    } catch (err) {
      setCentError(err instanceof Error ? err.message : 'Claim transaction failed');
    } finally {
      setCentClaimBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div className="space-y-1.5 max-w-2xl">
          <p className="text-xs font-medium text-emerald-400">
            Live On-Chain Solana Native PoS ($150.00 / hr) &amp; {cluster} Protection Guard ({tokenSymbol})
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
            $150.00 / Hour On-Chain Solana PoS &amp; Protection Guard
          </h1>
          <p className="text-sm text-slate-400">
            Anchor Solana ledger slots &amp; blockTime directly on-chain for{' '}
            <span className="font-mono text-slate-200">$150.00 / hour</span> Native PoS claims,
            stream funded $150/hr treasury rewards, and audit live {cluster} Stake Accounts against
            delinquency or commission rug-pulls. Zero off-chain timers or simulators.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            loadChainSnapshot();
            loadCentSnapshot();
          }}
          disabled={chainLoading || centLoading}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-600 rounded-md bg-[#0F1623] transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${chainLoading || centLoading ? 'animate-spin' : ''}`} />
          Sync On-Chain Clock
        </button>
      </div>

      {/* 100% On-Chain Solana Native PoS: $150.00 Per-Hourly Rate */}
      <div className="rounded-lg border border-emerald-500/40 bg-[#0F1623] p-6 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
              <Zap className="w-4 h-4 text-emerald-400" />
              <span>Live On-Chain Solana Native PoS — $150.00 / Hour</span>
            </div>
            <p className="text-xs text-slate-400">
              100% ledger-anchored on <span className="font-mono text-slate-200">{cluster}</span>:{' '}
              elapsed milliseconds are verified strictly from confirmed Solana{' '}
              <span className="font-mono text-slate-200">blockTime</span> &amp;{' '}
              <span className="font-mono text-slate-200">slotDelta</span>. Payouts require a real
              signed on-chain transaction and funded treasury solvency.
            </p>
          </div>
          <div className="text-right font-mono text-xs tabular-nums shrink-0">
            <div className="text-emerald-300 font-semibold">
              {chainSnapshot?.anchorSignature
                ? `ANCHORED SLOT ${chainSnapshot.anchorSlot.toLocaleString()}`
                : `CURRENT SLOT ${(chainSnapshot?.currentSlot ?? 0).toLocaleString()}`}
            </div>
            <div className="text-slate-400">
              Verified On-Chain Elapsed:{' '}
              <span className="text-slate-100">
                {posElapsedMsLive.toLocaleString()} ms ({chainSnapshot?.slotDelta ?? 0} slots)
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 space-y-4">
            <div className="p-3.5 rounded-md border border-slate-800 bg-[#090D16] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-slate-300">
                  On-Chain Anchor Transaction ({cluster})
                </label>
                <button
                  type="button"
                  onClick={() => handleAnchorOnChain('native_pos')}
                  disabled={anchoringPos}
                  className="text-[11px] font-medium text-emerald-400 hover:underline whitespace-nowrap shrink-0"
                >
                  {anchoringPos ? 'Anchoring...' : 'Anchor On-Chain Clock'}
                </button>
              </div>
              <input
                type="text"
                value={posAnchorSigInput}
                onChange={(e) => setPosAnchorSigInput(e.target.value)}
                placeholder="Paste confirmed Solana tx signature or click Anchor On-Chain Clock..."
                className="w-full px-3 py-1.5 text-xs font-mono bg-[#0F1623] border border-slate-800 rounded text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Staked Principal (SOL)
              </label>
              <input
                type="number"
                min={0}
                step={10}
                value={posPrincipalInput}
                onChange={(e) => setPosPrincipalInput(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-400"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs gap-2">
                <label className="font-medium text-slate-300">
                  Native PoS $ Rate ($ / Hour)
                </label>
                <button
                  type="button"
                  onClick={() => setPosHourlyUsdRate(150)}
                  className="font-mono text-emerald-300 hover:underline whitespace-nowrap"
                >
                  Reset $150.00/hr
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={0}
                  step={10}
                  value={posHourlyUsdRate}
                  onChange={(e) => setPosHourlyUsdRate(Math.max(0, Number(e.target.value)))}
                  className="flex-1 px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-400"
                />
                <button
                  type="button"
                  onClick={handleUpdateRateOnChain}
                  disabled={updatingRate}
                  className="px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-emerald-300 border border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  {updatingRate ? 'Updating...' : 'Commit On-Chain'}
                </button>
              </div>
              {rateUpdateSig && (
                <a
                  href={getExplorerTxUrl(rateUpdateSig, cluster)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-400 hover:underline"
                >
                  <span>Rate Updated On-Chain: {rateUpdateSig.slice(0, 14)}...</span>
                  <ArrowUpRight className="w-3 h-3" />
                </a>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Funded SOL Yield Treasury Public Key ({cluster})
              </label>
              <input
                type="text"
                value={posTreasuryInput}
                onChange={(e) => setPosTreasuryInput(e.target.value)}
                placeholder="Enter funded SOL treasury pubkey..."
                className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            {chainError && <div className="text-xs font-mono text-red-400">{chainError}</div>}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleClaimNativeSolOnChain}
                disabled={posClaimBusy}
                className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-40 text-slate-950 rounded-md transition-colors"
              >
                <Coins className="w-3.5 h-3.5" />
                {!walletPubkey
                  ? 'Connect Wallet'
                  : posClaimBusy
                    ? 'Settling...'
                    : 'Claim Native SOL On-Chain'}
              </button>
              <button
                type="button"
                onClick={handleSettleSplYieldOnChain}
                disabled={posClaimBusy}
                className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 border border-slate-700 rounded-md transition-colors"
              >
                <Layers className="w-3.5 h-3.5" />
                Settle {tokenSymbol} Yield On-Chain
              </button>
            </div>
          </div>

          <div className="lg:col-span-7 space-y-4">
            <div className="p-5 rounded-lg border border-slate-800 bg-[#090D16] space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                <span>
                  {chainSnapshot?.anchorSignature
                    ? `On-Chain Verified Accrual (Slot ${chainSnapshot.anchorSlot.toLocaleString()} -> ${(chainSnapshot.currentSlot ?? chainSnapshot.anchorSlot).toLocaleString()})`
                    : `Anchor a confirmed transaction on ${cluster} to track live Native PoS accrual`}
                </span>
                <span className="font-mono text-emerald-300">
                  ${posHourlyUsdRate.toFixed(2)} / hr
                </span>
              </div>
              <div className="text-3xl font-mono font-semibold tabular-nums text-emerald-400 break-all">
                +{formatLamportsAsSol(posAccruedLamports, 6)}{' '}
                <span className="text-sm font-normal text-slate-400">
                  SOL (+${posAccruedUsd.toFixed(4)} USD)
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 font-mono tabular-nums">
                <span>Exact Lamports: +{posAccruedLamports.toLocaleString()} lamports</span>
                <span>100% On-Chain Solana Slot &amp; BlockTime Consensus</span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                <div className="text-[11px] text-slate-400">On-Chain Growth / 1 sec</div>
                <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-100 break-all">
                  +{formatLamportsAsSol(posPerSecLamports, 6)} SOL
                </div>
              </div>
              <div className="p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                <div className="text-[11px] text-slate-400">On-Chain Growth / 1 hr</div>
                <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-emerald-400 break-all">
                  +{formatLamportsAsSol(posPerHourLamports, 4)} SOL/hr
                </div>
              </div>
              <div className="p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                <div className="text-[11px] text-slate-400">Hourly USD Rate</div>
                <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-emerald-300">
                  ${posHourlyUsdRate.toFixed(2)}/hr (${(posHourlyUsdRate * 24).toLocaleString()}/day)
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-[#090D16] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-200">
                  Confirmed On-Chain Settlement Ledger
                </span>
                <span className="font-mono text-emerald-300">SOLANA {cluster.toUpperCase()}</span>
              </div>
              {onChainLedger.length === 0 ? (
                <div className="p-4 text-xs text-slate-500 font-mono">
                  No confirmed settlements yet. Anchor your on-chain clock and sign a real claim
                  transaction on {cluster}.
                </div>
              ) : (
                <div className="divide-y divide-slate-800/70 max-h-44 overflow-y-auto text-xs font-mono tabular-nums">
                  {onChainLedger.map((entry) => (
                    <div
                      key={entry.signature}
                      className="px-4 py-2 flex flex-wrap items-center justify-between gap-2"
                    >
                      <span className="text-slate-300">{entry.kind}</span>
                      <span className="text-emerald-400">{entry.amountDetail}</span>
                      <span className="text-slate-500">
                        Slot {entry.anchorSlot.toLocaleString()} ·{' '}
                        {entry.verifiedOnChainElapsedMs.toLocaleString()} ms
                      </span>
                      <a
                        href={getExplorerTxUrl(entry.signature, cluster)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-blue-400 hover:underline"
                      >
                        Explorer <ArrowUpRight className="w-3 h-3" />
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Live On-Chain $150.00 / Hour Funded Reward Stream */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-6 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <DollarSign className="w-4 h-4 text-emerald-400" />
              <span>Live On-Chain $150.00 / Hour Reward Stream</span>
            </div>
            <p className="text-xs text-slate-400">
              Pays real on-chain rewards at <span className="font-mono text-slate-200">$150.00/hr</span>{' '}
              (<span className="font-mono text-slate-200">$0.0417/sec</span> ·{' '}
              <span className="font-mono text-slate-200">$3,600.00/day</span>) strictly from a funded
              on-chain USDC or Native SOL Treasury—never off-chain, simulated, or minted without backing.
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadCentSnapshot()}
            disabled={centLoading}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-600 rounded-md bg-[#090D16] transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${centLoading ? 'animate-spin' : ''}`} />
            Sync Oracle &amp; Ledger
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 space-y-4">
            <div className="p-3.5 rounded-md border border-slate-800 bg-[#090D16] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-slate-300">
                  On-Chain Anchor Transaction ({cluster})
                </label>
                <button
                  type="button"
                  onClick={() => handleAnchorOnChain('hourly_150_usd')}
                  disabled={anchoringCent}
                  className="text-[11px] font-medium text-emerald-400 hover:underline whitespace-nowrap shrink-0"
                >
                  {anchoringCent ? 'Anchoring...' : 'Anchor On-Chain Clock'}
                </button>
              </div>
              <input
                type="text"
                value={centAnchorSigInput}
                onChange={(e) => setCentAnchorSigInput(e.target.value)}
                placeholder="Paste confirmed Solana tx signature or click Anchor On-Chain Clock..."
                className="w-full px-3 py-1.5 text-xs font-mono bg-[#0F1623] border border-slate-800 rounded text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-1 p-1 rounded-md bg-[#090D16] border border-slate-800">
              <button
                type="button"
                onClick={() => setCentAsset('usdc')}
                className={`py-1.5 px-2 text-xs font-medium rounded transition-colors ${
                  centAsset === 'usdc'
                    ? 'bg-emerald-400 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Funded USDC (150M μUSDC/hr)
              </button>
              <button
                type="button"
                onClick={() => setCentAsset('sol')}
                className={`py-1.5 px-2 text-xs font-medium rounded transition-colors ${
                  centAsset === 'sol'
                    ? 'bg-emerald-400 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Funded SOL (Oracle Pegged)
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Funded Reward Treasury Public Key ({cluster})
              </label>
              <input
                type="text"
                value={centTreasuryInput}
                onChange={(e) => setCentTreasuryInput(e.target.value)}
                placeholder="Enter funded sponsor/treasury wallet pubkey..."
                className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            {centAsset === 'usdc' && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  USD SPL Mint Address (optional — defaults to {cluster} USDC)
                </label>
                <input
                  type="text"
                  value={centUsdcMintInput}
                  onChange={(e) => setCentUsdcMintInput(e.target.value)}
                  placeholder={centSnapshot?.usdcMint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'}
                  className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>
            )}

            {centSnapshot && (
              <div className="p-3.5 rounded-md border border-slate-800 bg-[#090D16] space-y-1.5 text-xs font-mono tabular-nums">
                <div className="flex justify-between">
                  <span className="text-slate-400">Live Oracle ({centSnapshot.priceSource})</span>
                  <span className="text-slate-100">${centSnapshot.solUsdPrice.toFixed(2)} / SOL</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">On-Chain SOL Treasury</span>
                  <span className={centSnapshot.treasurySolBalance ? 'text-emerald-400' : 'text-slate-400'}>
                    {centSnapshot.treasurySolBalance !== null
                      ? `${centSnapshot.treasurySolBalance} SOL (${(centSnapshot.treasurySolRunwayHours ?? 0).toFixed(2)} hr runway)`
                      : 'Enter treasury pubkey'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">On-Chain USDC Treasury</span>
                  <span className={centSnapshot.treasuryUsdcBalance ? 'text-emerald-400' : 'text-slate-400'}>
                    {centSnapshot.treasuryUsdcBalance !== null
                      ? `${centSnapshot.treasuryUsdcBalance.toFixed(2)} USDC (${(centSnapshot.treasuryUsdcRunwayHours ?? 0).toFixed(2)} hr runway)`
                      : 'Enter treasury pubkey'}
                  </span>
                </div>
              </div>
            )}

            {centError && <div className="text-xs font-mono text-red-400">{centError}</div>}

            <button
              type="button"
              onClick={handleClaimCentMsOnChain}
              disabled={centClaimBusy}
              className="w-full py-2.5 px-4 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 text-slate-950 rounded-md transition-colors"
            >
              {!walletPubkey
                ? `Connect Wallet to Claim $150/hr on ${cluster}`
                : centClaimBusy
                  ? 'Verifying Anchor, Treasury & Signing On-Chain...'
                  : centAsset === 'usdc'
                    ? `Claim Verified $150/hr in Funded USDC (${cluster})`
                    : `Claim Verified $150/hr in Funded SOL (${cluster})`}
            </button>

            {centClaimResult && (
              <div className="p-3.5 rounded-md border border-emerald-500/40 bg-[#090D16] space-y-1.5 text-xs font-mono">
                <div className="text-emerald-400 font-semibold">
                  $150/hr Settled (Anchor Slot {centClaimResult.anchorSlot.toLocaleString()} · {centClaimResult.verifiedOnChainElapsedMs.toLocaleString()} ms on-chain)
                </div>
                <div className="text-slate-300">
                  Paid: ${Number(centClaimResult.usdClaimed).toLocaleString()} USD ({centClaimResult.unitDetail})
                </div>
                <a
                  href={getExplorerTxUrl(centClaimResult.signature, cluster)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-blue-400 hover:underline"
                >
                  <span>Verify Transaction on Solana Explorer</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </a>
              </div>
            )}
          </div>

          <div className="lg:col-span-7 space-y-4">
            <div className="p-5 rounded-lg border border-slate-800 bg-[#090D16] space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                <span>
                  {centSnapshot?.anchorSignature
                    ? `On-Chain Verified Claim (Slot ${centSnapshot.anchorSlot.toLocaleString()} -> ${(centSnapshot.currentSlot ?? centSnapshot.anchorSlot).toLocaleString()})`
                    : `Anchor a confirmed transaction on ${cluster} to track live $150/hr ledger blockTime`}
                </span>
                <span className="font-mono text-emerald-400">
                  {centSnapshot?.anchorSignature
                    ? `${centElapsedMsLive.toLocaleString()} ms (${centSnapshot.slotDelta ?? 0} slots)`
                    : '0 ms (awaiting anchor tx)'}
                </span>
              </div>
              <div className="text-3xl font-mono font-semibold tabular-nums text-emerald-400 break-all">
                +${((centElapsedMsLive * 150) / 3_600_000).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}{' '}
                <span className="text-sm font-normal text-slate-400">
                  USD (@ $150.00/hr)
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 font-mono tabular-nums">
                <span>
                  {centAsset === 'usdc'
                    ? `Exact Settlement: +${Math.floor((centElapsedMsLive * 150_000_000) / 3_600_000).toLocaleString()} micro-USDC`
                    : centSnapshot
                      ? `Live SOL Equivalent: +${(((centElapsedMsLive * 150) / 3_600_000) / centSnapshot.solUsdPrice).toFixed(6)} SOL`
                      : 'Loading oracle...'}
                </span>
                <span>100% On-Chain BlockTime &amp; Treasury Solvency Enforced</span>
              </div>
            </div>

            {centSnapshot && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                  <div className="text-[11px] text-slate-400">Exact Payout Rate</div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-100">
                    $150.00 / hr ($0.0417/s)
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                    150M μUSDC/hr or {(centSnapshot.lamportsPerHourAtLivePrice / 1e9).toFixed(4)} SOL/hr
                  </div>
                </div>
                <div className="p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                  <div className="text-[11px] text-slate-400">Daily Funded Requirement</div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-100">
                    ${centSnapshot.rateUsdPerDay.toLocaleString()}/day
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                    ~{(centSnapshot.rateUsdPerDay / centSnapshot.solUsdPrice).toFixed(2)} SOL/day
                  </div>
                </div>
                <div className="p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                  <div className="text-[11px] text-slate-400">
                    Native PoS $ Rate (Per-Hourly)
                  </div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-emerald-400">
                    {centSnapshot.nativePosRateLabel}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                    ~{(150 / centSnapshot.solUsdPrice).toFixed(4)} SOL/hr @ ${centSnapshot.solUsdPrice.toFixed(2)}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Live Stake Account 100% Loss Protection Auditor & Emergency Guard */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-slate-100">
              On-Chain Staking Account Principal Protection Guard
            </h2>
            <p className="text-xs text-slate-400">
              Audit any live Solana Stake Account for hot-key withdrawal exposure, validator
              delinquency, or commission spikes, and execute real protection transactions on-chain.
            </p>
          </div>
          {walletPubkey && (
            <button
              type="button"
              onClick={loadWalletStakes}
              disabled={walletStakesLoading}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-600 rounded-md bg-[#090D16] transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${walletStakesLoading ? 'animate-spin' : ''}`} />
              {walletStakesLoading ? 'Scanning Chain...' : 'Refresh Wallet Stakes'}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
          <div className="lg:col-span-7 space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              Solana Stake Account Public Key ({cluster})
            </label>
            <input
              type="text"
              value={stakeAccountInput}
              onChange={(e) => setStakeAccountInput(e.target.value)}
              placeholder="Paste live Solana Stake Account pubkey to audit..."
              className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="lg:col-span-2 space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              Max Validator Fee (%)
            </label>
            <input
              type="number"
              min={0}
              max={100}
              value={maxCommissionPct}
              onChange={(e) => setMaxCommissionPct(Number(e.target.value))}
              className="w-full px-3 py-2 text-xs font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="lg:col-span-3">
            <button
              type="button"
              onClick={() => handleAuditStakeAccount()}
              disabled={auditLoading}
              className="w-full py-2 px-4 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 text-slate-950 rounded-md transition-colors"
            >
              {auditLoading ? 'Auditing On-Chain...' : 'Run Protection Audit'}
            </button>
          </div>
        </div>

        {walletStakes.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>Connected wallet on-chain stakes ({cluster}):</span>
            {walletStakes.slice(0, 5).map((s) => (
              <button
                key={s.pubkey}
                type="button"
                onClick={() => handleAuditStakeAccount(s.pubkey)}
                className="font-mono text-emerald-400 hover:underline"
              >
                {s.pubkey.slice(0, 6)}... ({s.balanceSol} SOL)
              </button>
            ))}
          </div>
        )}

        {protocols.some((p) => p.reserveStakeAddress) && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>Created protocol reserve stakes:</span>
            {protocols
              .filter((p) => p.reserveStakeAddress)
              .slice(0, 3)
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleAuditStakeAccount(p.reserveStakeAddress)}
                  className="font-mono text-emerald-400 hover:underline"
                >
                  {p.tokenSymbol} ({p.reserveStakeAddress?.slice(0, 6)}...)
                </button>
              ))}
          </div>
        )}

        {auditError && (
          <div className="p-3 rounded border border-red-900/60 bg-red-950/30 text-xs font-mono text-red-300">
            {auditError}
          </div>
        )}

        {guardTxSig && (
          <a
            href={getExplorerTxUrl(guardTxSig, cluster)}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between p-3 rounded border border-emerald-500/40 bg-emerald-500/10 text-xs font-mono text-emerald-300"
          >
            <span>Protection Transaction Confirmed: {guardTxSig}</span>
            <ArrowUpRight className="w-4 h-4 shrink-0" />
          </a>
        )}

        {audit && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-2">
            <div className="lg:col-span-7 space-y-4">
              <div className="flex items-center justify-between p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                <div className="flex items-center gap-3">
                  {audit.protectionStatus === 'PROTECTED' ||
                  audit.protectionStatus === 'UNDELEGATED' ? (
                    <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
                  ) : (
                    <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0" />
                  )}
                  <div>
                    <div className="text-xs text-slate-400">Protection Audit Verdict</div>
                    <div className="text-sm font-mono font-semibold text-slate-100">
                      {audit.protectionStatus} · {audit.balanceSol} SOL Principal
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {onInspectPoh && (
                    <button
                      type="button"
                      onClick={() => onInspectPoh(audit.stakeAccount)}
                      className="text-xs font-mono text-emerald-400 hover:underline whitespace-nowrap"
                    >
                      Verify PoH History
                    </button>
                  )}
                  <a
                    href={getExplorerAddressUrl(audit.stakeAccount, cluster)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-mono text-blue-400 hover:underline inline-flex items-center gap-1"
                  >
                    Explorer <ArrowUpRight className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>

              <div className="space-y-1.5 text-xs font-mono p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                <div className="flex justify-between py-1 border-b border-slate-800/60">
                  <span className="text-slate-400">Account State</span>
                  <span className="text-slate-200">{audit.state}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800/60">
                  <span className="text-slate-400">Authority Split Protected</span>
                  <span
                    className={
                      audit.authoritySplitProtected ? 'text-emerald-400' : 'text-amber-400'
                    }
                  >
                    {audit.authoritySplitProtected ? 'Yes (Isolated)' : 'No (Same Key)'}
                  </span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800/60">
                  <span className="text-slate-400">Validator Commission</span>
                  <span className="text-slate-200">
                    {audit.validatorCommission !== null ? `${audit.validatorCommission}%` : 'N/A'}
                  </span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-slate-400">Delegated Vote Account</span>
                  <span className="text-slate-200 truncate max-w-[240px]">
                    {audit.voterPubkey || 'None'}
                  </span>
                </div>
              </div>

              <ul className="space-y-1.5 text-xs text-slate-300">
                {audit.protectionNotes.map((note, i) => (
                  <li key={i} className="leading-relaxed">
                    • {note}
                  </li>
                ))}
              </ul>
            </div>

            <div className="lg:col-span-5 rounded-lg border border-slate-800 bg-[#090D16] p-4 space-y-4">
              <h3 className="text-xs font-semibold text-slate-100">
                Execute On-Chain Protection Controls
              </h3>

              <div className="space-y-2">
                <button
                  type="button"
                  onClick={handleEmergencyDeactivate}
                  disabled={guardBusy || !audit.voterPubkey}
                  className="w-full py-2 px-3 text-xs font-medium bg-amber-500/15 hover:bg-amber-500/25 disabled:opacity-40 text-amber-300 border border-amber-500/30 rounded transition-colors"
                >
                  Emergency Deactivate Stake Account
                </button>
              </div>

              <div className="pt-3 border-t border-slate-800 space-y-2">
                <label className="block text-xs text-slate-400">
                  Isolate Withdrawer Authority to Cold Vault Pubkey
                </label>
                <input
                  type="text"
                  value={coldWithdrawerInput}
                  onChange={(e) => setColdWithdrawerInput(e.target.value)}
                  placeholder="Cold hardware / multisig pubkey..."
                  className="w-full px-3 py-2 text-xs font-mono bg-[#0F1623] border border-slate-800 rounded text-slate-200 focus:outline-none focus:border-emerald-500"
                />
                <button
                  type="button"
                  onClick={handleIsolateWithdrawer}
                  disabled={guardBusy}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 rounded transition-colors"
                >
                  <Lock className="w-3.5 h-3.5" />
                  Lock Withdrawer Authority On-Chain
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
