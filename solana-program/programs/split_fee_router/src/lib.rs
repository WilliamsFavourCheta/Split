use crate::program::SplitFeeRouter;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

// Development ID only. Replace with the deployed program address before integration.
declare_id!("Fg6PaFpoGXkYsidMpWxTWqkZzZuyhzCf81xbj2dH7Jf");

const BPS: u128 = 10_000;
const PROTOCOL_BPS: u128 = 1_000;

#[program]
pub mod split_fee_router {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        protocol_treasury: Pubkey,
    ) -> Result<()> {
        require!(
            protocol_treasury != Pubkey::default(),
            SplitError::InvalidRecipient
        );
        ctx.accounts.protocol.authority = ctx.accounts.upgrade_authority.key();
        ctx.accounts.protocol.treasury = protocol_treasury;
        Ok(())
    }

    pub fn register_project(ctx: Context<RegisterProject>, shares: Shares) -> Result<()> {
        require!(shares.total()? == BPS as u16, SplitError::InvalidShares);
        require!(
            ctx.accounts.project_treasury.key() != Pubkey::default(),
            SplitError::InvalidRecipient
        );
        require!(
            ctx.accounts.community.key() != Pubkey::default(),
            SplitError::InvalidRecipient
        );
        let project = &mut ctx.accounts.project;
        project.mint = ctx.accounts.mint.key();
        project.quote_mint = ctx.accounts.quote_mint.key();
        project.creator = ctx.accounts.creator.key();
        project.project_treasury = ctx.accounts.project_treasury.key();
        project.community = ctx.accounts.community.key();
        project.protocol_treasury = ctx.accounts.protocol.treasury;
        project.shares = shares;
        project.bump = ctx.bumps.project;
        emit!(ProjectRegistered {
            mint: project.mint,
            creator: project.creator,
            shares
        });
        Ok(())
    }

    // Accounts tokens already present in the project's dedicated quote vault.
    // The Raydium claim CPI must precede this instruction in the finished launch flow.
    pub fn allocate_available(ctx: Context<AllocateAvailable>) -> Result<()> {
        let project = &mut ctx.accounts.project;
        let outstanding = project.outstanding()?;
        let gross = ctx
            .accounts
            .vault
            .amount
            .checked_sub(outstanding)
            .ok_or(SplitError::VaultUnderfunded)?;
        require!(gross > 0, SplitError::NoNewFees);
        let allocation = allocate(gross, project.shares)?;
        project.protocol_pending = add(project.protocol_pending, allocation.protocol)?;
        project.creator_pending = add(project.creator_pending, allocation.creator)?;
        project.treasury_pending = add(project.treasury_pending, allocation.project_treasury)?;
        project.community_pending = add(project.community_pending, allocation.community)?;
        project.liquidity_locked = add(project.liquidity_locked, allocation.liquidity)?;
        emit!(FeesAllocated {
            mint: project.mint,
            gross,
            protocol: allocation.protocol,
            creator: allocation.creator,
            project_treasury: allocation.project_treasury,
            community: allocation.community,
            liquidity: allocation.liquidity,
        });
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>, role: ClaimRole) -> Result<()> {
        let project = &mut ctx.accounts.project;
        let (expected_recipient, pending) = match role {
            ClaimRole::Protocol => (project.protocol_treasury, &mut project.protocol_pending),
            ClaimRole::Creator => (project.creator, &mut project.creator_pending),
            ClaimRole::ProjectTreasury => (project.project_treasury, &mut project.treasury_pending),
            ClaimRole::Community => (project.community, &mut project.community_pending),
        };
        require_keys_eq!(
            ctx.accounts.recipient.key(),
            expected_recipient,
            SplitError::WrongRecipient
        );
        let amount = *pending;
        require!(amount > 0, SplitError::NothingToClaim);
        *pending = 0;
        let mint = project.mint;
        let bump = [project.bump];
        let seeds: &[&[u8]] = &[b"project", mint.as_ref(), &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.recipient_tokens.to_account_info(),
                    authority: project.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        emit!(FeesClaimed {
            mint,
            recipient: expected_recipient,
            role,
            amount
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub upgrade_authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, SplitFeeRouter>,
    #[account(constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()))]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = upgrade_authority, space = 8 + Protocol::INIT_SPACE, seeds = [b"protocol"], bump)]
    pub protocol: Account<'info, Protocol>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterProject<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub creator: Signer<'info>,
    #[account(address = protocol.authority)]
    pub platform_authority: Signer<'info>,
    #[account(seeds = [b"protocol"], bump)]
    pub protocol: Account<'info, Protocol>,
    // A fresh mint keypair signs registration before LaunchLab initializes the mint.
    pub mint: Signer<'info>,
    #[account(address = anchor_spl::token::spl_token::native_mint::ID)]
    pub quote_mint: Account<'info, Mint>,
    /// CHECK: Stored as an immutable recipient; checked against the claim signer later.
    pub project_treasury: UncheckedAccount<'info>,
    /// CHECK: Stored as an immutable recipient; checked against the claim signer later.
    pub community: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + Project::INIT_SPACE, seeds = [b"project", mint.key().as_ref()], bump)]
    pub project: Account<'info, Project>,
    #[account(init, payer = payer, token::mint = quote_mint, token::authority = project, seeds = [b"vault", project.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[account]
#[derive(InitSpace)]
pub struct Protocol {
    pub authority: Pubkey,
    pub treasury: Pubkey,
}

#[derive(Accounts)]
pub struct AllocateAvailable<'info> {
    #[account(mut, seeds = [b"project", project.mint.as_ref()], bump = project.bump)]
    pub project: Account<'info, Project>,
    #[account(seeds = [b"vault", project.key().as_ref()], bump, token::mint = project.quote_mint, token::authority = project)]
    pub vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, seeds = [b"project", project.mint.as_ref()], bump = project.bump)]
    pub project: Account<'info, Project>,
    #[account(mut, seeds = [b"vault", project.key().as_ref()], bump, token::mint = project.quote_mint, token::authority = project)]
    pub vault: Account<'info, TokenAccount>,
    pub recipient: Signer<'info>,
    #[account(mut, token::mint = project.quote_mint, token::authority = recipient)]
    pub recipient_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Project {
    pub mint: Pubkey,
    pub quote_mint: Pubkey,
    pub creator: Pubkey,
    pub project_treasury: Pubkey,
    pub community: Pubkey,
    pub protocol_treasury: Pubkey,
    pub shares: Shares,
    pub bump: u8,
    pub protocol_pending: u64,
    pub creator_pending: u64,
    pub treasury_pending: u64,
    pub community_pending: u64,
    pub liquidity_locked: u64,
}

impl Project {
    fn outstanding(&self) -> Result<u64> {
        [
            self.protocol_pending,
            self.creator_pending,
            self.treasury_pending,
            self.community_pending,
            self.liquidity_locked,
        ]
        .into_iter()
        .try_fold(0_u64, |sum, value| add(sum, value))
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub struct Shares {
    pub creator: u16,
    pub liquidity: u16,
    pub project_treasury: u16,
    pub community: u16,
}

impl Shares {
    fn total(&self) -> Result<u16> {
        [
            self.creator,
            self.liquidity,
            self.project_treasury,
            self.community,
        ]
        .into_iter()
        .try_fold(0_u16, |sum, share| {
            sum.checked_add(share).ok_or(error!(SplitError::Overflow))
        })
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimRole {
    Protocol,
    Creator,
    ProjectTreasury,
    Community,
}

#[derive(Debug, PartialEq, Eq)]
struct Allocation {
    protocol: u64,
    creator: u64,
    project_treasury: u64,
    community: u64,
    liquidity: u64,
}

fn allocate(gross: u64, shares: Shares) -> Result<Allocation> {
    require!(shares.total()? == BPS as u16, SplitError::InvalidShares);
    let protocol = (u128::from(gross) * PROTOCOL_BPS / BPS) as u64;
    let project = gross - protocol;
    let part = |bps: u16| -> u64 { (u128::from(project) * u128::from(bps) / BPS) as u64 };
    let creator = part(shares.creator);
    let project_treasury = part(shares.project_treasury);
    let community = part(shares.community);
    let liquidity = project - creator - project_treasury - community;
    Ok(Allocation {
        protocol,
        creator,
        project_treasury,
        community,
        liquidity,
    })
}

fn add(left: u64, right: u64) -> Result<u64> {
    left.checked_add(right).ok_or(error!(SplitError::Overflow))
}

#[event]
pub struct ProjectRegistered {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub shares: Shares,
}
#[event]
pub struct FeesAllocated {
    pub mint: Pubkey,
    pub gross: u64,
    pub protocol: u64,
    pub creator: u64,
    pub project_treasury: u64,
    pub community: u64,
    pub liquidity: u64,
}
#[event]
pub struct FeesClaimed {
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub role: ClaimRole,
    pub amount: u64,
}

#[error_code]
pub enum SplitError {
    #[msg("The recipient cannot be the default public key")]
    InvalidRecipient,
    #[msg("The four shares must add to 10,000 basis points")]
    InvalidShares,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("The fee vault contains less than its accounted balance")]
    VaultUnderfunded,
    #[msg("The fee vault contains no unallocated fees")]
    NoNewFees,
    #[msg("This wallet cannot claim the selected share")]
    WrongRecipient,
    #[msg("There is no balance to claim")]
    NothingToClaim,
}

#[cfg(test)]
mod tests {
    use super::*;
    const DEFAULT: Shares = Shares {
        creator: 4_000,
        liquidity: 3_000,
        project_treasury: 2_000,
        community: 1_000,
    };

    #[test]
    fn mirrors_existing_split() {
        assert_eq!(
            allocate(100, DEFAULT).unwrap(),
            Allocation {
                protocol: 10,
                creator: 36,
                liquidity: 27,
                project_treasury: 18,
                community: 9
            }
        );
    }

    #[test]
    fn every_quote_unit_is_accounted_for() {
        for gross in [1, 2, 3, 7, 11, 99, 1_000_000_001, u64::MAX] {
            let a = allocate(gross, DEFAULT).unwrap();
            assert_eq!(
                u128::from(a.protocol)
                    + u128::from(a.creator)
                    + u128::from(a.project_treasury)
                    + u128::from(a.community)
                    + u128::from(a.liquidity),
                u128::from(gross)
            );
        }
    }

    #[test]
    fn rejects_invalid_shares() {
        let bad = Shares {
            community: 1_001,
            ..DEFAULT
        };
        assert!(allocate(100, bad).is_err());
    }
}
