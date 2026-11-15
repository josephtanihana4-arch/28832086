import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Cpu,
  DollarSign,
  RefreshCw,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import type { CentMillisecondStreamSnapshot, SolanaCluster } from '../types';
import {
  type SolanaWalletProvider,
  getExplorerTxUrl,
  signAndBroadcastBase64Tx,
} from '../utils/solanaWallet';

interface DeveloperIncomeAgentProps {
  cluster: SolanaCluster;
  customRpcUrl?: string;
  rpcUrl: string;
  walletPubkey: string | null;
  walletProvider: SolanaWalletProvider | null;
  onConnectWallet: () => void;
}

export function DeveloperIncomeAgent({
  cluster,
  customRpcUrl,
  rpcUrl,
  walletPubkey,
  walletProvider,
  onConnectWallet,
}: DeveloperIncomeAgentProps) {
  const [agentMode, setAgentMode] = useState<'person' | 'ai'>('person');
  const [stakeAmountSol, setStakeAmountSol] = useState<string>('100');
  const [entryPriceUsd, setEntryPriceUsd] = useState<number>(180);
  const [treasuryPubkeyInput, setTreasuryPubkeyInput] = useState<string>('');
  const [anchorSigInput, setAnchorSigInput] = useState<string>('');
  const [snapshot, setSnapshot] = useState<CentMillisecondStreamSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [anchoring, setAnchoring] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimResult, setClaimResult] = useState<{
    signature: string;
    usdClaimed: string;
    solClaimed: string;
    lamportsClaimed: number;
    anchorSlot: number;
    verifiedOnChainElapsedMs: number;
  } | null>(null);
  const [copiedSdk, setCopiedSdk] = useState<'node' | 'go' | null>(null);

  useEffect(() => {
    if (walletPubkey && !treasuryPubkeyInput) {
      setTreasuryPubkeyInput(walletPubkey);
    }
  }, [walletPubkey, treasuryPubkeyInput]);

  const loadLiveChainSnapshot = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ cluster });
        if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
        if (treasuryPubkeyInput.trim().length > 20) {
          qs.set('treasuryPubkey', treasuryPubkeyInput.trim());
        }
        if (anchorSigInput.trim().length > 20) {
          qs.set('anchorSignature', anchorSigInput.trim());
        }
        const res = await fetch(`/api/usd-stream/snapshot?${qs.toString()}`);
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.error || 'Failed to sync live Solana blockchain oracle & slot');
        }
        setSnapshot(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Live Solana RPC connection failed');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [cluster, customRpcUrl, treasuryPubkeyInput, anchorSigInput],
  );

  useEffect(() => {
    loadLiveChainSnapshot();
  }, [loadLiveChainSnapshot]);

  useEffect(() => {
    if (anchorSigInput.trim().length <= 20) return;
    const timer = setInterval(() => {
      loadLiveChainSnapshot(true);
    }, 2200);
    return () => clearInterval(timer);
  }, [anchorSigInput, loadLiveChainSnapshot]);

  const handleAnchorOnChain = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    setAnchoring(true);
    setError(null);
    try {
      const principalNum = Math.max(0.000000001, Number(stakeAmountSol) || 100);
      const res = await fetch('/api/stream/anchor-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl,
          walletPubkey,
          principalSol: principalNum,
          streamType: 'usd_120_ms',
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
      setAnchorSigInput(sig);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to broadcast anchor tx on Solana');
    } finally {
      setAnchoring(false);
    }
  };

  const handleClaim120UsdMsInSol = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    if (anchorSigInput.trim().length <= 20) {
      setError('Confirm an on-chain Anchor transaction first — offline/simulator timers are disabled.');
      return;
    }
    const treasury = treasuryPubkeyInput.trim() || walletPubkey;
    setClaiming(true);
    setError(null);
    setClaimResult(null);
    try {
      const res = await fetch('/api/usd-stream/claim-sol-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl,
          treasuryPubkey: treasury,
          stakerPubkey: walletPubkey,
          anchorSignature: anchorSigInput.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to build $120/ms real SOL claim tx');
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setClaimResult({
        signature: sig,
        usdClaimed: json.usdClaimed,
        solClaimed: json.solClaimed,
        lamportsClaimed: json.lamportsClaimed,
        anchorSlot: json.anchorSlot,
        verifiedOnChainElapsedMs: json.verifiedOnChainElapsedMs,
      });
      loadLiveChainSnapshot(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'On-chain $120/ms SOL payout failed');
    } finally {
      setClaiming(false);
    }
  };

  const handleCopyCode = (kind: 'node' | 'go', code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedSdk(kind);
    setTimeout(() => setCopiedSdk(null), 2500);
  };

  const principalNum = Math.max(0, Number(stakeAmountSol) || 0);
  const liveSolPrice = snapshot?.solUsdPrice ?? 0;
  const elapsedMsOnChain = snapshot?.anchorSignature ? Math.max(0, snapshot.onChainElapsedMs ?? 0) : 0;
  const accruedUsdOnChain = elapsedMsOnChain * 120;
  const accruedSolOnChain = liveSolPrice > 0 ? accruedUsdOnChain / liveSolPrice : 0;
  const solPerMsAtLivePrice = snapshot ? snapshot.lamportsPerMsAtLivePrice / 1e9 : 0;
  const solPerSecAtLivePrice = snapshot ? snapshot.lamportsPerSecAtLivePrice / 1e9 : 0;

  const entryValUsd = principalNum * entryPriceUsd;
  const currentValUsd = principalNum * (liveSolPrice || entryPriceUsd);
  const drawdownUsd = Math.max(0, entryValUsd - currentValUsd);
  const drawdownPct = entryValUsd > 0 ? (drawdownUsd / entryValUsd) * 100 : 0;

  const nodeSnippet = `import { Keypair } from '@solana/web3.js';
import { TitaniumStakingProtocol } from 'solpool-staking-roi-protocol';

// Old Package 2 (Titanium Staking) — 100% Live Solana Blockchain (Zero Simulator/Offline)
const sdk = new TitaniumStakingProtocol("${rpcUrl}");
const liveRate = await sdk.getPerson120UsdMsSolRate();
console.log("$120/ms in SOL:", liveRate.lamportsPerMsAtLivePrice, "lamports/ms @ $" + liveRate.solUsdPrice);

// Anchor on-chain clock and claim real native SOL at $120.00/ms
const earn = await sdk.getPerson120UsdMsOnChainEarn("<CONFIRMED_ANCHOR_SIGNATURE>");
console.log("Verified On-Chain SOL Earned:", earn.solEarned, "SOL ($" + earn.usdEarned + ")");`;

  const goSnippet = `package main

import (
    "fmt"
    "github.com/solpool/solana-native-pos-go"
)

func main() {
    // 100% Live Solana JSON-RPC & Oracle (Zero Simulator/Offline)
    client := pos.NewClient("${rpcUrl}")
    rate, _ := client.GetLive120UsdMsSolRate()
    fmt.Printf("$120/ms in SOL: %.6f SOL/ms @ $%.2f/SOL\\n", rate.SolPerMs, rate.SolUsdPrice)

    earn, _ := client.GetOnChainPerson120UsdMsEarn("<CONFIRMED_ANCHOR_SIGNATURE>")
    fmt.Printf("On-Chain Earned: %.6f SOL ($%.2f)\\n", earn.SolEarned, earn.UsdEarned)
}`;

  return (
    <div className="space-y-6 max-w-7xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="bg-[#0B101B] border border-slate-800 rounded-2xl p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              Live On-Chain $120/ms in Real SOL (Zero Simulator)
            </span>
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              Titanium Package 2 + Node.js &amp; Go SDK
            </span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100">Person &amp; AI Developer Web3 Staking Agent</h1>
          <p className="text-sm text-slate-400 mt-1">
            100% live Solana blockchain ({cluster}) earn staking at $120.00/ms in native SOL with confirmed ledger anchors and personal vault price protection.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center bg-[#090D16] p-1.5 rounded-xl border border-slate-800">
            <button
              type="button"
              onClick={() => setAgentMode('person')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                agentMode === 'person'
                  ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Cpu className="w-4 h-4" />
              Person Staker
            </button>
            <button
              type="button"
              onClick={() => setAgentMode('ai')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                agentMode === 'ai'
                  ? 'bg-cyan-500 text-slate-950 font-semibold shadow-lg shadow-cyan-500/20'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Bot className="w-4 h-4" />
              AI Developer Agent
            </button>
          </div>
        </div>
      </div>

      {/* Live On-Chain Configuration & Earn Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-[#0B101B] border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <Zap className="w-5 h-5 text-emerald-400" />
              On-Chain Staking Anchor ({cluster})
            </h2>
            <button
              type="button"
              onClick={() => loadLiveChainSnapshot()}
              disabled={loading}
              className="p-1.5 rounded-lg border border-slate-800 bg-[#090D16] text-slate-300 hover:text-white"
              title="Sync live Solana slot & oracle"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Stake Principal (0.01¢ / 1 lamport to Unlimited SOL)
            </label>
            <input
              type="number"
              step="any"
              min="0.000000001"
              value={stakeAmountSol}
              onChange={(e) => setStakeAmountSol(e.target.value)}
              className="w-full bg-[#090D16] border border-slate-700 rounded-xl px-4 py-2 text-slate-100 font-mono text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-400">
                Confirmed On-Chain Anchor Signature
              </label>
              <button
                type="button"
                onClick={handleAnchorOnChain}
                disabled={anchoring}
                className="text-xs font-semibold text-emerald-400 hover:underline"
              >
                {anchoring ? 'Anchoring on Solana...' : 'Anchor On-Chain Clock'}
              </button>
            </div>
            <input
              type="text"
              value={anchorSigInput}
              onChange={(e) => setAnchorSigInput(e.target.value)}
              placeholder="Paste confirmed Solana signature or click Anchor..."
              className="w-full bg-[#090D16] border border-slate-700 rounded-xl px-3 py-2 text-slate-100 font-mono text-xs focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Funded SOL Treasury Public Key
            </label>
            <input
              type="text"
              value={treasuryPubkeyInput}
              onChange={(e) => setTreasuryPubkeyInput(e.target.value)}
              placeholder="Enter funded SOL treasury wallet pubkey..."
              className="w-full bg-[#090D16] border border-slate-700 rounded-xl px-3 py-2 text-slate-100 font-mono text-xs focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="pt-2 border-t border-slate-800/80 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Entry Price ($)</label>
              <input
                type="number"
                value={entryPriceUsd}
                onChange={(e) => setEntryPriceUsd(Math.max(0, Number(e.target.value)))}
                className="w-full bg-[#090D16] border border-slate-700 rounded-lg px-3 py-2 text-slate-100 font-mono text-xs focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Live Oracle ($)</label>
              <div className="w-full bg-[#090D16] border border-slate-800 rounded-lg px-3 py-2 text-emerald-400 font-mono text-xs">
                {liveSolPrice > 0 ? `$${liveSolPrice.toFixed(2)}` : 'Syncing...'}
              </div>
            </div>
          </div>

          {error && <div className="text-xs font-mono text-red-400">{error}</div>}

          <button
            type="button"
            onClick={handleClaim120UsdMsInSol}
            disabled={claiming}
            className="w-full py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-semibold text-xs rounded-xl transition-all"
          >
            {!walletPubkey
              ? `Connect Wallet for Live $120/ms SOL Payout (${cluster})`
              : claiming
                ? 'Verifying Solana Slot & Treasury...'
                : `Claim Verified $120/ms in Real SOL (${cluster})`}
          </button>

          {claimResult && (
            <div className="p-3 rounded-xl border border-emerald-500/40 bg-[#090D16] space-y-1 text-xs font-mono">
              <div className="text-emerald-400 font-semibold">
                Paid +{claimResult.solClaimed} SOL (${Number(claimResult.usdClaimed).toLocaleString()})
              </div>
              <a
                href={getExplorerTxUrl(claimResult.signature, cluster)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-cyan-400 hover:underline"
              >
                <span>View on Solana Explorer</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </a>
            </div>
          )}
        </div>

        {/* Live Blockchain $120/ms SOL Earn Breakdown */}
        <div className="lg:col-span-2 bg-[#0B101B] border border-slate-800 rounded-2xl p-6 space-y-6">
          <div className="flex flex-wrap justify-between items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-emerald-400" />
              Live On-Chain $120/ms Real SOL Earn Stream
            </h2>
            <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/20">
              {snapshot
                ? `Slot ${snapshot.currentSlot?.toLocaleString() ?? snapshot.anchorSlot.toLocaleString()} · ${snapshot.priceSource}`
                : `Connecting to ${cluster}...`}
            </span>
          </div>

          {/* Verified On-Chain Ledger Counter */}
          <div className="bg-[#090D16] border border-slate-800 rounded-xl p-5 space-y-2">
            <div className="flex justify-between items-center text-xs text-slate-400">
              <span>
                {snapshot?.anchorSignature
                  ? `Verified On-Chain Delta (Anchor Slot ${snapshot.anchorSlot.toLocaleString()} → ${(snapshot.currentSlot ?? snapshot.anchorSlot).toLocaleString()})`
                  : `Awaiting confirmed on-chain Solana anchor transaction on ${cluster}`}
              </span>
              <span className="font-mono text-emerald-400">
                {elapsedMsOnChain.toLocaleString()} ms ({snapshot?.slotDelta ?? 0} slots)
              </span>
            </div>
            <div className="text-3xl font-mono font-bold text-emerald-400 tabular-nums">
              +{accruedSolOnChain.toFixed(6)} SOL{' '}
              <span className="text-sm font-normal text-slate-400">
                (${accruedUsdOnChain.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} @ $120.00/ms)
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-[#090D16] border border-slate-800/80 rounded-xl p-4">
              <div className="text-xs text-slate-400 mb-1">$120/ms in SOL</div>
              <div className="text-lg font-mono font-bold text-emerald-400 truncate">
                +{solPerMsAtLivePrice.toFixed(4)} SOL/ms
              </div>
            </div>
            <div className="bg-[#090D16] border border-slate-800/80 rounded-xl p-4">
              <div className="text-xs text-slate-400 mb-1">$120,000/s in SOL</div>
              <div className="text-lg font-mono font-bold text-emerald-400 truncate">
                +{solPerSecAtLivePrice.toFixed(2)} SOL/s
              </div>
            </div>
            <div className="bg-[#090D16] border border-slate-800/80 rounded-xl p-4">
              <div className="text-xs text-slate-400 mb-1">Treasury SOL Balance</div>
              <div className="text-lg font-mono font-bold text-slate-100 truncate">
                {snapshot?.treasurySolBalance !== null && snapshot?.treasurySolBalance !== undefined
                  ? `${snapshot.treasurySolBalance} SOL`
                  : '—'}
              </div>
            </div>
            <div className="bg-[#090D16] border border-slate-800/80 rounded-xl p-4">
              <div className="text-xs text-slate-400 mb-1">Treasury Runway</div>
              <div className="text-lg font-mono font-bold text-cyan-400 truncate">
                {snapshot?.treasurySolRunwayMs !== null && snapshot?.treasurySolRunwayMs !== undefined
                  ? `${snapshot.treasurySolRunwayMs.toLocaleString()} ms`
                  : '—'}
              </div>
            </div>
          </div>

          {/* Personal Vault Protection Status */}
          <div className="bg-[#090D16] border border-slate-800 rounded-xl p-5 space-y-3">
            <div className="flex justify-between items-center">
              <div className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-cyan-400" />
                100% Personal Vault Price Drop Protection Status
              </div>
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                100% Floor Backed ({agentMode === 'person' ? 'Person' : 'AI Agent'})
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs font-mono">
              <div className="bg-[#0B101B] p-3 rounded-lg border border-slate-800">
                <div className="text-slate-400">Entry Value</div>
                <div className="text-slate-100 font-bold text-sm mt-0.5">${entryValUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
              </div>
              <div className="bg-[#0B101B] p-3 rounded-lg border border-slate-800">
                <div className="text-slate-400">Live Oracle Value</div>
                <div className="text-slate-100 font-bold text-sm mt-0.5">${currentValUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
              </div>
              <div className="bg-[#0B101B] p-3 rounded-lg border border-slate-800">
                <div className="text-slate-400">Insurance Floor Coverage</div>
                <div className="text-emerald-400 font-bold text-sm mt-0.5">+${drawdownUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} ({drawdownPct.toFixed(1)}% Insured)</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Developer SDK Code Snippets */}
      <div className="bg-[#0B101B] border border-slate-800 rounded-2xl p-6 space-y-4">
        <div className="flex flex-wrap justify-between items-center gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-100">Web3 Developer SDK Code Snippets (Node.js Package 2 &amp; Go)</h3>
            <p className="text-xs text-slate-400">100% live Solana RPC &amp; oracle integration for $120/ms in real SOL — zero simulators or offline chains.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleCopyCode('node', nodeSnippet)}
              className="px-3.5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs rounded-xl transition-all flex items-center gap-1.5"
            >
              {copiedSdk === 'node' ? <CheckCircle2 className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
              {copiedSdk === 'node' ? 'Copied Node.js!' : 'Copy Node.js'}
            </button>
            <button
              type="button"
              onClick={() => handleCopyCode('go', goSnippet)}
              className="px-3.5 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs rounded-xl transition-all flex items-center gap-1.5"
            >
              {copiedSdk === 'go' ? <CheckCircle2 className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
              {copiedSdk === 'go' ? 'Copied Go!' : 'Copy Go'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 font-mono text-xs">
          <div className="bg-[#090D16] border border-slate-800 rounded-xl p-4 overflow-x-auto">
            <div className="text-slate-400 font-semibold mb-2 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
              Node.js (`TitaniumStakingProtocol` / `solpool-staking-roi-protocol`)
            </div>
            <pre className="text-slate-300 leading-relaxed">{nodeSnippet}</pre>
          </div>
          <div className="bg-[#090D16] border border-slate-800 rounded-xl p-4 overflow-x-auto">
            <div className="text-slate-400 font-semibold mb-2 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
              Go (`solpool-staking-roi-protocol/go`)
            </div>
            <pre className="text-slate-300 leading-relaxed">{goSnippet}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
