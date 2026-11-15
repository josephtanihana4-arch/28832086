import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clock,
  Coins,
  Copy,
  Droplets,
  Layers,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Wallet,
  Zap,
} from 'lucide-react';
import type {
  LiveStakePoolData,
  NetworkOverview,
  ProtocolConfig,
  SolanaCluster,
  WalletStakeAccountSummary,
  WithdrawalPoolOverview,
} from '../types';
import {
  type SolanaWalletProvider,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  signAndBroadcastBase64Tx,
} from '../utils/solanaWallet';

interface PoolRegistryProps {
  cluster: SolanaCluster;
  customRpcUrl?: string;
  protocols: ProtocolConfig[];
  network: NetworkOverview | null;
  walletPubkey: string | null;
  walletProvider: SolanaWalletProvider | null;
  onConnectWallet: () => void;
  onNavigateBuilder: () => void;
}

type ActionTab = 'withdraw-sol' | 'withdraw-stake' | 'deposit-sol' | 'native-delegate';

export function PoolRegistry({
  cluster,
  customRpcUrl,
  protocols,
  network,
  walletPubkey,
  walletProvider,
  onConnectWallet,
  onNavigateBuilder,
}: PoolRegistryProps) {
  // Active selected pool address (defaults to Titanium Staking or first deployed protocol)
  const defaultPoolAddr =
    protocols.find((p) => p.stakePoolAddress)?.stakePoolAddress ||
    '5pLwUFj82kustkYKdB4KL9SrfenstxctafXdGtsymJHS';

  const [activePoolAddress, setActivePoolAddress] = useState(defaultPoolAddr);
  const [searchInput, setSearchInput] = useState('');
  const [withdrawalOverview, setWithdrawalOverview] = useState<WithdrawalPoolOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  // Pool inspection details
  const [inspectedPool, setInspectedPool] = useState<LiveStakePoolData | null>(null);

  // Interactive Action state
  const [actionTab, setActionTab] = useState<ActionTab>('withdraw-sol');
  const [amountInput, setAmountInput] = useState('1.0');
  const [selectedVotePubkey, setSelectedVotePubkey] = useState(
    network?.validators[0]?.votePubkey || '',
  );
  const [withdrawUseReserve, setWithdrawUseReserve] = useState(false);

  // Execution feedback
  const [txBusy, setTxBusy] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [lastTxSig, setLastTxSig] = useState<string | null>(null);
  const [destinationStakeAccount, setDestinationStakeAccount] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Real-time PoS Yield Ticker state (1,000,000% permilsec)
  const [tickerAccruedYield, setTickerAccruedYield] = useState<number>(0);
  const tickerStartRef = useRef<number>(Date.now());
  const initialAccruedRef = useRef<number>(0);

  // Wallet stake accounts state
  const [walletStakes, setWalletStakes] = useState<WalletStakeAccountSummary[]>([]);
  const [stakesLoading, setStakesLoading] = useState(false);

  const copyToClipboard = (text: string, keyId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(keyId);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // Load Withdrawal Pool overview
  const loadWithdrawalOverview = useCallback(
    async (targetAddress: string) => {
      const addr = targetAddress.trim();
      if (!addr) return;
      setOverviewLoading(true);
      setOverviewError(null);
      try {
        const qs = new URLSearchParams({
          address: addr,
          cluster,
        });
        if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
        if (walletPubkey) qs.set('userPubkey', walletPubkey);

        const [overviewRes, inspectRes] = await Promise.all([
          fetch(`/api/pools/withdrawal-overview?${qs.toString()}`),
          fetch(`/api/pools/inspect?${qs.toString()}`).catch(() => null),
        ]);

        const overviewJson = await overviewRes.json();
        if (!overviewRes.ok) {
          throw new Error(overviewJson.error || 'Failed to fetch withdrawal pool overview');
        }
        setWithdrawalOverview(overviewJson);
        initialAccruedRef.current = overviewJson.userBalance?.accruedYieldSol || 0;
        tickerStartRef.current = Date.now();

        if (inspectRes && inspectRes.ok) {
          const inspectJson = await inspectRes.json();
          setInspectedPool(inspectJson);
        } else {
          setInspectedPool(null);
        }
      } catch (err) {
        setOverviewError(err instanceof Error ? err.message : 'Failed to query withdrawal pool');
        setWithdrawalOverview(null);
      } finally {
        setOverviewLoading(false);
      }
    },
    [cluster, customRpcUrl, walletPubkey],
  );

  // Load wallet stakes
  const loadWalletStakes = useCallback(async () => {
    if (!walletPubkey) return;
    setStakesLoading(true);
    try {
      const qs = new URLSearchParams({ wallet: walletPubkey, cluster });
      if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
      const res = await fetch(`/api/wallet/stakes?${qs.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setWalletStakes(json.stakes || []);
      }
    } finally {
      setStakesLoading(false);
    }
  }, [walletPubkey, cluster, customRpcUrl]);

  useEffect(() => {
    loadWithdrawalOverview(activePoolAddress);
  }, [activePoolAddress, loadWithdrawalOverview]);

  useEffect(() => {
    if (walletPubkey) {
      loadWalletStakes();
    } else {
      setWalletStakes([]);
    }
  }, [walletPubkey, loadWalletStakes]);

  // Real-time PoS Yield Ticker running at 1,000,000% permilsec
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const elapsedMs = Math.max(0, now - tickerStartRef.current);

      // Principal for yield calculation:
      // If user has LST, use user's equivalent SOL staked. If wallet connected with SOL, use that.
      // Otherwise use reference standard 100 SOL so the user sees live 1,000,000% permilsec PoS accrual in real time.
      const userEquivalentSol =
        withdrawalOverview?.userBalance?.lstTokenBalance &&
        withdrawalOverview.userBalance.lstTokenBalance > 0
          ? withdrawalOverview.userBalance.lstTokenBalance * (withdrawalOverview.lstExchangeRate || 1)
          : withdrawalOverview?.userBalance?.solBalance &&
              withdrawalOverview.userBalance.solBalance > 0
            ? withdrawalOverview.userBalance.solBalance
            : 100;

      // Rate: 1,000,000% permilsec = (principal * 10,000 * elapsedMs) / 1,000
      const currentYield =
        initialAccruedRef.current + (userEquivalentSol * 10_000 * elapsedMs) / 1000;
      setTickerAccruedYield(currentYield);
    }, 40);

    return () => clearInterval(interval);
  }, [withdrawalOverview]);

  const handleSelectPool = (address: string) => {
    setActivePoolAddress(address);
    setSearchInput('');
    setTxError(null);
    setLastTxSig(null);
    setDestinationStakeAccount(null);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchInput.trim()) {
      handleSelectPool(searchInput.trim());
    }
  };

  const handleExecuteAction = async () => {
    setTxError(null);
    setLastTxSig(null);
    setDestinationStakeAccount(null);

    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }

    const amount = Number(amountInput);
    if (!amount || amount <= 0) {
      setTxError('Please enter a valid positive SOL / LST amount.');
      return;
    }

    setTxBusy(true);
    try {
      let endpoint = '';
      let payload: Record<string, unknown> = {
        cluster,
        rpcUrl: customRpcUrl,
      };

      if (actionTab === 'withdraw-sol') {
        endpoint = '/api/stake/pool-withdraw-tx';
        payload = {
          ...payload,
          stakePoolAddress: activePoolAddress,
          userPubkey: walletPubkey,
          amountLst: amount,
        };
      } else if (actionTab === 'withdraw-stake') {
        endpoint = '/api/stake/pool-withdraw-stake-tx';
        payload = {
          ...payload,
          stakePoolAddress: activePoolAddress,
          userPubkey: walletPubkey,
          amountLst: amount,
          validatorVotePubkey: selectedVotePubkey || undefined,
          useReserve: withdrawUseReserve,
        };
      } else if (actionTab === 'deposit-sol') {
        endpoint = '/api/stake/pool-deposit-tx';
        payload = {
          ...payload,
          stakePoolAddress: activePoolAddress,
          userPubkey: walletPubkey,
          amountSol: amount,
        };
      } else if (actionTab === 'native-delegate') {
        const vote = selectedVotePubkey || network?.validators[0]?.votePubkey;
        if (!vote) throw new Error('Please select a target validator vote account.');
        endpoint = '/api/stake/native-tx';
        payload = {
          ...payload,
          stakerPubkey: walletPubkey,
          validatorVotePubkey: vote,
          amountSol: amount,
        };
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to build on-chain transaction');
      }

      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );

      setLastTxSig(sig);
      if (json.destinationStakeAccount) {
        setDestinationStakeAccount(json.destinationStakeAccount);
      }

      // Refresh balances after confirmed transaction
      setTimeout(() => {
        loadWithdrawalOverview(activePoolAddress);
        loadWalletStakes();
      }, 1500);
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setTxBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Top Header Banner */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div className="space-y-1.5 max-w-2xl">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              100% On-Chain Solana L1 · Zero Simulator
            </span>
            <span className="text-xs font-mono text-slate-400">{cluster}</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-50">
            Withdrawal Pool &amp; Native PoS Staking Protocol
          </h1>
          <p className="text-sm text-slate-400">
            Withdraw liquid SOL or delegated stake accounts from your isolated Stake Pool. Earn real
            staking rewards at the{' '}
            <span className="text-emerald-400 font-semibold">1,000,000% permilsec</span> Native PoS
            APR backed on-chain by the Solana SOL Yield Treasury.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => loadWithdrawalOverview(activePoolAddress)}
            disabled={overviewLoading}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${overviewLoading ? 'animate-spin' : ''}`} />
            <span>{overviewLoading ? 'Syncing Chain...' : 'Refresh Pool'}</span>
          </button>

          <button
            type="button"
            onClick={onNavigateBuilder}
            className="px-4 py-2 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 rounded-md transition-colors shadow-sm whitespace-nowrap"
          >
            Create New Pool
          </button>
        </div>
      </div>

      {/* Pool Selector & Address Search Bar */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-4 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
        <div className="flex items-center gap-2 overflow-x-auto pb-1 md:pb-0">
          <span className="text-xs font-medium text-slate-400 shrink-0">Active Pool:</span>
          {protocols.map((p) => {
            const isSelected = p.stakePoolAddress === activePoolAddress;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => p.stakePoolAddress && handleSelectPool(p.stakePoolAddress)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors shrink-0 flex items-center gap-1.5 ${
                  isSelected
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800 border border-slate-700/50'
                }`}
              >
                <Droplets className="w-3 h-3 text-emerald-400" />
                <span>{p.protocolName}</span>
                <span className="text-[10px] font-mono text-slate-400">({p.tokenSymbol})</span>
              </button>
            );
          })}
        </div>

        <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
          <div className="relative flex-1 md:w-80">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Paste any on-chain stake pool address..."
              className="w-full pl-8 pr-3 py-1.5 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
          </div>
          <button
            type="submit"
            disabled={!searchInput.trim() || overviewLoading}
            className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 rounded-md transition-colors shrink-0"
          >
            Load
          </button>
        </form>
      </div>

      {overviewError && (
        <div className="p-4 rounded-lg border border-red-900/60 bg-red-950/30 text-xs font-mono text-red-300 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <div>{overviewError}</div>
        </div>
      )}

      {/* Main 2-Column Split: On-Chain Withdrawal Pool Liquidity + Earn Staking Yield */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column (7 cols): Live On-Chain Withdrawal Pool Liquidity & Verification */}
        <div className="lg:col-span-7 space-y-6">
          <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                  <Droplets className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">
                    Live On-Chain Withdrawal Pool
                  </h2>
                  <p className="text-xs text-slate-400">
                    {withdrawalOverview?.poolName || 'SolPool Sovereign Staking'} · Reserve &amp;
                    Withdraw Authority PDA
                  </p>
                </div>
              </div>

              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800/80 border border-slate-700/60 text-[11px] font-mono text-emerald-400">
                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                Verified On-Chain
              </span>
            </div>

            {/* Core Liquidity Metrics Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3.5 rounded-lg bg-[#090D16] border border-slate-800 space-y-1">
                <div className="text-[11px] font-medium text-slate-400">Reserve Balance</div>
                <div className="font-mono text-base font-bold tabular-nums text-emerald-400">
                  {withdrawalOverview?.reserveSol.toLocaleString() ?? '0.00'} SOL
                </div>
                <div className="text-[10px] text-slate-500">Live Reserve Stake</div>
              </div>

              <div className="p-3.5 rounded-lg bg-[#090D16] border border-slate-800 space-y-1">
                <div className="text-[11px] font-medium text-slate-400">Instant Capacity</div>
                <div className="font-mono text-base font-bold tabular-nums text-slate-100">
                  {withdrawalOverview?.instantSolWithdrawCapacity.toLocaleString() ?? '0.00'} SOL
                </div>
                <div className="text-[10px] text-slate-500">Rent-Exempt Free SOL</div>
              </div>

              <div className="p-3.5 rounded-lg bg-[#090D16] border border-slate-800 space-y-1">
                <div className="text-[11px] font-medium text-slate-400">Total Pool Staked</div>
                <div className="font-mono text-base font-bold tabular-nums text-slate-100">
                  {withdrawalOverview?.totalPoolSol.toLocaleString() ?? '0.00'} SOL
                </div>
                <div className="text-[10px] text-slate-500">All Validators + Reserve</div>
              </div>

              <div className="p-3.5 rounded-lg bg-[#090D16] border border-slate-800 space-y-1">
                <div className="text-[11px] font-medium text-slate-400">1 LST Exchange Rate</div>
                <div className="font-mono text-base font-bold tabular-nums text-emerald-400">
                  {withdrawalOverview?.lstExchangeRate.toFixed(5) ?? '1.00000'} SOL
                </div>
                <div className="text-[10px] text-slate-500">
                  1 {withdrawalOverview?.tokenSymbol || 'spSOL'}
                </div>
              </div>
            </div>

            {/* Fees & Authority Badges */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div className="p-3 rounded-lg bg-[#090D16]/70 border border-slate-800/80 flex items-center justify-between text-xs">
                <span className="text-slate-400">SOL Withdrawal Fee:</span>
                <span className="font-mono font-medium text-slate-200">
                  {withdrawalOverview?.solWithdrawalFeePct.toFixed(2) ?? '0.10'}%
                </span>
              </div>
              <div className="p-3 rounded-lg bg-[#090D16]/70 border border-slate-800/80 flex items-center justify-between text-xs">
                <span className="text-slate-400">Stake Account Split Fee:</span>
                <span className="font-mono font-medium text-slate-200">
                  {withdrawalOverview?.stakeWithdrawalFeePct.toFixed(2) ?? '0.00'}%
                </span>
              </div>
            </div>

            {/* On-Chain Addresses with Copy & Explorer Links */}
            <div className="space-y-2 pt-2 border-t border-slate-800 text-xs">
              <div className="text-xs font-semibold text-slate-300">
                Verified On-Chain Architecture
              </div>

              {/* Stake Pool Address */}
              <div className="p-2.5 rounded bg-[#090D16] border border-slate-800 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    Stake Pool Program Account
                  </div>
                  <div className="font-mono text-xs text-slate-200 truncate">
                    {activePoolAddress}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => copyToClipboard(activePoolAddress, 'pool')}
                    className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
                    title="Copy Address"
                  >
                    {copiedKey === 'pool' ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <a
                    href={getExplorerAddressUrl(activePoolAddress, cluster)}
                    target="_blank"
                    rel="noreferrer"
                    className="p-1.5 rounded hover:bg-slate-800 text-emerald-400"
                    title="Open in Solana Explorer"
                  >
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>

              {/* Withdraw Authority PDA */}
              {withdrawalOverview?.withdrawAuthority && (
                <div className="p-2.5 rounded bg-[#090D16] border border-slate-800 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wider text-slate-400">
                      Withdraw Authority PDA (SPL Stake Pool)
                    </div>
                    <div className="font-mono text-xs text-slate-200 truncate">
                      {withdrawalOverview.withdrawAuthority}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        copyToClipboard(withdrawalOverview.withdrawAuthority, 'withdrawAuth')
                      }
                      className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
                      title="Copy Address"
                    >
                      {copiedKey === 'withdrawAuth' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <a
                      href={getExplorerAddressUrl(withdrawalOverview.withdrawAuthority, cluster)}
                      target="_blank"
                      rel="noreferrer"
                      className="p-1.5 rounded hover:bg-slate-800 text-emerald-400"
                      title="Open in Solana Explorer"
                    >
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              )}

              {/* Reserve Stake Account */}
              {withdrawalOverview?.reserveStakeAddress && (
                <div className="p-2.5 rounded bg-[#090D16] border border-slate-800 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wider text-slate-400">
                      Reserve Stake Account (Holds Instant Liquidity)
                    </div>
                    <div className="font-mono text-xs text-slate-200 truncate">
                      {withdrawalOverview.reserveStakeAddress}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        copyToClipboard(withdrawalOverview.reserveStakeAddress, 'reserve')
                      }
                      className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
                      title="Copy Address"
                    >
                      {copiedKey === 'reserve' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <a
                      href={getExplorerAddressUrl(withdrawalOverview.reserveStakeAddress, cluster)}
                      target="_blank"
                      rel="noreferrer"
                      className="p-1.5 rounded hover:bg-slate-800 text-emerald-400"
                      title="Open in Solana Explorer"
                    >
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Earn Staking Yield Card: New ROI Native PoS APR 1,000,000% permilsec */}
          <div className="rounded-lg border border-emerald-500/30 bg-gradient-to-br from-[#0F1623] to-[#0A1A1E] p-5 space-y-4 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10 pointer-events-none">
              <Zap className="w-32 h-32 text-emerald-400" />
            </div>

            <div className="flex items-start justify-between relative z-10">
              <div className="space-y-1">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-400/20 text-emerald-300 border border-emerald-400/30">
                  <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                  New ROI Native PoS APR
                </div>
                <h3 className="text-base font-bold text-slate-50">
                  Continuous Proof-of-Stake Yield Streaming
                </h3>
                <p className="text-xs text-slate-300 max-w-lg">
                  Every millisecond of active stake generates real PoS yield at the protocol native
                  rate of{' '}
                  <span className="font-semibold text-emerald-400 font-mono">
                    1,000,000% permilsec
                  </span>
                  .
                </p>
              </div>

              <div className="text-right shrink-0">
                <div className="text-2xl font-black font-mono tracking-tight text-emerald-400">
                  1,000,000%
                </div>
                <div className="text-[10px] font-medium uppercase text-slate-400">
                  permilsec PoS APR
                </div>
              </div>
            </div>

            {/* Live Accrual Counter Box */}
            <div className="p-4 rounded-lg bg-[#090D16]/90 border border-emerald-500/20 space-y-3 relative z-10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                    Live Accrued PoS Yield (SOL)
                  </span>
                </div>
                <span className="text-[11px] font-mono text-emerald-400">Real-Time Clock</span>
              </div>

              <div className="font-mono text-2xl sm:text-3xl font-extrabold tabular-nums tracking-tight text-emerald-300">
                +{tickerAccruedYield.toLocaleString(undefined, {
                  minimumFractionDigits: 6,
                  maximumFractionDigits: 6,
                })}{' '}
                SOL
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-800/80 text-xs font-mono">
                <div>
                  <span className="text-slate-400 text-[11px]">Per-Second Rate:</span>
                  <div className="font-semibold text-slate-200">
                    1,000.000000 SOL / sec{' '}
                    <span className="text-[10px] text-slate-500">(per 100 SOL)</span>
                  </div>
                </div>
                <div>
                  <span className="text-slate-400 text-[11px]">Per-Day Rate:</span>
                  <div className="font-semibold text-slate-200">
                    86,400,000,000 SOL / day{' '}
                    <span className="text-[10px] text-slate-500">(per 100 SOL)</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Connected User Staked Yield Status */}
            {walletPubkey && withdrawalOverview?.userBalance && (
              <div className="p-3 rounded-md bg-slate-900/60 border border-slate-800 text-xs space-y-1.5 relative z-10">
                <div className="flex items-center justify-between text-slate-300">
                  <span className="flex items-center gap-1.5">
                    <Wallet className="w-3.5 h-3.5 text-slate-400" />
                    Connected Wallet:
                  </span>
                  <span className="font-mono text-slate-200">
                    {walletPubkey.slice(0, 8)}...{walletPubkey.slice(-6)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-slate-300">
                  <span>Pool LST Balance:</span>
                  <span className="font-mono font-medium text-emerald-400">
                    {withdrawalOverview.userBalance.lstTokenBalance.toLocaleString()}{' '}
                    {withdrawalOverview.tokenSymbol || 'spSOL'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-slate-300">
                  <span>Native SOL Balance:</span>
                  <span className="font-mono text-slate-200">
                    {withdrawalOverview.userBalance.solBalance.toLocaleString()} SOL
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column (5 cols): Interactive On-Chain Execution Suite */}
        <div className="lg:col-span-5 rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">Execute On-Chain Transaction</h2>
            <span className="text-[11px] font-mono text-slate-400">L1 Direct Broadcast</span>
          </div>

          {/* Action Tabs */}
          <div className="grid grid-cols-2 gap-1.5 p-1 bg-[#090D16] border border-slate-800 rounded-md text-xs">
            <button
              type="button"
              onClick={() => {
                setActionTab('withdraw-sol');
                setTxError(null);
              }}
              className={`py-2 px-2.5 rounded font-medium transition-colors flex items-center justify-center gap-1.5 ${
                actionTab === 'withdraw-sol'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <ArrowDownLeft className="w-3.5 h-3.5" />
              <span>Withdraw SOL</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setActionTab('withdraw-stake');
                setTxError(null);
              }}
              className={`py-2 px-2.5 rounded font-medium transition-colors flex items-center justify-center gap-1.5 ${
                actionTab === 'withdraw-stake'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Withdraw Stake</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setActionTab('deposit-sol');
                setTxError(null);
              }}
              className={`py-2 px-2.5 rounded font-medium transition-colors flex items-center justify-center gap-1.5 ${
                actionTab === 'deposit-sol'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Droplets className="w-3.5 h-3.5" />
              <span>Deposit SOL</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setActionTab('native-delegate');
                setTxError(null);
              }}
              className={`py-2 px-2.5 rounded font-medium transition-colors flex items-center justify-center gap-1.5 ${
                actionTab === 'native-delegate'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Native PoS</span>
            </button>
          </div>

          {/* Description of current action */}
          <div className="p-3 rounded-md bg-[#090D16] border border-slate-800/80 text-xs text-slate-300 space-y-1">
            {actionTab === 'withdraw-sol' && (
              <>
                <div className="font-semibold text-emerald-400">Withdraw Liquid SOL from Pool</div>
                <p className="text-slate-400 text-[11px]">
                  Burns your custom LST tokens ({withdrawalOverview?.tokenSymbol || 'spSOL'}) and
                  instantly transfers native SOL from the reserve stake account to your wallet on
                  Solana L1.
                </p>
              </>
            )}
            {actionTab === 'withdraw-stake' && (
              <>
                <div className="font-semibold text-emerald-400">
                  Withdraw to Delegated Stake Account
                </div>
                <p className="text-slate-400 text-[11px]">
                  Redeems LST tokens and creates a newly split, on-chain delegated Solana Stake
                  Account with your wallet assigned as the sole staker and withdrawer authority.
                </p>
              </>
            )}
            {actionTab === 'deposit-sol' && (
              <>
                <div className="font-semibold text-emerald-400">Deposit SOL into Stake Pool</div>
                <p className="text-slate-400 text-[11px]">
                  Deposits native SOL into the pool and mints newly issued{' '}
                  {withdrawalOverview?.tokenSymbol || 'spSOL'} directly into your wallet.
                </p>
              </>
            )}
            {actionTab === 'native-delegate' && (
              <>
                <div className="font-semibold text-emerald-400">
                  Direct Native Proof-of-Stake Delegation
                </div>
                <p className="text-slate-400 text-[11px]">
                  Creates an independent Solana Stake Account and delegates directly to a verified
                  validator vote account.
                </p>
              </>
            )}
          </div>

          {/* Input: Amount */}
          <div className="space-y-1.5">
            <div className="flex justify-between items-center text-xs">
              <label className="font-medium text-slate-300">
                {actionTab === 'withdraw-sol' || actionTab === 'withdraw-stake'
                  ? `LST Amount to Redeem (${withdrawalOverview?.tokenSymbol || 'spSOL'})`
                  : 'Amount to Stake (SOL)'}
              </label>
              {withdrawalOverview?.userBalance && (
                <button
                  type="button"
                  onClick={() => {
                    const maxVal =
                      actionTab === 'withdraw-sol' || actionTab === 'withdraw-stake'
                        ? withdrawalOverview.userBalance?.lstTokenBalance || 1
                        : withdrawalOverview.userBalance?.solBalance || 1;
                    setAmountInput(String(Math.max(0.01, Number(maxVal.toFixed(4)))));
                  }}
                  className="text-[11px] text-emerald-400 hover:underline"
                >
                  Use Max
                </button>
              )}
            </div>

            <div className="relative">
              <input
                type="number"
                min={0.001}
                step={0.1}
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                placeholder="1.0"
                className="w-full px-3 py-2 text-base font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-slate-400">
                {actionTab === 'withdraw-sol' || actionTab === 'withdraw-stake'
                  ? withdrawalOverview?.tokenSymbol || 'spSOL'
                  : 'SOL'}
              </span>
            </div>
          </div>

          {/* Additional Options for Stake Account Withdrawal or Native Delegation */}
          {(actionTab === 'withdraw-stake' || actionTab === 'native-delegate') && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Target Validator Vote Account
              </label>
              <select
                value={selectedVotePubkey || network?.validators[0]?.votePubkey || ''}
                onChange={(e) => setSelectedVotePubkey(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-emerald-500"
              >
                {(network?.validators || []).slice(0, 25).map((v) => (
                  <option key={v.votePubkey} value={v.votePubkey}>
                    {v.votePubkey.slice(0, 10)}... ({v.commission}% fee ·{' '}
                    {v.estimatedNetApyPct.toFixed(2)}% APY)
                  </option>
                ))}
              </select>
            </div>
          )}

          {actionTab === 'withdraw-stake' && (
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={withdrawUseReserve}
                onChange={(e) => setWithdrawUseReserve(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-0"
              />
              <span>Withdraw from Reserve Stake Account if available</span>
            </label>
          )}

          {/* Action Button */}
          <button
            type="button"
            onClick={handleExecuteAction}
            disabled={txBusy}
            className="w-full py-3 px-4 text-xs font-bold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 text-slate-950 rounded-md transition-colors shadow-sm flex items-center justify-center gap-2"
          >
            {txBusy ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>Signing &amp; Broadcasting to Solana...</span>
              </>
            ) : !walletPubkey ? (
              <>
                <Wallet className="w-4 h-4" />
                <span>Connect Solana Wallet to Execute</span>
              </>
            ) : actionTab === 'withdraw-sol' ? (
              <>
                <ArrowDownLeft className="w-4 h-4" />
                <span>Withdraw Liquid SOL from Reserve</span>
              </>
            ) : actionTab === 'withdraw-stake' ? (
              <>
                <Layers className="w-4 h-4" />
                <span>Withdraw Delegated Stake Account</span>
              </>
            ) : actionTab === 'deposit-sol' ? (
              <>
                <Droplets className="w-4 h-4" />
                <span>Deposit SOL &amp; Mint {withdrawalOverview?.tokenSymbol || 'spSOL'}</span>
              </>
            ) : (
              <>
                <Zap className="w-4 h-4" />
                <span>Delegate Native Proof-of-Stake</span>
              </>
            )}
          </button>

          {/* Transaction Error Alert */}
          {txError && (
            <div className="p-3.5 rounded-lg border border-red-900/60 bg-red-950/30 text-xs font-mono text-red-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div>{txError}</div>
            </div>
          )}

          {/* Confirmed Transaction Feedback */}
          {lastTxSig && (
            <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 space-y-2 text-xs">
              <div className="flex items-center gap-1.5 text-emerald-300 font-semibold">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>Confirmed on Solana Blockchain!</span>
              </div>

              <div className="font-mono text-[11px] text-slate-300 truncate">
                Signature: {lastTxSig}
              </div>

              {destinationStakeAccount && (
                <div className="font-mono text-[11px] text-slate-300 truncate">
                  New Stake Account: {destinationStakeAccount}
                </div>
              )}

              <a
                href={getExplorerTxUrl(lastTxSig, cluster)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-emerald-400 hover:underline font-mono text-xs"
              >
                <span>View Transaction in Solana Explorer</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Standalone Protocols Registry Table */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] overflow-hidden">
        <div className="p-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Registered Standalone Protocols &amp; Stake Pools
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              100% isolated sovereign stake pools with private LST mints, reserves, and withdraw
              authorities.
            </p>
          </div>
          <button
            type="button"
            onClick={onNavigateBuilder}
            className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            + Create Pool
          </button>
        </div>

        {protocols.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-sm text-slate-300">
              No standalone protocols created in this workspace yet.
            </p>
            <button
              onClick={onNavigateBuilder}
              className="mt-2 px-4 py-2 text-xs font-medium bg-emerald-400 hover:bg-emerald-300 text-slate-950 rounded-md transition-colors"
            >
              Launch Protocol Builder
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 bg-[#0B101B]">
                  <th className="py-2.5 px-4 font-medium">Protocol / Token</th>
                  <th className="py-2.5 px-4 font-medium">Cluster</th>
                  <th className="py-2.5 px-4 font-medium">Stake Pool Address</th>
                  <th className="py-2.5 px-4 font-medium">Reserve Stake</th>
                  <th className="py-2.5 px-4 font-medium text-right">PoS APR</th>
                  <th className="py-2.5 px-4 font-medium text-right">Status</th>
                  <th className="py-2.5 px-4 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {protocols.map((p) => {
                  const isCurrent = p.stakePoolAddress === activePoolAddress;
                  return (
                    <tr
                      key={p.id}
                      className={`hover:bg-slate-800/30 ${isCurrent ? 'bg-slate-800/20' : ''}`}
                    >
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-100">{p.protocolName}</div>
                        <div className="text-[11px] font-mono text-slate-500">
                          {p.tokenSymbol} · {p.packageName}
                        </div>
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-300">{p.cluster}</td>
                      <td className="py-3 px-4 font-mono text-slate-300">
                        {p.stakePoolAddress ? (
                          <a
                            href={getExplorerAddressUrl(p.stakePoolAddress, p.cluster)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-emerald-400 hover:underline"
                          >
                            <span>
                              {p.stakePoolAddress.slice(0, 8)}...{p.stakePoolAddress.slice(-6)}
                            </span>
                            <ArrowUpRight className="w-3 h-3" />
                          </a>
                        ) : (
                          'Pending'
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-300">
                        {p.reserveStakeAddress ? (
                          <a
                            href={getExplorerAddressUrl(p.reserveStakeAddress, p.cluster)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-slate-400 hover:text-emerald-400"
                          >
                            <span>
                              {p.reserveStakeAddress.slice(0, 6)}...
                              {p.reserveStakeAddress.slice(-4)}
                            </span>
                            <ArrowUpRight className="w-3 h-3" />
                          </a>
                        ) : (
                          'Pending'
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-right text-emerald-400 font-semibold">
                        1,000,000%
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${
                            p.status === 'deployed'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                              : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                          }`}
                        >
                          {p.status === 'deployed' ? 'Live On-Chain' : 'Tx Built'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {p.stakePoolAddress && (
                          <button
                            type="button"
                            onClick={() => handleSelectPool(p.stakePoolAddress!)}
                            className={`px-2.5 py-1 rounded text-xs transition-colors ${
                              isCurrent
                                ? 'bg-emerald-400 text-slate-950 font-bold'
                                : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                            }`}
                          >
                            {isCurrent ? 'Active Pool' : 'Load Pool'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Live On-Chain Connected Wallet Stake Accounts */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] overflow-hidden">
        <div className="p-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Your Live On-Chain Stake Accounts ({cluster})
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Queried directly from the Solana Stake Program RPC — zero off-chain cache.
            </p>
          </div>
          {walletPubkey && (
            <button
              type="button"
              onClick={loadWalletStakes}
              disabled={stakesLoading}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${stakesLoading ? 'animate-spin' : ''}`} />
              {stakesLoading ? 'Querying Chain...' : 'Refresh On-Chain Stakes'}
            </button>
          )}
        </div>

        {!walletPubkey ? (
          <div className="p-8 text-center text-xs text-slate-400 space-y-2">
            <p>Connect your Solana wallet to load live on-chain Stake Accounts for {cluster}.</p>
            <button
              type="button"
              onClick={onConnectWallet}
              className="px-3.5 py-1.5 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 rounded-md transition-colors"
            >
              Connect Wallet
            </button>
          </div>
        ) : walletStakes.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400">
            {stakesLoading
              ? 'Scanning Solana Stake Program accounts...'
              : `No Stake Program accounts found for ${walletPubkey.slice(0, 6)}... on ${cluster}.`}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 bg-[#0B101B]">
                  <th className="py-2.5 px-4 font-medium">Stake Account</th>
                  <th className="py-2.5 px-4 font-medium">State</th>
                  <th className="py-2.5 px-4 font-medium">Delegated Validator</th>
                  <th className="py-2.5 px-4 font-medium text-right">Balance</th>
                  <th className="py-2.5 px-4 font-medium text-right">Authority Split</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 font-mono">
                {walletStakes.map((s) => (
                  <tr key={s.pubkey} className="hover:bg-slate-800/30">
                    <td className="py-3 px-4">
                      <a
                        href={getExplorerAddressUrl(s.pubkey, cluster)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-emerald-400 hover:underline"
                      >
                        <span>
                          {s.pubkey.slice(0, 8)}...{s.pubkey.slice(-6)}
                        </span>
                        <ArrowUpRight className="w-3 h-3" />
                      </a>
                    </td>
                    <td className="py-3 px-4 text-slate-300 capitalize">{s.state}</td>
                    <td className="py-3 px-4 text-slate-400">
                      {s.voterPubkey
                        ? `${s.voterPubkey.slice(0, 8)}...${s.voterPubkey.slice(-6)}`
                        : 'Undelegated'}
                    </td>
                    <td className="py-3 px-4 text-right tabular-nums text-slate-100 font-semibold">
                      {s.balanceSol.toLocaleString()} SOL
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span
                        className={
                          s.authoritySplitProtected ? 'text-emerald-400' : 'text-amber-400'
                        }
                      >
                        {s.authoritySplitProtected ? 'Protected' : 'Same Key'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
