import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Fingerprint,
  History,
  Link2,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type {
  ProtocolConfig,
  SolanaCluster,
  StakingProofOfHistoryResponse,
} from '../types';
import {
  type SolanaWalletProvider,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  signAndBroadcastBase64Tx,
} from '../utils/solanaWallet';

interface StakingProofOfHistoryProps {
  cluster: SolanaCluster;
  customRpcUrl?: string;
  protocols: ProtocolConfig[];
  walletPubkey: string | null;
  walletProvider: SolanaWalletProvider | null;
  onConnectWallet: () => void;
  initialAddress?: string;
}

const SPL_STAKE_POOL_PROGRAM = 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy';
const NATIVE_STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111';

export function StakingProofOfHistory({
  cluster,
  customRpcUrl,
  protocols,
  walletPubkey,
  walletProvider,
  onConnectWallet,
  initialAddress,
}: StakingProofOfHistoryProps) {
  const [addressInput, setAddressInput] = useState(
    initialAddress || walletPubkey || SPL_STAKE_POOL_PROGRAM,
  );
  const [limit, setLimit] = useState(10);
  const [data, setData] = useState<StakingProofOfHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [checkpointBusy, setCheckpointBusy] = useState(false);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [checkpointResult, setCheckpointResult] = useState<{
    signature: string;
    slot: number;
    blockhash: string;
    checkpointDigest: string;
  } | null>(null);

  useEffect(() => {
    if (initialAddress && initialAddress.trim().length > 20) {
      setAddressInput(initialAddress.trim());
    }
  }, [initialAddress]);

  const loadPoh = useCallback(
    async (overrideAddress?: string) => {
      const targetAddr = (overrideAddress ?? addressInput).trim();
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          cluster,
          limit: String(limit),
        });
        if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
        if (targetAddr.length > 20) qs.set('address', targetAddr);

        const res = await fetch(`/api/staking/poh?${qs.toString()}`);
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.error || 'Failed to verify on-chain Staking Proof of History');
        }
        setData(json);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Unable to query Solana Proof of History ledger',
        );
      } finally {
        setLoading(false);
      }
    },
    [addressInput, cluster, customRpcUrl, limit],
  );

  useEffect(() => {
    loadPoh();
  }, [loadPoh]);

  const handleInspectAddress = (addr: string) => {
    setAddressInput(addr);
    loadPoh(addr);
  };

  const handleAnchorPohCheckpoint = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    setCheckpointBusy(true);
    setCheckpointError(null);
    setCheckpointResult(null);
    try {
      const res = await fetch('/api/staking/poh-checkpoint-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl,
          signerPubkey: walletPubkey,
          stakeOrPoolPubkey: addressInput.trim() || walletPubkey,
          actionLabel: 'STAKING_POH_VERIFIED',
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to build PoH checkpoint transaction');

      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );

      setCheckpointResult({
        signature: sig,
        slot: json.slot,
        blockhash: json.blockhash,
        checkpointDigest: json.checkpointDigest,
      });

      const targetAfter = addressInput.trim().length > 20 ? addressInput.trim() : walletPubkey;
      await loadPoh(targetAfter);
    } catch (err) {
      setCheckpointError(
        err instanceof Error ? err.message : 'Failed to confirm PoH checkpoint on-chain',
      );
    } finally {
      setCheckpointBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div className="space-y-1.5 max-w-3xl">
          <p className="text-xs font-medium text-emerald-400">
            100% On-Chain Solana Staking Proof of History ({cluster})
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
            Proof of History (PoH) of Staking
          </h1>
          <p className="text-sm text-slate-400">
            Cryptographically verifies live Solana PoH blockhashes, tick height, on-chain{' '}
            <span className="font-mono text-slate-200">SysvarStakeHistory</span> epochs, and
            confirmed staking transaction SHA-256 chains directly from {cluster} validators. Zero
            off-chain simulation or mock history.
          </p>
        </div>

        <button
          type="button"
          onClick={() => loadPoh()}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-600 rounded-md bg-[#0F1623] transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Sync Live PoH Ledger
        </button>
      </div>

      {/* Address Inspector & On-Chain Checkpoint Controls */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-6 space-y-5">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
          <div className="lg:col-span-7 space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              Stake Account, Staker Wallet, or Stake Pool Public Key ({cluster})
            </label>
            <input
              type="text"
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              placeholder="Enter any Solana Stake Account, Wallet, Pool, or Program pubkey..."
              className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="lg:col-span-2 space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">History Depth</label>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
            >
              <option value={5}>5 tx links</option>
              <option value={10}>10 tx links</option>
              <option value={15}>15 tx links</option>
              <option value={20}>20 tx links</option>
            </select>
          </div>

          <div className="lg:col-span-3 flex gap-2">
            <button
              type="button"
              onClick={() => loadPoh()}
              disabled={loading}
              className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 text-slate-950 rounded-md transition-colors whitespace-nowrap"
            >
              <Search className="w-3.5 h-3.5" />
              Verify PoH Chain
            </button>
          </div>
        </div>

        {/* Quick Inspect Selectors */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/80 text-xs">
          <div className="flex flex-wrap items-center gap-3 text-slate-400">
            <span>Quick inspect:</span>
            {walletPubkey && (
              <button
                type="button"
                onClick={() => handleInspectAddress(walletPubkey)}
                className="font-mono text-emerald-400 hover:underline"
              >
                Connected Wallet ({walletPubkey.slice(0, 6)}...)
              </button>
            )}
            <button
              type="button"
              onClick={() => handleInspectAddress(SPL_STAKE_POOL_PROGRAM)}
              className="font-mono text-slate-300 hover:text-emerald-400 hover:underline"
            >
              SPL Stake Pool Ledger
            </button>
            <button
              type="button"
              onClick={() => handleInspectAddress(NATIVE_STAKE_PROGRAM)}
              className="font-mono text-slate-300 hover:text-emerald-400 hover:underline"
            >
              Native Stake Program
            </button>
            {protocols
              .filter((p) => p.stakePoolAddress || p.reserveStakeAddress)
              .slice(0, 3)
              .map((p) => {
                const target = p.reserveStakeAddress || p.stakePoolAddress || '';
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleInspectAddress(target)}
                    className="font-mono text-emerald-400 hover:underline"
                  >
                    {p.tokenSymbol} ({target.slice(0, 6)}...)
                  </button>
                );
              })}
          </div>

          <button
            type="button"
            onClick={handleAnchorPohCheckpoint}
            disabled={checkpointBusy}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 border border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Fingerprint className="w-3.5 h-3.5 text-emerald-400" />
            {!walletPubkey
              ? 'Connect Wallet to Anchor PoH Checkpoint'
              : checkpointBusy
                ? 'Confirming PoH Checkpoint...'
                : 'Anchor Staking PoH Checkpoint On-Chain'}
          </button>
        </div>

        {checkpointError && (
          <div className="p-3 rounded border border-red-900/60 bg-red-950/30 text-xs font-mono text-red-300">
            {checkpointError}
          </div>
        )}

        {checkpointResult && (
          <div className="p-4 rounded-md border border-emerald-500/40 bg-[#090D16] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs font-mono">
            <div className="space-y-1">
              <div className="text-emerald-400 font-semibold">
                On-Chain Staking PoH Checkpoint Confirmed at Slot {checkpointResult.slot.toLocaleString()}
              </div>
              <div className="text-slate-400 break-all">
                PoH Blockhash: {checkpointResult.blockhash} · Digest: {checkpointResult.checkpointDigest}
              </div>
            </div>
            <a
              href={getExplorerTxUrl(checkpointResult.signature, cluster)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-blue-400 hover:underline whitespace-nowrap shrink-0"
            >
              <span>Solana Explorer</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </a>
          </div>
        )}
      </div>

      {error && (
        <div className="p-4 rounded-lg border border-red-900/60 bg-red-950/30 text-xs font-mono text-red-300">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Live Solana L1 PoH Block & Chain Telemetry */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 rounded-lg border border-slate-800 bg-[#0F1623]">
              <div className="text-xs text-slate-400">Verified PoH Slot &amp; Parent</div>
              <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-slate-50">
                {data.livePohBlock.slot.toLocaleString()}
              </div>
              <div className="mt-1 text-[11px] font-mono text-slate-400 tabular-nums">
                Parent: {data.livePohBlock.parentSlot.toLocaleString()}
                {data.livePohBlock.blockHeight !== null
                  ? ` · Height ${data.livePohBlock.blockHeight.toLocaleString()}`
                  : ''}
              </div>
            </div>

            <div className="p-4 rounded-lg border border-slate-800 bg-[#0F1623]">
              <div className="text-xs text-slate-400">Solana PoH Tick Height</div>
              <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-emerald-400">
                {data.livePohBlock.estimatedPohTickHeight.toLocaleString()}
              </div>
              <div className="mt-1 text-[11px] font-mono text-slate-400">
                {data.livePohBlock.ticksPerSlot} PoH ticks/slot ·{' '}
                {data.ledgerTimeIso.replace('T', ' ').slice(0, 19)} UTC
              </div>
            </div>

            <div className="p-4 rounded-lg border border-slate-800 bg-[#0F1623]">
              <div className="text-xs text-slate-400">Inspected Staking Target</div>
              <div className="mt-1 text-sm font-mono font-semibold text-slate-100 truncate">
                {data.queriedAddress}
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>{data.accountType}</span>
                <a
                  href={getExplorerAddressUrl(data.queriedAddress, cluster)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-400 hover:underline inline-flex items-center gap-0.5"
                >
                  Explorer <ArrowUpRight className="w-3 h-3" />
                </a>
              </div>
            </div>

            <div className="p-4 rounded-lg border border-slate-800 bg-[#0F1623]">
              <div className="text-xs text-slate-400">Chained Staking Proofs</div>
              <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-slate-50">
                {data.totalVerifiedRecords}
              </div>
              <div className="mt-1 text-[11px] font-mono text-emerald-400 flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                <span>SHA-256 Chain Verified</span>
              </div>
            </div>
          </div>

          {/* Cryptographic PoH Blockhash & Digest Summary */}
          <div className="rounded-lg border border-emerald-500/30 bg-[#0F1623] p-5 grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs font-mono">
            <div className="p-3.5 rounded bg-[#090D16] border border-slate-800 space-y-1.5">
              <div className="text-slate-400 flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Live On-Chain PoH Blockhash Link</span>
              </div>
              <div className="text-slate-100 break-all">Current: {data.livePohBlock.blockhash}</div>
              <div className="text-slate-400 break-all">
                Previous: {data.livePohBlock.previousBlockhash}
              </div>
            </div>

            <div className="p-3.5 rounded bg-[#090D16] border border-slate-800 space-y-1.5">
              <div className="text-slate-400 flex items-center gap-1.5">
                <History className="w-3.5 h-3.5 text-emerald-400" />
                <span>Cryptographic Staking PoH Digest Chain</span>
              </div>
              <div className="text-emerald-300 break-all">Head: {data.headPohChainDigest}</div>
              <div className="text-slate-400 break-all">Genesis: {data.genesisPohSeed}</div>
            </div>
          </div>

          {/* Confirmed On-Chain Staking Transaction PoH Chain */}
          <div className="rounded-lg border border-slate-800 bg-[#0F1623] overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  Verified On-Chain Staking Proof-of-History Chain
                </h2>
                <p className="text-xs text-slate-400">
                  Each confirmed Solana transaction commits to an immutable L1 recentBlockhash and
                  links chronologically into a verifiable SHA-256 digest chain.
                </p>
              </div>
              <span className="text-xs font-mono text-slate-400">
                {data.records.length} confirmed records
              </span>
            </div>

            {data.records.length === 0 ? (
              <div className="p-6 text-xs font-mono text-slate-400">
                No confirmed transactions found yet for {data.queriedAddress} on {cluster}. Submit a
                stake, claim, or anchor a Staking PoH Checkpoint above.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-[11px] font-medium text-slate-400 bg-[#0B101B]">
                      <th className="py-2.5 px-4">#</th>
                      <th className="py-2.5 px-4">Slot &amp; Time</th>
                      <th className="py-2.5 px-4">Tx Signature</th>
                      <th className="py-2.5 px-4">Anchored PoH Blockhash</th>
                      <th className="py-2.5 px-4">Staking Action / Memo</th>
                      <th className="py-2.5 px-4 text-right">SOL Delta</th>
                      <th className="py-2.5 px-4">PoH Chain Digest</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70 text-xs font-mono tabular-nums">
                    {data.records.map((rec) => (
                      <tr key={rec.signature} className="hover:bg-slate-800/20">
                        <td className="py-3 px-4 text-slate-400">{rec.index}</td>
                        <td className="py-3 px-4">
                          <div className="text-slate-100">{rec.slot.toLocaleString()}</div>
                          <div className="text-[11px] text-slate-500">
                            {rec.blockTimeUnix
                              ? new Date(rec.blockTimeUnix * 1000)
                                  .toISOString()
                                  .replace('T', ' ')
                                  .slice(0, 19)
                              : 'confirmed'}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <a
                            href={getExplorerTxUrl(rec.signature, cluster)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-blue-400 hover:underline"
                          >
                            <span>
                              {rec.signature.slice(0, 8)}...{rec.signature.slice(-6)}
                            </span>
                            <ArrowUpRight className="w-3 h-3" />
                          </a>
                          <div className="text-[11px] text-slate-500">
                            {rec.err ? 'Failed' : rec.confirmationStatus}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-slate-300">
                          {rec.recentBlockhash.slice(0, 10)}...{rec.recentBlockhash.slice(-6)}
                        </td>
                        <td className="py-3 px-4 max-w-xs">
                          <div className="text-emerald-300 truncate">
                            {rec.stakingActions.join(', ')}
                          </div>
                          {rec.memo && (
                            <div className="text-[11px] text-slate-400 truncate" title={rec.memo}>
                              {rec.memo}
                            </div>
                          )}
                        </td>
                        <td
                          className={`py-3 px-4 text-right ${
                            rec.solDelta > 0
                              ? 'text-emerald-400'
                              : rec.solDelta < 0
                                ? 'text-amber-300'
                                : 'text-slate-400'
                          }`}
                        >
                          {rec.solDelta > 0 ? `+${rec.solDelta}` : rec.solDelta} SOL
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-slate-200" title={rec.pohChainDigest}>
                            {rec.pohChainDigest.slice(0, 14)}...
                          </div>
                          <div
                            className="text-[10px] text-slate-500"
                            title={`Prev: ${rec.previousPohChainDigest}`}
                          >
                            prev:{rec.previousPohChainDigest.slice(0, 10)}...
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Native Solana SysvarStakeHistory Epoch Ledger */}
          <div className="rounded-lg border border-slate-800 bg-[#0F1623] overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  On-Chain Solana SysvarStakeHistory (Network Staking Proof Ledger)
                </h2>
                <p className="text-xs text-slate-400">
                  Decoded directly from L1 sysvar account{' '}
                  <span className="font-mono text-slate-300">
                    SysvarStakeHist1111111111111111111111111
                  </span>{' '}
                  recording epoch-by-epoch verified effective, activating, and deactivating SOL.
                </p>
              </div>
              <a
                href={getExplorerAddressUrl(
                  'SysvarStakeHist1111111111111111111111111',
                  cluster,
                )}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-mono text-blue-400 hover:underline inline-flex items-center gap-1 whitespace-nowrap"
              >
                Inspect Sysvar <ArrowUpRight className="w-3.5 h-3.5" />
              </a>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-[11px] font-medium text-slate-400 bg-[#0B101B]">
                    <th className="py-2.5 px-4">Epoch</th>
                    <th className="py-2.5 px-4 text-right">Effective Stake (SOL)</th>
                    <th className="py-2.5 px-4 text-right">Activating (SOL)</th>
                    <th className="py-2.5 px-4 text-right">Deactivating (SOL)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70 text-xs font-mono tabular-nums">
                  {data.sysvarStakeHistory.map((row) => (
                    <tr key={row.epoch} className="hover:bg-slate-800/20">
                      <td className="py-2.5 px-4 text-slate-100 font-semibold">Epoch {row.epoch}</td>
                      <td className="py-2.5 px-4 text-right text-emerald-400">
                        {row.effectiveSol.toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}{' '}
                        SOL
                      </td>
                      <td className="py-2.5 px-4 text-right text-slate-200">
                        {row.activatingSol.toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}{' '}
                        SOL
                      </td>
                      <td className="py-2.5 px-4 text-right text-amber-300">
                        {row.deactivatingSol.toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}{' '}
                        SOL
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
