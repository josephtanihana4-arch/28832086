import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  SolanaStakingRoiProtocol,
  calculateNativePosRoi,
  deriveL2InflationPdas,
  deriveOneCentL2PackagePdas,
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
  assert.equal(net.hourlyUsdRate, 150, 'Native PoS $ rate must be $150.00/hr');

  const l2Status = await sdk.getL2InflationStatus({
    personWallet: 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy',
  });
  assert.equal(l2Status.l2PersonRateUsdPerHour, 150, 'L2.0 PoS inflation rate must be $150.00/hr');
  assert.equal(l2Status.isSimulator, false, 'L2.0 PoS inflation must not be simulated');
  assert.ok(l2Status.l1InflationValidatorPct > 0, 'Live L1 validator inflation % must be positive');

  const balanceCheck = await sdk.getWalletBalanceAndStaking(
    new PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy'),
  );
  assert.ok(balanceCheck.slot > 0 && balanceCheck.solBalance >= 0, 'Live balance lookup must succeed');

  const roi = calculateNativePosRoi({
    principalSol: 100,
    hourlyUsdRate: net.hourlyUsdRate,
    validatorCommissionPct: 5,
    poolManagementFeePct: 2.5,
    protocolBoostUsdPerHour: 0,
    solPriceUsd: net.solUsdPrice,
    horizonDays: 365,
    epochsPerYear: net.epochsPerYear,
  });

  assert.ok(roi.hourlyYieldSol > 0, 'Hourly SOL yield should be positive');
  assert.ok(roi.projectedFinalSol > 100, 'Projected final SOL should exceed principal');

  const authority = Keypair.generate().publicKey;
  const staker = Keypair.generate().publicKey;
  const pdas = deriveStakingProtocolPdas(authority, staker);
  assert.ok(pdas.protocolState && pdas.reserveVault && pdas.position, 'All Anchor PDAs must derive cleanly');

  const l2Pdas = deriveL2InflationPdas(authority, staker);
  assert.ok(l2Pdas.l2InflationState && l2Pdas.l2SolTreasury && l2Pdas.l2PersonAccount, 'All L2 Inflation PDAs must derive cleanly');

  const pkgStatus = await sdk.getOneCentL2PackageStatus({
    personWallet: 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy',
  });
  assert.equal(pkgStatus.packageEntryUsd, 0.01, '$0.01 cent L2.0 package entry must be 0.01 USD');
  assert.equal(pkgStatus.l2FixedHourlyUsdRate, 150, '$0.01 L2.0 package fixed rate must be $150/hr');
  assert.equal(pkgStatus.ignoresL1NormalStakingRate, true, 'L2.0 package must ignore L1 normal staking rate');
  assert.equal(pkgStatus.isSimulator, false, 'L2.0 $0.01 package must not be simulated');
  const pkgPdas = deriveOneCentL2PackagePdas(authority, staker);
  assert.ok(pkgPdas.l2PackageVault && pkgPdas.l2PersonPackage, '$0.01 L2 Package PDAs must derive cleanly');

  const poh = await fetchStakingProofOfHistory(rpcUrl, undefined, 5);
  assert.ok(poh.livePohBlock.blockhash.length > 20, 'Live Solana PoH blockhash must be verified');
  assert.ok(poh.sysvarStakeHistory.length > 0, 'SysvarStakeHistory must contain epoch entries');

  console.log(
    'RPC Latency:',
    rpcProbe.latencyMs + 'ms',
    '| Mainnet 2 Epoch:',
    net.epoch,
    '| L1 Inflation:',
    l2Status.l1InflationTotalPct + '%',
    '| L2 Person Rate:',
    '$' + l2Status.l2PersonRateUsdPerHour + '/hr',
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

