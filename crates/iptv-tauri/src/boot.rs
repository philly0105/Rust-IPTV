//! The boot gate: `AppState` once boot has built it.
//!
//! `setup` does not wait for the database. Tauri has already created the
//! main window by then, so WebView2 starts and the page and its scripts load
//! while `AppState::new` opens the database on the async runtime. IPC calls
//! and deep links that arrive first wait at the gate.

use tokio::sync::watch;

/// Set once by boot; every reader waits until it is.
pub struct BootGate<T: Clone>(watch::Sender<Option<T>>);

impl<T: Clone> Default for BootGate<T> {
    fn default() -> Self {
        Self(watch::channel(None).0)
    }
}

impl<T: Clone> BootGate<T> {
    /// Opens the gate: current and later waiters get `value`.
    pub fn open(&self, value: T) {
        self.0.send_replace(Some(value));
    }

    /// A handle that can wait for the value without borrowing the gate.
    pub fn waiter(&self) -> BootWaiter<T> {
        BootWaiter(self.0.subscribe())
    }

    /// The value once the gate is open.
    pub async fn get(&self) -> Option<T> {
        self.waiter().get().await
    }
}

/// Waits for the gate to open (`None` if the gate is gone first).
#[derive(Clone)]
pub struct BootWaiter<T>(watch::Receiver<Option<T>>);

impl<T: Clone> BootWaiter<T> {
    pub async fn get(mut self) -> Option<T> {
        self.0
            .wait_for(Option::is_some)
            .await
            .ok()
            .and_then(|v| (*v).clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn calls_before_boot_wait_for_it_and_later_calls_do_not() {
        let gate = Arc::new(BootGate::<u32>::default());
        let early = tokio::spawn({
            let gate = Arc::clone(&gate);
            async move { gate.get().await }
        });
        let link = tokio::spawn(gate.waiter().get());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!early.is_finished(), "an IPC call made while booting waits");
        assert!(
            !link.is_finished(),
            "a deep link that arrives while booting waits"
        );

        gate.open(7);
        assert_eq!(early.await.unwrap(), Some(7));
        assert_eq!(link.await.unwrap(), Some(7));
        let late = tokio::time::timeout(Duration::from_millis(50), gate.get()).await;
        assert_eq!(late.unwrap(), Some(7), "after boot, calls do not wait");
    }

    #[tokio::test]
    async fn a_waiter_whose_gate_is_dropped_gives_up() {
        let gate = BootGate::<u32>::default();
        let waiter = gate.waiter();
        drop(gate);
        assert_eq!(waiter.get().await, None);
    }
}
