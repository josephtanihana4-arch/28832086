import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  SolanaStakingRoiProtocol,
  calculateNativePosRoi,
  deriveStakingProtocolPdas,
  fetchStakingProofOfHistory,
  probeSolanaRpcLink,
  resolveSolanaRpcUrl,
} from '../src/index.js';

async function runTests() {
  const rpcUrl = resolveSolanaRpcUrl('mainnet-2');
  const rpcProbe = await probeSolanaRpcLink(rpcUrl);
  assert.ok(rpcProbe.healthy && rpcProbe.slot > 0, 'Live Solana Mainnet 2 RPC must respond with slot');
  assert.ok(rpcProbe.stakePoolProgramExecutable, 'SPL Stake Pool Program must be executable on-chain');

  const sdk = new SolanaStakingRoiProtocol(rpcUrl);
  const net = await sdk.getNetworkPosMetrics();
  assert.ok(net.epoch > 0, 'Mainnet epoch should be positive');
  assert.equal(net.baseNetworkAprPct, 1_000_000, 'Native PoS APR must be 1,000,000% permilsec');

  const balanceCheck = await sdk.getWalletBalanceAndStaking(
    new PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy'),
  );
  assert.ok(balanceCheck.slot > 0 && balanceCheck.solBalance >= 0, 'Live balance lookup must succeed');

  const roi = calculateNativePosRoi({
    principalSol: 100,
    baseNetworkAprPct: net.baseNetworkAprPct,
    validatorCommissionPct: 5,
    poolManagementFeePct: 2.5,
    protocolBoostAprPct: 1.25,
    horizonDays: 365,
    epochsPerYear: net.epochsPerYear,
  });

  assert.ok(roi.perMsYieldSol > 0, 'Per-ms SOL yield should be positive');
  assert.ok(roi.projectedFinalSol > 100, 'Projected final SOL should exceed principal');

  const authority = Keypair.generate().publicKey;
  const staker = Keypair.generate().publicKey;
  const pdas = deriveStakingProtocolPdas(authority, staker);
  assert.ok(pdas.protocolState && pdas.reserveVault && pdas.position, 'All Anchor PDAs must derive cleanly');

  const poh = await fetchStakingProofOfHistory(rpcUrl, undefined, 5);
  assert.ok(poh.livePohBlock.blockhash.length > 20, 'Live Solana PoH blockhash must be verified');
  assert.ok(poh.sysvarStakeHistory.length > 0, 'SysvarStakeHistory must contain epoch entries');

  console.log(
    'RPC Latency:',
    rpcProbe.latencyMs + 'ms',
    '| Mainnet 2 Epoch:',
    net.epoch,
    '| PoH Slot:',
    poh.livePohBlock.slot,
    '| PoH Blockhash:',
    poh.livePohBlock.blockhash.slice(0, 12) + '...',
    '| Head Digest:',
    poh.headPohChainDigest.slice(0, 12) + '...',
  );
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
