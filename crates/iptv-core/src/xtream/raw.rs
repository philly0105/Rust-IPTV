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
use serde_json::value::RawValue;
use serde_json::Value;
use std::fmt;
use std::marker::PhantomData;

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

/// One JSON value as the lenient helpers see it: a scalar, or `Compound`
/// for an array or object (whose contents are skipped, never built).
///
/// The `de_*` helpers read fields through this instead of a
/// [`serde_json::Value`]: a 170k-title list used to build a `Value` per
/// field (plus one per element, see [`LenientVec`]) only to throw it away.
/// `value_to_*` map a `Value` onto the same type, so both paths share one set
/// of rules.
#[derive(Debug, Clone, PartialEq)]
enum Scalar<'a> {
    Null,
    Bool(bool),
    I64(i64),
    U64(u64),
    F64(f64),
    Str(std::borrow::Cow<'a, str>),
    Compound,
}

impl<'a> Scalar<'a> {
    fn of(v: &'a Value) -> Self {
        match v {
            Value::Null => Scalar::Null,
            Value::Bool(b) => Scalar::Bool(*b),
            Value::Number(n) => {
                if let Some(u) = n.as_u64() {
                    Scalar::U64(u)
                } else if let Some(i) = n.as_i64() {
                    Scalar::I64(i)
                } else {
                    Scalar::F64(n.as_f64().unwrap_or(f64::NAN))
                }
            }
            Value::String(s) => Scalar::Str(s.as_str().into()),
            Value::Array(_) | Value::Object(_) => Scalar::Compound,
        }
    }

    /// The number as serde_json's `Number` prints and converts it.
    fn number(&self) -> Option<serde_json::Number> {
        match self {
            Scalar::I64(i) => Some((*i).into()),
            Scalar::U64(u) => Some((*u).into()),
            Scalar::F64(f) => serde_json::Number::from_f64(*f),
            _ => None,
        }
    }

    fn to_string_opt(&self) -> Option<String> {
        match self {
            Scalar::Str(s) => {
                let t = s.trim();
                (!t.is_empty()).then(|| t.to_string())
            }
            Scalar::Bool(b) => Some(if *b { "1" } else { "0" }.to_string()),
            Scalar::I64(_) | Scalar::U64(_) | Scalar::F64(_) => {
                self.number().map(|n| n.to_string())
            }
            Scalar::Null | Scalar::Compound => None,
        }
    }

    fn to_f64(&self) -> Option<f64> {
        let f = match self {
            Scalar::I64(_) | Scalar::U64(_) | Scalar::F64(_) => self.number()?.as_f64()?,
            Scalar::Str(s) => s.trim().replace(',', ".").parse::<f64>().ok()?,
            Scalar::Bool(b) => f64::from(u8::from(*b)),
            Scalar::Null | Scalar::Compound => return None,
        };
        f.is_finite().then_some(f)
    }

    fn to_i64(&self) -> Option<i64> {
        match self {
            Scalar::I64(_) | Scalar::U64(_) | Scalar::F64(_) => {
                let n = self.number()?;
                n.as_i64().or_else(|| n.as_f64().map(|f| f as i64))
            }
            Scalar::Str(s) => {
                let t = s.trim();
                t.parse::<i64>().ok().or_else(|| {
                    t.parse::<f64>()
                        .ok()
                        .filter(|f| f.is_finite())
                        .map(|f| f as i64)
                })
            }
            Scalar::Bool(b) => Some(i64::from(*b)),
            Scalar::Null | Scalar::Compound => None,
        }
    }

    fn to_bool(&self) -> Option<bool> {
        match self {
            Scalar::Bool(b) => Some(*b),
            Scalar::Null => None,
            other => match other.to_string_opt()?.to_ascii_lowercase().as_str() {
                "1" | "true" | "yes" => Some(true),
                "0" | "false" | "no" => Some(false),
                s => s.parse::<f64>().ok().map(|f| f != 0.0),
            },
        }
    }
}

impl<'de> Deserialize<'de> for Scalar<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(ScalarVisitor)
    }
}

struct ScalarVisitor;

impl<'de> Visitor<'de> for ScalarVisitor {
    type Value = Scalar<'de>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
        Ok(Scalar::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
        // serde_json keeps a non-negative integer as unsigned.
        Ok(u64::try_from(v).map_or(Scalar::I64(v), Scalar::U64))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
        Ok(Scalar::U64(v))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
        Ok(Scalar::F64(v))
    }
    fn visit_borrowed_str<E: de::Error>(self, v: &'de str) -> Result<Self::Value, E> {
        Ok(Scalar::Str(v.into()))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(Scalar::Str(v.to_owned().into()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
        Ok(Scalar::Str(v.into()))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(Scalar::Null)
    }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(Scalar::Null)
    }
    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_any(self)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element::<de::IgnoredAny>()?.is_some() {}
        Ok(Scalar::Compound)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map
            .next_entry::<de::IgnoredAny, de::IgnoredAny>()?
            .is_some()
        {}
        Ok(Scalar::Compound)
    }
}

/// The strings of a string, a number, or an array of either (nested arrays
/// and objects inside it are skipped).
struct Strings(Vec<String>);

impl<'de> Deserialize<'de> for Strings {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Strings;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Strings, A::Error> {
                let mut out = Vec::new();
                while let Some(s) = seq.next_element::<Scalar<'de>>()? {
                    out.extend(s.to_string_opt());
                }
                Ok(Strings(out))
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Strings, E> {
                Ok(Strings::one(ScalarVisitor.visit_bool(v)?))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Strings, E> {
                Ok(Strings::one(ScalarVisitor.visit_i64(v)?))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Strings, E> {
                Ok(Strings::one(ScalarVisitor.visit_u64(v)?))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Strings, E> {
                Ok(Strings::one(ScalarVisitor.visit_f64(v)?))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Strings, E> {
                Ok(Strings::one(Scalar::Str(v.into())))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Strings, E> {
                Ok(Strings(Vec::new()))
            }
            fn visit_none<E: de::Error>(self) -> Result<Strings, E> {
                Ok(Strings(Vec::new()))
            }
            fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Strings, D::Error> {
                d.deserialize_any(self)
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Strings, A::Error> {
                ScalarVisitor.visit_map(map)?;
                Ok(Strings(Vec::new()))
            }
        }
        d.deserialize_any(V)
    }
}

impl Strings {
    fn one(s: Scalar<'_>) -> Self {
        Strings(s.to_string_opt().into_iter().collect())
    }
}

/// Text from a string, number or bool; `None` for null, empty, objects, arrays.
pub fn value_to_string(v: &Value) -> Option<String> {
    Scalar::of(v).to_string_opt()
}

/// Float from a number or numeric string (`"7.5"`, `"7,5"`); `None` for `"N/A"`, NaN, etc.
pub fn value_to_f64(v: &Value) -> Option<f64> {
    Scalar::of(v).to_f64()
}

/// Integer from a number or numeric string (`"12"`, `"12.0"`).
pub fn value_to_i64(v: &Value) -> Option<i64> {
    Scalar::of(v).to_i64()
}

/// Truthiness of Xtream flags (`1`, `"1"`, `true`, `"true"`).
pub fn value_to_bool(v: &Value) -> Option<bool> {
    Scalar::of(v).to_bool()
}

/// Strings from a string, a number, or an array of either.
pub fn value_to_strings(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().filter_map(value_to_string).collect(),
        other => value_to_string(other).into_iter().collect(),
    }
}

pub fn de_opt_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(Scalar::deserialize(d)?.to_string_opt())
}

pub fn de_opt_i64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    Ok(Scalar::deserialize(d)?.to_i64())
}

pub fn de_opt_f64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(Scalar::deserialize(d)?.to_f64())
}

pub fn de_opt_bool<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    Ok(Scalar::deserialize(d)?.to_bool())
}

pub fn de_strings<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(Strings::deserialize(d)?.0)
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

/// One element of a lenient list, or `None` when it does not read as a `T`.
///
/// The element's text is decoded straight into `T` (no `Value` tree: about
/// 20 allocations per title fewer). A JSON object that repeats a key fails
/// that way, while a `Value` keeps the last copy of the key, so only then the
/// element is read through a `Value` as before: both paths give the same
/// items.
fn lenient_element<T: DeserializeOwned>(raw: &RawValue) -> Option<T> {
    serde_json::from_str::<T>(raw.get())
        .or_else(|_| serde_json::from_str::<Value>(raw.get()).and_then(serde_json::from_value::<T>))
        .ok()
}

/// Reads a list the way [`LenientVec`] does (an array, an object keyed by
/// index, or junk read as empty) and hands each element that reads as a `T`
/// to `f` at once, in list order, instead of collecting them. Returns the
/// number of elements skipped.
///
/// A sync maps every title to its catalog row as it is read through this, so
/// the decoded titles of a whole list are never in memory together.
pub fn for_each_lenient<'de, D, T, F>(d: D, f: F) -> Result<usize, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
    F: FnMut(T),
{
    struct V<T, F> {
        f: F,
        _t: PhantomData<T>,
    }
    impl<T: DeserializeOwned, F: FnMut(T)> V<T, F> {
        fn take(&mut self, raw: &RawValue) -> usize {
            match lenient_element::<T>(raw) {
                Some(t) => {
                    (self.f)(t);
                    0
                }
                None => 1,
            }
        }
    }
    impl<'de, T: DeserializeOwned, F: FnMut(T)> Visitor<'de> for V<T, F> {
        type Value = usize;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a list")
        }
        fn visit_seq<A: SeqAccess<'de>>(mut self, mut seq: A) -> Result<usize, A::Error> {
            let mut skipped = 0;
            while let Some(raw) = seq.next_element::<Box<RawValue>>()? {
                skipped += self.take(&raw);
            }
            Ok(skipped)
        }
        fn visit_map<A: MapAccess<'de>>(mut self, mut map: A) -> Result<usize, A::Error> {
            let mut skipped = 0;
            while let Some((_k, raw)) = map.next_entry::<de::IgnoredAny, Box<RawValue>>()? {
                skipped += self.take(&raw);
            }
            Ok(skipped)
        }
        fn visit_unit<E: de::Error>(self) -> Result<usize, E> {
            Ok(0)
        }
        fn visit_none<E: de::Error>(self) -> Result<usize, E> {
            Ok(0)
        }
        fn visit_bool<E: de::Error>(self, _: bool) -> Result<usize, E> {
            Ok(0)
        }
        fn visit_str<E: de::Error>(self, _: &str) -> Result<usize, E> {
            Ok(0)
        }
        fn visit_i64<E: de::Error>(self, _: i64) -> Result<usize, E> {
            Ok(0)
        }
        fn visit_u64<E: de::Error>(self, _: u64) -> Result<usize, E> {
            Ok(0)
        }
    }
    d.deserialize_any(V { f, _t: PhantomData })
}

impl<'de, T: DeserializeOwned> Deserialize<'de> for LenientVec<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let mut items = Vec::new();
        let skipped = for_each_lenient(d, |t| items.push(t))?;
        Ok(LenientVec { items, skipped })
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

    /// Wire values the panels send, scalar and not.
    const ODD_VALUES: &[&str] = &[
        "null",
        "true",
        "false",
        "0",
        "1",
        "-7",
        "18446744073709551615",
        "9223372036854775808",
        "-9223372036854775808",
        "7.5",
        "7.0",
        "1e3",
        "-0.0",
        "1.7976931348623157e308",
        "123456789012345678901234567890",
        r#""""#,
        r#""  ""#,
        r#"" 42 ""#,
        r#""7,5""#,
        r#""N/A""#,
        r#""12.9""#,
        r#""1e400""#,
        r#""true""#,
        r#""Yes""#,
        r#""no""#,
        r#""0.0""#,
        r#""café \"x\"""#,
        "[]",
        r#"["a", 2, null, [1], {"k": 1}, " b ", 1.5, true]"#,
        "{}",
        r#"{"a": [1, {"b": 2}]}"#,
    ];

    #[test]
    fn streamed_fields_read_like_values() {
        // The field helpers read the wire directly; `value_to_*` read a
        // `Value`. Every value must come out the same both ways.
        for text in ODD_VALUES {
            let value: Value = serde_json::from_str(text).unwrap();
            let streamed: Scalar<'_> = serde_json::from_str(text).unwrap();
            let owned = match &streamed {
                Scalar::Str(s) => Scalar::Str(s.to_string().into()),
                other => other.clone(),
            };
            let of_value = Scalar::of(&value);
            assert_eq!(owned.to_string_opt(), of_value.to_string_opt(), "{text}");
            assert_eq!(owned.to_i64(), of_value.to_i64(), "{text}");
            assert_eq!(
                owned.to_f64().map(f64::to_bits),
                of_value.to_f64().map(f64::to_bits),
                "{text}"
            );
            assert_eq!(owned.to_bool(), of_value.to_bool(), "{text}");
            let Strings(strings) = serde_json::from_str(text).unwrap();
            assert_eq!(strings, value_to_strings(&value), "{text}");
            // Through a `Value` (de_opt_object, tests) as well.
            let Strings(from_value) = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(from_value, strings, "{text}");
        }
    }

    #[test]
    fn list_elements_read_like_values() {
        // Each element as the old decoder read it: a `Value`, then the struct.
        fn via_value(text: &str) -> (Vec<String>, usize) {
            let mut items = Vec::new();
            let mut skipped = 0;
            for v in serde_json::from_str::<Vec<Value>>(text).unwrap() {
                match serde_json::from_value::<RawVod>(v) {
                    Ok(t) => items.push(format!("{t:?}")),
                    Err(_) => skipped += 1,
                }
            }
            (items, skipped)
        }
        let mut list = vec![
            r#""garbage""#.to_string(),
            "42".to_string(),
            "null".to_string(),
            "[1, 2]".to_string(),
            // A repeated key: a `Value` keeps the last one.
            r#"{"stream_id": 1, "name": "First", "name": "Second", "rating": "8"}"#.to_string(),
            r#"{"stream_id": "2", "category_ids": [3, "4"], "tmdb": 0, "tmdb_id": "77", "unknown": {"deep": [1]}}"#.to_string(),
        ];
        for v in ODD_VALUES {
            list.push(format!(
                r#"{{"stream_id": {v}, "name": {v}, "rating": {v}, "year": {v}, "is_adult": {v}, "category_ids": {v}}}"#
            ));
        }
        let text = format!("[{}]", list.join(","));
        let (want, want_skipped) = via_value(&text);
        let got: LenientVec<RawVod> = decode_list(&text);
        let got_items: Vec<String> = got.items.iter().map(|t| format!("{t:?}")).collect();
        assert_eq!(got_items, want);
        assert_eq!(got.skipped, want_skipped);
        assert!(got_items.iter().any(|t| t.contains("\"Second\"")));
        // Objects keyed by index too, and through a `Value`.
        let keyed = format!(
            "{{{}}}",
            list.iter()
                .enumerate()
                .map(|(i, e)| format!("\"{i}\": {e}"))
                .collect::<Vec<_>>()
                .join(",")
        );
        let got: LenientVec<RawVod> = decode_list(&keyed);
        assert_eq!(got.items.len(), want.len());
        assert_eq!(got.skipped, want_skipped);
        let from_value: LenientVec<RawVod> =
            serde_json::from_value(serde_json::from_str::<Value>(&text).unwrap()).unwrap();
        let from_value: Vec<String> = from_value.items.iter().map(|t| format!("{t:?}")).collect();
        assert_eq!(from_value, want);
    }

    #[test]
    fn decoding_each_element_reads_the_same_list() {
        use crate::xtream::client::{decode, decode_each};
        let bodies = [
            r#"[{"stream_id": 1, "name": "A"}, "junk", {"stream_id": 2, "name": "B", "name": "C"}, 7]"#,
            r#"{"1": {"stream_id": 1}, "0": {"stream_id": 0}, "x": null}"#,
            "",
            "null",
            "false",
            "[]",
        ];
        for body in bodies {
            let want: LenientVec<RawLive> = decode(body.as_bytes(), "t").unwrap();
            let mut got = Vec::new();
            let skipped = decode_each(body.as_bytes(), "t", |r: RawLive| got.push(r)).unwrap();
            let fmt = |v: &[RawLive]| v.iter().map(|r| format!("{r:?}")).collect::<Vec<_>>();
            assert_eq!(fmt(&got), fmt(&want.items), "{body}");
            assert_eq!(skipped, want.skipped, "{body}");
        }
        // A body that does not decode fails the same way, past its first
        // elements too.
        for body in [
            "<html>login</html>",
            r#"[{"stream_id": 1}, {"#,
            r#"[] trailing"#,
        ] {
            let want = decode::<LenientVec<RawLive>>(body.as_bytes(), "t").unwrap_err();
            let got = decode_each(body.as_bytes(), "t", |_: RawLive| {}).unwrap_err();
            assert_eq!(got.to_string(), want.to_string(), "{body}");
        }
    }

    fn decode_list<T: DeserializeOwned>(text: &str) -> LenientVec<T> {
        crate::xtream::client::decode(text.as_bytes(), "test").unwrap()
    }
}
