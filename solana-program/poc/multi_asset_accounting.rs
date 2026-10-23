//! Test-only accounting model. This does not execute Raydium or SPL Token instructions.
//! Run: rustc +stable --test poc/multi_asset_accounting.rs -o target/poc-accounting.exe
//!      target/poc-accounting.exe

use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Source {
    LaunchLab,
    CpmmCreator,
    FeeKey,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Role {
    Protocol,
    Creator,
    Treasury,
    Community,
}

#[derive(Clone, Copy)]
struct Project {
    pool: u64,
    mint: u64,
    quote_mint: u64,
    recipients: [u64; 4],
    shares: [u16; 4], // creator, liquidity, treasury, community
}

#[derive(Default)]
struct AssetBalance {
    pending: [u64; 4], // protocol, creator, treasury, community
    liquidity_reserve: u64,
    vault: u64,
}

#[derive(Default)]
struct Ledger {
    projects: HashMap<u64, Project>,
    assets: HashMap<(u64, u64), AssetBalance>, // (project, received asset mint)
    receipts: HashSet<(Source, u64, u64)>,     // (source, pool, claim identifier)
}

impl Ledger {
    fn register(&mut self, project_id: u64, project: Project) -> Result<(), &'static str> {
        if project.shares.iter().map(|x| u32::from(*x)).sum::<u32>() != 10_000 {
            return Err("invalid shares");
        }
        if self.projects.contains_key(&project_id) {
            return Err("duplicate project");
        }
        self.projects.insert(project_id, project);
        Ok(())
    }

    fn collect(
        &mut self,
        project_id: u64,
        source: Source,
        pool: u64,
        asset_mint: u64,
        claim_id: u64,
        source_before: u64,
        source_after: u64,
        vault_before: u64,
        vault_after: u64,
    ) -> Result<u64, &'static str> {
        let project = self.projects.get(&project_id).ok_or("unknown project")?;
        if pool != project.pool {
            return Err("wrong pool");
        }
        if asset_mint != project.mint && asset_mint != project.quote_mint {
            return Err("wrong asset");
        }
        if source == Source::LaunchLab && asset_mint != project.quote_mint {
            return Err("wrong LaunchLab asset");
        }
        let receipt = (source, pool, claim_id);
        if self.receipts.contains(&receipt) {
            return Err("duplicate collection");
        }
        let gross = source_after
            .checked_sub(source_before)
            .ok_or("negative source delta")?;
        if gross == 0 || vault_after.checked_sub(vault_before) != Some(gross) {
            return Err("unreconciled collection");
        }
        let asset = self.assets.entry((project_id, asset_mint)).or_default();
        if asset.vault != vault_before {
            return Err("unreconciled vault");
        }
        let protocol = gross / 10;
        let project_amount = gross.checked_sub(protocol).ok_or("underflow")?;
        let share = |bps: u16| -> Result<u64, &'static str> {
            u64::try_from(u128::from(project_amount) * u128::from(bps) / 10_000)
                .map_err(|_| "overflow")
        };
        let creator = share(project.shares[0])?;
        let treasury = share(project.shares[2])?;
        let community = share(project.shares[3])?;
        let liquidity = project_amount
            .checked_sub(creator)
            .and_then(|x| x.checked_sub(treasury))
            .and_then(|x| x.checked_sub(community))
            .ok_or("underflow")?;
        let amounts = [protocol, creator, treasury, community];
        let mut pending = asset.pending;
        for (entry, amount) in pending.iter_mut().zip(amounts) {
            *entry = entry.checked_add(amount).ok_or("overflow")?;
        }
        let reserve = asset
            .liquidity_reserve
            .checked_add(liquidity)
            .ok_or("overflow")?;
        let expected = pending
            .iter()
            .try_fold(reserve, |sum, x| sum.checked_add(*x))
            .ok_or("overflow")?;
        if expected > vault_after {
            return Err("vault underfunded");
        }
        asset.pending = pending;
        asset.liquidity_reserve = reserve;
        asset.vault = vault_after;
        self.receipts.insert(receipt);
        Ok(gross)
    }

    fn claim(
        &mut self,
        project_id: u64,
        mint: u64,
        role: Role,
        signer: u64,
    ) -> Result<u64, &'static str> {
        let project = self.projects.get(&project_id).ok_or("unknown project")?;
        let index = match role {
            Role::Protocol => 0,
            Role::Creator => 1,
            Role::Treasury => 2,
            Role::Community => 3,
        };
        if signer != project.recipients[index] {
            return Err("wrong recipient");
        }
        let asset = self
            .assets
            .get_mut(&(project_id, mint))
            .ok_or("wrong asset")?;
        let amount = asset.pending[index];
        if amount == 0 {
            return Err("nothing to claim");
        }
        asset.vault = asset.vault.checked_sub(amount).ok_or("vault underfunded")?;
        asset.pending[index] = 0;
        Ok(amount)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(pool: u64, mint: u64) -> Project {
        Project {
            pool,
            mint,
            quote_mint: 2,
            recipients: [10, 11, 12, 13],
            shares: [4_000, 3_000, 2_000, 1_000],
        }
    }

    #[test]
    fn two_assets_two_projects_reconcile_and_claim() {
        let mut ledger = Ledger::default();
        ledger.register(1, project(101, 201)).unwrap();
        ledger.register(2, project(102, 202)).unwrap();
        assert_eq!(
            ledger.collect(1, Source::LaunchLab, 101, 2, 1, 0, 100, 0, 100),
            Ok(100)
        );
        assert_eq!(
            ledger.collect(1, Source::CpmmCreator, 101, 201, 2, 0, 101, 0, 101),
            Ok(101)
        );
        assert_eq!(
            ledger.collect(2, Source::FeeKey, 102, 2, 3, 0, 7, 0, 7),
            Ok(7)
        );
        let quote = ledger.assets.get(&(1, 2)).unwrap();
        assert_eq!(
            (quote.pending, quote.liquidity_reserve),
            ([10, 36, 18, 9], 27)
        );
        let base = ledger.assets.get(&(1, 201)).unwrap();
        assert_eq!(
            base.pending.iter().sum::<u64>() + base.liquidity_reserve,
            101
        );
        assert_eq!(ledger.claim(1, 2, Role::Creator, 11), Ok(36));
        assert_eq!(ledger.claim(1, 2, Role::Treasury, 12), Ok(18));
        assert_eq!(ledger.claim(1, 2, Role::Community, 13), Ok(9));
        assert_eq!(ledger.claim(1, 2, Role::Protocol, 10), Ok(10));
        assert_eq!(ledger.assets[&(1, 2)].vault, 27);
        assert_eq!(ledger.assets[&(2, 2)].vault, 7);
        assert_eq!(
            ledger.claim(1, 2, Role::Creator, 11),
            Err("nothing to claim")
        );
    }

    #[test]
    fn rejects_wrong_pool_asset_duplicate_and_unreconciled_deposit() {
        let mut ledger = Ledger::default();
        ledger.register(1, project(101, 201)).unwrap();
        assert_eq!(
            ledger.register(1, project(101, 201)),
            Err("duplicate project")
        );
        assert_eq!(
            ledger.collect(1, Source::CpmmCreator, 102, 2, 1, 0, 10, 0, 10),
            Err("wrong pool")
        );
        assert_eq!(
            ledger.collect(1, Source::CpmmCreator, 101, 202, 1, 0, 10, 0, 10),
            Err("wrong asset")
        );
        assert_eq!(
            ledger.collect(1, Source::LaunchLab, 101, 201, 1, 0, 10, 0, 10),
            Err("wrong LaunchLab asset")
        );
        assert_eq!(
            ledger.collect(1, Source::CpmmCreator, 101, 2, 1, 0, 10, 0, 11),
            Err("unreconciled collection")
        );
        assert_eq!(
            ledger.collect(1, Source::CpmmCreator, 101, 2, 1, 0, 10, 0, 10),
            Ok(10)
        );
        assert_eq!(
            ledger.collect(1, Source::CpmmCreator, 101, 2, 1, 10, 20, 10, 20),
            Err("duplicate collection")
        );
        assert_eq!(
            ledger.collect(1, Source::CpmmCreator, 101, 2, 2, 10, 20, 11, 21),
            Err("unreconciled vault")
        );
        assert_eq!(
            ledger.claim(1, 2, Role::Creator, 12),
            Err("wrong recipient")
        );
        assert_eq!(ledger.claim(1, 201, Role::Creator, 11), Err("wrong asset"));
    }

    #[test]
    fn small_amounts_and_maximum_amount_conserve_units() {
        for gross in [1, 2, 3, 7, 11, u64::MAX] {
            let mut ledger = Ledger::default();
            ledger.register(1, project(101, 201)).unwrap();
            ledger
                .collect(1, Source::CpmmCreator, 101, 201, 1, 0, gross, 0, gross)
                .unwrap();
            let asset = &ledger.assets[&(1, 201)];
            let total = asset.pending.iter().map(|x| u128::from(*x)).sum::<u128>()
                + u128::from(asset.liquidity_reserve);
            assert_eq!(total, u128::from(gross));
        }
    }
}
