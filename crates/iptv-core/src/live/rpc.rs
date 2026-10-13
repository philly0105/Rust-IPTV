//! `live.*` RPC commands (failover slice).

use super::Alternates;
use crate::catalog::rpc::RefArgs;
use crate::error::RpcError;
use crate::rpc::RpcRouter;
use crate::state::AppState;
use std::sync::Arc;

/// Every command this module registers.
pub const COMMANDS: &[&str] = &["live.alternates"];

/// `live.alternates {ref}`: the same channel elsewhere, best first.
pub async fn alternates(state: Arc<AppState>, a: RefArgs) -> Result<Alternates, RpcError> {
    Ok(state
        .db_call(move |c| {
            let mut alt = super::alternates(c, &a.item_ref)?;
            // guide: the M3U catch-up override applies here as on every channel read.
            // One pass, so each source's override is read once.
            let mut chans: Vec<_> = alt.alternates.iter().map(|x| x.channel.clone()).collect();
            crate::catchup::m3u::apply_overrides(c, &mut chans)?;
            for (x, ch) in alt.alternates.iter_mut().zip(chans) {
                x.channel = ch;
            }
            Ok(alt)
        })
        .await?)
}

pub fn register(r: &mut RpcRouter) {
    r.add("live.alternates", alternates);
}
