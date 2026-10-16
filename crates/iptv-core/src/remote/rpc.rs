//! `remote.*` RPC commands (SPEC C4 remote section).

use super::pairing::DeviceInfo;
use super::{PairingInfo, RemoteChannel, ServerStatus};
use crate::error::RpcError;
use crate::model::RemoteStatus;
use crate::rpc::RpcRouter;
use serde::{Deserialize, Serialize};

/// Every command this module registers.
pub const COMMANDS: [&str; 9] = [
    "remote.start",
    "remote.stop",
    "remote.status",
    "remote.reportStatus",
    "remote.publishChannels",
    // remote: LAN pairing (desktop only; `unsupported` in server mode)
    "remote.pairingCode",
    "remote.devices",
    "remote.revokeDevice",
    "remote.resetPairing",
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

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PairingCodeArgs {
    address: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevokeArgs {
    id: String,
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
    r.add(
        "remote.pairingCode",
        |state, args: PairingCodeArgs| async move {
            super::pairing_code(&state, args.address.as_deref())
                .map_err(RpcError::from)
                .map(|p: PairingInfo| p)
        },
    );
    r.add("remote.devices", |state, _: ()| async move {
        super::devices(&state)
            .await
            .map_err(RpcError::from)
            .map(|d: Vec<DeviceInfo>| d)
    });
    r.add(
        "remote.revokeDevice",
        |state, args: RevokeArgs| async move {
            super::revoke_device(&state, &args.id)
                .await
                .map_err(RpcError::from)
        },
    );
    r.add("remote.resetPairing", |state, _: ()| async move {
        super::reset_pairing(&state).await.map_err(RpcError::from)
    });
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
