import { useCallback, useEffect, useState } from 'react';
import {
  Anchor,
  ArrowUpRight,
  Coins,
  Layers,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import type { L2InflationSnapshot, L2OneCentPackageSnapshot, SolanaCluster } from '../types';
import {
  type SolanaWalletProvider,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  signAndBroadcastBase64Tx,
} from '../utils/solanaWallet';

interface L2InflationProtocolProps {
  cluster: SolanaCluster;
  customRpcUrl?: string;
  walletPubkey: string | null;
  walletProvider: SolanaWalletProvider | null;
  onConnectWallet: () => void;
}

interface L2SettlementRecord {
  signature: string;
  kind: 'REAL_SOL_CLAIM' | 'REAL_USDC_CLAIM' | 'L2_SPL_MINT';
  amountDetail: string;
  anchorSlot: number;
  verifiedOnChainElapsedMs: number;
  timestampIso: string;
}

type L2ProtocolMode = 'one-cent-package' | 'pos-inflation';

export function L2InflationProtocol({
  cluster,
  customRpcUrl,
  walletPubkey,
  walletProvider,
  onConnectWallet,
}: L2InflationProtocolProps) {
  const [mode, setMode] = useState<L2ProtocolMode>('one-cent-package');

  // Shared Person / Treasury Inputs
  const [personWalletInput, setPersonWalletInput] = useState<string>('');
  const [treasuryPubkeyInput, setTreasuryPubkeyInput] = useState<string>('');

  // Mode 1: Layer 2.0 $0.01 Cent Package -> Fixed $150/hr (Ignores L1 Staking Rates)
  const [pkgAsset, setPkgAsset] = useState<'sol' | 'usdc'>('sol');
  const [pkgActivationSig, setPkgActivationSig] = useState<string>('');
  const [pkgSnapshot, setPkgSnapshot] = useState<L2OneCentPackageSnapshot | null>(null);
  const [pkgLoading, setPkgLoading] = useState<boolean>(true);
  const [activatingPkg, setActivatingPkg] = useState<boolean>(false);

  // Mode 2: Layer 2.0 PoS Inflation ($150/hr Person Rate)
  const [anchorSigInput, setAnchorSigInput] = useState<string>('');
  const [snapshot, setSnapshot] = useState<L2InflationSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [anchoring, setAnchoring] = useState<boolean>(false);

  // Settlement Action States
  const [error, setError] = useState<string | null>(null);
  const [claimingSol, setClaimingSol] = useState<boolean>(false);
  const [claimingUsdc, setClaimingUsdc] = useState<boolean>(false);
  const [mintingSpl, setMintingSpl] = useState<boolean>(false);
  const [txNotice, setTxNotice] = useState<{
    signature: string;
    message: string;
  } | null>(null);
  const [settlementHistory, setSettlementHistory] = useState<L2SettlementRecord[]>([]);

  useEffect(() => {
    if (walletPubkey && !personWalletInput) {
      setPersonWalletInput(walletPubkey);
    }
    if (walletPubkey && !treasuryPubkeyInput) {
      setTreasuryPubkeyInput(walletPubkey);
    }
  }, [walletPubkey, personWalletInput, treasuryPubkeyInput]);

  const loadPkgSnapshot = useCallback(
    async (silent = false) => {
      if (!silent) setPkgLoading(true);
      try {
        const qs = new URLSearchParams({ cluster });
        if (customRpcUrl?.trim()) qs.set('rpcUrl', customRpcUrl.trim());
        if (personWalletInput.trim().length > 20) {
          qs.set('personWallet', personWalletInput.trim());
        }
        if (treasuryPubkeyInput.trim().length > 20) {
          qs.set('treasuryPubkey', treasuryPubkeyInput.trim());
        }
        if (pkgActivationSig.trim().length > 20) {
          qs.set('packageActivationSig', pkgActivationSig.trim());
        }
        const res = await fetch(`/api/l2-package/snapshot?${qs.toString()}`);
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.error || 'Failed to load Layer 2.0 $0.01 package telemetry');
        }
        setPkgSnapshot(json);
      } catch (err) {
        if (!silent) {
          setError(
            err instanceof Error
              ? err.message
              : 'Unable to reach Solana RPC for L2.0 $0.01 package telemetry',
          );
        }
      } finally {
        if (!silent) setPkgLoading(false);
      }
    },
    [cluster, customRpcUrl, personWalletInput, treasuryPubkeyInput, pkgActivationSig],
  );

  const loadSnapshot = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const qs = new URLSearchParams({ cluster });
        if (customRpcUrl?.trim()) qs.set('rpcUrl', customRpcUrl.trim());
        if (personWalletInput.trim().length > 20) {
          qs.set('personWallet', personWalletInput.trim());
        }
        if (treasuryPubkeyInput.trim().length > 20) {
          qs.set('treasuryPubkey', treasuryPubkeyInput.trim());
        }
        if (anchorSigInput.trim().length > 20) {
          qs.set('anchorSignature', anchorSigInput.trim());
        }
        const res = await fetch(`/api/l2-inflation/snapshot?${qs.toString()}`);
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.error || 'Failed to load Solana L2.0 PoS inflation snapshot');
        }
        setSnapshot(json);
      } catch (err) {
        if (!silent) {
          setError(
            err instanceof Error ? err.message : 'Unable to reach Solana RPC for L2.0 telemetry',
          );
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [cluster, customRpcUrl, personWalletInput, treasuryPubkeyInput, anchorSigInput],
  );

  useEffect(() => {
    if (mode === 'one-cent-package') {
      loadPkgSnapshot();
    } else {
      loadSnapshot();
    }
  }, [mode, loadPkgSnapshot, loadSnapshot]);

  // Poll confirmed on-chain slot & blockTime delta while active on-chain signature exists
  useEffect(() => {
    if (mode === 'one-cent-package' && pkgActivationSig.trim().length > 20) {
      const timer = setInterval(() => {
        loadPkgSnapshot(true);
      }, 2500);
      return () => clearInterval(timer);
    }
    if (mode === 'pos-inflation' && anchorSigInput.trim().length > 20) {
      const timer = setInterval(() => {
        loadSnapshot(true);
      }, 2500);
      return () => clearInterval(timer);
    }
  }, [mode, pkgActivationSig, anchorSigInput, loadPkgSnapshot, loadSnapshot]);

  const handleActivateOneCentPackage = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    setActivatingPkg(true);
    setError(null);
    setTxNotice(null);
    try {
      const res = await fetch('/api/l2-package/activate-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl?.trim() || undefined,
          personPubkey: personWalletInput.trim() || walletPubkey,
          treasuryPubkey: treasuryPubkeyInput.trim() || undefined,
          asset: pkgAsset,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to build $0.01 cent L2.0 activation transaction');
      }
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setPkgActivationSig(sig);
      setTxNotice({
        signature: sig,
        message: `Activated $0.01 (1¢) Layer 2.0 package (${json.asset === 'usdc' ? '0.01 USDC' : `${json.entrySol} SOL`}) at slot ${json.slot.toLocaleString('en-US')}. Fixed $150.00/hr schedule ignores L1 staking rates.`,
      });
      await loadPkgSnapshot(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : '$0.01 cent package activation canceled or failed',
      );
    } finally {
      setActivatingPkg(false);
    }
  };

  const handleClaimPkgSol = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    if (!pkgActivationSig.trim()) {
      setError('Activate your $0.01 cent L2.0 package on-chain first.');
      return;
    }
    const treasury = treasuryPubkeyInput.trim() || walletPubkey;
    const person = personWalletInput.trim() || walletPubkey;
    setClaimingSol(true);
    setError(null);
    setTxNotice(null);
    try {
      const res = await fetch('/api/l2-package/claim-sol-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl?.trim() || undefined,
          treasuryPubkey: treasury,
          personPubkey: person,
          packageActivationSig: pkgActivationSig.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to build real SOL settlement transaction');
      }
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setTxNotice({
        signature: sig,
        message: `Paid $${json.usdClaimed} (${json.solClaimed} SOL at $${json.solUsdPrice}/SOL) on-chain from funded L2 Treasury.`,
      });
      setSettlementHistory((prev) => [
        {
          signature: sig,
          kind: 'REAL_SOL_CLAIM',
          amountDetail: `$${json.usdClaimed} / ${json.solClaimed} SOL`,
          anchorSlot: json.activationSlot,
          verifiedOnChainElapsedMs: json.verifiedOnChainElapsedMs,
          timestampIso: new Date().toISOString(),
        },
        ...prev,
      ]);
      await loadPkgSnapshot(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Real SOL payout failed');
    } finally {
      setClaimingSol(false);
    }
  };

  const handleClaimPkgUsdc = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    if (!pkgActivationSig.trim()) {
      setError('Activate your $0.01 cent L2.0 package on-chain first.');
      return;
    }
    const treasury = treasuryPubkeyInput.trim() || walletPubkey;
    const person = personWalletInput.trim() || walletPubkey;
    setClaimingUsdc(true);
    setError(null);
    setTxNotice(null);
    try {
      const res = await fetch('/api/l2-package/claim-usdc-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl?.trim() || undefined,
          treasuryPubkey: treasury,
          personPubkey: person,
          packageActivationSig: pkgActivationSig.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to build real USDC settlement transaction');
      }
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setTxNotice({
        signature: sig,
        message: `Paid $${json.usdClaimed} USDC on-chain from funded L2 Treasury.`,
      });
      setSettlementHistory((prev) => [
        {
          signature: sig,
          kind: 'REAL_USDC_CLAIM',
          amountDetail: `$${json.usdClaimed} USDC`,
          anchorSlot: json.anchorSlot,
          verifiedOnChainElapsedMs: json.verifiedOnChainElapsedMs,
          timestampIso: new Date().toISOString(),
        },
        ...prev,
      ]);
      await loadPkgSnapshot(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Real USDC payout failed');
    } finally {
      setClaimingUsdc(false);
    }
  };

  const handleMintPkgSpl = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    if (!pkgActivationSig.trim()) {
      setError('Activate your $0.01 cent L2.0 package on-chain first.');
      return;
    }
    const person = personWalletInput.trim() || walletPubkey;
    setMintingSpl(true);
    setError(null);
    setTxNotice(null);
    try {
      const res = await fetch('/api/l2-package/mint-token-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl?.trim() || undefined,
          personPubkey: person,
          packageActivationSig: pkgActivationSig.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to build L2.0 receipt SPL mint transaction');
      }
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setTxNotice({
        signature: sig,
        message: `Minted ${json.mintedTokenAmount} L2.0 package receipt SPL tokens ($${json.usdEquivalent} equiv).`,
      });
      setSettlementHistory((prev) => [
        {
          signature: sig,
          kind: 'L2_SPL_MINT',
          amountDetail: `$${json.usdEquivalent} / ${json.mintedTokenAmount} L2 SPL`,
          anchorSlot: json.anchorSlot,
          verifiedOnChainElapsedMs: json.verifiedOnChainElapsedMs,
          timestampIso: new Date().toISOString(),
        },
        ...prev,
      ]);
      await loadPkgSnapshot(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'L2.0 SPL mint failed');
    } finally {
      setMintingSpl(false);
    }
  };

  // Mode 2 Handlers (PoS Inflation)
  const handleAnchorOnChain = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    setAnchoring(true);
    setError(null);
    setTxNotice(null);
    try {
      const res = await fetch('/api/l2-inflation/anchor-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl?.trim() || undefined,
          personPubkey: personWalletInput.trim() || walletPubkey,
          stakedSol: snapshot?.personDelegatedStakeSol ?? 0,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to build L2.0 on-chain anchor transaction');
      }
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setAnchorSigInput(sig);
      setTxNotice({
        signature: sig,
        message: `L2.0 PoS inflation anchor confirmed at slot ${json.slot.toLocaleString('en-US')}.`,
      });
      await loadSnapshot(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'L2.0 anchor transaction canceled or failed');
    } finally {
      setAnchoring(false);
    }
  };

  const handleClaimInflationSol = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    if (!anchorSigInput.trim()) {
      setError('Confirm an on-chain L2 anchor signature first. Simulator clocks are disabled.');
      return;
    }
    const treasury = treasuryPubkeyInput.trim() || walletPubkey;
    const person = personWalletInput.trim() || walletPubkey;
    setClaimingSol(true);
    setError(null);
    setTxNotice(null);
    try {
      const res = await fetch('/api/l2-inflation/claim-sol-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl?.trim() || undefined,
          treasuryPubkey: treasury,
          personPubkey: person,
          anchorSignature: anchorSigInput.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to build real SOL settlement transaction');
      }
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setTxNotice({
        signature: sig,
        message: `Settled $${json.usdClaimed} (${json.solClaimed} SOL at $${json.solUsdPrice}/SOL) on-chain from funded treasury.`,
      });
      setSettlementHistory((prev) => [
        {
          signature: sig,
          kind: 'REAL_SOL_CLAIM',
          amountDetail: `$${json.usdClaimed} / ${json.solClaimed} SOL`,
          anchorSlot: json.anchorSlot,
          verifiedOnChainElapsedMs: json.verifiedOnChainElapsedMs,
          timestampIso: new Date().toISOString(),
        },
        ...prev,
      ]);
      await loadSnapshot(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Real SOL claim failed');
    } finally {
      setClaimingSol(false);
    }
  };

  const handleMintInflationSpl = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    if (!anchorSigInput.trim()) {
      setError('Confirm an on-chain L2 anchor signature first. Simulator clocks are disabled.');
      return;
    }
    const person = personWalletInput.trim() || walletPubkey;
    setMintingSpl(true);
    setError(null);
    setTxNotice(null);
    try {
      const res = await fetch('/api/l2-inflation/mint-token-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl?.trim() || undefined,
          personPubkey: person,
          anchorSignature: anchorSigInput.trim(),
          stakedSol: snapshot?.personDelegatedStakeSol ?? 0,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to build L2.0 SPL inflation mint transaction');
      }
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setTxNotice({
        signature: sig,
        message: `Minted ${json.mintedTokenAmount} L2 PoS tokens ($${json.usdEquivalent} equivalent).`,
      });
      setSettlementHistory((prev) => [
        {
          signature: sig,
          kind: 'L2_SPL_MINT',
          amountDetail: `$${json.usdEquivalent} / ${json.mintedTokenAmount} L2 SPL`,
          anchorSlot: json.anchorSlot,
          verifiedOnChainElapsedMs: json.verifiedOnChainElapsedMs,
          timestampIso: new Date().toISOString(),
        },
        ...prev,
      ]);
      await loadSnapshot(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'L2.0 SPL mint transaction failed');
    } finally {
      setMintingSpl(false);
    }
  };

  const formatDurationMs = (ms: number) => {
    if (ms <= 0) return '0.0s';
    const totalSec = ms / 1000;
    if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
    const mins = Math.floor(totalSec / 60);
    const remSec = Math.floor(totalSec % 60);
    return `${mins}m ${remSec}s`;
  };

  const activeLoading = mode === 'one-cent-package' ? pkgLoading : loading;

  return (
    <div className="space-y-6">
      {/* Header & Protocol Mode Toggle */}
      <div className="flex flex-col gap-4 border-b border-slate-800 pb-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-50">
              {mode === 'one-cent-package'
                ? 'Layer 2.0 — $0.01 Cent Package -> Fixed $150.00/hr Protocol'
                : 'Solana L2.0 Proof-of-Stake Inflation ($150.00/hr Person Rate)'}
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              {mode === 'one-cent-package'
                ? 'Decoupled from normal L1 staking APY rates. Activate a $0.01 (1¢) on-chain package and settle strictly at $150.00/hr against verified Solana blockTime and real treasury reserves.'
                : 'Live Solana L1 inflation telemetry paired with L2.0 $150.00/hr person rate, on-chain slot anchoring, and funded treasury solvency checks.'}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() =>
                mode === 'one-cent-package' ? loadPkgSnapshot(false) : loadSnapshot(false)
              }
              disabled={activeLoading}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-md border border-slate-800 bg-[#0B101B] hover:bg-slate-800 text-slate-200 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${activeLoading ? 'animate-spin' : ''}`} />
              Sync Live RPC
            </button>
            {!walletPubkey && (
              <button
                type="button"
                onClick={onConnectWallet}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-md bg-emerald-400 hover:bg-emerald-300 text-slate-950 transition-colors whitespace-nowrap shrink-0"
              >
                Connect Wallet
              </button>
            )}
          </div>
        </div>

        <div className="inline-flex p-1 bg-[#0B101B] border border-slate-800 rounded-md w-fit">
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMode('one-cent-package');
            }}
            className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
              mode === 'one-cent-package'
                ? 'bg-slate-800 text-emerald-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            $0.01 Cent Package ($150/hr Fixed)
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMode('pos-inflation');
            }}
            className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
              mode === 'pos-inflation'
                ? 'bg-slate-800 text-emerald-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            L2.0 PoS Inflation
          </button>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="rounded-md border border-rose-800/70 bg-rose-950/30 px-4 py-3 text-xs text-rose-200 flex items-center justify-between gap-4">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-rose-300 hover:text-rose-100 shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {txNotice && (
        <div className="rounded-md border border-emerald-800/70 bg-emerald-950/30 px-4 py-3 text-xs text-emerald-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <span>{txNotice.message}</span>
          <a
            href={getExplorerTxUrl(txNotice.signature, cluster)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-emerald-300 hover:text-emerald-200 shrink-0"
          >
            View Tx <ArrowUpRight className="w-3.5 h-3.5" />
          </a>
        </div>
      )}

      {/* MODE 1: $0.01 CENT PACKAGE -> FIXED $150/HR (IGNORES L1 NORMAL STAKING RATES) */}
      {mode === 'one-cent-package' && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-4">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>L2.0 Package Entry</span>
                <Coins className="w-4 h-4 text-slate-500" />
              </div>
              <div className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-50">
                $0.01 <span className="text-sm font-normal text-slate-400">(1¢)</span>
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums text-slate-400">
                {pkgSnapshot
                  ? `${pkgSnapshot.packageEntrySol.toFixed(6)} SOL or 0.01 USDC`
                  : 'Loading live conversion'}
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-4">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Fixed L2.0 Earning Rate</span>
                <TrendingUp className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="mt-2 text-2xl font-semibold font-mono tabular-nums text-emerald-400">
                $150.00 <span className="text-sm font-normal text-slate-400">/ hr</span>
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums text-slate-400">
                {pkgSnapshot
                  ? `${pkgSnapshot.l2FixedHourlySolRate.toFixed(6)} SOL/hr @ $${pkgSnapshot.solUsdPrice.toFixed(2)}`
                  : '$0.041667 / sec fixed'}
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-4">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Normal L1 Staking APY</span>
                <Layers className="w-4 h-4 text-slate-500" />
              </div>
              <div className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-100">
                IGNORED
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums text-slate-400">
                {pkgSnapshot
                  ? `L1 ${pkgSnapshot.l1NormalStakingRatePct.toFixed(3)}% bypassed by L2.0`
                  : 'Decoupled from L1 rate'}
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-4">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>L2 Vault Solvency</span>
                <ShieldCheck className="w-4 h-4 text-slate-500" />
              </div>
              <div className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-50">
                {pkgSnapshot?.treasurySolBalance !== null &&
                pkgSnapshot?.treasurySolBalance !== undefined
                  ? `${pkgSnapshot.treasurySolBalance.toFixed(4)} SOL`
                  : 'No Vault'}
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums text-slate-400">
                {pkgSnapshot?.treasuryRunwayHours !== null &&
                pkgSnapshot?.treasuryRunwayHours !== undefined
                  ? `USDC ${(pkgSnapshot.treasuryUsdcBalance ?? 0).toFixed(2)} · Runway ${pkgSnapshot.treasuryRunwayHours.toFixed(2)} hr`
                  : 'Enter funded vault pubkey'}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5 space-y-4">
              <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-100">
                    $0.01 Cent Package On-Chain Execution
                  </h2>
                  <span className="text-[11px] font-mono text-emerald-400">
                    L1-RATE INDEPENDENT
                  </span>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Package Entry Payment Asset ($0.01)
                    </label>
                    <div className="grid grid-cols-2 gap-1 p-1 bg-[#090D16] border border-slate-800 rounded-md">
                      <button
                        type="button"
                        onClick={() => setPkgAsset('sol')}
                        className={`py-1.5 text-xs font-medium rounded transition-colors ${
                          pkgAsset === 'sol'
                            ? 'bg-slate-800 text-emerald-400'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Native SOL ($0.01)
                      </button>
                      <button
                        type="button"
                        onClick={() => setPkgAsset('usdc')}
                        className={`py-1.5 text-xs font-medium rounded transition-colors ${
                          pkgAsset === 'usdc'
                            ? 'bg-slate-800 text-emerald-400'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        USDC ($0.01)
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Person Wallet Pubkey
                    </label>
                    <input
                      type="text"
                      value={personWalletInput}
                      onChange={(e) => setPersonWalletInput(e.target.value)}
                      placeholder="Person Solana wallet public key"
                      className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Funded L2 Treasury / Vault Pubkey
                    </label>
                    <input
                      type="text"
                      value={treasuryPubkeyInput}
                      onChange={(e) => setTreasuryPubkeyInput(e.target.value)}
                      placeholder="Funded SOL / USDC vault paying $150/hr claims"
                      className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Confirmed $0.01 Package Activation Signature
                    </label>
                    <input
                      type="text"
                      value={pkgActivationSig}
                      onChange={(e) => setPkgActivationSig(e.target.value)}
                      placeholder="Activate below or paste confirmed tx signature"
                      className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                </div>

                <div className="pt-2 space-y-2.5">
                  <button
                    type="button"
                    onClick={handleActivateOneCentPackage}
                    disabled={activatingPkg}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium rounded-md bg-emerald-400 hover:bg-emerald-300 text-slate-950 transition-colors disabled:opacity-50"
                  >
                    <Anchor className="w-3.5 h-3.5" />
                    {activatingPkg
                      ? 'Confirming $0.01 L2.0 Package on Solana...'
                      : walletPubkey
                        ? `1. Activate $0.01 (1¢) L2.0 Package (${pkgAsset.toUpperCase()})`
                        : 'Connect Wallet to Activate $0.01 Package'}
                  </button>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={handleClaimPkgSol}
                      disabled={claimingSol || !pkgActivationSig.trim()}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-100 transition-colors disabled:opacity-40"
                    >
                      <Coins className="w-3.5 h-3.5 text-emerald-400" />
                      {claimingSol ? 'Settling SOL...' : '2. Claim Real SOL'}
                    </button>

                    <button
                      type="button"
                      onClick={handleClaimPkgUsdc}
                      disabled={claimingUsdc || !pkgActivationSig.trim()}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-100 transition-colors disabled:opacity-40"
                    >
                      <Coins className="w-3.5 h-3.5 text-emerald-400" />
                      {claimingUsdc ? 'Settling USDC...' : '3. Claim Real USDC'}
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={handleMintPkgSpl}
                    disabled={mintingSpl || !pkgActivationSig.trim()}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium rounded-md border border-slate-800 bg-[#090D16] hover:bg-slate-800/70 text-slate-200 transition-colors disabled:opacity-40"
                  >
                    <TrendingUp className="w-3.5 h-3.5 text-slate-400" />
                    {mintingSpl
                      ? 'Minting L2 Receipt SPL...'
                      : '4. Mint L2.0 Fixed-Rate Receipt Token (SPL)'}
                  </button>
                </div>
              </div>

              {pkgSnapshot?.l2PackageVaultPda && (
                <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-4 space-y-2 text-xs">
                  <div className="font-medium text-slate-200">Anchor L2.0 $0.01 Package PDAs</div>
                  <div className="space-y-1.5 font-mono text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-400">L2 $0.01 Vault PDA</span>
                      <a
                        href={getExplorerAddressUrl(pkgSnapshot.l2PackageVaultPda, cluster)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-slate-200 hover:text-emerald-400 truncate max-w-[210px]"
                      >
                        {pkgSnapshot.l2PackageVaultPda}
                      </a>
                    </div>
                    {pkgSnapshot.l2PersonPackagePda && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-400">Person Package PDA</span>
                        <a
                          href={getExplorerAddressUrl(pkgSnapshot.l2PersonPackagePda, cluster)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-slate-200 hover:text-emerald-400 truncate max-w-[210px]"
                        >
                          {pkgSnapshot.l2PersonPackagePda}
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="lg:col-span-7 space-y-4">
              <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-5">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-100">
                      Verified On-Chain $0.01 Package Accrual ($150.00/hr Fixed)
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Calculated strictly from confirmed Solana package activation blockTime & slot delta. Zero client-side simulation.
                    </p>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-slate-400">
                    Slot {pkgSnapshot ? pkgSnapshot.slot.toLocaleString('en-US') : '—'}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4">
                  <div>
                    <div className="text-xs text-slate-400">On-Chain Elapsed</div>
                    <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-100">
                      {pkgSnapshot ? formatDurationMs(pkgSnapshot.onChainElapsedMs) : '0.0s'}
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-slate-500">
                      {pkgSnapshot?.activationSlot
                        ? `${pkgSnapshot.activationSlot.toLocaleString('en-US')} → ${pkgSnapshot.slot.toLocaleString('en-US')} (+${pkgSnapshot.slotDelta})`
                        : 'Activate $0.01 package first'}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-slate-400">Verified Accrued USD</div>
                    <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-emerald-400">
                      ${pkgSnapshot ? pkgSnapshot.verifiedEarnedUsd.toFixed(6) : '0.000000'}
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-slate-500">
                      Fixed $150.00 / hr ($0.041667 / sec)
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-slate-400">Verified Accrued SOL</div>
                    <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-100">
                      {pkgSnapshot ? pkgSnapshot.verifiedEarnedSol.toFixed(9) : '0.000000000'} SOL
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-slate-500">
                      {pkgSnapshot
                        ? `${pkgSnapshot.verifiedEarnedLamports.toLocaleString('en-US')} lamports`
                        : '0 lamports'}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-5">
                <h2 className="text-sm font-semibold text-slate-100 mb-3">
                  Layer 2.0 $0.01 Cent Package Specification & Reserve Honesty
                </h2>
                <div className="divide-y divide-slate-800/80 text-xs">
                  <div className="py-2.5 flex items-center justify-between gap-4">
                    <span className="text-slate-400">Required Package Entry Deposit</span>
                    <span className="font-mono tabular-nums text-slate-100">
                      {pkgSnapshot
                        ? `$0.01 USD (${pkgSnapshot.packageEntryLamports.toLocaleString('en-US')} lamports / 10,000 µUSDC)`
                        : '$0.01 USD'}
                    </span>
                  </div>
                  <div className="py-2.5 flex items-center justify-between gap-4">
                    <span className="text-slate-400">Layer 2.0 Fixed Person Earning Schedule</span>
                    <span className="font-mono tabular-nums text-emerald-400">
                      $150.00 / hr ($3,600.00 / day)
                    </span>
                  </div>
                  <div className="py-2.5 flex items-center justify-between gap-4">
                    <span className="text-slate-400">Solana L1 Normal Staking Inflation APY</span>
                    <span className="font-mono tabular-nums text-slate-300">
                      {pkgSnapshot
                        ? `${pkgSnapshot.l1NormalStakingRatePct.toFixed(4)}% (Not Used by L2.0 Formula)`
                        : 'Ignored'}
                    </span>
                  </div>
                  <div className="py-2.5 flex items-center justify-between gap-4">
                    <span className="text-slate-400">Funded Treasury Solvency Requirement</span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {pkgSnapshot
                        ? `${pkgSnapshot.l2FixedHourlySolRate.toFixed(6)} SOL/hr or 150.00 USDC/hr in vault`
                        : 'Real SOL/USDC required for payouts'}
                    </span>
                  </div>
                  <div className="py-2.5 flex items-center justify-between gap-4">
                    <span className="text-slate-400">Live Oracle SOL-USD Reference</span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {pkgSnapshot
                        ? `$${pkgSnapshot.solUsdPrice.toFixed(2)} (${pkgSnapshot.priceSource})`
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* MODE 2: L2.0 PROOF-OF-STAKE INFLATION */}
      {mode === 'pos-inflation' && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-4">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>L1 Solana Inflation</span>
                <TrendingUp className="w-4 h-4 text-slate-500" />
              </div>
              <div className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-50">
                {snapshot ? `${snapshot.l1InflationTotalPct.toFixed(3)}%` : '—'}
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums text-slate-400">
                {snapshot
                  ? `Validator ${snapshot.l1InflationValidatorPct.toFixed(3)}% · Epoch ${snapshot.epoch}`
                  : 'Loading getInflationRate()'}
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-4">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>L2.0 Person Earning Rate</span>
                <Coins className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="mt-2 text-2xl font-semibold font-mono tabular-nums text-emerald-400">
                ${snapshot ? snapshot.l2PersonRateUsdPerHour.toFixed(2) : '150.00'}
                <span className="text-sm font-normal text-slate-400"> / hr</span>
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums text-slate-400">
                {snapshot
                  ? `${snapshot.l2PersonRateSolPerHour.toFixed(6)} SOL/hr @ $${snapshot.solUsdPrice.toFixed(2)}`
                  : 'Live oracle rate'}
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-4">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Person Delegated Stake</span>
                <Layers className="w-4 h-4 text-slate-500" />
              </div>
              <div className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-50">
                {snapshot
                  ? `${snapshot.personDelegatedStakeSol.toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`
                  : '0 SOL'}
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums text-slate-400">
                {snapshot
                  ? `L1 $${snapshot.personL1HourlyUsd.toFixed(4)}/hr + L2 Top-Up $${snapshot.personL2TopUpHourlyUsd.toFixed(2)}/hr`
                  : 'Enter wallet to inspect'}
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-4">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>L2 Treasury Solvency</span>
                <ShieldCheck className="w-4 h-4 text-slate-500" />
              </div>
              <div className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-50">
                {snapshot?.treasurySolBalance !== null && snapshot?.treasurySolBalance !== undefined
                  ? `${snapshot.treasurySolBalance.toFixed(4)} SOL`
                  : 'No Treasury'}
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums text-slate-400">
                {snapshot?.treasuryRunwayHours !== null &&
                snapshot?.treasuryRunwayHours !== undefined
                  ? `Runway ${snapshot.treasuryRunwayHours.toFixed(2)} hr`
                  : 'Set funded treasury address'}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5 space-y-4">
              <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-100">
                    On-Chain L2.0 Settlement Controls
                  </h2>
                  <span className="text-[11px] font-mono text-emerald-400">LIVE SOLANA RPC</span>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Person Wallet Pubkey
                    </label>
                    <input
                      type="text"
                      value={personWalletInput}
                      onChange={(e) => setPersonWalletInput(e.target.value)}
                      placeholder="Solana wallet public key"
                      className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Funded L2 SOL Treasury Pubkey
                    </label>
                    <input
                      type="text"
                      value={treasuryPubkeyInput}
                      onChange={(e) => setTreasuryPubkeyInput(e.target.value)}
                      placeholder="Solana wallet funding $150/hr payouts"
                      className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Confirmed L2 Anchor Transaction Signature
                    </label>
                    <input
                      type="text"
                      value={anchorSigInput}
                      onChange={(e) => setAnchorSigInput(e.target.value)}
                      placeholder="Anchor below or paste confirmed L2 signature"
                      className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                </div>

                <div className="pt-2 space-y-2.5">
                  <button
                    type="button"
                    onClick={handleAnchorOnChain}
                    disabled={anchoring}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium rounded-md bg-emerald-400 hover:bg-emerald-300 text-slate-950 transition-colors disabled:opacity-50"
                  >
                    <Anchor className="w-3.5 h-3.5" />
                    {anchoring
                      ? 'Signing L2.0 Anchor on Solana...'
                      : walletPubkey
                        ? '1. Anchor L2.0 PoS State on Solana L1'
                        : 'Connect Wallet to Anchor L2.0 State'}
                  </button>

                  <button
                    type="button"
                    onClick={handleClaimInflationSol}
                    disabled={claimingSol || !anchorSigInput.trim()}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium rounded-md border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-100 transition-colors disabled:opacity-40"
                  >
                    <Coins className="w-3.5 h-3.5 text-emerald-400" />
                    {claimingSol
                      ? 'Settling Real SOL Transfer...'
                      : '2. Claim Verified $150/hr in Real SOL'}
                  </button>

                  <button
                    type="button"
                    onClick={handleMintInflationSpl}
                    disabled={mintingSpl || !anchorSigInput.trim()}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium rounded-md border border-slate-800 bg-[#090D16] hover:bg-slate-800/70 text-slate-200 transition-colors disabled:opacity-40"
                  >
                    <TrendingUp className="w-3.5 h-3.5 text-slate-400" />
                    {mintingSpl
                      ? 'Minting L2 SPL Receipt Token...'
                      : '3. Mint L2.0 Inflation Receipt Token (SPL)'}
                  </button>
                </div>
              </div>

              {snapshot?.l2StatePda && (
                <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-4 space-y-2 text-xs">
                  <div className="font-medium text-slate-200">Anchor Program PDAs</div>
                  <div className="space-y-1.5 font-mono text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-400">L2 Inflation State</span>
                      <a
                        href={getExplorerAddressUrl(snapshot.l2StatePda, cluster)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-slate-200 hover:text-emerald-400 truncate max-w-[210px]"
                      >
                        {snapshot.l2StatePda}
                      </a>
                    </div>
                    {snapshot.l2TreasuryPda && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-400">L2 SOL Treasury PDA</span>
                        <a
                          href={getExplorerAddressUrl(snapshot.l2TreasuryPda, cluster)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-slate-200 hover:text-emerald-400 truncate max-w-[210px]"
                        >
                          {snapshot.l2TreasuryPda}
                        </a>
                      </div>
                    )}
                    {snapshot.l2PersonPda && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-400">Person Position PDA</span>
                        <a
                          href={getExplorerAddressUrl(snapshot.l2PersonPda, cluster)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-slate-200 hover:text-emerald-400 truncate max-w-[210px]"
                        >
                          {snapshot.l2PersonPda}
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="lg:col-span-7 space-y-4">
              <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-5">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-100">
                      Verified On-Chain Slot & BlockTime Accrual
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Computed exclusively from confirmed Solana anchor slot vs current slot. Zero client-side simulation.
                    </p>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-slate-400">
                    Slot {snapshot ? snapshot.slot.toLocaleString('en-US') : '—'}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4">
                  <div>
                    <div className="text-xs text-slate-400">On-Chain Elapsed</div>
                    <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-100">
                      {snapshot ? formatDurationMs(snapshot.onChainElapsedMs) : '0.0s'}
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-slate-500">
                      {snapshot?.anchorSlot
                        ? `${snapshot.anchorSlot.toLocaleString('en-US')} → ${snapshot.slot.toLocaleString('en-US')} (+${snapshot.slotDelta})`
                        : 'Not anchored yet'}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-slate-400">Verified Accrued USD</div>
                    <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-emerald-400">
                      ${snapshot ? snapshot.verifiedAccruedUsd.toFixed(6) : '0.000000'}
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-slate-500">
                      $150.00 / 3,600,000 ms
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-slate-400">Verified Accrued SOL</div>
                    <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-100">
                      {snapshot ? snapshot.verifiedAccruedSol.toFixed(9) : '0.000000000'} SOL
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-slate-500">
                      {snapshot
                        ? `${snapshot.verifiedAccruedLamports.toLocaleString('en-US')} lamports`
                        : '0 lamports'}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-5">
                <h2 className="text-sm font-semibold text-slate-100 mb-3">
                  Solana L1 Inflation vs L2.0 $150/hr Person Rate Transparency
                </h2>
                <div className="divide-y divide-slate-800/80 text-xs">
                  <div className="py-2.5 flex items-center justify-between gap-4">
                    <span className="text-slate-400">Live Solana L1 Validator Inflation Rate</span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {snapshot ? `${snapshot.l1InflationValidatorPct.toFixed(3)}% APY` : '—'}
                    </span>
                  </div>
                  <div className="py-2.5 flex items-center justify-between gap-4">
                    <span className="text-slate-400">
                      Principal Needed for $150/hr from Pure L1 Staking
                    </span>
                    <span className="font-mono tabular-nums text-slate-100">
                      {snapshot
                        ? `${snapshot.requiredL1PrincipalFor150HrSol.toLocaleString('en-US')} SOL ($${snapshot.requiredL1PrincipalFor150HrUsd.toLocaleString('en-US')})`
                        : '—'}
                    </span>
                  </div>
                  <div className="py-2.5 flex items-center justify-between gap-4">
                    <span className="text-slate-400">Your Delegated Stake L1 Yield / hr</span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {snapshot
                        ? `${snapshot.personL1HourlySol.toFixed(9)} SOL ($${snapshot.personL1HourlyUsd.toFixed(6)}/hr)`
                        : '—'}
                    </span>
                  </div>
                  <div className="py-2.5 flex items-center justify-between gap-4">
                    <span className="text-slate-400">
                      L2.0 Treasury Subsidy Needed for $150/hr
                    </span>
                    <span className="font-mono tabular-nums text-emerald-400">
                      {snapshot
                        ? `$${snapshot.personL2TopUpHourlyUsd.toFixed(4)}/hr (${snapshot.personL2TopUpHourlySol.toFixed(6)} SOL/hr)`
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Confirmed Settlement History */}
      {settlementHistory.length > 0 && (
        <div className="rounded-lg border border-slate-800 bg-[#0B101B] p-5">
          <h2 className="text-sm font-semibold text-slate-100 mb-3">
            Confirmed On-Chain L2.0 Settlements
          </h2>
          <div className="divide-y divide-slate-800/80 text-xs">
            {settlementHistory.map((item) => (
              <div key={item.signature} className="py-2.5 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-medium text-slate-200">
                    {item.kind === 'REAL_SOL_CLAIM'
                      ? 'Real SOL Payout'
                      : item.kind === 'REAL_USDC_CLAIM'
                        ? 'Real USDC Payout'
                        : 'L2 SPL Mint'}{' '}
                    · {item.amountDetail}
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 truncate">
                    Slot {item.anchorSlot} · {formatDurationMs(item.verifiedOnChainElapsedMs)}{' '}
                    verified
                  </div>
                </div>
                <a
                  href={getExplorerTxUrl(item.signature, cluster)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-emerald-400 hover:text-emerald-300 shrink-0"
                >
                  {item.signature.slice(0, 8)}... <ArrowUpRight className="w-3 h-3" />
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
