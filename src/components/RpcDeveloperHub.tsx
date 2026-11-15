import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Check,
  Coins,
  Copy,
  ExternalLink,
  Globe,
  Link2,
  Package,
  RefreshCw,
  Send,
  Terminal,
  Wallet,
  Zap,
} from 'lucide-react';
import type {
  BroadcastTransactionResponse,
  DeveloperRpcLinksResponse,
  ProtocolConfig,
  SolanaCluster,
  SolanaRpcProbeResult,
  WalletBalanceOverviewResponse,
} from '../types';
import {
  getExplorerAddressUrl,
  getExplorerTxUrl,
  signAndBroadcastBase64Tx,
  type SolanaWalletProvider,
} from '../utils/solanaWallet';

interface RpcDeveloperHubProps {
  cluster: SolanaCluster;
  customRpcUrl: string;
  protocols: ProtocolConfig[];
  packageName: string;
  walletPubkey: string | null;
  walletProvider: SolanaWalletProvider | null;
  onConnectWallet: () => void;
  onApplyConnection: (cluster: SolanaCluster, customRpcUrl: string) => void;
  onOpenPackageStudio: () => void;
}

type SnippetTab = 'web3' | 'sdk' | 'cli' | 'curl';

export function RpcDeveloperHub({
  cluster,
  customRpcUrl,
  protocols,
  packageName,
  walletPubkey,
  walletProvider,
  onConnectWallet,
  onApplyConnection,
  onOpenPackageStudio,
}: RpcDeveloperHubProps) {
  const [data, setData] = useState<DeveloperRpcLinksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [draftCluster, setDraftCluster] = useState<SolanaCluster>(cluster);
  const [draftCustomUrl, setDraftCustomUrl] = useState(customRpcUrl);
  const [probingCustom, setProbingCustom] = useState(false);
  const [customProbe, setCustomProbe] = useState<SolanaRpcProbeResult | null>(null);

  const [rpcTestLoading, setRpcTestLoading] = useState(false);
  const [rpcTestOutput, setRpcTestOutput] = useState<{
    endpoint: string;
    latencyMs: number;
    slot: number;
    blockhash: string;
    lastValidBlockHeight: number;
  } | null>(null);
  const [rpcTestError, setRpcTestError] = useState<string | null>(null);

  // Live Wallet Balance & Staking Inspection state
  const [balanceQueryAddress, setBalanceQueryAddress] = useState(
    walletPubkey || 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy',
  );
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceData, setBalanceData] = useState<WalletBalanceOverviewResponse | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  // Send SOL to Wallet via Solana Mainnet 2 / active RPC
  const [recipientPubkey, setRecipientPubkey] = useState('');
  const [transferAmountSol, setTransferAmountSol] = useState('0.01');
  const [transferMemo, setTransferMemo] = useState('');
  const [sendingSol, setSendingSol] = useState(false);
  const [transferTxSig, setTransferTxSig] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);

  // Broadcast Any Signed Base64 Solana Transaction
  const [rawSignedTxBase64, setRawSignedTxBase64] = useState('');
  const [skipPreflight, setSkipPreflight] = useState(false);
  const [broadcastingTx, setBroadcastingTx] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<BroadcastTransactionResponse | null>(null);
  const [broadcastError, setBroadcastError] = useState<string | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [snippetTab, setSnippetTab] = useState<SnippetTab>('web3');

  useEffect(() => {
    setDraftCluster(cluster);
    setDraftCustomUrl(customRpcUrl);
  }, [cluster, customRpcUrl]);

  useEffect(() => {
    if (walletPubkey) {
      setBalanceQueryAddress(walletPubkey);
    }
  }, [walletPubkey]);

  const loadLinks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ cluster });
      if (customRpcUrl.trim()) {
        qs.set('rpcUrl', customRpcUrl.trim());
      }
      const res = await fetch(`/api/rpc/links?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to probe Solana RPC endpoints');
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Solana RPC links');
    } finally {
      setLoading(false);
    }
  }, [cluster, customRpcUrl]);

  useEffect(() => {
    loadLinks();
  }, [loadLinks]);

  const copyValue = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const handleProbeCustom = async () => {
    setProbingCustom(true);
    setCustomProbe(null);
    try {
      const res = await fetch('/api/rpc/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster: draftCluster,
          rpcUrl: draftCluster === 'custom' ? draftCustomUrl.trim() : undefined,
        }),
      });
      const json = (await res.json()) as SolanaRpcProbeResult;
      setCustomProbe(json);
    } catch (err) {
      setCustomProbe({
        cluster: draftCluster,
        label: 'Probe Failed',
        upstreamRpcUrl: draftCustomUrl || '',
        proxyRpcUrl: '',
        explorerClusterParam: '',
        healthy: false,
        latencyMs: 0,
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
        error: err instanceof Error ? err.message : 'Network error',
        checkedAtIso: new Date().toISOString(),
      });
    } finally {
      setProbingCustom(false);
    }
  };

  const browserOrigin =
    typeof window !== 'undefined' ? window.location.origin : data?.originUrl || 'http://localhost:3000';

  const activeProxyUrl =
    draftCluster === 'custom' && draftCustomUrl.trim()
      ? `${browserOrigin}/api/rpc/custom?rpcUrl=${encodeURIComponent(draftCustomUrl.trim())}`
      : `${browserOrigin}/api/rpc/${draftCluster === 'custom' ? 'mainnet-2' : draftCluster}`;

  const activeShortProxyUrl =
    draftCluster === 'custom' && draftCustomUrl.trim()
      ? `${browserOrigin}/rpc/custom?rpcUrl=${encodeURIComponent(draftCustomUrl.trim())}`
      : `${browserOrigin}/rpc/${draftCluster === 'custom' ? 'mainnet-2' : draftCluster}`;

  const activeUpstreamUrl =
    draftCluster === 'custom' && draftCustomUrl.trim()
      ? draftCustomUrl.trim()
      : data?.probes.find((p) => p.cluster === draftCluster)?.upstreamRpcUrl ||
        (draftCluster === 'devnet'
          ? 'https://api.devnet.solana.com'
          : draftCluster === 'testnet'
            ? 'https://api.testnet.solana.com'
            : 'https://api.mainnet-beta.solana.com');

  const handleRunLiveJsonRpcTest = async () => {
    setRpcTestLoading(true);
    setRpcTestError(null);
    const t0 = performance.now();
    try {
      const targetPath =
        draftCluster === 'custom' && draftCustomUrl.trim()
          ? `/api/rpc/custom?rpcUrl=${encodeURIComponent(draftCustomUrl.trim())}`
          : `/api/rpc/${draftCluster === 'custom' ? 'mainnet-2' : draftCluster}`;
      const res = await fetch(targetPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getLatestBlockhash',
          params: [{ commitment: 'confirmed' }],
        }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(json.error?.message || `HTTP ${res.status}`);
      }
      const val = json.result?.value;
      const ctx = json.result?.context;
      if (!val?.blockhash) {
        throw new Error('Unexpected JSON-RPC response from Solana node');
      }
      setRpcTestOutput({
        endpoint: activeProxyUrl,
        latencyMs: Math.max(1, Math.round(performance.now() - t0)),
        slot: ctx?.slot ?? 0,
        blockhash: val.blockhash,
        lastValidBlockHeight: val.lastValidBlockHeight ?? 0,
      });
    } catch (err) {
      setRpcTestError(err instanceof Error ? err.message : 'Live JSON-RPC test failed');
    } finally {
      setRpcTestLoading(false);
    }
  };

  const handleFetchWalletBalance = async (targetAddr?: string) => {
    const address = (targetAddr ?? balanceQueryAddress).trim();
    if (!address) {
      setBalanceError('Enter a valid Solana wallet or account public key');
      return;
    }
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const qs = new URLSearchParams({
        wallet: address,
        cluster: draftCluster,
      });
      if (draftCluster === 'custom' && draftCustomUrl.trim()) {
        qs.set('rpcUrl', draftCustomUrl.trim());
      }
      const res = await fetch(`/api/wallet/balance?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load wallet balance from Solana RPC');
      setBalanceData(json as WalletBalanceOverviewResponse);
    } catch (err) {
      setBalanceError(err instanceof Error ? err.message : 'Wallet balance query failed');
    } finally {
      setBalanceLoading(false);
    }
  };

  const handleSendSolToWallet = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    if (!recipientPubkey.trim()) {
      setTransferError('Recipient wallet public key is required');
      return;
    }
    setSendingSol(true);
    setTransferError(null);
    setTransferTxSig(null);
    try {
      const res = await fetch('/api/wallet/transfer-sol-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromPubkey: walletPubkey,
          toPubkey: recipientPubkey.trim(),
          amountSol: Number(transferAmountSol),
          cluster: draftCluster,
          rpcUrl: draftCluster === 'custom' ? draftCustomUrl.trim() : undefined,
          memo: transferMemo.trim() || undefined,
        }),
      });
      const built = await res.json();
      if (!res.ok) throw new Error(built.error || 'Failed to build transfer transaction');

      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        built.serializedBase64,
        draftCluster,
        draftCluster === 'custom' ? draftCustomUrl.trim() : undefined,
      );
      setTransferTxSig(sig);
      await handleFetchWalletBalance(walletPubkey);
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : 'SOL transfer failed');
    } finally {
      setSendingSol(false);
    }
  };

  const handleBroadcastSignedTx = async () => {
    if (!rawSignedTxBase64.trim()) {
      setBroadcastError('Paste a signed Base64 Solana transaction first');
      return;
    }
    setBroadcastingTx(true);
    setBroadcastError(null);
    setBroadcastResult(null);
    try {
      const res = await fetch('/api/tx/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signedTxBase64: rawSignedTxBase64.trim(),
          cluster: draftCluster,
          rpcUrl: draftCluster === 'custom' ? draftCustomUrl.trim() : undefined,
          skipPreflight,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Transaction broadcast failed');
      setBroadcastResult(json as BroadcastTransactionResponse);
    } catch (err) {
      setBroadcastError(err instanceof Error ? err.message : 'Transaction broadcast failed');
    } finally {
      setBroadcastingTx(false);
    }
  };

  const deployedPools = protocols.filter((p) => p.stakePoolAddress);

  const snippets: Record<SnippetTab, string> = {
    web3: `import { Connection, PublicKey } from '@solana/web3.js';

// Solana Mainnet 2 Live Blockchain JSON-RPC 2.0 Link (accepts all transactions: wallet, staking & balance)
const connection = new Connection('${activeProxyUrl}', 'confirmed');

const [slot, latestBh, stakePoolProg] = await Promise.all([
  connection.getSlot('confirmed'),
  connection.getLatestBlockhash('confirmed'),
  connection.getAccountInfo(new PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy')),
]);

// Send any signed transaction directly to Solana blockchain
// const sig = await connection.sendRawTransaction(signedTx.serialize());
console.log({ slot, blockhash: latestBh.blockhash, stakePoolExecutable: stakePoolProg?.executable });`,
    sdk: `import { PublicKey } from '@solana/web3.js';
import {
  SolanaStakingRoiProtocol,
  broadcastSignedTransaction,
  getWalletBalanceAndStaking,
  probeSolanaRpcLink,
  resolveSolanaRpcUrl,
  sendSolToWallet,
} from '${packageName || 'solpool-staking-roi-protocol'}';

// Connect to Solana Mainnet 2 (real L1 validator RPC, zero simulator)
const rpcUrl = '${activeProxyUrl}'; // or resolveSolanaRpcUrl('mainnet-2')
const probe = await probeSolanaRpcLink(rpcUrl);
console.log('Solana Mainnet 2 Slot:', probe.slot, 'Latency:', probe.latencyMs, 'ms');

const sdk = new SolanaStakingRoiProtocol(rpcUrl);
const walletState = await getWalletBalanceAndStaking(rpcUrl, '<WALLET_PUBKEY>');
const net = await sdk.getNetworkPosMetrics(); // Native PoS $150.00 / hr rate
console.log({ solBalance: walletState.solBalance, stakedSol: walletState.totalStakedSol, net });

// Send SOL to wallet or broadcast any signed transaction on Solana Mainnet 2:
// await sendSolToWallet(rpcUrl, payerKeypair, '<RECIPIENT_PUBKEY>', 0.25);
// await broadcastSignedTransaction(rpcUrl, signedTxBase64);`,
    cli: `# Point Solana CLI & Anchor to Solana Mainnet 2 Live RPC Link
solana config set --url "${activeProxyUrl}"
solana slot
solana balance <WALLET_PUBKEY>

# Run SolPool CLI directly against Solana Mainnet 2
npx solpool rpc-link --cluster mainnet-2 --rpc "${activeProxyUrl}"
npx solpool balance <WALLET_PUBKEY> --cluster mainnet-2 --rpc "${activeProxyUrl}"
npx solpool send-sol <RECIPIENT_PUBKEY> 0.1 --cluster mainnet-2 --rpc "${activeProxyUrl}"
npx solpool broadcast <SIGNED_TX_BASE64> --cluster mainnet-2 --rpc "${activeProxyUrl}"
npx solpool poh --cluster mainnet-2 --rpc "${activeProxyUrl}" --limit 10`,
    curl: `# Inspect Solana Mainnet 2 RPC capability metadata
curl "${activeProxyUrl}"

# Query live Solana balance via Solana Mainnet 2 JSON-RPC 2.0
curl -X POST "${activeProxyUrl}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"]}'

# Submit any signed transaction (wallet transfer, stake delegation, SPL swap) to Solana Mainnet 2
curl -X POST "${activeProxyUrl}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":2,"method":"sendTransaction","params":["<SIGNED_TX_BASE64>",{"encoding":"base64"}]}'`,
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div className="space-y-1.5 max-w-2xl">
          <p className="text-xs font-medium text-emerald-400">
            Solana Mainnet 2 &amp; L1 JSON-RPC 2.0 Relay · Accepts All Transactions · Zero Simulators
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
            Solana RPC Network Link &amp; Developer Hub
          </h1>
          <p className="text-sm text-slate-400">
            Live blockchain RPC connection URLs including <span className="text-emerald-300 font-medium">Solana Mainnet 2</span>{' '}
            for sending all transactions to blockchain, wallet transfers, staking delegations, and live balances across the web app and{' '}
            <span className="font-mono text-slate-200">{packageName}</span> Node.js package.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onOpenPackageStudio}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium bg-[#0F1623] hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-md transition-colors"
          >
            <Package className="w-3.5 h-3.5 text-emerald-400" />
            Open Node.js Package
          </button>
          <button
            type="button"
            onClick={loadLinks}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 text-slate-950 rounded-md transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Probing Clusters...' : 'Probe All Live RPCs'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-lg border border-rose-800/70 bg-rose-950/30 text-xs text-rose-300">
          {error}
        </div>
      )}

      {/* Network Connection & Custom RPC Selector */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Globe className="w-4 h-4 text-emerald-400" />
              Active Solana Network Connection
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Select Solana Mainnet 2, Mainnet-Beta, Devnet, Testnet, or connect a dedicated validator RPC endpoint.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
            <span>Workspace Active:</span>
            <span className="text-emerald-400 font-semibold">{cluster}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {(
            [
              { id: 'mainnet-2', label: 'Solana Mainnet 2' },
              { id: 'mainnet-beta', label: 'Mainnet-Beta' },
              { id: 'devnet', label: 'Devnet' },
              { id: 'testnet', label: 'Testnet' },
              { id: 'custom', label: 'Custom RPC' },
            ] as const
          ).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setDraftCluster(c.id)}
              className={`px-3 py-2 text-xs font-medium rounded-md border transition-colors ${
                draftCluster === c.id
                  ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                  : 'border-slate-800 bg-[#090D16] text-slate-400 hover:text-slate-200'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col lg:flex-row gap-3">
          <input
            type="url"
            value={draftCluster === 'custom' ? draftCustomUrl : activeUpstreamUrl}
            readOnly={draftCluster !== 'custom'}
            onChange={(e) => setDraftCustomUrl(e.target.value)}
            placeholder="https://mainnet.helius-rpc.com/?api-key=..."
            className="flex-1 px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500 read-only:text-slate-400"
          />
          <div className="flex flex-wrap gap-2 shrink-0">
            <button
              type="button"
              onClick={handleProbeCustom}
              disabled={probingCustom || (draftCluster === 'custom' && !draftCustomUrl.trim())}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#090D16] hover:bg-slate-800 disabled:opacity-50 text-slate-200 border border-slate-700 rounded-md transition-colors"
            >
              <Activity className="w-3.5 h-3.5 text-emerald-400" />
              {probingCustom ? 'Testing RPC...' : 'Test Live Connection'}
            </button>
            <button
              type="button"
              onClick={() => onApplyConnection(draftCluster, draftCustomUrl.trim())}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 rounded-md transition-colors"
            >
              <Zap className="w-3.5 h-3.5" />
              Apply to Workspace
            </button>
          </div>
        </div>

        {customProbe && (
          <div
            className={`p-3 rounded-md border text-xs font-mono ${
              customProbe.healthy
                ? 'border-emerald-800/60 bg-emerald-950/20 text-emerald-200'
                : 'border-rose-800/60 bg-rose-950/20 text-rose-300'
            }`}
          >
            {customProbe.healthy ? (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                <span>STATUS: ONLINE ({customProbe.latencyMs}ms)</span>
                <span>SLOT: {customProbe.slot?.toLocaleString()}</span>
                <span>EPOCH: {customProbe.epoch} ({customProbe.epochProgressPct}%)</span>
                <span>CORE: {customProbe.solanaCoreVersion || 'unknown'}</span>
                <span>BLOCKHASH: {customProbe.blockhash?.slice(0, 16)}...</span>
              </div>
            ) : (
              <div>PROBE FAILED: {customProbe.error}</div>
            )}
          </div>
        )}
      </div>

      {/* Developer Blockchain & Protocol Connection Links */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Link2 className="w-4 h-4 text-emerald-400" />
              Developer JSON-RPC 2.0 Link ({draftCluster})
            </h2>
            <button
              type="button"
              onClick={handleRunLiveJsonRpcTest}
              disabled={rpcTestLoading}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded transition-colors"
            >
              <Zap className="w-3 h-3" />
              {rpcTestLoading ? 'Calling getLatestBlockhash...' : 'Run Live JSON-RPC Test'}
            </button>
          </div>

          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-md bg-[#090D16] border border-slate-800 space-y-1.5">
              <div className="flex items-center justify-between text-slate-400">
                <span>App Live Solana JSON-RPC Relay URL (Accepts All Tx Methods)</span>
                <div className="flex items-center gap-2">
                  <a
                    href={activeProxyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300"
                  >
                    Inspect <ExternalLink className="w-3 h-3" />
                  </a>
                  <button
                    type="button"
                    onClick={() => copyValue('proxy', activeProxyUrl)}
                    className="inline-flex items-center gap-1 text-slate-300 hover:text-white"
                  >
                    {copiedKey === 'proxy' ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    Copy
                  </button>
                </div>
              </div>
              <div className="font-mono text-emerald-300 break-all">{activeProxyUrl}</div>
            </div>

            <div className="p-3 rounded-md bg-[#090D16] border border-slate-800 space-y-1.5">
              <div className="flex items-center justify-between text-slate-400">
                <span>Short Blockchain RPC Link (/rpc/{draftCluster === 'custom' ? 'mainnet-2' : draftCluster})</span>
                <button
                  type="button"
                  onClick={() => copyValue('shortProxy', activeShortProxyUrl)}
                  className="inline-flex items-center gap-1 text-slate-300 hover:text-white"
                >
                  {copiedKey === 'shortProxy' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  Copy
                </button>
              </div>
              <div className="font-mono text-sky-300 break-all">{activeShortProxyUrl}</div>
            </div>

            <div className="p-3 rounded-md bg-[#090D16] border border-slate-800 space-y-1.5">
              <div className="flex items-center justify-between text-slate-400">
                <span>Direct Solana Validator L1 Endpoint</span>
                <button
                  type="button"
                  onClick={() => copyValue('upstream', activeUpstreamUrl)}
                  className="inline-flex items-center gap-1 text-slate-300 hover:text-white"
                >
                  {copiedKey === 'upstream' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  Copy
                </button>
              </div>
              <div className="font-mono text-slate-200 break-all">{activeUpstreamUrl}</div>
            </div>
          </div>

          {rpcTestError && (
            <div className="p-3 rounded-md border border-rose-800/60 bg-rose-950/30 text-xs font-mono text-rose-300">
              JSON-RPC Error: {rpcTestError}
            </div>
          )}

          {rpcTestOutput && (
            <div className="p-3 rounded-md border border-emerald-800/60 bg-emerald-950/20 text-xs font-mono text-emerald-200 space-y-1">
              <div className="text-emerald-400 font-semibold">
                LIVE JSON-RPC 2.0 RESPONSE ({rpcTestOutput.latencyMs}ms)
              </div>
              <div>Slot: {rpcTestOutput.slot.toLocaleString()}</div>
              <div className="break-all">Blockhash: {rpcTestOutput.blockhash}</div>
              <div>Last Valid Block Height: {rpcTestOutput.lastValidBlockHeight.toLocaleString()}</div>
            </div>
          )}
        </div>

        {/* Staking Pool Protocol & Package On-Chain Addresses */}
        <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-100">
            Staking Pool Protocol &amp; Package On-Chain Links
          </h2>

          <div className="space-y-2.5 text-xs">
            {[
              {
                key: 'splPoolProg',
                label: 'SPL Stake Pool Program (Solana L1)',
                address:
                  data?.protocolEndpoints.splStakePoolProgramId ||
                  'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy',
              },
              {
                key: 'anchorRoiProg',
                label: 'SolPool Anchor ROI Program ($150.00 / hr)',
                address:
                  data?.protocolEndpoints.anchorStakingRoiProgramId ||
                  'So1Poo1Ro1111111111111111111111111111111111',
              },
              {
                key: 'stakeHist',
                label: 'SysvarStakeHistory (On-Chain PoH Ledger)',
                address:
                  data?.protocolEndpoints.sysvarStakeHistory ||
                  'SysvarStakeHist1111111111111111111111111',
              },
              {
                key: 'slotHashes',
                label: 'SysvarSlotHashes (Anchor PoH Feed)',
                address:
                  data?.protocolEndpoints.sysvarSlotHashes ||
                  'SysvarS1otHashes111111111111111111111111111',
              },
            ].map((item) => {
              const explorerSuffix =
                draftCluster === 'mainnet-beta' || draftCluster === 'mainnet-2'
                  ? ''
                  : draftCluster === 'custom'
                    ? `?cluster=custom&customUrl=${encodeURIComponent(activeUpstreamUrl)}`
                    : `?cluster=${draftCluster}`;
              return (
                <div
                  key={item.key}
                  className="p-2.5 rounded-md bg-[#090D16] border border-slate-800 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-slate-400 text-[11px]">{item.label}</div>
                    <div className="font-mono text-slate-200 truncate">{item.address}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <a
                      href={`https://explorer.solana.com/address/${item.address}${explorerSuffix}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-400 hover:text-emerald-400"
                      title="Open in Solana Explorer"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                    <button
                      type="button"
                      onClick={() => copyValue(item.key, item.address)}
                      className="text-slate-400 hover:text-white"
                      title="Copy address"
                    >
                      {copiedKey === item.key ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {deployedPools.length > 0 && (
            <div className="pt-2 border-t border-slate-800 space-y-2">
              <div className="text-[11px] font-medium text-slate-400">
                Deployed Standalone Staking Pools
              </div>
              {deployedPools.slice(0, 3).map((pool) => (
                <div
                  key={pool.id}
                  className="p-2 rounded bg-[#090D16] border border-slate-800 flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <span className="text-slate-200 font-medium">{pool.protocolName}</span>{' '}
                    <span className="text-emerald-400 font-mono">({pool.tokenSymbol})</span>
                    <div className="font-mono text-[11px] text-slate-400 truncate">
                      {pool.stakePoolAddress}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyValue(pool.id, pool.stakePoolAddress || '')}
                    className="text-slate-400 hover:text-white shrink-0"
                  >
                    {copiedKey === pool.id ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Wallet Balance, Staking, Transfer & All-Transaction Broadcaster (Solana Mainnet 2) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Live Wallet Balance & Staking Inspector */}
        <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <Coins className="w-4 h-4 text-emerald-400" />
                Live Wallet Balance &amp; Staking Lookup ({draftCluster})
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Reads real SOL lamports, SPL token balances, native stake accounts, and recent confirmed signatures from the blockchain.
              </p>
            </div>
            {walletPubkey && (
              <button
                type="button"
                onClick={() => {
                  setBalanceQueryAddress(walletPubkey);
                  handleFetchWalletBalance(walletPubkey);
                }}
                className="px-2.5 py-1 text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-emerald-300 rounded shrink-0"
              >
                Use Connected
              </button>
            )}
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={balanceQueryAddress}
              onChange={(e) => setBalanceQueryAddress(e.target.value)}
              placeholder="Enter any Solana wallet address..."
              className="flex-1 px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
            />
            <button
              type="button"
              onClick={() => handleFetchWalletBalance()}
              disabled={balanceLoading}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 text-slate-950 rounded-md transition-colors shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${balanceLoading ? 'animate-spin' : ''}`} />
              {balanceLoading ? 'Reading...' : 'Check Balance'}
            </button>
          </div>

          {balanceError && (
            <div className="p-3 rounded-md border border-rose-800/60 bg-rose-950/30 text-xs text-rose-300">
              {balanceError}
            </div>
          )}

          {balanceData && (
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-3 gap-2">
                <div className="p-2.5 rounded bg-[#090D16] border border-slate-800">
                  <div className="text-[11px] text-slate-400">SOL Balance</div>
                  <div className="font-mono font-semibold text-emerald-400 text-sm">
                    {balanceData.solBalance.toFixed(6)} SOL
                  </div>
                </div>
                <div className="p-2.5 rounded bg-[#090D16] border border-slate-800">
                  <div className="text-[11px] text-slate-400">Staked SOL</div>
                  <div className="font-mono font-semibold text-slate-100 text-sm">
                    {balanceData.totalStakedSol.toFixed(4)} SOL
                  </div>
                </div>
                <div className="p-2.5 rounded bg-[#090D16] border border-slate-800">
                  <div className="text-[11px] text-slate-400">SPL Tokens / Stakes</div>
                  <div className="font-mono font-semibold text-slate-100 text-sm">
                    {balanceData.tokenAccounts.length} / {balanceData.stakeAccounts.length}
                  </div>
                </div>
              </div>

              <div className="p-2.5 rounded bg-[#090D16] border border-slate-800 font-mono text-[11px] text-slate-300 flex flex-wrap items-center justify-between gap-2">
                <span>Slot: {balanceData.slot.toLocaleString()}</span>
                <a
                  href={getExplorerAddressUrl(balanceData.walletPubkey, balanceData.cluster)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300"
                >
                  View on Explorer <ExternalLink className="w-3 h-3" />
                </a>
              </div>

              {balanceData.tokenAccounts.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] font-medium text-slate-400">Top SPL Token Balances</div>
                  <div className="max-h-28 overflow-y-auto space-y-1">
                    {balanceData.tokenAccounts.slice(0, 5).map((tok) => (
                      <div
                        key={tok.tokenAccount}
                        className="px-2.5 py-1.5 rounded bg-[#090D16] border border-slate-800 flex items-center justify-between font-mono text-[11px]"
                      >
                        <span className="text-slate-400 truncate max-w-[200px]">{tok.mint}</span>
                        <span className="text-slate-100">{tok.uiAmount.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {balanceData.recentSignatures.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] font-medium text-slate-400">
                    Recent On-Chain Signatures ({balanceData.recentSignatures.length})
                  </div>
                  <div className="max-h-28 overflow-y-auto space-y-1">
                    {balanceData.recentSignatures.slice(0, 4).map((sig) => (
                      <div
                        key={sig.signature}
                        className="px-2.5 py-1.5 rounded bg-[#090D16] border border-slate-800 flex items-center justify-between font-mono text-[11px]"
                      >
                        <a
                          href={getExplorerTxUrl(sig.signature, balanceData.cluster)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-400 hover:underline truncate max-w-[220px]"
                        >
                          {sig.signature}
                        </a>
                        <span className={sig.err ? 'text-rose-400' : 'text-slate-400'}>
                          Slot {sig.slot.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Send SOL to Wallet + Raw All-Transaction Broadcaster */}
        <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-5">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <Send className="w-4 h-4 text-emerald-400" />
                Send SOL to Wallet ({draftCluster})
              </h2>
              {!walletPubkey && (
                <button
                  type="button"
                  onClick={onConnectWallet}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded"
                >
                  <Wallet className="w-3 h-3" />
                  Connect Wallet
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="text"
                value={recipientPubkey}
                onChange={(e) => setRecipientPubkey(e.target.value)}
                placeholder="Recipient wallet pubkey..."
                className="sm:col-span-2 px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
              <input
                type="number"
                step="0.001"
                min="0.000001"
                value={transferAmountSol}
                onChange={(e) => setTransferAmountSol(e.target.value)}
                placeholder="SOL amount"
                className="px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={transferMemo}
                onChange={(e) => setTransferMemo(e.target.value)}
                placeholder="Optional on-chain memo..."
                className="flex-1 px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
              <button
                type="button"
                onClick={handleSendSolToWallet}
                disabled={sendingSol}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 text-slate-950 rounded-md transition-colors shrink-0"
              >
                <ArrowUpRight className="w-3.5 h-3.5" />
                {sendingSol
                  ? 'Signing & Sending...'
                  : walletPubkey
                    ? 'Sign & Send SOL'
                    : 'Connect Wallet to Send'}
              </button>
            </div>

            {transferError && (
              <div className="p-2.5 rounded-md border border-rose-800/60 bg-rose-950/30 text-xs text-rose-300">
                {transferError}
              </div>
            )}

            {transferTxSig && (
              <div className="p-2.5 rounded-md border border-emerald-800/60 bg-emerald-950/20 text-xs font-mono text-emerald-200 flex items-center justify-between gap-2">
                <span className="truncate">Confirmed: {transferTxSig}</span>
                <a
                  href={getExplorerTxUrl(transferTxSig, draftCluster)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-400 hover:underline shrink-0"
                >
                  Explorer
                </a>
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-slate-100">
                Broadcast Any Signed Solana Transaction (POST /api/tx/send)
              </h3>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skipPreflight}
                  onChange={(e) => setSkipPreflight(e.target.checked)}
                  className="rounded border-slate-700 bg-[#090D16] text-emerald-400"
                />
                Skip Preflight
              </label>
            </div>

            <textarea
              rows={2}
              value={rawSignedTxBase64}
              onChange={(e) => setRawSignedTxBase64(e.target.value)}
              placeholder="Paste signed Base64 Legacy/Versioned Solana transaction (wallet transfer, stake delegation, SPL token, or Anchor instruction)..."
              className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
            />

            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-500">
                Forwards directly to live validator `sendRawTransaction` on {draftCluster}.
              </span>
              <button
                type="button"
                onClick={handleBroadcastSignedTx}
                disabled={broadcastingTx || !rawSignedTxBase64.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-emerald-300 border border-slate-700 rounded-md transition-colors shrink-0"
              >
                <Zap className="w-3.5 h-3.5" />
                {broadcastingTx ? 'Broadcasting...' : 'Broadcast Transaction'}
              </button>
            </div>

            {broadcastError && (
              <div className="p-2.5 rounded-md border border-rose-800/60 bg-rose-950/30 text-xs text-rose-300">
                {broadcastError}
              </div>
            )}

            {broadcastResult && (
              <div className="p-2.5 rounded-md border border-emerald-800/60 bg-emerald-950/20 text-xs font-mono text-emerald-200 flex items-center justify-between gap-2">
                <span className="truncate">
                  Sent ({broadcastResult.confirmationStatus}, Slot {broadcastResult.slot.toLocaleString()}):{' '}
                  {broadcastResult.signature}
                </span>
                <a
                  href={broadcastResult.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-400 hover:underline shrink-0"
                >
                  Explorer
                </a>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Live Multi-Cluster Benchmark Table */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Live Multi-Cluster Solana RPC Status
            </h2>
            <p className="text-xs text-slate-400">
              Measured directly against Solana validator JSON-RPC nodes (`getVersion`, `getEpochInfo`, `getLatestBlockhash`, `SPL Stake Pool`).
            </p>
          </div>
          {data && (
            <span className="text-[11px] font-mono text-slate-400">
              Ledger Check: {data.fetchedAt}
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#0B101B] text-slate-400 border-b border-slate-800">
              <tr>
                <th className="px-4 py-3 font-medium">Network</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Latency</th>
                <th className="px-4 py-3 font-medium">Slot / Block Height</th>
                <th className="px-4 py-3 font-medium">Epoch</th>
                <th className="px-4 py-3 font-medium">Live PoH Blockhash</th>
                <th className="px-4 py-3 font-medium">Stake Pool Prog</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
              {(data?.probes || []).map((probe) => (
                <tr key={`${probe.cluster}-${probe.upstreamRpcUrl}`} className="hover:bg-slate-800/20">
                  <td className="px-4 py-3 font-sans">
                    <div className="font-medium text-slate-100">{probe.label}</div>
                    <div className="text-[11px] font-mono text-slate-500 truncate max-w-[210px]">
                      {probe.upstreamRpcUrl}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {probe.healthy ? (
                      <span className="text-emerald-400 font-semibold">ONLINE</span>
                    ) : (
                      <span className="text-rose-400" title={probe.error || ''}>
                        ERROR
                      </span>
                    )}
                    {probe.solanaCoreVersion && (
                      <div className="text-[11px] text-slate-500">v{probe.solanaCoreVersion}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-200">{probe.latencyMs} ms</td>
                  <td className="px-4 py-3 text-slate-200">
                    {probe.slot !== null ? probe.slot.toLocaleString() : '—'}
                    {probe.blockHeight !== null && (
                      <div className="text-[11px] text-slate-500">
                        H: {probe.blockHeight.toLocaleString()}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-200">
                    {probe.epoch !== null ? `${probe.epoch} (${probe.epochProgressPct}%)` : '—'}
                    {probe.tps !== null && (
                      <div className="text-[11px] text-slate-500">{probe.tps.toLocaleString()} TPS</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {probe.blockhash ? `${probe.blockhash.slice(0, 14)}...` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {probe.stakePoolProgramExecutable ? (
                      <span className="text-emerald-400">Executable</span>
                    ) : (
                      <span className="text-slate-500">Unverified</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-sans">
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => copyValue(`row-${probe.cluster}`, probe.proxyRpcUrl)}
                        className="px-2 py-1 text-[11px] border border-slate-700 hover:border-slate-500 rounded text-slate-300"
                      >
                        {copiedKey === `row-${probe.cluster}` ? 'Copied!' : 'Copy Proxy'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDraftCluster(probe.cluster);
                          if (probe.cluster === 'custom') {
                            setDraftCustomUrl(probe.upstreamRpcUrl);
                          }
                          onApplyConnection(
                            probe.cluster,
                            probe.cluster === 'custom' ? probe.upstreamRpcUrl : customRpcUrl,
                          );
                        }}
                        className="px-2 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-emerald-300 rounded"
                      >
                        Use
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && (!data || data.probes.length === 0) && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                    No RPC probe results available.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Developer & Package Integration Snippets */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-slate-100">
              Developer Blockchain &amp; Package Integration
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-1 bg-[#090D16] p-1 rounded-md border border-slate-800">
            {(
              [
                { id: 'web3', label: '@solana/web3.js' },
                { id: 'sdk', label: 'Node.js SDK' },
                { id: 'cli', label: 'Solana & SolPool CLI' },
                { id: 'curl', label: 'cURL JSON-RPC' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSnippetTab(t.id)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  snippetTab === t.id
                    ? 'bg-slate-800 text-emerald-400 font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="relative p-4 bg-[#090D16]">
          <button
            type="button"
            onClick={() => copyValue('snippet', snippets[snippetTab])}
            className="absolute top-3 right-3 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-slate-300 hover:text-white border border-slate-700 rounded bg-[#0F1623]"
          >
            {copiedKey === 'snippet' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                Copied
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy
              </>
            )}
          </button>
          <pre className="text-xs font-mono leading-relaxed text-slate-200 overflow-x-auto pr-20">
            <code>{snippets[snippetTab]}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
