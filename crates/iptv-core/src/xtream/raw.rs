//! Lenient wire types for `player_api.php`.
//!
//! Real panels disagree on almost every field type: ids and numbers arrive as
//! numbers or strings, `rating` can be `"N/A"`, `backdrop_path` is a string or
//! an array, `info` is an object or `[]`, lists can be arrays, objects keyed by
//! index, `null` or `false`. Every field here deserializes through a helper
//! that accepts all of those and falls back to `None`/empty instead of failing.
//! One malformed element in a list is skipped (and counted), never fatal.

use serde::de::{self, DeserializeOwned, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::Value;
use std::fmt;
use std::marker::PhantomData;

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

/// Text from a string, number or bool; `None` for null, empty, objects, arrays.
pub fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(if *b { "1" } else { "0" }.to_string()),
        _ => None,
    }
}

/// Float from a number or numeric string (`"7.5"`, `"7,5"`); `None` for `"N/A"`, NaN, etc.
pub fn value_to_f64(v: &Value) -> Option<f64> {
    let f = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().replace(',', ".").parse::<f64>().ok()?,
        Value::Bool(b) => f64::from(u8::from(*b)),
        _ => return None,
    };
    f.is_finite().then_some(f)
}

/// Integer from a number or numeric string (`"12"`, `"12.0"`).
pub fn value_to_i64(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => {
            let t = s.trim();
            t.parse::<i64>().ok().or_else(|| {
                t.parse::<f64>()
                    .ok()
                    .filter(|f| f.is_finite())
                    .map(|f| f as i64)
            })
        }
        Value::Bool(b) => Some(i64::from(*b)),
        _ => None,
    }
}

/// Truthiness of Xtream flags (`1`, `"1"`, `true`, `"true"`).
pub fn value_to_bool(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::Null => None,
        other => match value_to_string(other)?.to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" => Some(true),
            "0" | "false" | "no" => Some(false),
            s => s.parse::<f64>().ok().map(|f| f != 0.0),
        },
    }
}

/// Strings from a string, a number, or an array of either.
pub fn value_to_strings(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().filter_map(value_to_string).collect(),
        other => value_to_string(other).into_iter().collect(),
    }
}

pub fn de_opt_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(value_to_string(&Value::deserialize(d)?))
}

pub fn de_opt_i64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    Ok(value_to_i64(&Value::deserialize(d)?))
}

pub fn de_opt_f64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(value_to_f64(&Value::deserialize(d)?))
}

pub fn de_opt_bool<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    Ok(value_to_bool(&Value::deserialize(d)?))
}

pub fn de_strings<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(value_to_strings(&Value::deserialize(d)?))
}

/// An object, or `None` for `[]`, `null`, strings and other junk.
pub fn de_opt_object<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    match Value::deserialize(d)? {
        v @ Value::Object(_) => Ok(serde_json::from_value(v).ok()),
        _ => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/// A list that tolerates `null`, `false`, `{}` and objects keyed by index, and
/// skips elements that fail to parse (counted in `skipped`).
#[derive(Debug)]
pub struct LenientVec<T> {
    pub items: Vec<T>,
    pub skipped: usize,
}

impl<T> Default for LenientVec<T> {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            skipped: 0,
        }
    }
}

impl<'de, T: DeserializeOwned> Deserialize<'de> for LenientVec<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<T>(PhantomData<T>);
        impl<'de, T: DeserializeOwned> Visitor<'de> for V<T> {
            type Value = LenientVec<T>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a list")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut out = LenientVec {
                    items: Vec::with_capacity(seq.size_hint().unwrap_or(0).min(1 << 16)),
                    skipped: 0,
                };
                while let Some(v) = seq.next_element::<Value>()? {
                    match serde_json::from_value::<T>(v) {
                        Ok(t) => out.items.push(t),
                        Err(_) => out.skipped += 1,
                    }
                }
                Ok(out)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut out = LenientVec::default();
                while let Some((_k, v)) = map.next_entry::<de::IgnoredAny, Value>()? {
                    match serde_json::from_value::<T>(v) {
                        Ok(t) => out.items.push(t),
                        Err(_) => out.skipped += 1,
                    }
                }
                Ok(out)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(LenientVec::default())
            }
            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(LenientVec::default())
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(LenientVec::default())
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(LenientVec::default())
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(LenientVec::default())
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(LenientVec::default())
            }
        }
        d.deserialize_any(V(PhantomData))
    }
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/// `player_api.php` without an action.
#[derive(Debug, Default, Deserialize)]
pub struct RawAccount {
    #[serde(default, deserialize_with = "de_opt_object")]
    pub user_info: Option<RawUserInfo>,
    #[serde(default, deserialize_with = "de_opt_object")]
    pub server_info: Option<RawServerInfo>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawUserInfo {
    #[serde(default, deserialize_with = "de_opt_string")]
    pub username: Option<String>,
    #[serde(default, deserialize_with = "de_opt_bool")]
    pub auth: Option<bool>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub status: Option<String>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub exp_date: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_bool")]
    pub is_trial: Option<bool>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub active_cons: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub created_at: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub max_connections: Option<i64>,
    #[serde(default, deserialize_with = "de_strings")]
    pub allowed_output_formats: Vec<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub message: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawServerInfo {
    #[serde(default, deserialize_with = "de_opt_string")]
    pub url: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub timezone: Option<String>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub timestamp_now: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub time_now: Option<String>,
}

// ---------------------------------------------------------------------------
// Catalog lists
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct RawCategory {
    #[serde(default, deserialize_with = "de_opt_string")]
    pub category_id: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub category_name: Option<String>,
}

/// One entry of `get_live_streams`.
#[derive(Debug, Deserialize)]
pub struct RawLive {
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub num: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub stream_type: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub stream_id: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub stream_icon: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub epg_channel_id: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub added: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub category_id: Option<String>,
    #[serde(default, deserialize_with = "de_strings")]
    pub category_ids: Vec<String>,
    #[serde(default, deserialize_with = "de_opt_bool")]
    pub tv_archive: Option<bool>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub tv_archive_duration: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_bool")]
    pub is_adult: Option<bool>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub custom_sid: Option<String>,
}

/// One entry of `get_vod_streams`.
#[derive(Debug, Deserialize)]
pub struct RawVod {
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub num: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub stream_id: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub stream_icon: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub cover: Option<String>,
    #[serde(default, deserialize_with = "de_opt_f64")]
    pub rating: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_f64")]
    pub rating_5based: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub added: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub category_id: Option<String>,
    #[serde(default, deserialize_with = "de_strings")]
    pub category_ids: Vec<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub container_extension: Option<String>,
    #[serde(default, deserialize_with = "de_opt_bool")]
    pub is_adult: Option<bool>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub year: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub tmdb: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub tmdb_id: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub plot: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub genre: Option<String>,
}

/// One entry of `get_series`.
#[derive(Debug, Deserialize)]
pub struct RawSeries {
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub num: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub series_id: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub cover: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub plot: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub genre: Option<String>,
    #[serde(default, rename = "releaseDate", deserialize_with = "de_opt_string")]
    pub release_date_camel: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub release_date: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub last_modified: Option<String>,
    #[serde(default, deserialize_with = "de_opt_f64")]
    pub rating: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_f64")]
    pub rating_5based: Option<f64>,
    #[serde(default, deserialize_with = "de_strings")]
    pub backdrop_path: Vec<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub category_id: Option<String>,
    #[serde(default, deserialize_with = "de_strings")]
    pub category_ids: Vec<String>,
    #[serde(default, deserialize_with = "de_opt_bool")]
    pub is_adult: Option<bool>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub year: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub tmdb: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub tmdb_id: Option<i64>,
}

// Panels send the same value under several names, sometimes all at once.
// serde aliases reject duplicates, so each spelling is its own field and
// these accessors pick the first one present.

fn first_id(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    a.filter(|v| *v > 0).or(b.filter(|v| *v > 0))
}

impl RawVod {
    pub fn tmdb_id(&self) -> Option<i64> {
        first_id(self.tmdb, self.tmdb_id)
    }
}

impl RawSeries {
    pub fn tmdb_id(&self) -> Option<i64> {
        first_id(self.tmdb, self.tmdb_id)
    }
    pub fn release(&self) -> Option<&str> {
        self.release_date_camel
            .as_deref()
            .or(self.release_date.as_deref())
    }
}

impl RawVodInfoBody {
    pub fn tmdb(&self) -> Option<i64> {
        first_id(self.tmdb_id, self.tmdb)
    }
    pub fn release(&self) -> Option<&str> {
        self.releasedate
            .as_deref()
            .or(self.release_date_camel.as_deref())
            .or(self.release_date.as_deref())
    }
}

impl RawSeriesInfoBody {
    pub fn tmdb(&self) -> Option<i64> {
        first_id(self.tmdb_id, self.tmdb)
    }
    pub fn release(&self) -> Option<&str> {
        self.release_date_camel
            .as_deref()
            .or(self.release_date.as_deref())
    }
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

/// Episodes of one season: the season key (when the panel keyed them) and the list.
pub type SeasonEpisodes = (Option<i64>, Vec<RawEpisode>);

/// `get_vod_info`.
#[derive(Debug, Default, Deserialize)]
pub struct RawVodInfo {
    #[serde(default, deserialize_with = "de_opt_object")]
    pub info: Option<RawVodInfoBody>,
    #[serde(default, deserialize_with = "de_opt_object")]
    pub movie_data: Option<RawMovieData>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawVodInfoBody {
    #[serde(default, deserialize_with = "de_opt_string")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub o_name: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub cover_big: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub movie_image: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub releasedate: Option<String>,
    #[serde(default, rename = "releaseDate", deserialize_with = "de_opt_string")]
    pub release_date_camel: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub release_date: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub youtube_trailer: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub director: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub actors: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub cast: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub plot: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub genre: Option<String>,
    #[serde(default, deserialize_with = "de_strings")]
    pub backdrop_path: Vec<String>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub duration_secs: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub duration: Option<String>,
    #[serde(default, deserialize_with = "de_opt_f64")]
    pub rating: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub tmdb_id: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub tmdb: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawMovieData {
    #[serde(default, deserialize_with = "de_opt_string")]
    pub stream_id: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub added: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub category_id: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub container_extension: Option<String>,
}

/// `get_series_info`.
#[derive(Debug, Default, Deserialize)]
pub struct RawSeriesInfo {
    #[serde(default)]
    pub seasons: LenientVec<RawSeason>,
    #[serde(default, deserialize_with = "de_opt_object")]
    pub info: Option<RawSeriesInfoBody>,
    #[serde(default, deserialize_with = "de_episodes")]
    pub episodes: Vec<SeasonEpisodes>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawSeason {
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub season_number: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub cover: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub cover_big: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub overview: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawSeriesInfoBody {
    #[serde(default, deserialize_with = "de_opt_string")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub cover: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub plot: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub cast: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub director: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub genre: Option<String>,
    #[serde(default, rename = "releaseDate", deserialize_with = "de_opt_string")]
    pub release_date_camel: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub release_date: Option<String>,
    #[serde(default, deserialize_with = "de_opt_f64")]
    pub rating: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_f64")]
    pub rating_5based: Option<f64>,
    #[serde(default, deserialize_with = "de_strings")]
    pub backdrop_path: Vec<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub youtube_trailer: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub category_id: Option<String>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub tmdb_id: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub tmdb: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawEpisode {
    #[serde(default, deserialize_with = "de_opt_string")]
    pub id: Option<String>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub episode_num: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub container_extension: Option<String>,
    #[serde(default, deserialize_with = "de_opt_object")]
    pub info: Option<RawEpisodeInfo>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub added: Option<String>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub season: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawEpisodeInfo {
    #[serde(default, deserialize_with = "de_opt_string")]
    pub plot: Option<String>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub duration_secs: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub duration: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub movie_image: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub releasedate: Option<String>,
}

/// `episodes` is usually `{ "1": [..], "2": [..] }`, sometimes `[[..], [..]]`,
/// sometimes `[]`/`null`. Returns `(season key, episodes)` pairs in input order.
fn de_episodes<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<SeasonEpisodes>, D::Error> {
    let parse_list = |v: Value| -> Vec<RawEpisode> {
        match v {
            Value::Array(a) => a
                .into_iter()
                .filter_map(|e| serde_json::from_value(e).ok())
                .collect(),
            Value::Object(m) => m
                .into_iter()
                .filter_map(|(_, e)| serde_json::from_value(e).ok())
                .collect(),
            _ => Vec::new(),
        }
    };
    Ok(match Value::deserialize(d)? {
        Value::Object(map) => map
            .into_iter()
            .map(|(k, v)| (k.trim().parse::<i64>().ok(), parse_list(v)))
            .collect(),
        Value::Array(arr) => arr
            .into_iter()
            .map(|v| match v {
                inner @ (Value::Array(_) | Value::Object(_)) if !is_episode_object(&inner) => {
                    (None, parse_list(inner))
                }
                single => (None, parse_list(Value::Array(vec![single]))),
            })
            .collect(),
        _ => Vec::new(),
    })
}

fn is_episode_object(v: &Value) -> bool {
    v.as_object()
        .is_some_and(|m| m.contains_key("id") || m.contains_key("episode_num"))
}

/// `get_short_epg`.
#[derive(Debug, Default, Deserialize)]
pub struct RawShortEpg {
    #[serde(default)]
    pub epg_listings: LenientVec<RawEpgListing>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawEpgListing {
    #[serde(default, deserialize_with = "de_opt_string")]
    pub epg_id: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub channel_id: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub start: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub end: Option<String>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub start_timestamp: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub stop_timestamp: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub end_timestamp: Option<i64>,
}

impl RawEpgListing {
    /// `stop_timestamp`, else `end_timestamp`.
    pub fn stop(&self) -> Option<i64> {
        self.stop_timestamp.or(self.end_timestamp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scalars_are_lenient() {
        assert_eq!(value_to_f64(&json!("N/A")), None);
        assert_eq!(value_to_f64(&json!("7,5")), Some(7.5));
        assert_eq!(value_to_f64(&json!(8)), Some(8.0));
        assert_eq!(value_to_i64(&json!("12")), Some(12));
        assert_eq!(value_to_i64(&json!("12.0")), Some(12));
        assert_eq!(value_to_i64(&json!("")), None);
        assert_eq!(value_to_bool(&json!("1")), Some(true));
        assert_eq!(value_to_bool(&json!(0)), Some(false));
        assert_eq!(value_to_string(&json!(101)).as_deref(), Some("101"));
        assert_eq!(value_to_string(&json!("  ")), None);
        assert_eq!(value_to_strings(&json!("a.jpg")), vec!["a.jpg"]);
        assert_eq!(value_to_strings(&json!(["a", 2, null])), vec!["a", "2"]);
    }

    #[test]
    fn live_entry_with_mixed_types() {
        let v: LenientVec<RawLive> = serde_json::from_value(json!([
            {"num": "3", "name": "BBC One", "stream_id": 101, "stream_icon": "",
             "epg_channel_id": null, "category_id": "1", "category_ids": [1, "2"],
             "tv_archive": "1", "tv_archive_duration": "7", "added": "1700000000", "is_adult": "0"},
            "garbage",
            {"stream_id": "102", "name": 42}
        ]))
        .unwrap();
        assert_eq!(v.items.len(), 2);
        assert_eq!(v.skipped, 1);
        let a = &v.items[0];
        assert_eq!(a.num, Some(3));
        assert_eq!(a.stream_id.as_deref(), Some("101"));
        assert_eq!(a.stream_icon, None);
        assert_eq!(a.category_ids, vec!["1", "2"]);
        assert_eq!(a.tv_archive, Some(true));
        assert_eq!(a.tv_archive_duration, Some(7));
        assert_eq!(v.items[1].name.as_deref(), Some("42"));
    }

    #[test]
    fn lists_accept_odd_containers() {
        let v: LenientVec<RawCategory> = serde_json::from_value(json!(null)).unwrap();
        assert!(v.items.is_empty());
        let v: LenientVec<RawCategory> = serde_json::from_value(json!(false)).unwrap();
        assert!(v.items.is_empty());
        let v: LenientVec<RawCategory> =
            serde_json::from_value(json!({"0": {"category_id": 1, "category_name": "A"}})).unwrap();
        assert_eq!(v.items[0].category_id.as_deref(), Some("1"));
    }

    #[test]
    fn series_info_shapes() {
        let s: RawSeriesInfo = serde_json::from_value(json!({
            "seasons": [],
            "info": {"name": "Show", "backdrop_path": "http://x/b.jpg", "rating": "N/A"},
            "episodes": {"1": [{"id": "3001", "episode_num": "1", "title": "Pilot",
                                 "container_extension": "mkv", "info": [], "season": 1}],
                         "2": [{"id": 3004, "episode_num": 1, "info": {"duration_secs": "1500"}}]}
        }))
        .unwrap();
        let info = s.info.unwrap();
        assert_eq!(info.backdrop_path, vec!["http://x/b.jpg"]);
        assert_eq!(info.rating, None);
        assert_eq!(s.episodes.len(), 2);
        let (k, eps) = &s.episodes[1];
        assert_eq!(*k, Some(2));
        assert_eq!(eps[0].id.as_deref(), Some("3004"));
        assert_eq!(eps[0].info.as_ref().unwrap().duration_secs, Some(1500));
        assert!(s.episodes[0].1[0].info.is_none());

        let s: RawSeriesInfo = serde_json::from_value(json!({
            "info": [], "episodes": [[{"id": "1", "season": 3, "episode_num": 2}]]
        }))
        .unwrap();
        assert!(s.info.is_none());
        assert_eq!(s.episodes[0].1[0].season, Some(3));
    }

    #[test]
    fn vod_info_with_empty_info_array() {
        let v: RawVodInfo = serde_json::from_value(json!({
            "info": [], "movie_data": {"stream_id": 201, "container_extension": "mp4"}
        }))
        .unwrap();
        assert!(v.info.is_none());
        assert_eq!(v.movie_data.unwrap().stream_id.as_deref(), Some("201"));
    }

    #[test]
    fn account_auth_flags() {
        let a: RawAccount = serde_json::from_value(json!({"user_info": {"auth": 0}})).unwrap();
        assert_eq!(a.user_info.unwrap().auth, Some(false));
        let a: RawAccount = serde_json::from_value(json!({
            "user_info": {"auth": 1, "status": "Active", "exp_date": null, "max_connections": "2",
                          "allowed_output_formats": ["m3u8", "ts"]},
            "server_info": {"timestamp_now": 1700000000, "time_now": "2023-11-14 23:13:20"}
        }))
        .unwrap();
        let u = a.user_info.unwrap();
        assert_eq!(u.max_connections, Some(2));
        assert_eq!(u.exp_date, None);
        assert_eq!(u.allowed_output_formats, vec!["m3u8", "ts"]);
    }

    #[test]
    fn duplicate_spellings_do_not_reject_the_row() {
        let v: LenientVec<RawSeries> = serde_json::from_value(json!([{
            "series_id": 301, "name": "S", "releaseDate": "2018-03-01", "release_date": "2018-03-01",
            "tmdb": "0", "tmdb_id": "1399"
        }]))
        .unwrap();
        assert_eq!((v.items.len(), v.skipped), (1, 0));
        assert_eq!(v.items[0].release(), Some("2018-03-01"));
        assert_eq!(v.items[0].tmdb_id(), Some(1399));

        let l: RawEpgListing =
            serde_json::from_value(json!({"stop_timestamp": "", "end_timestamp": "1700000000"}))
                .unwrap();
        assert_eq!(l.stop(), Some(1_700_000_000));
    }
}
