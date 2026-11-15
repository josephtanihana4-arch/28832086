import 'dotenv/config';

const originalWarn = console.warn;
const originalError = console.error;
const originalLog = console.log;

const suppressMessage = (msg: any) => {
  if (typeof msg === 'string' && (msg.includes('bigint:') || msg.includes('Failed to load bindings'))) {
    return true;
  }
  return false;
};

console.warn = (...args: any[]) => {
  if (suppressMessage(args[0])) return;
  originalWarn(...args);
};

console.error = (...args: any[]) => {
  if (suppressMessage(args[0])) return;
  originalError(...args);
};

console.log = (...args: any[]) => {
  if (suppressMessage(args[0])) return;
  originalLog(...args);
};

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  auditStakeAccountProtection,
  broadcastSignedTransaction,
  buildCentMsSolClaimTx,
  buildCentMsUsdcClaimTx,
  buildEmergencyDeactivateStakeTx,
  buildInitializeStakePoolTransactions,
  buildIsolateWithdrawerAuthorityTx,
  buildL1ToL2ConversionTx,
  buildL2InflationAnchorTx,
  buildL2InflationSolClaimTx,
  buildL2InflationSplMintTx,
  buildL2OneCentActivateTx,
  buildL2OneCentClaimSolTx,
  buildL2OneCentClaimUsdcTx,
  buildL2OneCentMintTokenTx,
  buildNativeSolMillisecondClaimTx,
  buildNativeStakeTransaction,
  buildOnChainRateUpdateTx,
  buildOnChainStreamAnchorTx,
  buildPoolDepositSolTransaction,
  buildPoolWithdrawSolTransaction,
  buildPoolWithdrawStakeTransaction,
  buildProtectedYieldStreamMintTx,
  buildSendSolToWalletTx,
  buildStakingPohCheckpointTx,
  calculateStakingRoi,
  executeDevnetTestDeployment,
  fetchCentMillisecondStreamSnapshot,
  fetchDeveloperRpcLinks,
  fetchL2OneCentPackageSnapshot,
  fetchL2PosInflationSnapshot,
  fetchLiveStakePool,
  fetchMillisecondChainYieldSnapshot,
  fetchNetworkOverview,
  fetchStakingProofOfHistory,
  fetchWalletBalanceOverview,
  fetchWalletStakeAccounts,
  fetchWithdrawalPoolOverview,
  forwardSolanaJsonRpc,
  listProtocolConfigs,
  markProtocolDeployed,
  probeSolanaRpcEndpoint,
  resolveRpcEndpoint,
} from './server/solanaService.ts';
import {
  buildLegitPackageZip,
  generateLegitNodePackageFiles,
} from './server/packageGenerator.ts';
import type { RoiCalculationInput, SolanaCluster } from './server/types.ts';

const PORT = Number((process.env.PORT && process.env.PORT !== '8080') ? process.env.PORT : 3000);
const distDir = path.resolve(process.cwd(), 'dist');
const distExists = fs.existsSync(path.join(distDir, 'index.html'));
const IS_PROD = process.env.NODE_ENV === 'production' || (distExists && !process.env.npm_lifecycle_event?.includes('dev'));

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  const getRequestOrigin = (req: express.Request): string | undefined => {
    const host = req.get('x-forwarded-host') || req.get('host');
    if (!host) return undefined;
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    return `${proto}://${host}`;
  };

  const normalizeCluster = (raw?: string): SolanaCluster => {
    const val = (raw || '').trim().toLowerCase();
    if (val === 'mainnet-2' || val === 'mainnet2' || val === 'solana-mainnet-2') return 'mainnet-2';
    if (val === 'devnet' || val === 'testnet' || val === 'custom') return val;
    return 'mainnet-beta';
  };

  app.get('/api/rpc/links', async (req, res) => {
    try {
      const cluster = normalizeCluster(typeof req.query.cluster === 'string' ? req.query.cluster : undefined);
      const customRpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const data = await fetchDeveloperRpcLinks({
        cluster,
        customRpcUrl,
        originUrl: getRequestOrigin(req),
      });
      res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to probe Solana RPC links';
      res.status(502).json({ error: message });
    }
  });

  app.post('/api/rpc/probe', async (req, res) => {
    try {
      const body = req.body || {};
      const cluster = normalizeCluster(typeof body.cluster === 'string' ? body.cluster : undefined);
      const rpcUrl = typeof body.rpcUrl === 'string' ? body.rpcUrl : undefined;
      const label = typeof body.label === 'string' ? body.label : undefined;
      const probe = await probeSolanaRpcEndpoint({
        cluster,
        rpcUrl,
        label,
        originUrl: getRequestOrigin(req),
      });
      res.status(probe.healthy ? 200 : 502).json(probe);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'RPC probe failed';
      res.status(502).json({ error: message });
    }
  });

  const setRpcCorsHeaders = (res: express.Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, solana-client, x-solana-rpc-url');
  };

  app.options(['/api/rpc', '/api/rpc/:cluster', '/rpc', '/rpc/:cluster'], (_req, res) => {
    setRpcCorsHeaders(res);
    res.status(204).end();
  });

  app.get(['/api/rpc', '/api/rpc/:cluster', '/rpc', '/rpc/:cluster'], (req, res) => {
    setRpcCorsHeaders(res);
    const cluster = normalizeCluster(req.params.cluster || (req.query.cluster as string | undefined));
    const customRpcUrl =
      (typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined) ||
      (typeof req.get('x-solana-rpc-url') === 'string' ? req.get('x-solana-rpc-url') : undefined);
    const origin = getRequestOrigin(req) || `http://localhost:${PORT}`;
    const upstreamRpcUrl = resolveRpcEndpoint(cluster, customRpcUrl);
    const displayName =
      cluster === 'mainnet-2'
        ? 'Solana Mainnet 2 — Live Blockchain JSON-RPC 2.0 Link'
        : `SolPool Protocol Real Solana JSON-RPC 2.0 Link (${cluster})`;
    res.json({
      name: displayName,
      cluster,
      upstreamRpcUrl,
      rpcEndpoint: `${origin}/api/rpc/${cluster}`,
      shortRpcEndpoint: `${origin}/rpc/${cluster}`,
      acceptsAllTransactions: true,
      supportedCapabilities: [
        'sendTransaction',
        'simulateTransaction',
        'getBalance',
        'getTokenAccountsByOwner',
        'getProgramAccounts',
        'getStakeActivation',
        'getLatestBlockhash',
        'getSignatureStatuses',
      ],
      isSimulator: false,
      usage: {
        web3Js: `new Connection("${origin}/api/rpc/${cluster}", "confirmed")`,
        solanaCli: `solana config set --url "${origin}/api/rpc/${cluster}"`,
        curlExample: `curl -X POST "${origin}/api/rpc/${cluster}" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'`,
      },
      protocol: {
        splStakePoolProgramId: 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy',
        anchorStakingRoiProgramId: 'So1Poo1Ro1111111111111111111111111111111111',
        packageName: 'solpool-staking-roi-protocol',
      },
    });
  });

  app.post(['/api/rpc', '/api/rpc/:cluster', '/rpc', '/rpc/:cluster'], async (req, res) => {
    setRpcCorsHeaders(res);
    try {
      const cluster = normalizeCluster(req.params.cluster || (req.query.cluster as string | undefined));
      const customRpcUrl =
        (typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined) ||
        (typeof req.get('x-solana-rpc-url') === 'string' ? req.get('x-solana-rpc-url') : undefined);
      const forwarded = await forwardSolanaJsonRpc({
        cluster,
        customRpcUrl,
        payload: req.body,
      });
      res.setHeader('X-Solana-Upstream-Rpc', forwarded.upstreamRpcUrl);
      res.status(forwarded.status).json(forwarded.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Solana JSON-RPC relay error';
      res.status(502).json({
        jsonrpc: '2.0',
        error: { code: -32603, message },
        id: null,
      });
    }
  });

  app.get('/api/wallet/balance', async (req, res) => {
    try {
      const walletPubkey = typeof req.query.wallet === 'string' ? req.query.wallet.trim() : '';
      if (!walletPubkey) {
        res.status(400).json({ error: 'wallet query parameter is required' });
        return;
      }
      const cluster = normalizeCluster(typeof req.query.cluster === 'string' ? req.query.cluster : undefined);
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const result = await fetchWalletBalanceOverview({ walletPubkey, cluster, rpcUrl });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch wallet balance from Solana RPC';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/wallet/transfer-sol-tx', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.fromPubkey || !body.toPubkey) {
        res.status(400).json({ error: 'fromPubkey and toPubkey are required' });
        return;
      }
      const result = await buildSendSolToWalletTx({
        fromPubkey: String(body.fromPubkey),
        toPubkey: String(body.toPubkey),
        amountSol: Number(body.amountSol),
        cluster: normalizeCluster(body.cluster),
        rpcUrl: typeof body.rpcUrl === 'string' ? body.rpcUrl : undefined,
        memo: typeof body.memo === 'string' ? body.memo : undefined,
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build wallet SOL transfer transaction';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/tx/send', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.signedTxBase64) {
        res.status(400).json({ error: 'signedTxBase64 is required to send transaction to Solana blockchain' });
        return;
      }
      const result = await broadcastSignedTransaction({
        signedTxBase64: String(body.signedTxBase64),
        cluster: normalizeCluster(body.cluster),
        rpcUrl: typeof body.rpcUrl === 'string' ? body.rpcUrl : undefined,
        skipPreflight: Boolean(body.skipPreflight),
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transaction broadcast to Solana blockchain failed';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/network/overview', async (req, res) => {
    try {
      const cluster = ((req.query.cluster as string) || 'mainnet-beta') as SolanaCluster;
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const data = await fetchNetworkOverview(cluster, rpcUrl);
      res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch Solana network data';
      res.status(502).json({ error: message });
    }
  });

  app.get('/api/pools/inspect', async (req, res) => {
    try {
      const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
      if (!address) {
        res.status(400).json({ error: 'Stake pool address is required' });
        return;
      }
      const cluster = ((req.query.cluster as string) || 'mainnet-beta') as SolanaCluster;
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const data = await fetchLiveStakePool(address, cluster, rpcUrl);
      res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to inspect stake pool';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/pools/withdrawal-overview', async (req, res) => {
    try {
      const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
      if (!address) {
        res.status(400).json({ error: 'Stake pool address is required' });
        return;
      }
      const cluster = normalizeCluster(typeof req.query.cluster === 'string' ? req.query.cluster : undefined);
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const userPubkey = (
        (typeof req.query.userPubkey === 'string' && req.query.userPubkey.trim()) ||
        (typeof req.query.userWallet === 'string' && req.query.userWallet.trim()) ||
        (typeof req.query.wallet === 'string' && req.query.wallet.trim()) ||
        undefined
      );
      const data = await fetchWithdrawalPoolOverview({
        stakePoolAddress: address,
        cluster,
        rpcUrl,
        userPubkey,
      });
      res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch withdrawal pool overview';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/roi/calculate', (req, res) => {
    try {
      const body = req.body as Partial<RoiCalculationInput>;
      const result = calculateStakingRoi({
        principalSol: Number(body.principalSol ?? 100),
        hourlyUsdRate: Number(body.hourlyUsdRate ?? 150),
        validatorCommissionPct: Number(body.validatorCommissionPct ?? 0),
        poolManagementFeePct: Number(body.poolManagementFeePct ?? 0),
        protocolBoostUsdPerHour: Number(body.protocolBoostUsdPerHour ?? 0),
        solPriceUsd: Number(body.solPriceUsd ?? 180),
        horizonDays: Number(body.horizonDays ?? 30),
        epochsPerYear: Number(body.epochsPerYear ?? 173.9),
        compoundingMode: body.compoundingMode === 'epoch' ? 'epoch' : 'simple',
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid ROI calculation input';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/protocols', async (_req, res) => {
    try {
      const protocols = await listProtocolConfigs();
      res.json({ protocols });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load protocols';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/protocols/build-transactions', async (req, res) => {
    try {
      const body = req.body;
      if (!body?.payerPubkey) {
        res.status(400).json({ error: 'Connected wallet or payer public key is required' });
        return;
      }
      const built = await buildInitializeStakePoolTransactions(body);
      res.json(built);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build Solana transactions';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/protocols/:id/deployed', async (req, res) => {
    try {
      const signatures = Array.isArray(req.body?.signatures) ? req.body.signatures : [];
      const updated = await markProtocolDeployed(req.params.id, signatures);
      if (!updated) {
        res.status(404).json({ error: 'Protocol not found' });
        return;
      }
      res.json({ protocol: updated });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update protocol status';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/protocols/devnet-deploy', async (req, res) => {
    try {
      const result = await executeDevnetTestDeployment(req.body || {});
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Devnet airdrop/deployment failed (Devnet faucet may be rate-limited)';
      res.status(502).json({ error: message });
    }
  });

  app.post('/api/stake/native-tx', async (req, res) => {
    try {
      const result = await buildNativeStakeTransaction(req.body);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build native stake tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/stake/pool-deposit-tx', async (req, res) => {
    try {
      const result = await buildPoolDepositSolTransaction(req.body);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build pool deposit tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/stake/pool-withdraw-tx', async (req, res) => {
    try {
      const result = await buildPoolWithdrawSolTransaction(req.body);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build pool withdraw tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/stake/pool-withdraw-stake-tx', async (req, res) => {
    try {
      const result = await buildPoolWithdrawStakeTransaction(req.body);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build pool withdraw stake tx';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/protection/audit', async (req, res) => {
    try {
      const stakeAccountPubkey =
        typeof req.query.stakeAccount === 'string' ? req.query.stakeAccount.trim() : '';
      if (!stakeAccountPubkey) {
        res.status(400).json({ error: 'Stake account public key is required' });
        return;
      }
      const cluster = ((req.query.cluster as string) || 'mainnet-beta') as SolanaCluster;
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const maxAllowedCommissionPct = Number(req.query.maxCommission ?? 10);
      const audit = await auditStakeAccountProtection({
        stakeAccountPubkey,
        cluster,
        rpcUrl,
        maxAllowedCommissionPct,
      });
      res.json(audit);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Stake account audit failed';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/protection/emergency-deactivate-tx', async (req, res) => {
    try {
      const result = await buildEmergencyDeactivateStakeTx(req.body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build emergency deactivate tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/protection/isolate-withdrawer-tx', async (req, res) => {
    try {
      const result = await buildIsolateWithdrawerAuthorityTx(req.body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build withdrawer authority lock tx';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/wallet/stakes', async (req, res) => {
    try {
      const walletPubkey = typeof req.query.wallet === 'string' ? req.query.wallet.trim() : '';
      if (!walletPubkey) {
        res.status(400).json({ error: 'Wallet public key is required' });
        return;
      }
      const cluster = ((req.query.cluster as string) || 'mainnet-beta') as SolanaCluster;
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const stakes = await fetchWalletStakeAccounts({ walletPubkey, cluster, rpcUrl });
      res.json({ stakes });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch on-chain wallet stake accounts';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/stream/anchor-tx', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.walletPubkey) {
        res.status(400).json({ error: 'walletPubkey is required to build an on-chain anchor tx' });
        return;
      }
      const result = await buildOnChainStreamAnchorTx(body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build on-chain anchor transaction';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/stream/update-rate-tx', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.walletPubkey) {
        res.status(400).json({ error: 'walletPubkey is required to build an on-chain rate update tx' });
        return;
      }
      const result = await buildOnChainRateUpdateTx(body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build on-chain $150/hr rate update tx';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/stream/chain-snapshot', async (req, res) => {
    try {
      const cluster = ((req.query.cluster as string) || 'mainnet-beta') as SolanaCluster;
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const principalSol = Number(req.query.principalSol ?? 100);
      const hourlyUsdRate = req.query.hourlyUsdRate ? Number(req.query.hourlyUsdRate) : 150;
      const anchorSignature =
        typeof req.query.anchorSignature === 'string' ? req.query.anchorSignature.trim() : undefined;
      const snapshot = await fetchMillisecondChainYieldSnapshot({
        cluster,
        rpcUrl,
        principalSol,
        hourlyUsdRate,
        anchorSignature,
      });
      res.json(snapshot);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch blockchain clock snapshot';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/stream/settle-tx', async (req, res) => {
    try {
      const result = await buildProtectedYieldStreamMintTx(req.body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build on-chain yield settlement tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/stream/claim-native-sol-tx', async (req, res) => {
    try {
      const result = await buildNativeSolMillisecondClaimTx(req.body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build native SOL $150/hr claim tx';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/usd-stream/snapshot', async (req, res) => {
    try {
      const cluster = ((req.query.cluster as string) || 'mainnet-beta') as SolanaCluster;
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const treasuryPubkey =
        typeof req.query.treasuryPubkey === 'string' ? req.query.treasuryPubkey : undefined;
      const usdcMint = typeof req.query.usdcMint === 'string' ? req.query.usdcMint : undefined;
      const anchorSignature =
        typeof req.query.anchorSignature === 'string' ? req.query.anchorSignature.trim() : undefined;
      const snapshot = await fetchCentMillisecondStreamSnapshot({
        cluster,
        rpcUrl,
        treasuryPubkey,
        usdcMint,
        anchorSignature,
      });
      res.json(snapshot);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load $150/hr oracle snapshot';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/usd-stream/claim-sol-tx', async (req, res) => {
    try {
      const result = await buildCentMsSolClaimTx(req.body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build $150/hr SOL claim tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/usd-stream/claim-usdc-tx', async (req, res) => {
    try {
      const result = await buildCentMsUsdcClaimTx(req.body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build $150/hr USDC claim tx';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/staking/poh', async (req, res) => {
    try {
      const cluster = ((req.query.cluster as string) || 'mainnet-beta') as SolanaCluster;
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const address = typeof req.query.address === 'string' ? req.query.address.trim() : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      const result = await fetchStakingProofOfHistory({ cluster, rpcUrl, address, limit });
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch on-chain Staking Proof of History';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/staking/poh-checkpoint-tx', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.signerPubkey) {
        res.status(400).json({ error: 'signerPubkey is required to build on-chain PoH checkpoint tx' });
        return;
      }
      const result = await buildStakingPohCheckpointTx(body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build Staking PoH checkpoint tx';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/l2-inflation/snapshot', async (req, res) => {
    try {
      const cluster = normalizeCluster(typeof req.query.cluster === 'string' ? req.query.cluster : undefined);
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const personWallet =
        typeof req.query.personWallet === 'string' ? req.query.personWallet.trim() : undefined;
      const treasuryPubkey =
        typeof req.query.treasuryPubkey === 'string' ? req.query.treasuryPubkey.trim() : undefined;
      const anchorSignature =
        typeof req.query.anchorSignature === 'string' ? req.query.anchorSignature.trim() : undefined;
      const snapshot = await fetchL2PosInflationSnapshot({
        cluster,
        rpcUrl,
        personWallet,
        treasuryPubkey,
        anchorSignature,
      });
      res.json(snapshot);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load Solana L2.0 PoS inflation snapshot';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/l2-inflation/anchor-tx', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.personPubkey) {
        res.status(400).json({ error: 'personPubkey is required to anchor Solana L2.0 PoS inflation' });
        return;
      }
      const result = await buildL2InflationAnchorTx({
        cluster: normalizeCluster(body.cluster),
        rpcUrl: typeof body.rpcUrl === 'string' ? body.rpcUrl : undefined,
        personPubkey: String(body.personPubkey),
        stakedSol: body.stakedSol !== undefined ? Number(body.stakedSol) : 0,
      });
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build L2.0 inflation anchor tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/l2-inflation/claim-sol-tx', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.treasuryPubkey || !body.personPubkey || !body.anchorSignature) {
        res
          .status(400)
          .json({ error: 'treasuryPubkey, personPubkey, and confirmed anchorSignature are required' });
        return;
      }
      const result = await buildL2InflationSolClaimTx({
        cluster: normalizeCluster(body.cluster),
        rpcUrl: typeof body.rpcUrl === 'string' ? body.rpcUrl : undefined,
        treasuryPubkey: String(body.treasuryPubkey),
        personPubkey: String(body.personPubkey),
        anchorSignature: String(body.anchorSignature),
      });
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build L2.0 inflation real SOL claim tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/l2-inflation/mint-token-tx', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.personPubkey || !body.anchorSignature) {
        res
          .status(400)
          .json({ error: 'personPubkey and confirmed anchorSignature are required' });
        return;
      }
      const result = await buildL2InflationSplMintTx({
        cluster: normalizeCluster(body.cluster),
        rpcUrl: typeof body.rpcUrl === 'string' ? body.rpcUrl : undefined,
        personPubkey: String(body.personPubkey),
        anchorSignature: String(body.anchorSignature),
        stakedSol: body.stakedSol !== undefined ? Number(body.stakedSol) : 0,
      });
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build L2.0 inflation SPL mint tx';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/l2-package/snapshot', async (req, res) => {
    try {
      const cluster = normalizeCluster(typeof req.query.cluster === 'string' ? req.query.cluster : undefined);
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const personWallet =
        typeof req.query.personWallet === 'string' ? req.query.personWallet.trim() : undefined;
      const treasuryPubkey =
        typeof req.query.treasuryPubkey === 'string' ? req.query.treasuryPubkey.trim() : undefined;
      const packageActivationSig =
        typeof req.query.packageActivationSig === 'string'
          ? req.query.packageActivationSig.trim()
          : undefined;
      const usdcMint =
        typeof req.query.usdcMint === 'string' ? req.query.usdcMint.trim() : undefined;
      const snapshot = await fetchL2OneCentPackageSnapshot({
        cluster,
        rpcUrl,
        personWallet,
        treasuryPubkey,
        packageActivationSig,
        usdcMint,
      });
      res.json(snapshot);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch L2.0 $0.01 package snapshot';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/l2-package/activate-tx', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.personPubkey) {
        res.status(400).json({ error: 'personPubkey is required to activate $0.01 L2.0 package' });
        return;
      }
      const result = await buildL2OneCentActivateTx({
        cluster: normalizeCluster(body.cluster),
        rpcUrl: typeof body.rpcUrl === 'string' ? body.rpcUrl : undefined,
        personPubkey: String(body.personPubkey),
        treasuryPubkey: typeof body.treasuryPubkey === 'string' ? body.treasuryPubkey : undefined,
        asset: body.asset === 'usdc' ? 'usdc' : 'sol',
        usdcMint: typeof body.usdcMint === 'string' ? body.usdcMint : undefined,
      });
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build $0.01 L2.0 activation tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/l2-package/claim-sol-tx', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.treasuryPubkey || !body.personPubkey || !body.packageActivationSig) {
        res.status(400).json({
          error: 'treasuryPubkey, personPubkey, and confirmed packageActivationSig are required',
        });
        return;
      }
      const result = await buildL2OneCentClaimSolTx({
        cluster: normalizeCluster(body.cluster),
        rpcUrl: typeof body.rpcUrl === 'string' ? body.rpcUrl : undefined,
        treasuryPubkey: String(body.treasuryPubkey),
        personPubkey: String(body.personPubkey),
        packageActivationSig: String(body.packageActivationSig),
      });
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build $0.01 L2.0 SOL claim tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/l2-package/claim-usdc-tx', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.treasuryPubkey || !body.personPubkey || !body.packageActivationSig) {
        res.status(400).json({
          error: 'treasuryPubkey, personPubkey, and confirmed packageActivationSig are required',
        });
        return;
      }
      const result = await buildL2OneCentClaimUsdcTx({
        cluster: normalizeCluster(body.cluster),
        rpcUrl: typeof body.rpcUrl === 'string' ? body.rpcUrl : undefined,
        treasuryPubkey: String(body.treasuryPubkey),
        personPubkey: String(body.personPubkey),
        packageActivationSig: String(body.packageActivationSig),
        usdcMint: typeof body.usdcMint === 'string' ? body.usdcMint : undefined,
      });
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build $0.01 L2.0 USDC claim tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/l2-package/mint-token-tx', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.personPubkey || !body.packageActivationSig) {
        res.status(400).json({
          error: 'personPubkey and confirmed packageActivationSig are required',
        });
        return;
      }
      const result = await buildL2OneCentMintTokenTx({
        cluster: normalizeCluster(body.cluster),
        rpcUrl: typeof body.rpcUrl === 'string' ? body.rpcUrl : undefined,
        personPubkey: String(body.personPubkey),
        packageActivationSig: String(body.packageActivationSig),
      });
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build $0.01 L2.0 SPL mint tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/l2-package/convert-l1-tx', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.personPubkey) {
        res.status(400).json({ error: 'personPubkey is required to convert L1 stake to L2.0' });
        return;
      }
      const result = await buildL1ToL2ConversionTx({
        cluster: normalizeCluster(body.cluster),
        rpcUrl: typeof body.rpcUrl === 'string' ? body.rpcUrl : undefined,
        personPubkey: String(body.personPubkey),
        stakeAccountPubkey:
          typeof body.stakeAccountPubkey === 'string' ? body.stakeAccountPubkey : undefined,
        conversionSol: body.conversionSol !== undefined ? Number(body.conversionSol) : 1.0,
      });
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build L1 to L2 conversion tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/package/files', (req, res) => {
    try {
      const files = generateLegitNodePackageFiles(req.body || {});
      res.json({ files });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate package files';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/package/download', async (req, res) => {
    try {
      const { filename, buffer } = await buildLegitPackageZip(req.body || {});
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to package archive';
      res.status(500).json({ error: message });
    }
  });

  if (IS_PROD) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SolPool Protocol Node.js server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
