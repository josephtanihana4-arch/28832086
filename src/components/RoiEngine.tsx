import { useEffect, useState } from 'react';
import type { NetworkOverview, RoiCalculationResult, SolanaCluster } from '../types';
import { RoiChart } from './RoiChart';

interface RoiEngineProps {
  cluster: SolanaCluster;
  customRpcUrl?: string;
  network: NetworkOverview | null;
  defaultEpochFeePct: number;
  defaultBoostAprPct: number;
  onSyncToProtocol: (params: { epochFeeBps: number; protocolBoostAprPct: number }) => void;
}

function formatLargeSol(val: number): string {
  if (!Number.isFinite(val)) return '0';
  const abs = Math.abs(val);
  if (abs >= 1e15) return `${(val / 1e15).toLocaleString(undefined, { maximumFractionDigits: 2 })}Q`;
  if (abs >= 1e12) return `${(val / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })}T`;
  if (abs >= 1e9) return `${(val / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })}B`;
  if (abs >= 1e6) return `${(val / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}M`;
  return val.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function RoiEngine({
  cluster,
  customRpcUrl,
  network,
  defaultEpochFeePct,
  defaultBoostAprPct,
  onSyncToProtocol,
}: RoiEngineProps) {
  const [principalSol, setPrincipalSol] = useState(100);
  const [baseNetworkAprPct, setBaseNetworkAprPct] = useState(
    network?.baseNetworkAprPct || 1_000_000,
  );
  const [validatorCommissionPct, setValidatorCommissionPct] = useState(0);
  const [poolManagementFeePct, setPoolManagementFeePct] = useState(defaultEpochFeePct);
  const [protocolBoostAprPct, setProtocolBoostAprPct] = useState(defaultBoostAprPct);
  const [liveSolUsdPrice, setLiveSolUsdPrice] = useState<number | null>(null);
  const [solPriceUsd, setSolPriceUsd] = useState(180);
  const [horizonDays, setHorizonDays] = useState(30);
  const [result, setResult] = useState<RoiCalculationResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (network?.baseNetworkAprPct) {
      setBaseNetworkAprPct(network.baseNetworkAprPct);
    }
  }, [network?.baseNetworkAprPct]);

  useEffect(() => {
    let active = true;
    const loadLivePrice = async () => {
      try {
        const qs = new URLSearchParams({ cluster });
        if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
        const res = await fetch(`/api/usd-stream/snapshot?${qs.toString()}`);
        if (res.ok && active) {
          const json = await res.json();
          if (typeof json.solUsdPrice === 'number' && json.solUsdPrice > 0) {
            setLiveSolUsdPrice(json.solUsdPrice);
            setSolPriceUsd(json.solUsdPrice);
          }
        }
      } catch {
        // Ignore transient price fetch issues
      }
    };
    loadLivePrice();
    return () => {
      active = false;
    };
  }, [cluster, customRpcUrl]);

  useEffect(() => {
    if (solPriceUsd <= 0) return;
    let active = true;
    const run = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/roi/calculate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            principalSol,
            baseNetworkAprPct,
            validatorCommissionPct,
            poolManagementFeePct,
            protocolBoostAprPct,
            solPriceUsd,
            horizonDays,
            epochsPerYear: network?.epochsPerYear || 173.9,
            compoundingMode: 'simple',
          }),
        });
        if (res.ok && active) {
          setResult(await res.json());
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    run();
    return () => {
      active = false;
    };
  }, [
    principalSol,
    baseNetworkAprPct,
    validatorCommissionPct,
    poolManagementFeePct,
    protocolBoostAprPct,
    solPriceUsd,
    horizonDays,
    network?.epochsPerYear,
  ]);

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div className="space-y-1.5 max-w-2xl">
          <p className="text-xs font-medium text-emerald-400">
            Live On-Chain Solana Native PoS · 1,000,000% APR permilsec ({cluster})
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
            Native PoS Staking ROI &amp; Permilsec APR Engine
          </h1>
          <p className="text-sm text-slate-400">
            Computes live on-chain Solana Native Proof-of-Stake yield at{' '}
            <span className="font-mono text-slate-200">1,000,000% permilsec</span> (10,000x
            principal per millisecond), factoring validator commission, pool epoch fees, and
            optional on-chain protocol boosts.
          </p>
        </div>

        <button
          onClick={() =>
            onSyncToProtocol({
              epochFeeBps: Math.round(poolManagementFeePct * 100),
              protocolBoostAprPct,
            })
          }
          className="px-4 py-2 text-xs font-medium bg-emerald-400 hover:bg-emerald-300 text-slate-950 rounded-md transition-colors whitespace-nowrap shrink-0"
        >
          Apply Fee &amp; Boost to Protocol Builder
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-4 rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-5">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              Staked Principal (SOL)
            </label>
            <input
              type="number"
              min={0.1}
              step={10}
              value={principalSol}
              onChange={(e) => setPrincipalSol(Math.max(0, Number(e.target.value)))}
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs gap-2">
              <label className="font-medium text-slate-300">
                Native PoS APR (% permilsec)
              </label>
              <button
                type="button"
                onClick={() => setBaseNetworkAprPct(network?.baseNetworkAprPct || 1_000_000)}
                className="text-emerald-400 hover:underline font-mono whitespace-nowrap"
              >
                Use Live ({(network?.baseNetworkAprPct || 1_000_000).toLocaleString()}%/ms)
              </button>
            </div>
            <input
              type="number"
              min={0}
              step={1000}
              value={baseNetworkAprPct}
              onChange={(e) => setBaseNetworkAprPct(Math.max(0, Number(e.target.value)))}
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Validator Fee (%)
              </label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={validatorCommissionPct}
                onChange={(e) => setValidatorCommissionPct(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Pool Epoch Fee (%)
              </label>
              <input
                type="number"
                min={0}
                max={25}
                step={0.25}
                value={poolManagementFeePct}
                onChange={(e) => setPoolManagementFeePct(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Protocol Boost (%/ms)
              </label>
              <input
                type="number"
                min={0}
                step={0.25}
                value={protocolBoostAprPct}
                onChange={(e) => setProtocolBoostAprPct(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <label className="font-medium text-slate-300">SOL Price (USD)</label>
                {liveSolUsdPrice !== null && (
                  <button
                    type="button"
                    onClick={() => setSolPriceUsd(liveSolUsdPrice)}
                    className="text-emerald-400 hover:underline font-mono"
                  >
                    Live (${liveSolUsdPrice.toFixed(2)})
                  </button>
                )}
              </div>
              <input
                type="number"
                min={1}
                step={1}
                value={solPriceUsd || ''}
                placeholder={liveSolUsdPrice ? liveSolUsdPrice.toFixed(2) : 'Fetching live...'}
                onChange={(e) => setSolPriceUsd(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">Projection Horizon</label>
            <div className="grid grid-cols-5 gap-1 p-1 bg-[#090D16] border border-slate-800 rounded-md">
              {[30, 90, 180, 365, 730].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setHorizonDays(d)}
                  className={`py-1.5 text-xs font-mono rounded transition-colors ${
                    horizonDays === d
                      ? 'bg-slate-800 text-slate-100 font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {d === 365 ? '1Y' : d === 730 ? '2Y' : `${d}D`}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-8 space-y-5">
          {result && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="p-4 rounded-lg border border-slate-800 bg-[#0F1623]">
                  <div className="text-xs text-slate-400">Net Native PoS APR</div>
                  <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-slate-100">
                    {result.netPosAprPct.toLocaleString()}%/ms
                  </div>
                </div>
                <div className="p-4 rounded-lg border border-slate-800 bg-[#0F1623]">
                  <div className="text-xs text-slate-400">Per-Millisecond Yield</div>
                  <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-emerald-400">
                    +{formatLargeSol(result.perMsYieldSol)} SOL
                  </div>
                </div>
                <div className="p-4 rounded-lg border border-slate-800 bg-[#0F1623]">
                  <div className="text-xs text-slate-400">Projected Balance</div>
                  <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-slate-100">
                    {formatLargeSol(result.projectedFinalSol)} SOL
                  </div>
                </div>
                <div className="p-4 rounded-lg border border-slate-800 bg-[#0F1623]">
                  <div className="text-xs text-slate-400">Net Staking Profit</div>
                  <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-emerald-400">
                    +{formatLargeSol(result.totalProfitSol)} SOL
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-5">
                <RoiChart points={result.points} principalSol={principalSol} />
              </div>

              <div className="rounded-lg border border-slate-800 bg-[#0F1623] overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-200">
                    On-Chain Native PoS Permilsec Yield Breakdown ({cluster})
                  </h3>
                  {loading && <span className="text-xs text-slate-500">Recalculating...</span>}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-800 text-xs">
                  <div className="p-4 space-y-1">
                    <div className="text-slate-400">Yield / 1 ms</div>
                    <div className="font-mono text-sm text-emerald-400 tabular-nums">
                      +{formatLargeSol(result.perMsYieldSol)} SOL/ms
                    </div>
                  </div>
                  <div className="p-4 space-y-1">
                    <div className="text-slate-400">Yield / 1 sec</div>
                    <div className="font-mono text-sm text-emerald-400 tabular-nums">
                      +{formatLargeSol(result.perSecYieldSol)} SOL/s
                    </div>
                  </div>
                  <div className="p-4 space-y-1">
                    <div className="text-slate-400">Daily Accrued Yield</div>
                    <div className="font-mono text-sm text-slate-100 tabular-nums">
                      +{formatLargeSol(result.dailyYieldSol)} SOL/day
                    </div>
                  </div>
                  <div className="p-4 space-y-1">
                    <div className="text-slate-400">Per-Epoch Yield</div>
                    <div className="font-mono text-sm text-slate-100 tabular-nums">
                      +{formatLargeSol(result.epochYieldSol)} SOL/epoch
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
