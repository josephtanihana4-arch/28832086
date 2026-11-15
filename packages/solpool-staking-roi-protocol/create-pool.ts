import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { SolanaStakingRoiProtocol } from './src/index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function main() {
  console.log('=== SolPool Protocol: Creating Brand New Staking Pool & Address ===');

  // 1. Connect to Solana Mainnet 2 / validator RPC
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const sdk = new SolanaStakingRoiProtocol(rpcUrl);
  console.log('Connected to Solana RPC:', rpcUrl);

  // 2. Load payer keypair from Solana CLI config or generate a funded test keypair
  let payer: Keypair;
  const keypath = path.resolve(os.homedir(), '.config', 'solana', 'id.json');
  if (fs.existsSync(keypath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(keypath, 'utf8'));
      payer = Keypair.fromSecretKey(Uint8Array.from(raw));
      console.log('Loaded payer wallet from CLI config:', payer.publicKey.toBase58());
    } catch {
      payer = Keypair.generate();
      console.log('Generated new ephemeral test payer:', payer.publicKey.toBase58());
    }
  } else {
    payer = Keypair.generate();
    console.log('Generated new ephemeral test payer:', payer.publicKey.toBase58());
    console.log('NOTE: Fund this address with SOL before broadcasting deployment transactions on Mainnet.');
  }

  // 3. Check SOL balance
  const balance = await sdk.connection.getBalance(payer.publicKey, 'confirmed');
  console.log(`Payer SOL Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  if (balance < 0.05 * LAMPORTS_PER_SOL) {
    console.log('\nWARNING: Payer balance is low (< 0.05 SOL). Rent exemption for Stake Pool, Validator List, Mint, and Reserve Stake requires ~0.05 SOL.');
    console.log('Run: solana airdrop 1 (if on Devnet/Testnet) or fund your wallet on Mainnet.');
  }

  // 4. Create brand-new standalone staking pool (Keypair.generate() guarantees 0% address reuse)
  console.log('\nGenerating brand-new cryptographic keypairs for Stake Pool, Pool Mint, Validator List & Reserve Stake...');
  try {
    const deployment = await sdk.createStandaloneStakePool({
      payer,
      initialReserveSol: 0.02,
      maxValidators: 32,
    });

    console.log('\nSUCCESS! Brand-New Staking Pool Created On-Chain:');
    console.log('--------------------------------------------------');
    console.log('Stake Pool Address:    ', deployment.stakePoolAddress);
    console.log('Pool Mint (LST):       ', deployment.poolMintAddress);
    console.log('Withdraw Authority PDA:', deployment.withdrawAuthorityAddress);
    console.log('Manager Fee Account:   ', deployment.managerFeeAccountAddress);
    console.log('Signatures:            ', deployment.signatures);
    console.log('--------------------------------------------------');
  } catch (err) {
    console.error('\nDeployment note:', err instanceof Error ? err.message : err);
    console.log('To test offline or inspect pool derivation without sending live txs, use SDK methods or a funded keypair.');
  }
}

main().catch(console.error);
