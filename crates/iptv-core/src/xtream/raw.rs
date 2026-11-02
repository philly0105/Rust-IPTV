//! Lenient wire types for `player_api.php`.
//!
//! Real panels disagree on almost every field type: ids and numbers arrive as
//! numbers or strings, `rating` can be `"N/A"`, `backdrop_path` is a string or
//! an array, `info` is an object or `[]`, lists can be arrays, objects keyed by
//! index, `null` or `false`. Every field here deserializes through a helper
//! that accepts all of those and falls back to `None`/empty instead of failing.
//! One malformed element in a list is skipped (and counted), never fatal.
//!
//! The big lists (`get_live_streams`, `get_vod_streams`, `get_series`) are
//! read element by element straight from the body ([`decode_list`]), and
//! each record goes to the caller as soon as it is read. The small answers
//! still go through a `Value` ([`LenientVec`], `de_opt_object`), with the
//! same field rules.

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

// ---------------------------------------------------------------------------
// Field decoders
// ---------------------------------------------------------------------------
//
// The fields read their value straight from the deserializer with the rules
// of the `value_to_*` functions above. They used to build a `Value` per
// field and copy its text again: with a `Value` per list element on top,
// a 180k-movie, 72 MB `get_vod_streams` took 486 ms and 7.74M allocations
// (43 per element) to decode, and 230 ms and 1.98M allocations without the
// detour (R3-2). None of them fails on well-formed JSON.

/// How one field type reads each JSON scalar: the rules of its `value_to_*`
/// function. `null`, arrays and objects give `None`.
trait Scalar: Sized {
    fn of_str(v: &str) -> Option<Self>;
    fn of_i64(v: i64) -> Option<Self>;
    fn of_u64(v: u64) -> Option<Self>;
    fn of_f64(v: f64) -> Option<Self>;
    fn of_bool(v: bool) -> Option<Self>;
}

/// [`value_to_string`].
impl Scalar for String {
    fn of_str(v: &str) -> Option<Self> {
        let t = v.trim();
        (!t.is_empty()).then(|| t.to_string())
    }
    fn of_i64(v: i64) -> Option<Self> {
        Some(v.to_string())
    }
    fn of_u64(v: u64) -> Option<Self> {
        Some(v.to_string())
    }
    /// `Number`'s own formatting, so `1.5e3` still reads `"1500.0"`.
    fn of_f64(v: f64) -> Option<Self> {
        serde_json::Number::from_f64(v).map(|n| n.to_string())
    }
    fn of_bool(v: bool) -> Option<Self> {
        Some(if v { "1" } else { "0" }.to_string())
    }
}

/// [`value_to_i64`].
impl Scalar for i64 {
    fn of_str(v: &str) -> Option<Self> {
        let t = v.trim();
        t.parse::<i64>().ok().or_else(|| {
            t.parse::<f64>()
                .ok()
                .filter(|f| f.is_finite())
                .map(|f| f as i64)
        })
    }
    fn of_i64(v: i64) -> Option<Self> {
        Some(v)
    }
    /// Past `i64::MAX` through f64, as `Number::as_f64` did: it saturates.
    fn of_u64(v: u64) -> Option<Self> {
        Some(i64::try_from(v).unwrap_or(v as f64 as i64))
    }
    fn of_f64(v: f64) -> Option<Self> {
        v.is_finite().then_some(v as i64)
    }
    fn of_bool(v: bool) -> Option<Self> {
        Some(i64::from(v))
    }
}

/// [`value_to_f64`].
impl Scalar for f64 {
    fn of_str(v: &str) -> Option<Self> {
        let t = v.trim();
        // Copied only for a decimal comma (`"7,5"`).
        let f = if t.contains(',') {
            t.replace(',', ".").parse::<f64>()
        } else {
            t.parse::<f64>()
        };
        f.ok().filter(|f| f.is_finite())
    }
    fn of_i64(v: i64) -> Option<Self> {
        Some(v as f64)
    }
    fn of_u64(v: u64) -> Option<Self> {
        Some(v as f64)
    }
    fn of_f64(v: f64) -> Option<Self> {
        v.is_finite().then_some(v)
    }
    fn of_bool(v: bool) -> Option<Self> {
        Some(f64::from(u8::from(v)))
    }
}

/// [`value_to_bool`]. A number is true when it is not zero, which is what
/// formatting it and parsing the text back gave.
impl Scalar for bool {
    fn of_str(v: &str) -> Option<Self> {
        let t = v.trim();
        if t.is_empty() {
            return None;
        }
        // `value_to_bool` lowercased the text first; the f64 parser ignores
        // ASCII case on its own (`"INF"`, `"1E3"`).
        let any = |words: [&str; 3]| words.iter().any(|w| t.eq_ignore_ascii_case(w));
        if any(["1", "true", "yes"]) {
            Some(true)
        } else if any(["0", "false", "no"]) {
            Some(false)
        } else {
            t.parse::<f64>().ok().map(|f| f != 0.0)
        }
    }
    fn of_i64(v: i64) -> Option<Self> {
        Some(v != 0)
    }
    fn of_u64(v: u64) -> Option<Self> {
        Some(v != 0)
    }
    fn of_f64(v: f64) -> Option<Self> {
        v.is_finite().then_some(v != 0.0)
    }
    fn of_bool(v: bool) -> Option<Self> {
        Some(v)
    }
}

/// One optional field read with `T`'s [`Scalar`] rules.
struct Opt<T>(Option<T>);

struct OptVisitor<T>(PhantomData<T>);

impl<'de, T: Scalar> Visitor<'de> for OptVisitor<T> {
    type Value = Option<T>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(T::of_str(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
        Ok(T::of_i64(v))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
        Ok(T::of_u64(v))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
        Ok(T::of_f64(v))
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
        Ok(T::of_bool(v))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Self::Value, A::Error> {
        Drain::seq(seq)?;
        Ok(None)
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
        Drain::map(map)?;
        Ok(None)
    }
}

impl<'de, T: Scalar> Deserialize<'de> for Opt<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(OptVisitor(PhantomData)).map(Opt)
    }
}

/// [`value_to_strings`]: the scalar elements of an array (nested arrays and
/// objects are skipped, not flattened), or the one scalar.
struct Strings(Vec<String>);

impl<'de> Deserialize<'de> for Strings {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Vec<String>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(String::of_str(v).into_iter().collect())
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(String::of_i64(v).into_iter().collect())
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(String::of_u64(v).into_iter().collect())
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok(String::of_f64(v).into_iter().collect())
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(String::of_bool(v).into_iter().collect())
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(Vec::new())
            }
            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(Vec::new())
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut out = Vec::new();
                while let Some(Opt(s)) = seq.next_element::<Opt<String>>()? {
                    out.extend(s);
                }
                Ok(out)
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                Drain::map(map)?;
                Ok(Vec::new())
            }
        }
        d.deserialize_any(V).map(Strings)
    }
}

/// Reads one value of any shape through `deserialize_any`, as building a
/// `Value` did (the same nesting limit, number range and UTF-8 checks), and
/// keeps nothing. `IgnoredAny` skips without those checks, so a body the
/// `Value` path rejected as a whole would have been read.
struct Drain;

impl Drain {
    fn seq<'de, A: SeqAccess<'de>>(mut seq: A) -> Result<(), A::Error> {
        while seq.next_element::<Drain>()?.is_some() {}
        Ok(())
    }
    fn map<'de, A: MapAccess<'de>>(mut map: A) -> Result<(), A::Error> {
        while map.next_entry::<Drain, Drain>()?.is_some() {}
        Ok(())
    }
}

impl<'de> Deserialize<'de> for Drain {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Drain;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Drain, E> {
                Ok(Drain)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Drain, E> {
                Ok(Drain)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Drain, E> {
                Ok(Drain)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Drain, E> {
                Ok(Drain)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Drain, E> {
                Ok(Drain)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Drain, E> {
                Ok(Drain)
            }
            fn visit_none<E: de::Error>(self) -> Result<Drain, E> {
                Ok(Drain)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Drain, A::Error> {
                Drain::seq(seq).map(|()| Drain)
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Drain, A::Error> {
                Drain::map(map).map(|()| Drain)
            }
        }
        d.deserialize_any(V)
    }
}

pub fn de_opt_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Opt::deserialize(d).map(|o| o.0)
}

pub fn de_opt_i64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    Opt::deserialize(d).map(|o| o.0)
}

pub fn de_opt_f64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Opt::deserialize(d).map(|o| o.0)
}

pub fn de_opt_bool<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    Opt::deserialize(d).map(|o| o.0)
}

pub fn de_strings<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Strings::deserialize(d).map(|s| s.0)
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
///
/// Each element goes through a `Value`, which is fine for the small answers
/// (categories, seasons, the short EPG). The big lists use [`decode_list`].
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

/// An element of a big list ([`decode_list`]), read without a `Value`. The
/// impls come from `lenient_record!`.
pub trait Record: Sized {
    /// Reads an object. Every key assigns its field, so the last of
    /// duplicate keys wins and a later `null` resets the field, as in the
    /// `Value` map elements used to go through (serde derive alone rejects
    /// duplicates).
    fn read_map<'de, A: MapAccess<'de>>(map: A) -> Result<Self, A::Error>;
    /// Reads an array as the fields in declaration order, as serde derive
    /// did; `None` (drained) when it has more elements than fields.
    fn read_seq<'de, A: SeqAccess<'de>>(seq: A) -> Result<Option<Self>, A::Error>;
}

/// After the fields of an array element: true when no element is left. The
/// rest of a longer array is drained (serde derive over a `Value` failed it).
fn fields_fit<'de, A: SeqAccess<'de>>(mut seq: A) -> Result<bool, A::Error> {
    if seq.next_element::<Drain>()?.is_none() {
        return Ok(true);
    }
    Drain::seq(seq)?;
    Ok(false)
}

/// A [`Record`] as a plain `Deserialize` (through `from_value`, in
/// [`LenientVec`] and tests): an object or an array, anything else fails.
struct RecordVisitor<T>(PhantomData<T>);

impl<'de, T: Record> Visitor<'de> for RecordVisitor<T> {
    type Value = T;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an object")
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<T, A::Error> {
        T::read_map(map)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<T, A::Error> {
        T::read_seq(seq)?.ok_or_else(|| de::Error::custom("more elements than fields"))
    }
}

/// A record field type and the decoder that reads it.
trait LenientField: Sized {
    type De: DeserializeOwned;
    fn take(de: Self::De) -> Self;
}

impl<T: Scalar> LenientField for Option<T> {
    type De = Opt<T>;
    fn take(de: Opt<T>) -> Self {
        de.0
    }
}

impl LenientField for Vec<String> {
    type De = Strings;
    fn take(de: Strings) -> Self {
        de.0
    }
}

/// One element of a big list: the record, or `None` for an element that is
/// neither an object nor an array that fits (skipped and counted).
struct Lenient<T>(Option<T>);

impl<'de, T: Record> Deserialize<'de> for Lenient<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<T>(PhantomData<T>);
        impl<'de, T: Record> Visitor<'de> for V<T> {
            type Value = Option<T>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a list element")
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                T::read_map(map).map(Some)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Self::Value, A::Error> {
                T::read_seq(seq)
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(None)
            }
        }
        d.deserialize_any(V(PhantomData)).map(Lenient)
    }
}

/// Reads a big list answer element by element and hands each record to
/// `each` as soon as it is read; returns how many elements were skipped.
/// The shapes and rules are [`LenientVec`]'s (an array, an object keyed by
/// index, `null`, `false` or another scalar for an empty list), without a
/// `Value` per element or a `Vec` of every record: the caller maps each one
/// to its row at once. A syntax error anywhere fails the whole list, after
/// `each` saw the records before it.
///
/// `body` is the whole answer; see `client::decode_list` for the empty-body
/// and error handling around it.
pub fn decode_list<T: Record>(body: &[u8], each: impl FnMut(T)) -> serde_json::Result<usize> {
    struct V<T, F>(F, PhantomData<T>);
    impl<'de, T: Record, F: FnMut(T)> Visitor<'de> for V<T, F> {
        type Value = usize;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a list")
        }
        fn visit_seq<A: SeqAccess<'de>>(mut self, mut seq: A) -> Result<usize, A::Error> {
            let mut skipped = 0;
            while let Some(Lenient(item)) = seq.next_element::<Lenient<T>>()? {
                match item {
                    Some(t) => (self.0)(t),
                    None => skipped += 1,
                }
            }
            Ok(skipped)
        }
        fn visit_map<A: MapAccess<'de>>(mut self, mut map: A) -> Result<usize, A::Error> {
            let mut skipped = 0;
            while let Some((_, Lenient(item))) = map.next_entry::<de::IgnoredAny, Lenient<T>>()? {
                match item {
                    Some(t) => (self.0)(t),
                    None => skipped += 1,
                }
            }
            Ok(skipped)
        }
        // As `LenientVec`: no list. A float is not accepted there either.
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
    let mut de = serde_json::Deserializer::from_slice(body);
    let skipped = de.deserialize_any(V(each, PhantomData))?;
    de.end()?;
    Ok(skipped)
}

/// Declares a big-list record: the struct (every field `pub`, in wire
/// order), its [`Record`] impl and a `Deserialize` impl through
/// [`RecordVisitor`]. Each field names its JSON key; a field type is
/// `Option<String | i64 | f64 | bool>` or `Vec<String>`, read with the
/// `value_to_*` rules. Unknown keys are drained.
macro_rules! lenient_record {
    (
        $(#[$meta:meta])*
        pub struct $name:ident {
            $($key:literal => $field:ident: $ty:ty,)*
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Default)]
        pub struct $name {
            $(pub $field: $ty,)*
        }

        impl Record for $name {
            fn read_map<'de, A: MapAccess<'de>>(mut map: A) -> Result<Self, A::Error> {
                #[allow(non_camel_case_types)]
                enum Key {
                    $($field,)*
                    __other,
                }
                impl<'de> Deserialize<'de> for Key {
                    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                        struct V;
                        impl<'de> Visitor<'de> for V {
                            type Value = Key;
                            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                                f.write_str("a field name")
                            }
                            fn visit_str<E: de::Error>(self, v: &str) -> Result<Key, E> {
                                Ok(match v {
                                    $($key => Key::$field,)*
                                    _ => Key::__other,
                                })
                            }
                        }
                        d.deserialize_identifier(V)
                    }
                }
                let mut out = Self::default();
                while let Some(key) = map.next_key::<Key>()? {
                    match key {
                        $(Key::$field => {
                            out.$field = <$ty as LenientField>::take(map.next_value()?);
                        })*
                        Key::__other => {
                            map.next_value::<Drain>()?;
                        }
                    }
                }
                Ok(out)
            }

            fn read_seq<'de, A: SeqAccess<'de>>(mut seq: A) -> Result<Option<Self>, A::Error> {
                let mut out = Self::default();
                $(if let Some(v) = seq.next_element()? {
                    out.$field = <$ty as LenientField>::take(v);
                })*
                Ok(fields_fit(seq)?.then_some(out))
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                d.deserialize_struct(
                    stringify!($name),
                    &[$($key),*],
                    RecordVisitor::<Self>(PhantomData),
                )
            }
        }
    };
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

// The big-list records are declared with `lenient_record!`, field order
// included: an element sent as an array fills them by position.

lenient_record! {
    /// One entry of `get_*_categories`.
    pub struct RawCategory {
        "category_id" => category_id: Option<String>,
        "category_name" => category_name: Option<String>,
    }
}

lenient_record! {
    /// One entry of `get_live_streams`.
    pub struct RawLive {
        "num" => num: Option<i64>,
        "name" => name: Option<String>,
        "stream_type" => stream_type: Option<String>,
        "stream_id" => stream_id: Option<String>,
        "stream_icon" => stream_icon: Option<String>,
        "epg_channel_id" => epg_channel_id: Option<String>,
        "added" => added: Option<String>,
        "category_id" => category_id: Option<String>,
        "category_ids" => category_ids: Vec<String>,
        "tv_archive" => tv_archive: Option<bool>,
        "tv_archive_duration" => tv_archive_duration: Option<i64>,
        "is_adult" => is_adult: Option<bool>,
        "custom_sid" => custom_sid: Option<String>,
    }
}

lenient_record! {
    /// One entry of `get_vod_streams`.
    pub struct RawVod {
        "num" => num: Option<i64>,
        "name" => name: Option<String>,
        "title" => title: Option<String>,
        "stream_id" => stream_id: Option<String>,
        "stream_icon" => stream_icon: Option<String>,
        "cover" => cover: Option<String>,
        "rating" => rating: Option<f64>,
        "rating_5based" => rating_5based: Option<f64>,
        "added" => added: Option<String>,
        "category_id" => category_id: Option<String>,
        "category_ids" => category_ids: Vec<String>,
        "container_extension" => container_extension: Option<String>,
        "is_adult" => is_adult: Option<bool>,
        "year" => year: Option<i64>,
        "tmdb" => tmdb: Option<i64>,
        "tmdb_id" => tmdb_id: Option<i64>,
        "plot" => plot: Option<String>,
        "genre" => genre: Option<String>,
    }
}

lenient_record! {
    /// One entry of `get_series`.
    pub struct RawSeries {
        "num" => num: Option<i64>,
        "name" => name: Option<String>,
        "title" => title: Option<String>,
        "series_id" => series_id: Option<String>,
        "cover" => cover: Option<String>,
        "plot" => plot: Option<String>,
        "genre" => genre: Option<String>,
        "releaseDate" => release_date_camel: Option<String>,
        "release_date" => release_date: Option<String>,
        "last_modified" => last_modified: Option<String>,
        "rating" => rating: Option<f64>,
        "rating_5based" => rating_5based: Option<f64>,
        "backdrop_path" => backdrop_path: Vec<String>,
        "category_id" => category_id: Option<String>,
        "category_ids" => category_ids: Vec<String>,
        "is_adult" => is_adult: Option<bool>,
        "year" => year: Option<i64>,
        "tmdb" => tmdb: Option<i64>,
        "tmdb_id" => tmdb_id: Option<i64>,
    }
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

    /// The list decoding before R3-2, for the parity tests below: serde
    /// derive over a `Value` per element (through `LenientVec`), and field
    /// helpers that build a `Value` and apply `value_to_*`. Same struct
    /// names, fields and order as the records, so their `Debug` text is
    /// equal exactly when every field is (hence no field is read).
    #[allow(dead_code)]
    mod legacy {
        use super::super::{
            value_to_bool, value_to_f64, value_to_i64, value_to_string, value_to_strings,
        };
        use serde::{Deserialize, Deserializer};
        use serde_json::Value;

        fn de_opt_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
            Ok(value_to_string(&Value::deserialize(d)?))
        }
        fn de_opt_i64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
            Ok(value_to_i64(&Value::deserialize(d)?))
        }
        fn de_opt_f64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
            Ok(value_to_f64(&Value::deserialize(d)?))
        }
        fn de_opt_bool<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
            Ok(value_to_bool(&Value::deserialize(d)?))
        }
        fn de_strings<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
            Ok(value_to_strings(&Value::deserialize(d)?))
        }

        #[derive(Debug, Deserialize)]
        pub struct RawCategory {
            #[serde(default, deserialize_with = "de_opt_string")]
            pub category_id: Option<String>,
            #[serde(default, deserialize_with = "de_opt_string")]
            pub category_name: Option<String>,
        }

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
    }

    use crate::xtream::client::{decode, decode_list};

    /// A decoded list as text: each record's `Debug` and the skip count, or
    /// the error message.
    type Outcome = Result<(Vec<String>, usize), String>;

    fn old_path<T: DeserializeOwned + fmt::Debug>(body: &[u8]) -> Outcome {
        decode::<LenientVec<T>>(body, "t")
            .map(|l| {
                (
                    l.items.iter().map(|t| format!("{t:?}")).collect(),
                    l.skipped,
                )
            })
            .map_err(|e| e.to_string())
    }

    fn new_path<T: Record + fmt::Debug>(body: &[u8]) -> Outcome {
        let mut items = Vec::new();
        decode_list(body, "t", |t: T| items.push(format!("{t:?}")))
            .map(|skipped| (items, skipped))
            .map_err(|e| e.to_string())
    }

    /// The old and new decoders of every record type agree on `body`: the
    /// same records field for field, the same skip count, or the same
    /// error. The records through `LenientVec` (a `Value` per element, as
    /// the categories still go) agree too.
    fn assert_parity(body: &[u8]) {
        fn one<Old, New>(body: &[u8])
        where
            Old: DeserializeOwned + fmt::Debug,
            New: Record + DeserializeOwned + fmt::Debug,
        {
            let old = old_path::<Old>(body);
            let text = String::from_utf8_lossy(body);
            assert_eq!(new_path::<New>(body), old, "streamed: {text}");
            assert_eq!(old_path::<New>(body), old, "through a Value: {text}");
        }
        one::<legacy::RawCategory, RawCategory>(body);
        one::<legacy::RawLive, RawLive>(body);
        one::<legacy::RawVod, RawVod>(body);
        one::<legacy::RawSeries, RawSeries>(body);
    }

    /// R3-2: each field decoder applies its `value_to_*` function's rules,
    /// read from the text and from a `Value`.
    #[test]
    fn field_decoders_match_the_value_rules() {
        let inputs = [
            "null",
            "true",
            "false",
            "0",
            "1",
            "-1",
            "7",
            "-0",
            "9223372036854775807",
            "9223372036854775808",
            "18446744073709551615",
            "-9223372036854775808",
            "123456789012345678901234567890",
            "1.5",
            "-0.0",
            "0.0",
            "1.0",
            "1.5e3",
            "1E20",
            "2.5e-7",
            "1e300",
            "7.25",
            "-3.7",
            r#""""#,
            r#""  ""#,
            r#"" 12 ""#,
            r#""12.0""#,
            r#""12.9""#,
            r#""-3.7""#,
            r#""7,5""#,
            r#""1,234.5""#,
            r#""N/A""#,
            r#""nan""#,
            r#""NaN""#,
            r#""inf""#,
            r#""-INF""#,
            r#""Infinity""#,
            r#""1e400""#,
            r#""1E3""#,
            r#""TRUE""#,
            r#""Yes""#,
            r#""no""#,
            r#""on""#,
            r#"" 0 ""#,
            r#""0.0""#,
            r#""-0""#,
            r#""0x10""#,
            r#""\u00a012\u00a0""#,
            r#""\t5\n""#,
            r#""+5""#,
            r#"".5""#,
            r#""e5""#,
            r#""http:\/\/h\/a.png""#,
            r#""映画 🎬""#,
            "[]",
            "{}",
            "[[[]]]",
            r#"[1, "2", null, [3, 4], {"a": 5}, true, 1.5, " x ", "", -0.0]"#,
            r#"{"a": [1, 2], "b": {"c": null}}"#,
        ];
        for text in inputs {
            let v: Value = serde_json::from_str(text).unwrap();
            let same = |what: &str, old: String, read: String, through: String| {
                assert_eq!(read, old, "{what} read from {text}");
                assert_eq!(through, old, "{what} through a Value of {text}");
            };
            same(
                "string",
                format!("{:?}", value_to_string(&v)),
                format!("{:?}", serde_json::from_str::<Opt<String>>(text).unwrap().0),
                format!("{:?}", Opt::<String>::deserialize(&v).unwrap().0),
            );
            same(
                "i64",
                format!("{:?}", value_to_i64(&v)),
                format!("{:?}", serde_json::from_str::<Opt<i64>>(text).unwrap().0),
                format!("{:?}", Opt::<i64>::deserialize(&v).unwrap().0),
            );
            same(
                "f64",
                format!("{:?}", value_to_f64(&v)),
                format!("{:?}", serde_json::from_str::<Opt<f64>>(text).unwrap().0),
                format!("{:?}", Opt::<f64>::deserialize(&v).unwrap().0),
            );
            same(
                "bool",
                format!("{:?}", value_to_bool(&v)),
                format!("{:?}", serde_json::from_str::<Opt<bool>>(text).unwrap().0),
                format!("{:?}", Opt::<bool>::deserialize(&v).unwrap().0),
            );
            same(
                "strings",
                format!("{:?}", value_to_strings(&v)),
                format!("{:?}", serde_json::from_str::<Strings>(text).unwrap().0),
                format!("{:?}", Strings::deserialize(&v).unwrap().0),
            );
        }
    }

    /// R3-2: bodies with every quirk the old `Value` path absorbed decode to
    /// the same records through the streaming visitors.
    #[test]
    fn list_decoding_matches_the_value_path_on_tricky_bodies() {
        let bodies: &[&[u8]] = &[
            // Duplicate keys: the last wins, a later null resets the field.
            br#"[{"name": "A", "name": null, "stream_id": 1, "series_id": 2, "category_id": 3}]"#,
            br#"[{"name": null, "name": " B ", "stream_id": "1", "stream_id": 5}]"#,
            br#"[{"releaseDate": "2018", "release_date": "2019", "releaseDate": null}]"#,
            // Nested arrays and objects in list fields and scalar fields.
            br#"[{"category_ids": [1, "2", null, [3, 4], {"a": 5}, true, 1.5, " x "],
                  "backdrop_path": [["http://a"], "http://b"], "name": ["x"], "num": {"a": 1}}]"#,
            br#"[{"category_ids": "7", "backdrop_path": "http://b", "category_name": 12}]"#,
            // Floats, booleans and numbers as strings.
            br#"[{"stream_id": 1.5e3, "num": 2.9, "rating": 1e2, "tv_archive": 0.0,
                  "is_adult": -0.0, "year": "2019.7", "tmdb": "1e400", "category_id": -0.0}]"#,
            br#"[{"tv_archive": "TRUE", "is_adult": "yes", "tv_archive_duration": " 7 ",
                  "rating": "7,5", "rating_5based": "N/A", "num": "-0"}]"#,
            br#"[{"tv_archive": "INF", "is_adult": "nan", "rating": "inf", "year": "NaN"}]"#,
            br#"[{"num": 18446744073709551615, "tmdb": 9223372036854775808,
                  "tmdb_id": -9223372036854775808, "year": 123456789012345678901234567890}]"#,
            // Escaped text (PHP escapes slashes) and non-ASCII.
            br#"[{"stream_icon": "http:\/\/h\/a.png", "name": "\u00a0Caf\u00e9 \ud83c\udfac ", "plot": "a\"b\\c"}]"#,
            // Objects keyed by index, duplicate indexes included.
            br#"{"0": {"stream_id": 1, "category_id": 1}, "1": "junk", "1": {"stream_id": 2}}"#,
            br#"{"2": [3, "Pos"], "x": null, "y": {}}"#,
            // Junk elements, positional arrays, a too-long array.
            br#"["x", 1, 1.5, true, false, null, [], {}, [3, "Name", "live", 101], [1, 2],
                [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21], {"stream_id": 9}]"#,
            br#"[[null, null, null, null, null, null, null, null, ["a", "b"], "1", 7]]"#,
            // Unknown keys of every shape.
            br#"[{"info": {"a": [1, {"b": []}]}, "x": [[]], "": 1, "stream_id": 4}]"#,
            // Containers that hold no list.
            b"null", b"false", b"true", br#""text""#, b"0", b"-3", b"{}", b"[]", b"", b"  \n ",
            // Failures: a float body, HTML, broken or trailing JSON.
            b"1.5", b"<html><body>Please log in</body></html>", b"[1,]", br#"[{"a":1}] x"#,
            br#"[{"stream_id": 1}, {"stream_id": "#, br#"[{"stream_id": 1} {"x": 2}]"#,
            // Rejected by the parser inside an element, even in an unknown
            // key: a number out of range, bad UTF-8, a bad escape.
            br#"[{"stream_id": 1}, {"x": 1e400}]"#, b"[{\"x\": \"\xff\"}]",
            br#"[{"x": "\q"}]"#, br#"[{"name": "\ud800"}]"#,
        ];
        for body in bodies {
            assert_parity(body);
        }
        // Nesting past serde_json's limit (128) fails the list both ways,
        // even under a key nothing reads.
        let deep = format!(r#"[{{"x": {}1{}}}]"#, "[".repeat(200), "]".repeat(200));
        assert_parity(deep.as_bytes());
        assert!(new_path::<RawVod>(deep.as_bytes()).is_err());
        let fine = format!(r#"[{{"x": {}1{}}}]"#, "[".repeat(100), "]".repeat(100));
        assert_eq!(new_path::<RawVod>(fine.as_bytes()).unwrap().0.len(), 1);
    }

    /// Tiny deterministic generator (xorshift64*) for the randomized parity
    /// test; the crate's fuzz harness lives with the integration tests.
    struct Gen(u64);

    impl Gen {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
        fn pick<'a>(&mut self, from: &[&'a str]) -> &'a str {
            from[self.below(from.len())]
        }
    }

    const KEYS: &[&str] = &[
        "num",
        "name",
        "title",
        "stream_type",
        "stream_id",
        "series_id",
        "stream_icon",
        "cover",
        "epg_channel_id",
        "added",
        "category_id",
        "category_ids",
        "category_name",
        "tv_archive",
        "tv_archive_duration",
        "is_adult",
        "custom_sid",
        "rating",
        "rating_5based",
        "container_extension",
        "year",
        "tmdb",
        "tmdb_id",
        "plot",
        "genre",
        "releaseDate",
        "release_date",
        "last_modified",
        "backdrop_path",
        "info",
        "x",
        "0",
        "Name",
        "",
    ];

    const SCALARS: &[&str] = &[
        "null",
        "true",
        "false",
        "0",
        "1",
        "-1",
        "7",
        "101",
        "-0",
        "9223372036854775807",
        "9223372036854775808",
        "18446744073709551615",
        "1.5",
        "-0.0",
        "0.0",
        "1.5e3",
        "1E20",
        "2.5e-7",
        "7.25",
        r#""""#,
        r#""  ""#,
        r#"" 12 ""#,
        r#""12.0""#,
        r#""7,5""#,
        r#""N/A""#,
        r#""nan""#,
        r#""INF""#,
        r#""1e400""#,
        r#""TRUE""#,
        r#""Yes""#,
        r#""no""#,
        r#""on""#,
        r#""radio_streams""#,
        r#""Drama, Crime / Thriller""#,
        r#""http:\/\/h\/a.png""#,
        r#""2018-03-01""#,
        r#""1700000000""#,
        r#""\u00e9t\u00e9 ""#,
        r#""映画 🎬""#,
    ];

    fn gen_value(g: &mut Gen, depth: u32) -> String {
        match g.below(if depth == 0 { 1 } else { 10 }) {
            0..=6 => g.pick(SCALARS).to_string(),
            7 | 8 => {
                let n = g.below(5);
                let items: Vec<String> = (0..n).map(|_| gen_value(g, depth - 1)).collect();
                format!("[{}]", items.join(","))
            }
            _ => {
                let n = g.below(4);
                let items: Vec<String> = (0..n)
                    .map(|_| format!(r#""{}":{}"#, g.pick(KEYS), gen_value(g, depth - 1)))
                    .collect();
                format!("{{{}}}", items.join(","))
            }
        }
    }

    fn gen_element(g: &mut Gen) -> String {
        match g.below(10) {
            0..=6 => {
                let mut entries: Vec<String> = Vec::new();
                for _ in 0..g.below(12) {
                    let key = g.pick(KEYS);
                    entries.push(format!(r#""{key}":{}"#, gen_value(g, 2)));
                    // A key sent again, often as null.
                    if g.below(6) == 0 {
                        let again = if g.below(2) == 0 {
                            "null".to_string()
                        } else {
                            gen_value(g, 1)
                        };
                        entries.push(format!(r#""{key}":{again}"#));
                    }
                }
                format!("{{{}}}", entries.join(","))
            }
            7 => g.pick(SCALARS).to_string(),
            _ => {
                // An array element, filled by position (or too long).
                let n = g.below(24);
                let items: Vec<String> = (0..n).map(|_| gen_value(g, 1)).collect();
                format!("[{}]", items.join(","))
            }
        }
    }

    fn gen_body(g: &mut Gen) -> Vec<u8> {
        let n = g.below(8);
        let text = match g.below(10) {
            0..=6 => {
                let items: Vec<String> = (0..n).map(|_| gen_element(g)).collect();
                format!(" [{}] ", items.join(","))
            }
            7 | 8 => {
                let items: Vec<String> = (0..n)
                    .map(|i| format!(r#""{}":{}"#, i % 3, gen_element(g)))
                    .collect();
                format!("{{{}}}", items.join(","))
            }
            _ => g.pick(SCALARS).to_string(),
        };
        let mut body = text.into_bytes();
        // Now and then a cut body: both paths fail it.
        if g.below(12) == 0 && !body.is_empty() {
            let cut = g.below(body.len());
            body.truncate(cut);
        }
        body
    }

    /// R3-2: thousands of generated bodies (mixed types, junk elements,
    /// duplicate keys, u64 overflow, positional arrays, cut bodies) decode
    /// to identical records through the old and the new path.
    #[test]
    fn list_decoding_matches_the_value_path_on_generated_bodies() {
        let mut g = Gen(0x5233_2d32_0000_0001);
        let (mut records, mut skips, mut failures) = (0, 0, 0);
        for _ in 0..3000 {
            let body = gen_body(&mut g);
            assert_parity(&body);
            match new_path::<RawLive>(&body) {
                Ok((items, skipped)) => {
                    records += items.len();
                    skips += skipped;
                }
                Err(_) => failures += 1,
            }
        }
        // The generator reaches every outcome.
        assert!(
            records > 5000 && skips > 1000 && failures > 200,
            "{records} {skips} {failures}"
        );
    }
}
