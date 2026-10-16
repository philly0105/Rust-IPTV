//! TMDB enrichment orchestration: id resolution, details, seasons, people,
//! trending, and key checks, all behind the cache.
//!
//! Resolution order for `tmdb.movie` / `tmdb.tv` (from the old app's
//! `tmdb-enrichment.service.ts`):
//! 1. A provider `tmdbId` is trusted unless its details contradict the
//!    provider's year (stale id); then a title search may beat it, and the
//!    id's details are kept if the search cannot. A 404 id is negatively
//!    cached and falls through to the search.
//! 2. Otherwise the confidence-gated title search (see `matcher`), cached
//!    per normalized title + year + language, negative results included.
//! 3. Details in the app language, refetched once in the content's original
//!    language when the overview or trailer is missing.

use super::cache::{Fetched, TmdbCache, Ttl};
use super::client::TmdbClient;
use super::config::{
    effective_language, resolve_api_key, search_language_for_title, ApiKey, BASE_URL_ENV,
    DEFAULT_BASE_URL, DETAILS_TTL, NEGATIVE_TTL, TRENDING_TTL,
};
use super::map;
use super::matcher::{
    assess_provider_id, build_search_title_variants, details_lookup_key, match_results,
    parse_provider_tmdb_id, person_lookup_key, search_lookup_key, season_lookup_key,
    trending_lookup_key, ProviderIdVerdict,
};
use super::normalize::{normalize_title_keys, release_tag_year};
use super::raw;
use crate::db::DbPool;
use crate::error::{CoreError, CoreResult};
use crate::model::{TmdbBrief, TmdbMediaType, TmdbMovie, TmdbPerson, TmdbSeason, TmdbTv};
use crate::state::AppState;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

/// `AppState.extensions` key holding the `Tmdb` singleton.
pub const EXT_KEY: &str = "tmdb";

/// Hidden fields stored alongside cached details (dropped on the way out).
const HIDDEN_ORIGINAL_LANGUAGE: &str = "_originalLanguage";
const HIDDEN_ORIGINAL_TITLE: &str = "_originalTitle";

const DETAILS: Ttl = Ttl {
    positive: DETAILS_TTL,
    negative: NEGATIVE_TTL,
};
const TRENDING: Ttl = Ttl {
    positive: TRENDING_TTL,
    negative: NEGATIVE_TTL,
};

/// Result of `tmdb.testKey`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestKeyResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Per-call context: only exists when TMDB is enabled and a key resolved.
#[derive(Debug, Clone)]
struct Ctx {
    key: ApiKey,
    language: String,
}

/// The TMDB service singleton (stored in `AppState.extensions["tmdb"]`).
pub struct Tmdb {
    client: Arc<TmdbClient>,
    cache: Arc<TmdbCache>,
    search_cwd_env: bool,
}

impl Tmdb {
    /// Client against `base_url`. Reads `.env` from the data dir only; call
    /// [`Self::with_cwd_env`] to also read `./.env`.
    pub fn new(http: reqwest::Client, base_url: impl Into<String>) -> Self {
        Self {
            client: Arc::new(TmdbClient::new(http, base_url)),
            cache: Arc::new(TmdbCache::default()),
            search_cwd_env: false,
        }
    }

    /// Production instance: base URL from `TMDB_BASE_URL` or the public API,
    /// key also looked up in `./.env`.
    pub fn from_env(http: reqwest::Client) -> Self {
        let base = std::env::var(BASE_URL_ENV)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
        Self::new(http, base).with_cwd_env(true)
    }

    pub fn with_cwd_env(mut self, on: bool) -> Self {
        self.search_cwd_env = on;
        self
    }

    pub fn base_url(&self) -> &str {
        self.client.base_url()
    }

    pub fn cache(&self) -> &Arc<TmdbCache> {
        &self.cache
    }

    /// The state's singleton, created from the environment on first use.
    pub fn get(state: &AppState) -> Arc<Tmdb> {
        state.ext_or_insert_with(EXT_KEY, || Arc::new(Tmdb::from_env(state.http.clone())))
    }

    /// Replaces the state's singleton (tests point it at a stub).
    pub fn install(state: &AppState, tmdb: Tmdb) -> Arc<Tmdb> {
        let tmdb = Arc::new(tmdb);
        state.set_ext(EXT_KEY, Arc::clone(&tmdb));
        tmdb
    }

    fn ctx(&self, state: &AppState) -> Option<Ctx> {
        let settings = state.settings_snapshot();
        if !settings.tmdb.enabled {
            return None;
        }
        let Some((key, source)) = resolve_api_key(&settings, &state.data_dir, self.search_cwd_env)
        else {
            tracing::debug!("tmdb enabled but no API key configured");
            return None;
        };
        tracing::trace!(?source, "tmdb key resolved");
        Some(Ctx {
            key,
            language: effective_language(&settings),
        })
    }

    /// True when TMDB calls would hit the network (enabled + key present).
    pub fn is_active(&self, state: &AppState) -> bool {
        self.ctx(state).is_some()
    }

    // ---- public operations ------------------------------------------------

    pub async fn movie(
        self: &Arc<Self>,
        state: &AppState,
        title: &str,
        year: Option<i64>,
        tmdb_id: Option<i64>,
    ) -> CoreResult<Option<TmdbMovie>> {
        let v = self
            .enrich(state, TmdbMediaType::Movie, title, year, tmdb_id)
            .await?;
        v.map(|v| typed(&v)).transpose()
    }

    pub async fn tv(
        self: &Arc<Self>,
        state: &AppState,
        title: &str,
        year: Option<i64>,
        tmdb_id: Option<i64>,
    ) -> CoreResult<Option<TmdbTv>> {
        let v = self
            .enrich(state, TmdbMediaType::Tv, title, year, tmdb_id)
            .await?;
        v.map(|v| typed(&v)).transpose()
    }

    pub async fn season(
        self: &Arc<Self>,
        state: &AppState,
        tmdb_id: i64,
        season: i64,
    ) -> CoreResult<Option<TmdbSeason>> {
        if tmdb_id <= 0 || season < 0 {
            return Err(CoreError::invalid(
                "tmdbId must be positive and season zero or more",
            ));
        }
        let Some(ctx) = self.ctx(state) else {
            return Ok(None);
        };
        let this = Arc::clone(self);
        let db = state.db.clone();
        let key = season_lookup_key(tmdb_id, season, &ctx.language);
        let entry = self
            .cache
            .get_or_fetch(&state.db, "tv", key, DETAILS, move || async move {
                this.fetch_season(db, ctx, tmdb_id, season).await
            })
            .await?;
        entry.payload.map(|v| typed(&v)).transpose()
    }

    pub async fn person(
        self: &Arc<Self>,
        state: &AppState,
        person_id: i64,
    ) -> CoreResult<Option<TmdbPerson>> {
        if person_id <= 0 {
            return Err(CoreError::invalid("personId must be positive"));
        }
        let Some(ctx) = self.ctx(state) else {
            return Ok(None);
        };
        let client = Arc::clone(&self.client);
        let key = person_lookup_key(person_id, &ctx.language);
        let entry = self
            .cache
            .get_or_fetch(&state.db, "person", key, DETAILS, move || async move {
                fetch_person(&client, &ctx, person_id).await
            })
            .await?;
        entry.payload.map(|v| typed(&v)).transpose()
    }

    pub async fn trending(self: &Arc<Self>, state: &AppState) -> CoreResult<Vec<TmdbBrief>> {
        let Some(ctx) = self.ctx(state) else {
            return Ok(Vec::new());
        };
        let client = Arc::clone(&self.client);
        let key = trending_lookup_key(&ctx.language);
        let entry = self
            .cache
            .get_or_fetch(&state.db, "trending", key, TRENDING, move || async move {
                let page: raw::ResultPage = client
                    .get_json(
                        "/trending/all/week",
                        &[("language", ctx.language.as_str())],
                        &ctx.key,
                    )
                    .await?;
                Ok(Fetched::payload(
                    None,
                    serde_json::to_value(map::trending_from_page(&page))?,
                ))
            })
            .await?;
        Ok(entry
            .payload
            .map(|v| typed(&v))
            .transpose()?
            .unwrap_or_default())
    }

    /// Similar titles, read from the (cached) details payload.
    pub async fn similar(
        self: &Arc<Self>,
        state: &AppState,
        media: TmdbMediaType,
        tmdb_id: i64,
    ) -> CoreResult<Vec<TmdbBrief>> {
        if tmdb_id <= 0 {
            return Err(CoreError::invalid("tmdbId must be positive"));
        }
        let Some(ctx) = self.ctx(state) else {
            return Ok(Vec::new());
        };
        let Some(details) = self.details(&state.db, &ctx, media, tmdb_id).await? else {
            return Ok(Vec::new());
        };
        match details.get("similar") {
            Some(v) => Ok(serde_json::from_value(v.clone())?),
            None => Ok(Vec::new()),
        }
    }

    /// Validates a key with `GET /configuration`. Works while TMDB is
    /// disabled (the settings page checks a key before enabling). A blank
    /// `api_key` tests the key resolved from settings / `.env`, and so does
    /// the masked key server mode shows ([`crate::settings::SECRET_MASK`]).
    pub async fn test_key(&self, state: &AppState, api_key: &str) -> TestKeyResult {
        let typed = if api_key.trim().starts_with(crate::settings::SECRET_MASK) {
            ""
        } else {
            api_key
        };
        let key = match ApiKey::new(typed) {
            Some(k) => k,
            None => match resolve_api_key(&state.settings_snapshot(), &state.data_dir, self.search_cwd_env) {
                Some((k, _)) => k,
                None => {
                    return TestKeyResult {
                        ok: false,
                        message: Some(
                            "No API key found. Paste one here, or put TMDB_API_KEY=<key> in a .env file in the app data folder."
                                .into(),
                        ),
                    }
                }
            },
        };
        match self.client.get_json::<Value>("/configuration", &[], &key).await {
            Ok(_) => TestKeyResult { ok: true, message: None },
            Err(CoreError::Auth(_)) => TestKeyResult {
                ok: false,
                message: Some(
                    "TMDB rejected this key. Copy the API key (v3) or the API read access token (v4) from themoviedb.org > Settings > API."
                        .into(),
                ),
            },
            Err(e @ (CoreError::Network(_) | CoreError::Server(_) | CoreError::Timeout(_))) => {
                TestKeyResult {
                    ok: false,
                    message: Some(error_text(&e)),
                }
            }
            Err(e) => TestKeyResult {
                ok: false,
                message: Some(format!("Could not verify the key: {}", error_text(&e))),
            },
        }
    }

    /// Deletes every cached TMDB row and the memory layer.
    pub async fn clear_cache(&self, state: &AppState) -> CoreResult<u64> {
        let n = self.cache.clear(&state.db).await?;
        tracing::info!(rows = n, "tmdb cache cleared");
        Ok(n)
    }

    // ---- internals -----------------------------------------------------------

    async fn enrich(
        self: &Arc<Self>,
        state: &AppState,
        media: TmdbMediaType,
        title: &str,
        year: Option<i64>,
        tmdb_id: Option<i64>,
    ) -> CoreResult<Option<Arc<Value>>> {
        let Some(ctx) = self.ctx(state) else {
            return Ok(None);
        };
        let db = &state.db;
        let title = title.trim();

        if let Some(pid) = parse_provider_tmdb_id(tmdb_id) {
            // A negative details row (404) means the id is dead: search instead.
            if let Some(details) = self.details(db, &ctx, media, pid).await? {
                if verdict(&details, title, year, media) != ProviderIdVerdict::Contradicted {
                    return Ok(Some(details));
                }
                // Stale-id signature: only a confident title search may answer.
                // When it finds nothing, the contradicted details are wrong
                // data, so show none rather than another film's metadata.
                return Ok(match self.resolve(db, &ctx, media, title, year).await {
                    Ok(Some(sid)) if sid == pid => Some(details),
                    Ok(Some(sid)) => self.details(db, &ctx, media, sid).await.ok().flatten(),
                    Ok(None) | Err(_) => None,
                });
            }
        }
        if title.is_empty() {
            return Ok(None);
        }
        match self.resolve(db, &ctx, media, title, year).await? {
            Some(id) => self.details(db, &ctx, media, id).await,
            None => Ok(None),
        }
    }

    /// Title -> TMDB id through the confidence gate, cached (negatives too).
    async fn resolve(
        &self,
        db: &DbPool,
        ctx: &Ctx,
        media: TmdbMediaType,
        title: &str,
        year: Option<i64>,
    ) -> CoreResult<Option<i64>> {
        let mut variants = build_search_title_variants(title, None);
        if variants.is_empty() {
            return Ok(None);
        }
        let keys = normalize_title_keys(title);
        let explicit_year = year.is_some();
        let year = year.or_else(|| release_tag_year(title));
        if !explicit_year && keys.trailing_year.is_some() && !variants.contains(&keys.exact) {
            variants.push(keys.exact.clone());
        }
        let cache_language = search_language_for_title(&variants[0], &ctx.language);
        let lookup = search_lookup_key(&variants[0], year, &cache_language);
        let client = Arc::clone(&self.client);
        let ctx = ctx.clone();
        let entry = self
            .cache
            .get_or_fetch(db, media.as_str(), lookup, DETAILS, move || async move {
                let path = format!("/search/{}", media.as_str());
                for variant in &variants {
                    // Search by title only: TMDB's year params filter strictly;
                    // the ±1 / season-year tolerance lives in the matcher.
                    let language = search_language_for_title(variant, &ctx.language);
                    let page: raw::ResultPage = client
                        .get_json(
                            &path,
                            &[
                                ("query", variant.as_str()),
                                ("language", language.as_str()),
                                ("include_adult", "false"),
                            ],
                            &ctx.key,
                        )
                        .await?;
                    if let Some(m) =
                        match_results(&page.results, variant, &keys, year, explicit_year, media)
                    {
                        return Ok(Fetched::id(m.id));
                    }
                }
                Ok(Fetched::negative())
            })
            .await?;
        Ok(entry.tmdb_id)
    }

    /// Mapped details payload (with hidden fields) for one id, cached.
    async fn details(
        &self,
        db: &DbPool,
        ctx: &Ctx,
        media: TmdbMediaType,
        tmdb_id: i64,
    ) -> CoreResult<Option<Arc<Value>>> {
        let client = Arc::clone(&self.client);
        let ctx = ctx.clone();
        let key = details_lookup_key(tmdb_id, &ctx.language);
        let entry = self
            .cache
            .get_or_fetch(db, media.as_str(), key, DETAILS, move || async move {
                fetch_details(&client, &ctx, media, tmdb_id).await
            })
            .await?;
        Ok(entry.payload)
    }

    async fn fetch_season(
        self: Arc<Self>,
        db: DbPool,
        ctx: Ctx,
        tmdb_id: i64,
        season: i64,
    ) -> CoreResult<Fetched> {
        let path = format!("/tv/{tmdb_id}/season/{season}");
        let mut primary: raw::Season = match self
            .client
            .get_json(&path, &[("language", ctx.language.as_str())], &ctx.key)
            .await
        {
            Ok(s) => s,
            Err(CoreError::NotFound(_)) => return Ok(Fetched::negative()),
            Err(e) => return Err(e),
        };
        if map::season_needs_text_fallback(&primary) {
            // The show's original language comes from its (cached) details.
            let original = self
                .details(&db, &ctx, TmdbMediaType::Tv, tmdb_id)
                .await
                .ok()
                .flatten()
                .and_then(|d| {
                    d.get(HIDDEN_ORIGINAL_LANGUAGE)
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            if let Some(orig) =
                original.filter(|o| !ctx.language.to_lowercase().starts_with(&o.to_lowercase()))
            {
                match self
                    .client
                    .get_json::<raw::Season>(&path, &[("language", orig.as_str())], &ctx.key)
                    .await
                {
                    Ok(fb) => map::fill_season_from_fallback(&mut primary, fb),
                    Err(err) => tracing::debug!(error = %err, "tmdb season fallback fetch failed"),
                }
            }
        }
        Ok(Fetched::payload(
            Some(tmdb_id),
            serde_json::to_value(map::season_from_raw(&primary, season))?,
        ))
    }
}

async fn fetch_details(
    client: &TmdbClient,
    ctx: &Ctx,
    media: TmdbMediaType,
    tmdb_id: i64,
) -> CoreResult<Fetched> {
    let path = format!("/{}/{tmdb_id}", media.as_str());
    let append = match media {
        TmdbMediaType::Movie => "credits,videos,similar,external_ids",
        // aggregate_credits spans the whole run; plain credits on a TV id is
        // the latest season only, so both are needed for the real cast.
        TmdbMediaType::Tv => "credits,aggregate_credits,videos,similar",
    };
    let mut d: raw::Details = match client
        .get_json(
            &path,
            &[
                ("language", ctx.language.as_str()),
                ("append_to_response", append),
            ],
            &ctx.key,
        )
        .await
    {
        Ok(d) => d,
        Err(CoreError::NotFound(_)) => return Ok(Fetched::negative()),
        Err(e) => return Err(e),
    };
    if d.id <= 0 {
        d.id = tmdb_id;
    }
    if let Some(fallback) = map::details_fallback_language(&d, &ctx.language) {
        // Best-effort: a failing fallback must never cost the primary payload.
        match client
            .get_json::<raw::Details>(
                &path,
                &[
                    ("language", fallback.as_str()),
                    ("append_to_response", "videos"),
                ],
                &ctx.key,
            )
            .await
        {
            Ok(fb) => map::fill_details_from_fallback(&mut d, fb),
            Err(err) => tracing::debug!(error = %err, "tmdb fallback-language fetch failed"),
        }
    }
    let (mut v, original_title) = match media {
        TmdbMediaType::Movie => (
            serde_json::to_value(map::movie_from_raw(&d))?,
            d.original_title.clone(),
        ),
        TmdbMediaType::Tv => (
            serde_json::to_value(map::tv_from_raw(&d))?,
            d.original_name.clone(),
        ),
    };
    if let Value::Object(obj) = &mut v {
        if let Some(l) = d
            .original_language
            .as_deref()
            .filter(|l| !l.trim().is_empty())
        {
            obj.insert(
                HIDDEN_ORIGINAL_LANGUAGE.into(),
                Value::String(l.trim().to_string()),
            );
        }
        if let Some(t) = original_title.filter(|t| !t.trim().is_empty()) {
            obj.insert(HIDDEN_ORIGINAL_TITLE.into(), Value::String(t));
        }
    }
    Ok(Fetched::payload(Some(tmdb_id), v))
}

async fn fetch_person(client: &TmdbClient, ctx: &Ctx, person_id: i64) -> CoreResult<Fetched> {
    let path = format!("/person/{person_id}");
    let mut p: raw::Person = match client
        .get_json(
            &path,
            &[
                ("language", ctx.language.as_str()),
                ("append_to_response", "combined_credits"),
            ],
            &ctx.key,
        )
        .await
    {
        Ok(p) => p,
        Err(CoreError::NotFound(_)) => return Ok(Fetched::negative()),
        Err(e) => return Err(e),
    };
    if p.id <= 0 {
        p.id = person_id;
    }
    // Most biographies exist only in English; fill an empty localized one.
    let bio_missing = p.biography.as_deref().is_none_or(|b| b.trim().is_empty());
    if bio_missing && !ctx.language.to_lowercase().starts_with("en") {
        match client
            .get_json::<raw::Person>(&path, &[("language", "en-US")], &ctx.key)
            .await
        {
            Ok(en) => p.biography = en.biography,
            Err(err) => tracing::debug!(error = %err, "tmdb biography fallback failed"),
        }
    }
    Ok(Fetched::payload(
        Some(person_id),
        serde_json::to_value(map::person_from_raw(&p))?,
    ))
}

fn verdict(
    details: &Value,
    title: &str,
    year: Option<i64>,
    media: TmdbMediaType,
) -> ProviderIdVerdict {
    let titles: Vec<&str> = ["title", HIDDEN_ORIGINAL_TITLE]
        .iter()
        .filter_map(|k| details.get(*k).and_then(Value::as_str))
        .collect();
    let details_year = details.get("year").and_then(Value::as_i64);
    assess_provider_id(&titles, details_year, title, year, media)
}

fn typed<T: DeserializeOwned>(v: &Value) -> CoreResult<T> {
    serde_json::from_value(v.clone()).map_err(|e| {
        CoreError::Other(anyhow::anyhow!(
            "cached TMDB payload has an unexpected shape: {e}"
        ))
    })
}

fn error_text(e: &CoreError) -> String {
    match e {
        CoreError::Network(m)
        | CoreError::Timeout(m)
        | CoreError::Auth(m)
        | CoreError::Invalid(m)
        | CoreError::NotFound(m) => m.clone(),
        other => other.to_string(),
    }
}
