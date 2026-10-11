//! TMDB v3 response shapes (only the fields the app reads).
//!
//! Every field is optional and every list tolerates `null`: TMDB omits or
//! nulls fields freely, and a missing poster must never fail a whole page.

use serde::{Deserialize, Deserializer};

/// `null` or missing -> `T::default()`.
pub(crate) fn nullable<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// One `/search/*`, `/trending/*`, or `similar` result.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SearchResult {
    pub id: i64,
    pub media_type: Option<String>,
    pub title: Option<String>,
    pub original_title: Option<String>,
    pub release_date: Option<String>,
    pub name: Option<String>,
    pub original_name: Option<String>,
    pub first_air_date: Option<String>,
    pub popularity: Option<f64>,
    pub vote_count: Option<i64>,
    pub vote_average: Option<f64>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub overview: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ResultPage {
    #[serde(deserialize_with = "nullable")]
    pub results: Vec<SearchResult>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct CastMember {
    pub id: Option<i64>,
    pub name: Option<String>,
    pub character: Option<String>,
    pub order: Option<i64>,
    pub profile_path: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct CrewMember {
    pub id: Option<i64>,
    pub name: Option<String>,
    pub job: Option<String>,
    pub department: Option<String>,
    pub profile_path: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Credits {
    #[serde(deserialize_with = "nullable")]
    pub cast: Vec<CastMember>,
    #[serde(deserialize_with = "nullable")]
    pub crew: Vec<CrewMember>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct AggregateRole {
    pub character: Option<String>,
    pub episode_count: Option<i64>,
}

/// `/tv/{id}/aggregate_credits` member: characters live in `roles[]`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct AggregateCastMember {
    pub id: Option<i64>,
    pub name: Option<String>,
    pub order: Option<i64>,
    pub profile_path: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub roles: Vec<AggregateRole>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct AggregateCredits {
    #[serde(deserialize_with = "nullable")]
    pub cast: Vec<AggregateCastMember>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Genre {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Video {
    pub key: Option<String>,
    pub site: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub official: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Videos {
    #[serde(deserialize_with = "nullable")]
    pub results: Vec<Video>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ExternalIds {
    pub imdb_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Creator {
    pub id: Option<i64>,
    pub name: Option<String>,
    pub profile_path: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SeasonSummary {
    pub season_number: Option<i64>,
    pub name: Option<String>,
    pub episode_count: Option<i64>,
    pub poster_path: Option<String>,
    pub air_date: Option<String>,
}

/// `/movie/{id}` or `/tv/{id}` with `append_to_response`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Details {
    pub id: i64,
    pub title: Option<String>,
    pub original_title: Option<String>,
    pub release_date: Option<String>,
    pub name: Option<String>,
    pub original_name: Option<String>,
    pub first_air_date: Option<String>,
    pub overview: Option<String>,
    pub original_language: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub genres: Vec<Genre>,
    pub vote_average: Option<f64>,
    pub vote_count: Option<i64>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub runtime: Option<i64>,
    pub imdb_id: Option<String>,
    pub external_ids: Option<ExternalIds>,
    pub credits: Option<Credits>,
    pub aggregate_credits: Option<AggregateCredits>,
    pub videos: Option<Videos>,
    pub similar: Option<ResultPage>,
    pub recommendations: Option<ResultPage>,
    pub status: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub created_by: Vec<Creator>,
    #[serde(deserialize_with = "nullable")]
    pub seasons: Vec<SeasonSummary>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Episode {
    pub episode_number: i64,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub still_path: Option<String>,
    pub air_date: Option<String>,
    pub runtime: Option<i64>,
}

/// `/tv/{id}/season/{n}`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Season {
    pub season_number: Option<i64>,
    pub name: Option<String>,
    pub overview: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub episodes: Vec<Episode>,
}

/// One `combined_credits` entry (cast or crew).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct PersonCredit {
    pub id: i64,
    pub media_type: Option<String>,
    pub title: Option<String>,
    pub release_date: Option<String>,
    pub name: Option<String>,
    pub first_air_date: Option<String>,
    pub character: Option<String>,
    pub job: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub overview: Option<String>,
    pub vote_count: Option<i64>,
    pub vote_average: Option<f64>,
    pub popularity: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct CombinedCredits {
    #[serde(deserialize_with = "nullable")]
    pub cast: Vec<PersonCredit>,
    #[serde(deserialize_with = "nullable")]
    pub crew: Vec<PersonCredit>,
}

/// `/person/{id}?append_to_response=combined_credits`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Person {
    pub id: i64,
    pub name: Option<String>,
    pub biography: Option<String>,
    pub birthday: Option<String>,
    pub place_of_birth: Option<String>,
    pub profile_path: Option<String>,
    pub combined_credits: Option<CombinedCredits>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tolerates_nulls_and_missing_fields() {
        let d: Details = serde_json::from_str(
            r#"{"id":1,"genres":null,"credits":{"cast":null},"seasons":null,"poster_path":null,"extra":42}"#,
        )
        .unwrap();
        assert_eq!(d.id, 1);
        assert!(d.genres.is_empty());
        assert!(d.credits.unwrap().cast.is_empty());
        let p: ResultPage = serde_json::from_str(r#"{"results":null}"#).unwrap();
        assert!(p.results.is_empty());
        let v: Video = serde_json::from_str(r#"{"key":"k","type":"Trailer"}"#).unwrap();
        assert_eq!(v.kind.as_deref(), Some("Trailer"));
    }
}
