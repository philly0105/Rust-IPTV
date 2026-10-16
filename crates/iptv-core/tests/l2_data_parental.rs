//! Loop 2 parental fixes: `parental.setLockedMany` writes every lock change
//! of the Lock groups dialog in one transaction with one `parental.changed`
//! (L2-settings-2), and `parental.setPin {unlock: true}` leaves the first
//! PIN's session unlocked so setup can go on (L1-settings-5).

#[path = "m3u_support.rs"]
mod support;

use iptv_core::error::RpcErrorCode;
use iptv_core::model::ParentalStatus;
use iptv_core::parental;
use iptv_core::rpc::{build_router, RpcRouter};
use iptv_core::{AppEvent, AppState};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::broadcast::Receiver;

const PIN: &str = "2468";

struct App {
    _dir: tempfile::TempDir,
    state: Arc<AppState>,
    router: RpcRouter,
    events: Receiver<AppEvent>,
}

async fn app() -> App {
    let support::Env { dir, state, events } = support::env().await;
    support::bare_source(&state, "s1").await;
    App {
        _dir: dir,
        state,
        router: build_router(),
        events,
    }
}

impl App {
    async fn call(&self, cmd: &str, args: Value) -> Value {
        self.router
            .dispatch(self.state.clone(), cmd, args)
            .await
            .unwrap_or_else(|e| panic!("{cmd} failed: {} {:?}", e.message, e.code))
    }

    async fn fail(&self, cmd: &str, args: Value) -> RpcErrorCode {
        match self
            .router
            .dispatch(self.state.clone(), cmd, args.clone())
            .await
        {
            Ok(v) => panic!("{cmd} {args} should fail, got {v}"),
            Err(e) => e.code,
        }
    }

    async fn status(&self) -> ParentalStatus {
        serde_json::from_value(self.call("parental.status", Value::Null).await).unwrap()
    }

    async fn lock_count(&self) -> usize {
        self.call("parental.locks", json!({"sourceId": "s1"}))
            .await
            .as_array()
            .unwrap()
            .len()
    }

    fn changes(&mut self) -> usize {
        let mut n = 0;
        while let Ok(e) = self.events.try_recv() {
            if e.kind == parental::CHANGED_EVENT {
                n += 1;
            }
        }
        n
    }
}

fn group(id: usize) -> Value {
    json!({"sourceId": "s1", "contentType": "live", "kind": "category",
           "targetId": format!("g{id}"), "name": format!("Group {id}")})
}

fn groups(range: std::ops::Range<usize>) -> Vec<Value> {
    range.map(group).collect()
}

#[tokio::test]
async fn set_locked_many_writes_84_groups_with_one_event() {
    let mut a = app().await;
    a.changes();
    let v = a
        .call("parental.setLockedMany", json!({"add": groups(0..84)}))
        .await;
    assert_eq!(v, json!({"changed": 84}));
    assert_eq!(a.lock_count().await, 84);
    assert_eq!(a.changes(), 1, "one parental.changed for the whole save");

    // The same save again changes nothing and emits nothing.
    let v = a
        .call("parental.setLockedMany", json!({"add": groups(0..84)}))
        .await;
    assert_eq!(v, json!({"changed": 0}));
    assert_eq!(a.changes(), 0);

    // Removals and additions together, no PIN set: one event.
    let v = a
        .call(
            "parental.setLockedMany",
            json!({"add": groups(84..90), "remove": groups(0..10)}),
        )
        .await;
    assert_eq!(v, json!({"changed": 16}));
    assert_eq!(a.lock_count().await, 80);
    assert_eq!(a.changes(), 1);

    // Nothing to do is not an error.
    assert_eq!(
        a.call("parental.setLockedMany", json!({})).await,
        json!({"changed": 0})
    );
}

#[tokio::test]
async fn set_locked_many_removals_need_the_pin_and_a_refusal_changes_nothing() {
    let mut a = app().await;
    a.call("parental.setLockedMany", json!({"add": groups(0..5)}))
        .await;
    a.call("parental.setPin", json!({"newPin": PIN})).await;
    assert!(!a.status().await.unlocked);
    a.changes();

    // Adding needs no PIN.
    a.call("parental.setLockedMany", json!({"add": groups(5..8)}))
        .await;
    assert_eq!(a.lock_count().await, 8);

    // A removal without the PIN (or with a wrong one) is refused before
    // anything is written, additions in the same call included.
    let mixed = json!({"add": groups(20..22), "remove": groups(0..3)});
    assert_eq!(
        a.fail("parental.setLockedMany", mixed.clone()).await,
        RpcErrorCode::Auth
    );
    let mut wrong = mixed.clone();
    wrong["pin"] = json!("0000");
    assert_eq!(
        a.fail("parental.setLockedMany", wrong).await,
        RpcErrorCode::Auth
    );
    assert_eq!(a.lock_count().await, 8);

    let mut right = mixed;
    right["pin"] = json!(PIN);
    assert_eq!(
        a.call("parental.setLockedMany", right).await,
        json!({"changed": 5})
    );
    assert_eq!(a.lock_count().await, 7);
}

#[tokio::test]
async fn set_locked_many_validates_every_target_and_rolls_back() {
    let a = app().await;
    let mut bad = groups(0..3);
    bad.push(json!({"sourceId": "s1", "contentType": "live", "kind": "category", "targetId": "", "name": "x"}));
    assert_eq!(
        a.fail("parental.setLockedMany", json!({"add": bad})).await,
        RpcErrorCode::Invalid
    );
    // An unknown source fails the whole call: the valid targets before it
    // are not kept.
    let mut unknown = groups(0..3);
    unknown.push(json!({"sourceId": "nope", "contentType": "live", "kind": "category", "targetId": "g", "name": "x"}));
    assert_eq!(
        a.fail("parental.setLockedMany", json!({"add": unknown}))
            .await,
        RpcErrorCode::NotFound
    );
    assert_eq!(a.lock_count().await, 0);

    let too_many: Vec<Value> = (0..parental::MAX_LOCK_TARGETS + 1).map(group).collect();
    assert_eq!(
        a.fail("parental.setLockedMany", json!({"add": too_many}))
            .await,
        RpcErrorCode::Invalid
    );
    assert_eq!(
        a.fail("parental.setLockedMany", json!("1234")).await,
        RpcErrorCode::Invalid
    );
}

#[tokio::test]
async fn first_pin_with_unlock_leaves_the_session_unlocked() {
    let mut a = app().await;
    a.changes();
    let s: ParentalStatus = serde_json::from_value(
        a.call("parental.setPin", json!({"newPin": PIN, "unlock": true}))
            .await,
    )
    .unwrap();
    assert!(s.enabled && s.unlocked, "{s:?}");
    assert!(s.unlocked_until.is_some(), "the default 15-minute unlock");
    assert_eq!(a.changes(), 1);

    // Setup goes on without the PIN: options, and removing a lock.
    a.call("parental.configure", json!({"mode": "ask"})).await;
    a.call("parental.setLockedMany", json!({"add": groups(0..2)}))
        .await;
    a.call("parental.setLockedMany", json!({"remove": groups(0..1)}))
        .await;
    assert_eq!(a.lock_count().await, 1);

    // The unlock runs out as any other.
    parental::advance_clock(&a.state, std::time::Duration::from_secs(16 * 60));
    assert!(!a.status().await.unlocked);
}

#[tokio::test]
async fn pin_change_with_unlock_keeps_the_session_as_it_was() {
    let a = app().await;
    a.call("parental.setPin", json!({"newPin": PIN})).await;
    assert!(
        !a.status().await.unlocked,
        "without unlock the first PIN locks"
    );
    let s: ParentalStatus = serde_json::from_value(
        a.call(
            "parental.setPin",
            json!({"currentPin": PIN, "newPin": "1357", "unlock": true}),
        )
        .await,
    )
    .unwrap();
    assert!(s.enabled && !s.unlocked, "{s:?}");

    // unlockMinutes 0: the first PIN's unlock lasts until restart.
    let b = app().await;
    b.call("parental.configure", json!({"unlockMinutes": 0}))
        .await;
    let s: ParentalStatus = serde_json::from_value(
        b.call("parental.setPin", json!({"newPin": PIN, "unlock": true}))
            .await,
    )
    .unwrap();
    assert!(s.unlocked && s.unlocked_until.is_none(), "{s:?}");
}
