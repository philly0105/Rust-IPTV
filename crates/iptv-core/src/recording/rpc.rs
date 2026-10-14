//! `reminders.*` and `recordings.*` RPC commands.

use super::{library, rules, ReminderRequest, ScheduleRequest};
use crate::error::RpcError;
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::Deserialize;
use std::sync::Arc;

/// Every command this module registers.
pub const COMMANDS: &[&str] = &[
    "reminders.list",
    "reminders.add",
    "reminders.remove",
    "reminders.unhandled",
    "reminders.ack",
    "recordings.capabilities",
    "recordings.list",
    "recordings.schedule",
    "recordings.cancel",
    "recordings.remove",
    "recordings.library",
    "recordings.playSource",
    "recordings.reveal",
    "recordings.delete",
    // Run 2 C5: series recording rules.
    "recordings.rules",
    "recordings.addRule",
    "recordings.setRuleEnabled",
    "recordings.removeRule",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdArgs {
    pub id: String,
}

type S = Arc<AppState>;

/// Registers this module's commands.
pub fn register(r: &mut RpcRouter) {
    r.add("reminders.list", |s: S, _: ()| async move {
        Ok::<_, RpcError>(super::list_reminders(&s).await?)
    });
    r.add("reminders.add", |s: S, a: ReminderRequest| async move {
        Ok::<_, RpcError>(super::add_reminder(&s, a).await?)
    });
    r.add("reminders.remove", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(super::remove_reminder(&s, &a.id).await?)
    });
    r.add("reminders.unhandled", |s: S, _: ()| async move {
        Ok::<_, RpcError>(super::unhandled_reminders(&s))
    });
    r.add("reminders.ack", |s: S, a: IdArgs| async move {
        super::ack_reminder(&s, &a.id);
        Ok::<_, RpcError>(())
    });
    r.add("recordings.capabilities", |s: S, _: ()| async move {
        Ok::<_, RpcError>(super::capabilities(&s))
    });
    r.add("recordings.list", |s: S, _: ()| async move {
        Ok::<_, RpcError>(super::list_recordings(&s).await?)
    });
    r.add(
        "recordings.schedule",
        |s: S, a: ScheduleRequest| async move { Ok::<_, RpcError>(super::schedule(&s, a).await?) },
    );
    r.add("recordings.cancel", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(super::cancel(&s, &a.id).await?)
    });
    r.add("recordings.remove", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(super::remove(&s, &a.id).await?)
    });
    r.add("recordings.library", |s: S, _: ()| async move {
        Ok::<_, RpcError>(library::list(&s).await?)
    });
    r.add("recordings.playSource", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(library::play_source(&s, &a.id).await?)
    });
    r.add("recordings.reveal", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(library::reveal(&s, &a.id).await?)
    });
    r.add("recordings.delete", |s: S, a: IdArgs| async move {
        Ok::<_, RpcError>(library::delete(&s, &a.id).await?)
    });
    // Series recording rules (Run 2 C5).
    r.add("recordings.rules", |s: S, _: ()| async move {
        Ok::<_, RpcError>(rules::list(&s).await?)
    });
    r.add(
        "recordings.addRule",
        |s: S, a: rules::AddRuleRequest| async move { Ok::<_, RpcError>(rules::add(&s, a).await?) },
    );
    r.add(
        "recordings.setRuleEnabled",
        |s: S, a: rules::SetRuleEnabledRequest| async move {
            Ok::<_, RpcError>(rules::set_enabled(&s, &a.id, a.enabled).await?)
        },
    );
    r.add(
        "recordings.removeRule",
        |s: S, a: rules::RemoveRuleRequest| async move {
            Ok::<_, RpcError>(rules::remove(&s, &a.id, a.keep_scheduled.unwrap_or(false)).await?)
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_exactly_its_commands() {
        let mut r = RpcRouter::new();
        register(&mut r);
        let mut want: Vec<&str> = COMMANDS.to_vec();
        want.sort_unstable();
        assert_eq!(r.names(), want);
    }
}
