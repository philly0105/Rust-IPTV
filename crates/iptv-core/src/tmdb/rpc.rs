//! `tmdb.*` RPC commands (SPEC C4 tmdb).
//!
//! Every command except `tmdb.testKey` and `tmdb.clearCache` returns `null`
//! / `[]` without touching the network while `settings.tmdb.enabled` is
//! false or no key resolves. Upstream failures surface as `RpcError`s.

use super::service::{TestKeyResult, Tmdb};
use crate::error::RpcError;
use crate::model::{TmdbBrief, TmdbMediaType, TmdbMovie, TmdbPerson, TmdbSeason, TmdbTv};
use crate::rpc::RpcRouter;
use serde::Deserialize;

/// Every command this module registers.
pub const COMMANDS: [&str; 8] = [
    "tmdb.movie",
    "tmdb.tv",
    "tmdb.season",
    "tmdb.person",
    "tmdb.trending",
    "tmdb.similar",
    "tmdb.testKey",
    "tmdb.clearCache",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleArgs {
    #[serde(default)]
    title: String,
    #[serde(default)]
    year: Option<i64>,
    #[serde(default)]
    tmdb_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeasonArgs {
    tmdb_id: i64,
    season: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersonArgs {
    person_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimilarArgs {
    media_type: TmdbMediaType,
    tmdb_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestKeyArgs {
    #[serde(default)]
    api_key: String,
}

/// Registers this module's commands.
pub fn register(r: &mut RpcRouter) {
    r.add("tmdb.movie", |state, a: TitleArgs| async move {
        let tmdb = Tmdb::get(&state);
        Ok::<Option<TmdbMovie>, RpcError>(tmdb.movie(&state, &a.title, a.year, a.tmdb_id).await?)
    });
    r.add("tmdb.tv", |state, a: TitleArgs| async move {
        let tmdb = Tmdb::get(&state);
        Ok::<Option<TmdbTv>, RpcError>(tmdb.tv(&state, &a.title, a.year, a.tmdb_id).await?)
    });
    r.add("tmdb.season", |state, a: SeasonArgs| async move {
        let tmdb = Tmdb::get(&state);
        Ok::<Option<TmdbSeason>, RpcError>(tmdb.season(&state, a.tmdb_id, a.season).await?)
    });
    r.add("tmdb.person", |state, a: PersonArgs| async move {
        let tmdb = Tmdb::get(&state);
        Ok::<Option<TmdbPerson>, RpcError>(tmdb.person(&state, a.person_id).await?)
    });
    r.add("tmdb.trending", |state, _: ()| async move {
        let tmdb = Tmdb::get(&state);
        Ok::<Vec<TmdbBrief>, RpcError>(tmdb.trending(&state).await?)
    });
    r.add("tmdb.similar", |state, a: SimilarArgs| async move {
        let tmdb = Tmdb::get(&state);
        Ok::<Vec<TmdbBrief>, RpcError>(tmdb.similar(&state, a.media_type, a.tmdb_id).await?)
    });
    r.add("tmdb.testKey", |state, a: TestKeyArgs| async move {
        let tmdb = Tmdb::get(&state);
        Ok::<TestKeyResult, RpcError>(tmdb.test_key(&state, &a.api_key).await)
    });
    r.add("tmdb.clearCache", |state, _: ()| async move {
        let tmdb = Tmdb::get(&state);
        tmdb.clear_cache(&state).await?;
        Ok::<(), RpcError>(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_every_command() {
        let mut r = RpcRouter::new();
        register(&mut r);
        let mut expected = COMMANDS.to_vec();
        expected.sort_unstable();
        assert_eq!(r.names(), expected);
    }
}
