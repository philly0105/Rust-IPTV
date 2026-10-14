//! `parental.*` RPC commands (contract C2). The logic lives in
//! [`super`]; this file parses arguments and maps results.
//!
//! The PIN must never reach a log line or an error message. The router logs
//! every error message, and serde's messages quote the offending value
//! (`invalid type: integer `1234``), so:
//!
//! - every PIN field is a [`Pin`], whose deserializer fails with a fixed
//!   message whatever it is given and whose `Debug` prints nothing;
//! - every argument type with a PIN field is wrapped in [`Obj`], which
//!   refuses a payload that is not a JSON object before serde could quote it
//!   (a bare `"1234"` would otherwise be echoed as `expected struct ...`).

use super::{ParentalLock, ParentalLockTarget, ParentalMode, ParentalStatus};
use crate::error::RpcError;
use crate::model::{ContentType, ItemRef};
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::sync::Arc;

/// Every command this module registers.
pub const COMMANDS: &[&str] = &[
    "parental.status",
    "parental.setPin",
    "parental.disable",
    "parental.configure",
    "parental.unlock",
    "parental.lockNow",
    "parental.locks",
    "parental.setLocked",
    "parental.check",
    "parental.adultCategories",
];

/// A PIN from the caller. Never printed: `Debug` is redacted and a value of
/// the wrong type fails with a message that does not quote it.
pub struct Pin(String);

impl Pin {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Pin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pin(<redacted>)")
    }
}

impl<'de> Deserialize<'de> for Pin {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match Value::deserialize(d) {
            Ok(Value::String(s)) => Ok(Pin(s)),
            _ => Err(D::Error::custom("a PIN must be a string of digits")),
        }
    }
}

/// Arguments that must arrive as a JSON object (see the module docs).
pub struct Obj<T>(pub T);

impl<'de, T: DeserializeOwned> Deserialize<'de> for Obj<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v =
            Value::deserialize(d).map_err(|_| D::Error::custom("arguments must be an object"))?;
        if !v.is_object() {
            return Err(D::Error::custom("arguments must be an object"));
        }
        T::deserialize(v).map(Obj).map_err(D::Error::custom)
    }
}

/// `parental.setPin`: first PIN without `currentPin`; changing it needs `currentPin`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPinArgs {
    #[serde(default)]
    pub current_pin: Option<Pin>,
    pub new_pin: Pin,
}

/// `parental.disable` and `parental.unlock`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinArgs {
    pub pin: Pin,
}

/// `parental.configure`: absent fields keep their value.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfigureArgs {
    pub pin: Option<Pin>,
    pub mode: Option<ParentalMode>,
    pub auto_adult: Option<bool>,
    pub unlock_minutes: Option<u32>,
}

/// `parental.locks`: every source when `sourceId` is absent.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LocksArgs {
    pub source_id: Option<String>,
}

/// `parental.setLocked`: removing a lock needs `pin` or an active unlock.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLockedArgs {
    pub target: ParentalLockTarget,
    pub locked: bool,
    #[serde(default)]
    pub pin: Option<Pin>,
}

/// One `parental.check` entry; `categoryId` is looked up when absent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckItem {
    #[serde(rename = "ref")]
    pub item_ref: ItemRef,
    #[serde(default)]
    pub category_id: Option<String>,
}

/// `parental.check` (at most [`super::MAX_CHECK_ITEMS`] items).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckArgs {
    pub items: Vec<CheckItem>,
}

/// `parental.adultCategories`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdultCategoriesArgs {
    pub source_id: String,
    pub content_type: ContentType,
}

type S = Arc<AppState>;

/// Registers this module's commands.
pub fn register(r: &mut RpcRouter) {
    r.add("parental.status", |s: S, _: ()| async move {
        Ok::<ParentalStatus, RpcError>(super::status(&s).await?)
    });
    r.add(
        "parental.setPin",
        |s: S, Obj(a): Obj<SetPinArgs>| async move {
            super::set_pin(
                &s,
                a.current_pin.as_ref().map(Pin::as_str),
                a.new_pin.as_str(),
            )
            .await
        },
    );
    r.add(
        "parental.disable",
        |s: S, Obj(a): Obj<PinArgs>| async move { super::disable(&s, a.pin.as_str()).await },
    );
    r.add(
        "parental.configure",
        |s: S, Obj(a): Obj<ConfigureArgs>| async move {
            super::configure(
                &s,
                a.pin.as_ref().map(Pin::as_str),
                a.mode,
                a.auto_adult,
                a.unlock_minutes,
            )
            .await
        },
    );
    r.add("parental.unlock", |s: S, Obj(a): Obj<PinArgs>| async move {
        super::unlock(&s, a.pin.as_str()).await
    });
    r.add("parental.lockNow", |s: S, _: ()| async move {
        Ok::<ParentalStatus, RpcError>(super::lock_now(&s).await?)
    });
    r.add("parental.locks", |s: S, a: LocksArgs| async move {
        Ok::<Vec<ParentalLock>, RpcError>(super::locks(&s, a.source_id).await?)
    });
    r.add(
        "parental.setLocked",
        |s: S, Obj(a): Obj<SetLockedArgs>| async move {
            super::set_locked(&s, &a.target, a.locked, a.pin.as_ref().map(Pin::as_str)).await
        },
    );
    r.add("parental.check", |s: S, a: CheckArgs| async move {
        let items = a
            .items
            .into_iter()
            .map(|i| (i.item_ref, i.category_id))
            .collect::<Vec<_>>();
        super::check(&s, items).await
    });
    r.add(
        "parental.adultCategories",
        |s: S, a: AdultCategoriesArgs| async move {
            Ok::<Vec<String>, RpcError>(
                super::adult_categories(&s, a.source_id, a.content_type).await?,
            )
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::RpcErrorCode;
    use crate::events::NoopSink;
    use serde_json::json;

    async fn router_and_state() -> (tempfile::TempDir, RpcRouter, Arc<AppState>) {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path().to_path_buf(), Arc::new(NoopSink), false)
            .await
            .unwrap();
        let mut r = RpcRouter::new();
        register(&mut r);
        (tmp, r, state)
    }

    #[tokio::test]
    async fn registers_every_command_and_rejects_malformed_args() {
        let (_tmp, r, state) = router_and_state().await;
        let mut expected = COMMANDS.to_vec();
        expected.sort_unstable();
        assert_eq!(
            r.names(),
            expected,
            "COMMANDS lists exactly what register adds"
        );

        for (cmd, bad) in [
            ("parental.setPin", json!({"currentPin": "1234"})),
            ("parental.configure", json!({"mode": "block"})),
            ("parental.configure", json!({"unlockMinutes": -1})),
            (
                "parental.setLocked",
                json!({"target": {"kind": "item"}, "locked": true}),
            ),
            ("parental.check", json!({"items": [{"categoryId": "c"}]})),
            (
                "parental.adultCategories",
                json!({"sourceId": "s1", "contentType": "tv"}),
            ),
        ] {
            let e = r.dispatch(state.clone(), cmd, bad).await.unwrap_err();
            assert_eq!(e.code, RpcErrorCode::Invalid, "{cmd}: {e:?}");
        }
    }

    #[tokio::test]
    async fn malformed_pins_are_never_echoed() {
        let (_tmp, r, state) = router_and_state().await;
        for (cmd, bad) in [
            ("parental.unlock", json!({"pin": 97531})),
            ("parental.unlock", json!("97531")),
            ("parental.unlock", json!(["97531"])),
            ("parental.unlock", json!(97531)),
            ("parental.disable", json!({"pin": [97531]})),
            ("parental.setPin", json!({"newPin": 97531})),
            (
                "parental.setPin",
                json!({"newPin": "1234", "currentPin": {"x": "97531"}}),
            ),
            ("parental.setPin", json!("97531")),
            ("parental.configure", json!({"pin": 97531})),
            ("parental.configure", json!("97531")),
            ("parental.setLocked", json!({"pin": 97531, "locked": false})),
        ] {
            let e = r
                .dispatch(state.clone(), cmd, bad.clone())
                .await
                .unwrap_err();
            assert_eq!(e.code, RpcErrorCode::Invalid, "{cmd} {bad}: {e:?}");
            let text = format!("{} {:?}", e.message, e.details);
            assert!(
                !text.contains("97531"),
                "{cmd} {bad} echoed the PIN: {text}"
            );
        }
        // A well-formed but invalid new PIN is refused without quoting it.
        let e = r
            .dispatch(
                state.clone(),
                "parental.setPin",
                json!({"newPin": "97531x"}),
            )
            .await
            .unwrap_err();
        assert_eq!(e.code, RpcErrorCode::Invalid);
        assert!(!e.message.contains("97531"), "{}", e.message);
        assert_eq!(format!("{:?}", Pin("97531".into())), "Pin(<redacted>)");
    }
}
