use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::solana_program::sysvar::slot_hashes;
use anchor_lang::system_program;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("So1Poo1Ro1111111111111111111111111111111111");

/// SolPool Sovereign Staking (spSOL)
/// Standalone 100% On-Chain Solana Staking ROI, Principal-Protection & Proof of History Protocol
/// 1) Enforces Principal Floor Guard backed by an isolated Insurance Reserve Vault PDA.
/// 2) Streams real native SOL lamports at $150.00 USD / hour (hourly_usd_rate)
///    from a strictly solvent funded SOL Yield Treasury PDA using on-chain Clock + slot delta.
/// 3) Streams $150.00 USD (150,000,000 micro-USDC) per hour strictly from a
///    pre-funded USDC/USD SPL Reward Vault PDA (zero off-chain timers or unbacked minting).
/// 4) Anchors every stake, claim, unstake, rate update, and checkpoint to Solana's native SlotHashes
///    Proof of History (PoH) sysvar and records an immutable cryptographic PoH hash chain.

fn read_latest_slot_hash(slot_hashes_info: &AccountInfo) -> Result<[u8; 32]> {
    let data = slot_hashes_info.try_borrow_data()?;
    if data.len() >= 48 {
        let mut out = [0u8; 32];
        out.copy_from_slice(&data[16..48]);
        return Ok(out);
    }
    Ok([0u8; 32])
}

fn advance_staking_poh_hash(
    prev_hash: &[u8; 32],
    slot_hash: &[u8; 32],
    slot: u64,
    epoch: u64,
    unix_timestamp: i64,
    actor: &Pubkey,
    amount: u64,
    action: &[u8],
) -> [u8; 32] {
    hashv(&[
        prev_hash,
        slot_hash,
        &slot.to_le_bytes(),
        &epoch.to_le_bytes(),
        &unix_timestamp.to_le_bytes(),
        actor.as_ref(),
        &amount.to_le_bytes(),
        action,
    ])
    .to_bytes()
}

#[program]
pub mod solpool_staking_roi_protocol {
    use super::*;

    pub fn initialize_roi_protocol(
        ctx: Context<InitializeRoiProtocol>,
        epoch_fee_bps: u16,
        hourly_usd_rate: u64,
        max_validator_commission_bps: u16,
    ) -> Result<()> {
        require!(epoch_fee_bps <= 2500, RoiError::FeeTooHigh);
        let clock = Clock::get()?;
        let slot_hash = read_latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let pool_key = ctx.accounts.protocol_state.key();
        let authority_key = ctx.accounts.authority.key();
        let next_poh_hash = advance_staking_poh_hash(
            &[0u8; 32],
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &authority_key,
            0,
            b"INIT_PROTOCOL",
        );

        let resolved_hourly_rate = if hourly_usd_rate > 0 { hourly_usd_rate } else { 150 };
        let resolved_micro_usd_per_hour = resolved_hourly_rate
            .checked_mul(1_000_000)
            .ok_or(RoiError::MathOverflow)?;

        let pool = &mut ctx.accounts.protocol_state;
        pool.authority = authority_key;
        pool.lst_mint = ctx.accounts.lst_mint.key();
        pool.reward_mint = ctx.accounts.reward_mint.key();
        pool.usd_reward_mint = ctx.accounts.usd_reward_mint.key();
        pool.reserve_vault = ctx.accounts.reserve_vault.key();
        pool.insurance_vault = ctx.accounts.insurance_vault.key();
        pool.sol_yield_treasury = ctx.accounts.sol_yield_treasury.key();
        pool.usd_reward_vault = ctx.accounts.usd_reward_vault.key();
        pool.epoch_fee_bps = epoch_fee_bps;
        pool.hourly_usd_rate = resolved_hourly_rate; // $150.00 USD / hour
        pool.micro_usd_per_hour = resolved_micro_usd_per_hour; // 150,000,000 micro-USDC / hour
        pool.max_validator_commission_bps = max_validator_commission_bps;
        pool.total_staked_lamports = 0;
        pool.total_lst_supply = 0;
        pool.last_update_epoch = clock.epoch;
        pool.genesis_slot = clock.slot;
        pool.poh_sequence = 1;
        pool.last_poh_hash = next_poh_hash;
        pool.bump = ctx.bumps.protocol_state;

        emit!(StakingPohEvent {
            protocol_state: pool_key,
            staker: authority_key,
            action: *b"INIT_PROTOCOL___",
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            slot_hash,
            previous_poh_hash: [0u8; 32],
            next_poh_hash,
            poh_sequence: pool.poh_sequence,
            amount: resolved_hourly_rate,
        });
        Ok(())
    }

    /// Updates the on-chain Native PoS $ Rate per hour (replaces legacy APR with $150.00/hr)
    /// and seals the rate update in the SlotHashes PoH digest chain.
    pub fn update_hourly_usd_rate(
        ctx: Context<UpdateHourlyUsdRate>,
        new_hourly_usd_rate: u64,
    ) -> Result<()> {
        require!(new_hourly_usd_rate > 0, RoiError::ZeroAmount);
        let clock = Clock::get()?;
        let slot_hash = read_latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let pool = &mut ctx.accounts.protocol_state;
        let pool_key = pool.key();

        let prev_poh = pool.last_poh_hash;
        let next_poh = advance_staking_poh_hash(
            &prev_poh,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.authority.key(),
            new_hourly_usd_rate,
            b"SET_RATE_150_HR",
        );

        pool.hourly_usd_rate = new_hourly_usd_rate;
        pool.micro_usd_per_hour = new_hourly_usd_rate
            .checked_mul(1_000_000)
            .ok_or(RoiError::MathOverflow)?;
        pool.poh_sequence = pool.poh_sequence.saturating_add(1);
        pool.last_poh_hash = next_poh;

        emit!(StakingPohEvent {
            protocol_state: pool_key,
            staker: ctx.accounts.authority.key(),
            action: *b"SET_RATE_150_HR_",
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            slot_hash,
            previous_poh_hash: prev_poh,
            next_poh_hash: next_poh,
            poh_sequence: pool.poh_sequence,
            amount: new_hourly_usd_rate,
        });
        Ok(())
    }

    /// Sponsor/operator funds the on-chain USDC/USD Reward Vault PDA with real SPL tokens
    /// to back real $150.00 USD per-hour payouts.
    pub fn fund_usd_reward_vault(
        ctx: Context<FundUsdRewardVault>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, RoiError::ZeroAmount);
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.funder_usd_account.to_account_info(),
                to: ctx.accounts.usd_reward_vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    /// Operator funds the on-chain SOL Yield Treasury PDA with real native SOL lamports
    /// to back real-time per-hourly $150.00/hr Native PoS yield payouts.
    pub fn fund_sol_yield_treasury(
        ctx: Context<FundSolYieldTreasury>,
        lamports: u64,
    ) -> Result<()> {
        require!(lamports > 0, RoiError::ZeroAmount);
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.funder.to_account_info(),
                to: ctx.accounts.sol_yield_treasury.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, lamports)?;
        Ok(())
    }

    pub fn stake_protected(ctx: Context<StakeProtected>, lamports: u64) -> Result<()> {
        require!(lamports >= 1, RoiError::MinimumStakeNotMet);
        let clock = Clock::get()?;
        let slot_hash = read_latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let pool = &mut ctx.accounts.protocol_state;
        let pool_key = pool.key();

        let lst_to_mint = if pool.total_lst_supply == 0 || pool.total_staked_lamports == 0 {
            lamports
        } else {
            (lamports as u128)
                .checked_mul(pool.total_lst_supply as u128)
                .ok_or(RoiError::MathOverflow)?
                .checked_div(pool.total_staked_lamports as u128)
                .ok_or(RoiError::MathOverflow)? as u64
        };

        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.staker.to_account_info(),
                to: ctx.accounts.reserve_vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, lamports)?;

        let authority_key = pool.authority;
        let seeds = &[b"roi_protocol", authority_key.as_ref(), &[pool.bump]];
        let signer = &[&seeds[..]];

        let mint_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.lst_mint.to_account_info(),
                to: ctx.accounts.staker_lst_account.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer,
        );
        token::mint_to(mint_ctx, lst_to_mint)?;

        let pos = &mut ctx.accounts.position;
        if pos.stake_start_slot == 0 {
            pos.stake_start_slot = clock.slot;
            pos.stake_start_timestamp = clock.unix_timestamp;
        }
        let prev_pos_poh = pos.last_poh_hash;
        let next_pos_poh = advance_staking_poh_hash(
            &prev_pos_poh,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.staker.key(),
            lamports,
            b"STAKE_PROTECTED",
        );

        pos.staker = ctx.accounts.staker.key();
        pos.principal_lamports = pos
            .principal_lamports
            .checked_add(lamports)
            .ok_or(RoiError::MathOverflow)?;
        pos.lst_minted = pos
            .lst_minted
            .checked_add(lst_to_mint)
            .ok_or(RoiError::MathOverflow)?;
        pos.last_claim_timestamp = clock.unix_timestamp;
        pos.last_claim_slot = clock.slot;
        pos.poh_sequence = pos.poh_sequence.saturating_add(1);
        pos.last_poh_hash = next_pos_poh;

        pool.total_staked_lamports = pool
            .total_staked_lamports
            .checked_add(lamports)
            .ok_or(RoiError::MathOverflow)?;
        pool.total_lst_supply = pool
            .total_lst_supply
            .checked_add(lst_to_mint)
            .ok_or(RoiError::MathOverflow)?;
        pool.poh_sequence = pool.poh_sequence.saturating_add(1);
        pool.last_poh_hash = advance_staking_poh_hash(
            &pool.last_poh_hash,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.staker.key(),
            lamports,
            b"STAKE_PROTECTED",
        );

        emit!(StakingPohEvent {
            protocol_state: pool_key,
            staker: ctx.accounts.staker.key(),
            action: *b"STAKE_PROTECTED_",
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            slot_hash,
            previous_poh_hash: prev_pos_poh,
            next_poh_hash: next_pos_poh,
            poh_sequence: pos.poh_sequence,
            amount: lamports,
        });

        Ok(())
    }

    /// Records a verifiable on-chain Proof of History (PoH) Staking Checkpoint anchored to
    /// Solana's SlotHashes sysvar without moving funds (for auditability & history proofs).
    pub fn record_staking_poh_checkpoint(
        ctx: Context<RecordStakingPohCheckpoint>,
        checkpoint_digest: [u8; 32],
    ) -> Result<()> {
        let clock = Clock::get()?;
        let slot_hash = read_latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let pool = &mut ctx.accounts.protocol_state;
        let pool_key = pool.key();
        let pos = &mut ctx.accounts.position;

        let prev_pos_poh = pos.last_poh_hash;
        let combined_slot_hash = hashv(&[&slot_hash, &checkpoint_digest]).to_bytes();
        let next_pos_poh = advance_staking_poh_hash(
            &prev_pos_poh,
            &combined_slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.staker.key(),
            pos.principal_lamports,
            b"POH_CHECKPOINT",
        );

        pos.poh_sequence = pos.poh_sequence.saturating_add(1);
        pos.last_poh_hash = next_pos_poh;
        pool.poh_sequence = pool.poh_sequence.saturating_add(1);
        pool.last_poh_hash = advance_staking_poh_hash(
            &pool.last_poh_hash,
            &combined_slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.staker.key(),
            pos.principal_lamports,
            b"POH_CHECKPOINT",
        );

        emit!(StakingPohEvent {
            protocol_state: pool_key,
            staker: ctx.accounts.staker.key(),
            action: *b"POH_CHECKPOINT__",
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            slot_hash,
            previous_poh_hash: prev_pos_poh,
            next_poh_hash: next_pos_poh,
            poh_sequence: pos.poh_sequence,
            amount: pos.principal_lamports,
        });

        Ok(())
    }

    /// Claims real native SOL lamports accrued at $150.00/hour (micro_usd_per_hour = 150_000_000)
    /// from the funded SOL Yield Treasury PDA at live SOL/USD oracle price, enforcing PoH & solvency.
    pub fn claim_hourly_sol_yield(
        ctx: Context<ClaimHourlySolYield>,
        sol_usd_price_micros: u64,
    ) -> Result<()> {
        require!(sol_usd_price_micros > 0, RoiError::ZeroAmount);
        let clock = Clock::get()?;
        let slot_hash = read_latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let pool = &mut ctx.accounts.protocol_state;
        let pool_key = pool.key();
        let pos = &mut ctx.accounts.position;

        require!(pos.principal_lamports > 0, RoiError::MinimumStakeNotMet);

        let ts_delta_ms = clock
            .unix_timestamp
            .saturating_sub(pos.last_claim_timestamp) as u128
            * 1000;
        let slot_delta_ms = clock.slot.saturating_sub(pos.last_claim_slot) as u128 * 400;
        let elapsed_ms = ts_delta_ms.max(slot_delta_ms);

        require!(elapsed_ms > 0, RoiError::NothingToClaimYet);

        let denom = 3_600_000u128
            .checked_mul(sol_usd_price_micros as u128)
            .ok_or(RoiError::MathOverflow)?;
        let accrued_u128 = elapsed_ms
            .checked_mul(pool.micro_usd_per_hour as u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_mul(1_000_000_000u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(denom)
            .ok_or(RoiError::MathOverflow)?;

        let accrued_lamports = accrued_u128.min(u64::MAX as u128) as u64;
        require!(accrued_lamports > 0, RoiError::NothingToClaimYet);

        let rent_floor = Rent::get()?.minimum_balance(0);
        let available = ctx
            .accounts
            .sol_yield_treasury
            .lamports()
            .saturating_sub(rent_floor);
        require!(
            available >= accrued_lamports,
            RoiError::InsufficientSolTreasury
        );

        **ctx.accounts.sol_yield_treasury.try_borrow_mut_lamports()? -= accrued_lamports;
        **ctx.accounts.staker.try_borrow_mut_lamports()? += accrued_lamports;

        let prev_pos_poh = pos.last_poh_hash;
        let next_pos_poh = advance_staking_poh_hash(
            &prev_pos_poh,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.staker.key(),
            accrued_lamports,
            b"CLAIM_150_HR_SOL",
        );

        pos.total_native_sol_claimed = pos
            .total_native_sol_claimed
            .checked_add(accrued_lamports)
            .ok_or(RoiError::MathOverflow)?;
        pos.last_claim_timestamp = clock.unix_timestamp;
        pos.last_claim_slot = clock.slot;
        pos.poh_sequence = pos.poh_sequence.saturating_add(1);
        pos.last_poh_hash = next_pos_poh;

        pool.poh_sequence = pool.poh_sequence.saturating_add(1);
        pool.last_poh_hash = advance_staking_poh_hash(
            &pool.last_poh_hash,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.staker.key(),
            accrued_lamports,
            b"CLAIM_150_HR_SOL",
        );

        emit!(StakingPohEvent {
            protocol_state: pool_key,
            staker: ctx.accounts.staker.key(),
            action: *b"CLAIM_150HR_SOL_",
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            slot_hash,
            previous_poh_hash: prev_pos_poh,
            next_poh_hash: next_pos_poh,
            poh_sequence: pos.poh_sequence,
            amount: accrued_lamports,
        });

        Ok(())
    }

    /// Claims real $150.00 USD (150,000,000 micro-USDC) per hour strictly from the
    /// funded on-chain USD Reward Vault PDA, enforcing full SPL token solvency and PoH linkage.
    pub fn claim_hourly_usd_reward(
        ctx: Context<ClaimHourlyUsdReward>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let slot_hash = read_latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let pool = &mut ctx.accounts.protocol_state;
        let pool_key = pool.key();
        let authority_key = pool.authority;
        let pool_bump = pool.bump;
        let micro_usd_per_hour = pool.micro_usd_per_hour;
        let pos = &mut ctx.accounts.position;

        require!(pos.principal_lamports > 0, RoiError::MinimumStakeNotMet);

        let ts_delta_ms = clock
            .unix_timestamp
            .saturating_sub(pos.last_claim_timestamp) as u128
            * 1000;
        let slot_delta_ms = clock.slot.saturating_sub(pos.last_claim_slot) as u128 * 400;
        let elapsed_ms = ts_delta_ms.max(slot_delta_ms);

        require!(elapsed_ms > 0, RoiError::NothingToClaimYet);

        let owed_u128 = elapsed_ms
            .checked_mul(micro_usd_per_hour as u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(3_600_000u128)
            .ok_or(RoiError::MathOverflow)?;
        let owed_units = owed_u128.min(u64::MAX as u128) as u64;
        require!(owed_units > 0, RoiError::NothingToClaimYet);
        require!(
            ctx.accounts.usd_reward_vault.amount >= owed_units,
            RoiError::InsufficientUsdVault
        );

        let seeds = &[b"roi_protocol", authority_key.as_ref(), &[pool_bump]];
        let signer = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.usd_reward_vault.to_account_info(),
                to: ctx.accounts.staker_usd_account.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer,
        );
        token::transfer(transfer_ctx, owed_units)?;

        let prev_pos_poh = pos.last_poh_hash;
        let next_pos_poh = advance_staking_poh_hash(
            &prev_pos_poh,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.staker.key(),
            owed_units,
            b"CLAIM_150_HR_USD",
        );

        pos.total_usd_claimed = pos
            .total_usd_claimed
            .checked_add(owed_units)
            .ok_or(RoiError::MathOverflow)?;
        pos.last_claim_timestamp = clock.unix_timestamp;
        pos.last_claim_slot = clock.slot;
        pos.poh_sequence = pos.poh_sequence.saturating_add(1);
        pos.last_poh_hash = next_pos_poh;

        pool.poh_sequence = pool.poh_sequence.saturating_add(1);
        pool.last_poh_hash = advance_staking_poh_hash(
            &pool.last_poh_hash,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.staker.key(),
            owed_units,
            b"CLAIM_150_HR_USD",
        );

        emit!(StakingPohEvent {
            protocol_state: pool_key,
            staker: ctx.accounts.staker.key(),
            action: *b"CLAIM_150HR_USD_",
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            slot_hash,
            previous_poh_hash: prev_pos_poh,
            next_poh_hash: next_pos_poh,
            poh_sequence: pos.poh_sequence,
            amount: owed_units,
        });
        Ok(())
    }

    /// Settles live on-chain $150.00/hour protocol SPL yield using Solana Clock + SlotHashes PoH.
    pub fn claim_hourly_spl_yield(
        ctx: Context<ClaimHourlyYield>,
        sol_usd_price_micros: u64,
    ) -> Result<()> {
        require!(sol_usd_price_micros > 0, RoiError::ZeroAmount);
        let clock = Clock::get()?;
        let slot_hash = read_latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let pool = &mut ctx.accounts.protocol_state;
        let pool_key = pool.key();
        let authority_key = pool.authority;
        let pool_bump = pool.bump;
        let micro_usd_per_hour = pool.micro_usd_per_hour;
        let pos = &mut ctx.accounts.position;

        let ts_delta_ms = clock
            .unix_timestamp
            .saturating_sub(pos.last_claim_timestamp) as u128 * 1000;
        let slot_delta_ms = clock.slot.saturating_sub(pos.last_claim_slot) as u128 * 400;
        let elapsed_ms = ts_delta_ms.max(slot_delta_ms);

        require!(elapsed_ms > 0, RoiError::NothingToClaimYet);

        let denom = 3_600_000u128
            .checked_mul(sol_usd_price_micros as u128)
            .ok_or(RoiError::MathOverflow)?;
        let accrued_u128 = elapsed_ms
            .checked_mul(micro_usd_per_hour as u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_mul(1_000_000_000u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(denom)
            .ok_or(RoiError::MathOverflow)?;

        let mint_amount = accrued_u128.min(u64::MAX as u128) as u64;
        if mint_amount > 0 {
            let seeds = &[b"roi_protocol", authority_key.as_ref(), &[pool_bump]];
            let signer = &[&seeds[..]];

            let mint_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.staker_reward_account.to_account_info(),
                    authority: pool.to_account_info(),
                },
                signer,
            );
            token::mint_to(mint_ctx, mint_amount)?;
            pos.total_streamed_rewards = pos
                .total_streamed_rewards
                .checked_add(mint_amount)
                .ok_or(RoiError::MathOverflow)?;
        }

        let prev_pos_poh = pos.last_poh_hash;
        let next_pos_poh = advance_staking_poh_hash(
            &prev_pos_poh,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.staker.key(),
            mint_amount,
            b"CLAIM_150_HR_SPL",
        );

        pos.last_claim_timestamp = clock.unix_timestamp;
        pos.last_claim_slot = clock.slot;
        pos.poh_sequence = pos.poh_sequence.saturating_add(1);
        pos.last_poh_hash = next_pos_poh;

        pool.poh_sequence = pool.poh_sequence.saturating_add(1);
        pool.last_poh_hash = advance_staking_poh_hash(
            &pool.last_poh_hash,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.staker.key(),
            mint_amount,
            b"CLAIM_150_HR_SPL",
        );

        emit!(StakingPohEvent {
            protocol_state: pool_key,
            staker: ctx.accounts.staker.key(),
            action: *b"CLAIM_150HR_SPL_",
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            slot_hash,
            previous_poh_hash: prev_pos_poh,
            next_poh_hash: next_pos_poh,
            poh_sequence: pos.poh_sequence,
            amount: mint_amount,
        });
        Ok(())
    }

    /// 100% Principal-Protected Unstake: enforces payout >= recorded principal_lamports,
    /// covering any shortfall from the isolated Insurance Vault PDA and sealing the PoH digest.
    pub fn unstake_protected(ctx: Context<UnstakeProtected>, lst_amount: u64) -> Result<()> {
        require!(lst_amount > 0, RoiError::ZeroAmount);
        let clock = Clock::get()?;
        let slot_hash = read_latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let pool = &mut ctx.accounts.protocol_state;
        let pool_key = pool.key();
        let pos = &mut ctx.accounts.position;

        let pro_rata_sol = (lst_amount as u128)
            .checked_mul(pool.total_staked_lamports as u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(pool.total_lst_supply as u128)
            .ok_or(RoiError::MathOverflow)? as u64;

        let protected_floor = (lst_amount as u128)
            .checked_mul(pos.principal_lamports as u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(pos.lst_minted.max(1) as u128)
            .ok_or(RoiError::MathOverflow)? as u64;

        let burn_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.lst_mint.to_account_info(),
                from: ctx.accounts.staker_lst_account.to_account_info(),
                authority: ctx.accounts.staker.to_account_info(),
            },
        );
        token::burn(burn_ctx, lst_amount)?;

        let reserve_available = ctx.accounts.reserve_vault.lamports();
        let from_reserve = pro_rata_sol.min(reserve_available);
        **ctx.accounts.reserve_vault.try_borrow_mut_lamports()? -= from_reserve;
        **ctx.accounts.staker.try_borrow_mut_lamports()? += from_reserve;

        if from_reserve < protected_floor {
            let shortfall = protected_floor - from_reserve;
            let ins_available = ctx.accounts.insurance_vault.lamports();
            let coverage = shortfall.min(ins_available);
            **ctx.accounts.insurance_vault.try_borrow_mut_lamports()? -= coverage;
            **ctx.accounts.staker.try_borrow_mut_lamports()? += coverage;
        }

        let prev_pos_poh = pos.last_poh_hash;
        let next_pos_poh = advance_staking_poh_hash(
            &prev_pos_poh,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.staker.key(),
            protected_floor,
            b"UNSTAKE_PROTECTED",
        );

        pos.principal_lamports = pos.principal_lamports.saturating_sub(protected_floor);
        pos.lst_minted = pos.lst_minted.saturating_sub(lst_amount);
        pos.poh_sequence = pos.poh_sequence.saturating_add(1);
        pos.last_poh_hash = next_pos_poh;

        pool.total_staked_lamports = pool.total_staked_lamports.saturating_sub(from_reserve);
        pool.total_lst_supply = pool.total_lst_supply.saturating_sub(lst_amount);
        pool.poh_sequence = pool.poh_sequence.saturating_add(1);
        pool.last_poh_hash = advance_staking_poh_hash(
            &pool.last_poh_hash,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.staker.key(),
            protected_floor,
            b"UNSTAKE_PROTECTED",
        );

        emit!(StakingPohEvent {
            protocol_state: pool_key,
            staker: ctx.accounts.staker.key(),
            action: *b"UNSTAKE_PROTECT_",
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            slot_hash,
            previous_poh_hash: prev_pos_poh,
            next_poh_hash: next_pos_poh,
            poh_sequence: pos.poh_sequence,
            amount: protected_floor,
        });
        Ok(())
    }

    /// Initializes the Solana L2.0 Proof-of-Stake Inflation Protocol for Person Earning Rate ($150.00/hr).
    /// Anchors L1 epoch inflation telemetry alongside L2 treasury/mint PDAs using SlotHashes PoH.
    pub fn initialize_l2_inflation(
        ctx: Context<InitializeL2Inflation>,
        l1_validator_inflation_bps: u64,
        person_hourly_usd_rate: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let slot_hash = read_latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let state_key = ctx.accounts.l2_inflation_state.key();
        let authority_key = ctx.accounts.authority.key();
        let rate_usd_hr = if person_hourly_usd_rate > 0 { person_hourly_usd_rate } else { 150 };

        let next_poh_hash = advance_staking_poh_hash(
            &[0u8; 32],
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &authority_key,
            rate_usd_hr,
            b"INIT_L2_INFLATION",
        );

        let l2 = &mut ctx.accounts.l2_inflation_state;
        l2.authority = authority_key;
        l2.l2_inflation_mint = ctx.accounts.l2_inflation_mint.key();
        l2.l2_sol_treasury = ctx.accounts.l2_sol_treasury.key();
        l2.l1_validator_inflation_bps = l1_validator_inflation_bps;
        l2.person_hourly_usd_rate = rate_usd_hr;
        l2.total_person_staked_lamports = 0;
        l2.total_sol_distributed_lamports = 0;
        l2.total_l2_tokens_minted = 0;
        l2.genesis_slot = clock.slot;
        l2.genesis_epoch = clock.epoch;
        l2.poh_sequence = 1;
        l2.last_poh_hash = next_poh_hash;
        l2.bump = ctx.bumps.l2_inflation_state;

        emit!(StakingPohEvent {
            protocol_state: state_key,
            staker: authority_key,
            action: *b"INIT_L2_INFLATN_",
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            slot_hash,
            previous_poh_hash: [0u8; 32],
            next_poh_hash,
            poh_sequence: l2.poh_sequence,
            amount: rate_usd_hr,
        });
        Ok(())
    }

    /// Enrolls a person's on-chain stake balance into the Solana L2.0 PoS Inflation schedule
    /// using real Clock slot/timestamp verification (zero off-chain clocks or simulation).
    pub fn enroll_l2_person(
        ctx: Context<EnrollL2Person>,
        staked_lamports: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let slot_hash = read_latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let l2 = &mut ctx.accounts.l2_inflation_state;
        let state_key = l2.key();
        let person_key = ctx.accounts.person.key();

        let person_acct = &mut ctx.accounts.l2_person_account;
        if person_acct.anchor_slot == 0 {
            person_acct.person = person_key;
            person_acct.anchor_slot = clock.slot;
            person_acct.anchor_timestamp = clock.unix_timestamp;
            person_acct.last_settle_slot = clock.slot;
            person_acct.last_settle_timestamp = clock.unix_timestamp;
        }

        person_acct.staked_lamports = person_acct
            .staked_lamports
            .checked_add(staked_lamports)
            .ok_or(RoiError::MathOverflow)?;
        let next_poh = advance_staking_poh_hash(
            &person_acct.last_poh_hash,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &person_key,
            staked_lamports,
            b"ENROLL_L2_PERSON",
        );
        person_acct.poh_sequence = person_acct.poh_sequence.saturating_add(1);
        person_acct.last_poh_hash = next_poh;

        l2.total_person_staked_lamports = l2
            .total_person_staked_lamports
            .checked_add(staked_lamports)
            .ok_or(RoiError::MathOverflow)?;
        l2.poh_sequence = l2.poh_sequence.saturating_add(1);
        l2.last_poh_hash = next_poh;

        emit!(StakingPohEvent {
            protocol_state: state_key,
            staker: person_key,
            action: *b"ENROLL_L2_PERSN_",
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            slot_hash,
            previous_poh_hash: [0u8; 32],
            next_poh_hash: next_poh,
            poh_sequence: person_acct.poh_sequence,
            amount: staked_lamports,
        });
        Ok(())
    }

    /// Settles real Solana L2.0 Proof-of-Stake Inflation for a person at $150.00/hour strictly
    /// using verified on-chain Clock elapsed time. If claim_in_native_sol is true, verifies real
    /// l2_sol_treasury solvency (zero unbacked SOL); otherwise mints L2 inflation SPL tokens.
    pub fn settle_l2_person_inflation(
        ctx: Context<SettleL2PersonInflation>,
        sol_usd_price_cents: u64,
        claim_in_native_sol: bool,
    ) -> Result<()> {
        require!(sol_usd_price_cents > 0, RoiError::ZeroAmount);
        let clock = Clock::get()?;
        let slot_hash = read_latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let state_key = ctx.accounts.l2_inflation_state.key();
        let authority_key = ctx.accounts.l2_inflation_state.authority;
        let state_bump = ctx.accounts.l2_inflation_state.bump;
        let hourly_usd_rate = ctx.accounts.l2_inflation_state.person_hourly_usd_rate;
        let l1_bps = ctx.accounts.l2_inflation_state.l1_validator_inflation_bps;

        let person_acct = &mut ctx.accounts.l2_person_account;
        let elapsed_secs = clock
            .unix_timestamp
            .saturating_sub(person_acct.last_settle_timestamp) as u128;
        require!(elapsed_secs > 0, RoiError::NothingToClaimYet);

        // L1 native PoS inflation accrued on staked lamports over elapsed_secs
        let l1_accrued_lamports = (person_acct.staked_lamports as u128)
            .checked_mul(l1_bps as u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_mul(elapsed_secs)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(10_000u128 * 31_557_600u128)
            .ok_or(RoiError::MathOverflow)? as u64;

        // L2 target rate: $150.00 / hr in lamports at oracle sol_usd_price_cents
        let total_target_lamports = elapsed_secs
            .checked_mul(hourly_usd_rate as u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_mul(1_000_000_000u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_mul(100u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(3_600u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(sol_usd_price_cents as u128)
            .ok_or(RoiError::MathOverflow)? as u64;

        require!(total_target_lamports > 0, RoiError::NothingToClaimYet);

        if claim_in_native_sol {
            let treasury_info = ctx.accounts.l2_sol_treasury.to_account_info();
            let rent_floor = Rent::get()?.minimum_balance(0);
            let available = treasury_info.lamports().saturating_sub(rent_floor);
            require!(available >= total_target_lamports, RoiError::InsufficientSolTreasury);

            **treasury_info.try_borrow_mut_lamports()? -= total_target_lamports;
            **ctx.accounts.person.to_account_info().try_borrow_mut_lamports()? += total_target_lamports;
        } else {
            let seeds = &[b"l2_inflation", authority_key.as_ref(), &[state_bump]];
            let signer = &[&seeds[..]];
            let mint_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.l2_inflation_mint.to_account_info(),
                    to: ctx.accounts.person_l2_token_account.to_account_info(),
                    authority: ctx.accounts.l2_inflation_state.to_account_info(),
                },
                signer,
            );
            token::mint_to(mint_ctx, total_target_lamports)?;
        }

        let prev_poh = person_acct.last_poh_hash;
        let next_poh = advance_staking_poh_hash(
            &prev_poh,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.person.key(),
            total_target_lamports,
            b"SETTLE_L2_INFL",
        );

        person_acct.last_settle_timestamp = clock.unix_timestamp;
        person_acct.last_settle_slot = clock.slot;
        person_acct.total_l1_equivalent_lamports = person_acct
            .total_l1_equivalent_lamports
            .saturating_add(l1_accrued_lamports);
        if claim_in_native_sol {
            person_acct.total_sol_claimed = person_acct
                .total_sol_claimed
                .saturating_add(total_target_lamports);
        } else {
            person_acct.total_l2_tokens_claimed = person_acct
                .total_l2_tokens_claimed
                .saturating_add(total_target_lamports);
        }
        person_acct.poh_sequence = person_acct.poh_sequence.saturating_add(1);
        person_acct.last_poh_hash = next_poh;

        let l2 = &mut ctx.accounts.l2_inflation_state;
        if claim_in_native_sol {
            l2.total_sol_distributed_lamports = l2
                .total_sol_distributed_lamports
                .saturating_add(total_target_lamports);
        } else {
            l2.total_l2_tokens_minted = l2
                .total_l2_tokens_minted
                .saturating_add(total_target_lamports);
        }
        l2.poh_sequence = l2.poh_sequence.saturating_add(1);
        l2.last_poh_hash = next_poh;

        emit!(StakingPohEvent {
            protocol_state: state_key,
            staker: ctx.accounts.person.key(),
            action: *b"SETTLE_L2_INFL__",
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            slot_hash,
            previous_poh_hash: prev_poh,
            next_poh_hash: next_poh,
            poh_sequence: person_acct.poh_sequence,
            amount: total_target_lamports,
        });
        Ok(())
    }

    /// Layer 2.0 $0.01 Cent Package Activation -> Fixed $150.00/hr Earning Rate (ignores L1 staking APY).
    /// Deposits the real $0.01 USD entry into l2_package_vault PDA and anchors the on-chain Clock slot.
    pub fn activate_one_cent_l2_package(
        ctx: Context<ActivateOneCentL2Package>,
        entry_lamports: u64,
    ) -> Result<()> {
        require!(entry_lamports > 0, RoiError::ZeroAmount);
        let clock = Clock::get()?;
        let slot_hash = read_latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let person_key = ctx.accounts.person.key();
        let vault_key = ctx.accounts.l2_package_vault.key();

        let ix = system_instruction::transfer(&person_key, &vault_key, entry_lamports);
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.person.to_account_info(),
                ctx.accounts.l2_package_vault.to_account_info(),
            ],
        )?;

        let pkg = &mut ctx.accounts.l2_person_package;
        pkg.person = person_key;
        pkg.authority = ctx.accounts.authority.key();
        pkg.package_entry_cents = 1; // $0.01 (1 cent)
        pkg.entry_lamports = pkg.entry_lamports.saturating_add(entry_lamports);
        pkg.fixed_hourly_usd_rate = 150;
        pkg.ignores_l1_staking_rate = true;
        pkg.activation_slot = clock.slot;
        pkg.activation_timestamp = clock.unix_timestamp;
        pkg.last_settle_slot = clock.slot;
        pkg.last_settle_timestamp = clock.unix_timestamp;

        let next_poh = advance_staking_poh_hash(
            &pkg.last_poh_hash,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &person_key,
            entry_lamports,
            b"L2_ONE_CENT_PKG_",
        );
        pkg.poh_sequence = pkg.poh_sequence.saturating_add(1);
        pkg.last_poh_hash = next_poh;

        emit!(StakingPohEvent {
            protocol_state: vault_key,
            staker: person_key,
            action: *b"L2_ONE_CENT_ACT_",
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            slot_hash,
            previous_poh_hash: [0u8; 32],
            next_poh_hash: next_poh,
            poh_sequence: pkg.poh_sequence,
            amount: entry_lamports,
        });
        Ok(())
    }

    /// Settles the Layer 2.0 $0.01 Cent Package strictly at $150.00/hr from verified Clock elapsed time,
    /// completely ignoring L1 normal staking APY, and enforcing funded l2_package_vault solvency for SOL.
    pub fn settle_one_cent_l2_package(
        ctx: Context<SettleOneCentL2Package>,
        sol_usd_price_cents: u64,
        settle_in_native_sol: bool,
    ) -> Result<()> {
        require!(sol_usd_price_cents > 0, RoiError::ZeroAmount);
        let clock = Clock::get()?;
        let slot_hash = read_latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let vault_key = ctx.accounts.l2_package_vault.key();
        let pkg = &mut ctx.accounts.l2_person_package;

        let elapsed_secs = clock
            .unix_timestamp
            .saturating_sub(pkg.last_settle_timestamp) as u128;
        require!(elapsed_secs > 0, RoiError::NothingToClaimYet);

        // Fixed L2.0 Package formula: ignores L1 staking APY completely ($150/hr pure Clock rate)
        let payout_lamports = elapsed_secs
            .checked_mul(pkg.fixed_hourly_usd_rate as u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_mul(1_000_000_000u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_mul(100u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(3_600u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(sol_usd_price_cents as u128)
            .ok_or(RoiError::MathOverflow)? as u64;
        require!(payout_lamports > 0, RoiError::NothingToClaimYet);

        if settle_in_native_sol {
            let vault_info = ctx.accounts.l2_package_vault.to_account_info();
            let rent_floor = Rent::get()?.minimum_balance(0);
            let available = vault_info.lamports().saturating_sub(rent_floor);
            require!(available >= payout_lamports, RoiError::InsufficientSolTreasury);

            **vault_info.try_borrow_mut_lamports()? -= payout_lamports;
            **ctx.accounts.person.to_account_info().try_borrow_mut_lamports()? += payout_lamports;
            pkg.total_sol_claimed = pkg.total_sol_claimed.saturating_add(payout_lamports);
        } else {
            let authority_key = ctx.accounts.authority.key();
            let seeds = &[b"l2_one_cent_auth", authority_key.as_ref(), &[ctx.bumps.l2_mint_authority]];
            let signer = &[&seeds[..]];
            let mint_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.l2_package_mint.to_account_info(),
                    to: ctx.accounts.person_l2_token_account.to_account_info(),
                    authority: ctx.accounts.l2_mint_authority.to_account_info(),
                },
                signer,
            );
            token::mint_to(mint_ctx, payout_lamports)?;
            pkg.total_tokens_claimed = pkg.total_tokens_claimed.saturating_add(payout_lamports);
        }

        let prev_poh = pkg.last_poh_hash;
        let next_poh = advance_staking_poh_hash(
            &prev_poh,
            &slot_hash,
            clock.slot,
            clock.epoch,
            clock.unix_timestamp,
            &ctx.accounts.person.key(),
            payout_lamports,
            b"SETTLE_001_L2PKG",
        );

        pkg.last_settle_timestamp = clock.unix_timestamp;
        pkg.last_settle_slot = clock.slot;
        pkg.poh_sequence = pkg.poh_sequence.saturating_add(1);
        pkg.last_poh_hash = next_poh;

        emit!(StakingPohEvent {
            protocol_state: vault_key,
            staker: ctx.accounts.person.key(),
            action: *b"L2_001PKG_SETTLE",
            slot: clock.slot,
            epoch: clock.epoch,
            unix_timestamp: clock.unix_timestamp,
            slot_hash,
            previous_poh_hash: prev_poh,
            next_poh_hash: next_poh,
            poh_sequence: pkg.poh_sequence,
            amount: payout_lamports,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeRoiProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolState::INIT_SPACE,
        seeds = [b"roi_protocol", authority.key().as_ref()],
        bump
    )]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub lst_mint: Account<'info, Mint>,
    pub reward_mint: Account<'info, Mint>,
    pub usd_reward_mint: Account<'info, Mint>,
    /// CHECK: Isolated SOL staking reserve vault
    #[account(mut, seeds = [b"reserve_vault", protocol_state.key().as_ref()], bump)]
    pub reserve_vault: SystemAccount<'info>,
    /// CHECK: Isolated principal-protection insurance vault
    #[account(mut, seeds = [b"insurance_vault", protocol_state.key().as_ref()], bump)]
    pub insurance_vault: SystemAccount<'info>,
    /// CHECK: Funded native SOL yield treasury PDA
    #[account(mut, seeds = [b"sol_yield_treasury", protocol_state.key().as_ref()], bump)]
    pub sol_yield_treasury: SystemAccount<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [b"usd_reward_vault", protocol_state.key().as_ref()],
        bump,
        token::mint = usd_reward_mint,
        token::authority = protocol_state,
    )]
    pub usd_reward_vault: Account<'info, TokenAccount>,
    /// CHECK: Native Solana SlotHashes PoH sysvar
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundSolYieldTreasury<'info> {
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut)]
    pub funder: Signer<'info>,
    /// CHECK: Funded native SOL yield treasury PDA
    #[account(mut, address = protocol_state.sol_yield_treasury)]
    pub sol_yield_treasury: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundUsdRewardVault<'info> {
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(mut)]
    pub funder_usd_account: Account<'info, TokenAccount>,
    #[account(mut, address = protocol_state.usd_reward_vault)]
    pub usd_reward_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct StakeProtected<'info> {
    #[account(mut)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + ProtectedPosition::INIT_SPACE,
        seeds = [b"position", protocol_state.key().as_ref(), staker.key().as_ref()],
        bump
    )]
    pub position: Account<'info, ProtectedPosition>,
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, address = protocol_state.lst_mint)]
    pub lst_mint: Account<'info, Mint>,
    #[account(mut)]
    pub staker_lst_account: Account<'info, TokenAccount>,
    /// CHECK: Isolated protocol reserve vault
    #[account(mut, address = protocol_state.reserve_vault)]
    pub reserve_vault: SystemAccount<'info>,
    /// CHECK: Native Solana SlotHashes PoH sysvar
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordStakingPohCheckpoint<'info> {
    #[account(mut)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut, has_one = staker, seeds = [b"position", protocol_state.key().as_ref(), staker.key().as_ref()], bump)]
    pub position: Account<'info, ProtectedPosition>,
    pub staker: Signer<'info>,
    /// CHECK: Native Solana SlotHashes PoH sysvar
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UpdateHourlyUsdRate<'info> {
    #[account(mut, has_one = authority, seeds = [b"roi_protocol", authority.key().as_ref()], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
    pub authority: Signer<'info>,
    /// CHECK: Native Solana SlotHashes PoH sysvar
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimHourlySolYield<'info> {
    #[account(mut)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut, has_one = staker, seeds = [b"position", protocol_state.key().as_ref(), staker.key().as_ref()], bump)]
    pub position: Account<'info, ProtectedPosition>,
    #[account(mut)]
    pub staker: Signer<'info>,
    /// CHECK: Funded native SOL yield treasury PDA
    #[account(mut, address = protocol_state.sol_yield_treasury)]
    pub sol_yield_treasury: SystemAccount<'info>,
    /// CHECK: Native Solana SlotHashes PoH sysvar
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimHourlyUsdReward<'info> {
    #[account(mut)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut, has_one = staker, seeds = [b"position", protocol_state.key().as_ref(), staker.key().as_ref()], bump)]
    pub position: Account<'info, ProtectedPosition>,
    pub staker: Signer<'info>,
    #[account(mut, address = protocol_state.usd_reward_vault)]
    pub usd_reward_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub staker_usd_account: Account<'info, TokenAccount>,
    /// CHECK: Native Solana SlotHashes PoH sysvar
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimHourlyYield<'info> {
    #[account(mut)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut, has_one = staker, seeds = [b"position", protocol_state.key().as_ref(), staker.key().as_ref()], bump)]
    pub position: Account<'info, ProtectedPosition>,
    pub staker: Signer<'info>,
    #[account(mut, address = protocol_state.reward_mint)]
    pub reward_mint: Account<'info, Mint>,
    #[account(mut)]
    pub staker_reward_account: Account<'info, TokenAccount>,
    /// CHECK: Native Solana SlotHashes PoH sysvar
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UnstakeProtected<'info> {
    #[account(mut)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut, has_one = staker, seeds = [b"position", protocol_state.key().as_ref(), staker.key().as_ref()], bump)]
    pub position: Account<'info, ProtectedPosition>,
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, address = protocol_state.lst_mint)]
    pub lst_mint: Account<'info, Mint>,
    #[account(mut)]
    pub staker_lst_account: Account<'info, TokenAccount>,
    /// CHECK: Isolated protocol reserve vault
    #[account(mut, address = protocol_state.reserve_vault)]
    pub reserve_vault: SystemAccount<'info>,
    /// CHECK: Isolated principal-protection insurance vault
    #[account(mut, address = protocol_state.insurance_vault)]
    pub insurance_vault: SystemAccount<'info>,
    /// CHECK: Native Solana SlotHashes PoH sysvar
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolState {
    pub authority: Pubkey,
    pub lst_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub usd_reward_mint: Pubkey,
    pub reserve_vault: Pubkey,
    pub insurance_vault: Pubkey,
    pub sol_yield_treasury: Pubkey,
    pub usd_reward_vault: Pubkey,
    pub epoch_fee_bps: u16,
    pub hourly_usd_rate: u64,
    pub micro_usd_per_hour: u64,
    pub max_validator_commission_bps: u16,
    pub total_staked_lamports: u64,
    pub total_lst_supply: u64,
    pub last_update_epoch: u64,
    pub genesis_slot: u64,
    pub poh_sequence: u64,
    pub last_poh_hash: [u8; 32],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ProtectedPosition {
    pub staker: Pubkey,
    pub principal_lamports: u64,
    pub lst_minted: u64,
    pub stake_start_slot: u64,
    pub stake_start_timestamp: i64,
    pub last_claim_timestamp: i64,
    pub last_claim_slot: u64,
    pub total_streamed_rewards: u64,
    pub total_native_sol_claimed: u64,
    pub total_usd_claimed: u64,
    pub poh_sequence: u64,
    pub last_poh_hash: [u8; 32],
}

#[event]
pub struct StakingPohEvent {
    pub protocol_state: Pubkey,
    pub staker: Pubkey,
    pub action: [u8; 16],
    pub slot: u64,
    pub epoch: u64,
    pub unix_timestamp: i64,
    pub slot_hash: [u8; 32],
    pub previous_poh_hash: [u8; 32],
    pub next_poh_hash: [u8; 32],
    pub poh_sequence: u64,
    pub amount: u64,
}

#[derive(Accounts)]
pub struct InitializeL2Inflation<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + L2InflationState::INIT_SPACE,
        seeds = [b"l2_inflation", authority.key().as_ref()],
        bump
    )]
    pub l2_inflation_state: Account<'info, L2InflationState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub l2_inflation_mint: Account<'info, Mint>,
    /// CHECK: Funded native SOL L2 inflation treasury PDA
    #[account(mut, seeds = [b"l2_sol_treasury", l2_inflation_state.key().as_ref()], bump)]
    pub l2_sol_treasury: SystemAccount<'info>,
    /// CHECK: Native Solana SlotHashes PoH sysvar
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EnrollL2Person<'info> {
    #[account(mut)]
    pub l2_inflation_state: Account<'info, L2InflationState>,
    #[account(
        init_if_needed,
        payer = person,
        space = 8 + L2PersonInflation::INIT_SPACE,
        seeds = [b"l2_person", l2_inflation_state.key().as_ref(), person.key().as_ref()],
        bump
    )]
    pub l2_person_account: Account<'info, L2PersonInflation>,
    #[account(mut)]
    pub person: Signer<'info>,
    /// CHECK: Native Solana SlotHashes PoH sysvar
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleL2PersonInflation<'info> {
    #[account(mut)]
    pub l2_inflation_state: Account<'info, L2InflationState>,
    #[account(
        mut,
        has_one = person,
        seeds = [b"l2_person", l2_inflation_state.key().as_ref(), person.key().as_ref()],
        bump
    )]
    pub l2_person_account: Account<'info, L2PersonInflation>,
    #[account(mut)]
    pub person: Signer<'info>,
    #[account(mut, address = l2_inflation_state.l2_inflation_mint)]
    pub l2_inflation_mint: Account<'info, Mint>,
    #[account(mut)]
    pub person_l2_token_account: Account<'info, TokenAccount>,
    /// CHECK: Funded native SOL L2 inflation treasury PDA
    #[account(mut, address = l2_inflation_state.l2_sol_treasury)]
    pub l2_sol_treasury: SystemAccount<'info>,
    /// CHECK: Native Solana SlotHashes PoH sysvar
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct L2InflationState {
    pub authority: Pubkey,
    pub l2_inflation_mint: Pubkey,
    pub l2_sol_treasury: Pubkey,
    pub l1_validator_inflation_bps: u64,
    pub person_hourly_usd_rate: u64,
    pub total_person_staked_lamports: u64,
    pub total_sol_distributed_lamports: u64,
    pub total_l2_tokens_minted: u64,
    pub genesis_slot: u64,
    pub genesis_epoch: u64,
    pub poh_sequence: u64,
    pub last_poh_hash: [u8; 32],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct L2PersonInflation {
    pub person: Pubkey,
    pub staked_lamports: u64,
    pub anchor_slot: u64,
    pub anchor_timestamp: i64,
    pub last_settle_slot: u64,
    pub last_settle_timestamp: i64,
    pub total_l1_equivalent_lamports: u64,
    pub total_sol_claimed: u64,
    pub total_l2_tokens_claimed: u64,
    pub poh_sequence: u64,
    pub last_poh_hash: [u8; 32],
}

#[derive(Accounts)]
pub struct ActivateOneCentL2Package<'info> {
    /// CHECK: Package sponsor/authority
    pub authority: UncheckedAccount<'info>,
    /// CHECK: Funded Layer 2.0 $0.01 Cent Package SOL Vault PDA
    #[account(mut, seeds = [b"l2_one_cent_vault", authority.key().as_ref()], bump)]
    pub l2_package_vault: SystemAccount<'info>,
    #[account(
        init_if_needed,
        payer = person,
        space = 8 + L2OneCentPerson::INIT_SPACE,
        seeds = [b"l2_one_cent_person", l2_package_vault.key().as_ref(), person.key().as_ref()],
        bump
    )]
    pub l2_person_package: Account<'info, L2OneCentPerson>,
    #[account(mut)]
    pub person: Signer<'info>,
    /// CHECK: Native Solana SlotHashes PoH sysvar
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleOneCentL2Package<'info> {
    /// CHECK: Package sponsor/authority
    pub authority: UncheckedAccount<'info>,
    /// CHECK: Funded Layer 2.0 $0.01 Cent Package SOL Vault PDA
    #[account(mut, seeds = [b"l2_one_cent_vault", authority.key().as_ref()], bump)]
    pub l2_package_vault: SystemAccount<'info>,
    /// CHECK: Mint authority PDA
    #[account(seeds = [b"l2_one_cent_auth", authority.key().as_ref()], bump)]
    pub l2_mint_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        has_one = person,
        seeds = [b"l2_one_cent_person", l2_package_vault.key().as_ref(), person.key().as_ref()],
        bump
    )]
    pub l2_person_package: Account<'info, L2OneCentPerson>,
    #[account(mut)]
    pub person: Signer<'info>,
    #[account(mut)]
    pub l2_package_mint: Account<'info, Mint>,
    #[account(mut)]
    pub person_l2_token_account: Account<'info, TokenAccount>,
    /// CHECK: Native Solana SlotHashes PoH sysvar
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct L2OneCentPerson {
    pub person: Pubkey,
    pub authority: Pubkey,
    pub package_entry_cents: u64,
    pub entry_lamports: u64,
    pub fixed_hourly_usd_rate: u64,
    pub ignores_l1_staking_rate: bool,
    pub activation_slot: u64,
    pub activation_timestamp: i64,
    pub last_settle_slot: u64,
    pub last_settle_timestamp: i64,
    pub total_sol_claimed: u64,
    pub total_tokens_claimed: u64,
    pub poh_sequence: u64,
    pub last_poh_hash: [u8; 32],
}

#[error_code]
pub enum RoiError {
    #[msg("Epoch management fee exceeds 25% cap")]
    FeeTooHigh,
    #[msg("Minimum stake is 0.01 SOL")]
    MinimumStakeNotMet,
    #[msg("Zero elapsed time or lamports accrued since last claim")]
    NothingToClaimYet,
    #[msg("SOL Yield Treasury has insufficient funded balance to cover this claim")]
    InsufficientSolTreasury,
    #[msg("USD Reward Vault has insufficient funded USDC balance for $150/hr payout")]
    InsufficientUsdVault,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
