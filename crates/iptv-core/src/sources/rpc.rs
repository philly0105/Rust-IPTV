//! `sources.*` RPC commands (SPEC C4).

use super::{AddSourceArgs, RefreshAllResult, SourceCounts, SourcePatch};
use crate::error::RpcError;
use crate::model::Source;
use crate::rpc::RpcRouter;
use crate::state::AppState;
use serde::Deserialize;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
pub struct IdArgs {
    pub id: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateArgs {
    pub id: String,
    #[serde(default)]
    pub patch: SourcePatch,
}

#[derive(Debug, Deserialize)]
pub struct ReorderArgs {
    #[serde(default)]
    pub ids: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct NoArgs {}

pub async fn list(state: Arc<AppState>, _a: NoArgs) -> Result<Vec<Source>, RpcError> {
    Ok(super::list(&state).await?)
}

pub async fn get(state: Arc<AppState>, a: IdArgs) -> Result<Source, RpcError> {
    Ok(super::get(&state, &a.id).await?)
}

pub async fn add(state: Arc<AppState>, a: AddSourceArgs) -> Result<Source, RpcError> {
    Ok(super::add(state, a).await?)
}

pub async fn update(state: Arc<AppState>, a: UpdateArgs) -> Result<Source, RpcError> {
    Ok(super::update(&state, &a.id, a.patch).await?)
}

pub async fn remove(state: Arc<AppState>, a: IdArgs) -> Result<(), RpcError> {
    Ok(super::remove(&state, &a.id).await?)
}

pub async fn reorder(state: Arc<AppState>, a: ReorderArgs) -> Result<(), RpcError> {
    Ok(super::reorder(&state, a.ids).await?)
}

pub async fn refresh(state: Arc<AppState>, a: IdArgs) -> Result<Source, RpcError> {
    Ok(super::refresh(state, &a.id).await?)
}

pub async fn refresh_all(state: Arc<AppState>, _a: NoArgs) -> Result<RefreshAllResult, RpcError> {
    Ok(super::refresh_all(state).await?)
}

pub async fn remove_all(state: Arc<AppState>, _a: NoArgs) -> Result<(), RpcError> {
    Ok(super::remove_all(&state).await?)
}

pub async fn counts(state: Arc<AppState>, a: IdArgs) -> Result<SourceCounts, RpcError> {
    Ok(super::counts(&state, &a.id).await?)
}

/// Registers every `sources.*` command of C4.
pub fn register(r: &mut RpcRouter) {
    r.add("sources.list", list);
    r.add("sources.get", get);
    r.add("sources.add", add);
    r.add("sources.update", update);
    r.add("sources.remove", remove);
    r.add("sources.removeAll", remove_all);
    r.add("sources.reorder", reorder);
    r.add("sources.refresh", refresh);
    r.add("sources.refreshAll", refresh_all);
    r.add("sources.counts", counts);
}
