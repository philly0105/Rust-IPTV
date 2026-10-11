//! `remote.*` RPC commands (SPEC C4 remote section).

use super::{RemoteChannel, ServerStatus};
use crate::error::RpcError;
use crate::model::RemoteStatus;
use crate::rpc::RpcRouter;
use serde::{Deserialize, Serialize};

/// Every command this module registers.
pub const COMMANDS: [&str; 5] = [
    "remote.start",
    "remote.stop",
    "remote.status",
    "remote.reportStatus",
    "remote.publishChannels",
];

#[derive(Debug, Serialize)]
struct StartResult {
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportStatusArgs {
    status: RemoteStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishChannelsArgs {
    channels: Vec<RemoteChannel>,
}

/// Registers this module's commands.
pub fn register(r: &mut RpcRouter) {
    r.add("remote.start", |state, _: ()| async move {
        let info = super::start(state).await.map_err(RpcError::from)?;
        Ok(StartResult { url: info.url })
    });
    r.add("remote.stop", |state, _: ()| async move {
        super::stop(state).await.map_err(RpcError::from)
    });
    r.add("remote.status", |state, _: ()| async move {
        Ok::<ServerStatus, RpcError>(super::server_status(&state))
    });
    r.add(
        "remote.reportStatus",
        |state, args: ReportStatusArgs| async move {
            super::hub(&state).set_status(args.status);
            Ok(())
        },
    );
    r.add(
        "remote.publishChannels",
        |state, args: PublishChannelsArgs| async move {
            super::hub(&state).set_channels(args.channels);
            Ok(())
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_exactly_the_c4_names() {
        let mut r = RpcRouter::new();
        register(&mut r);
        assert_eq!(r.names().len(), COMMANDS.len());
        for name in COMMANDS {
            assert!(r.contains(name), "{name} not registered");
        }
    }
}
