//! Offline artwork: `/img/logo/{key}.svg`, `/img/poster/{key}.svg`,
//! `/img/backdrop/{key}.svg`. Generated SVGs keep the UI and e2e runs free
//! of external image hosts while still showing distinct, legible art.

use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::catalog::{self, mix};
use crate::gen::xml_escape;

const PALETTE: [(&str, &str); 8] = [
    ("#1f3a5f", "#4f8fd6"),
    ("#5b1f3a", "#d64f7d"),
    ("#1f5b45", "#4fd6a2"),
    ("#5b4a1f", "#d6a84f"),
    ("#3a1f5b", "#8f4fd6"),
    ("#1f4f5b", "#4fc3d6"),
    ("#5b2d1f", "#d6744f"),
    ("#2d2d2d", "#9a9a9a"),
];

fn hash(s: &str) -> u64 {
    s.bytes().fold(0u64, |h, b| mix(h ^ b as u64))
}

fn title_for(kind: &str, key: &str) -> String {
    match kind {
        "logo" => catalog::channel_by_epg(key).map(|c| c.name.to_string()),
        _ => catalog::MOVIES
            .iter()
            .find(|m| m.slug == key)
            .map(|m| m.name.to_string())
            .or_else(|| {
                catalog::SERIES
                    .iter()
                    .chain(std::iter::once(&catalog::VOD_SERIES))
                    .find(|s| s.slug == key)
                    .map(|s| s.name.to_string())
            }),
    }
    .unwrap_or_else(|| key.replace(['-', '_', '.'], " "))
}

fn initials(name: &str) -> String {
    let words: Vec<&str> = name
        .split_whitespace()
        .filter(|w| w.chars().next().is_some_and(|c| c.is_alphanumeric()))
        .collect();
    let mut s: String = words
        .iter()
        .take(3)
        .filter_map(|w| w.chars().next())
        .collect();
    if s.is_empty() {
        s.push('?');
    }
    s.to_uppercase()
}

/// SVG artwork for `kind` (`logo` | `poster` | `backdrop`) and `key`.
pub fn svg(kind: &str, key: &str) -> Option<String> {
    let title = title_for(kind, key);
    let (dark, light) = PALETTE[(hash(key) % PALETTE.len() as u64) as usize];
    let t = xml_escape(&title);
    let out = match kind {
        "logo" => format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><title>{t}</title><rect width="200" height="200" rx="36" fill="{dark}"/><circle cx="160" cy="40" r="22" fill="{light}" opacity=".55"/><text x="100" y="118" font-family="Segoe UI, Arial, sans-serif" font-size="64" font-weight="700" fill="#fff" text-anchor="middle">{}</text></svg>"##,
            xml_escape(&initials(&title))
        ),
        "poster" => format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600"><title>{t}</title><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{light}"/><stop offset="1" stop-color="{dark}"/></linearGradient></defs><rect width="400" height="600" fill="url(#g)"/><circle cx="200" cy="230" r="120" fill="#fff" opacity=".12"/><text x="200" y="470" font-family="Georgia, serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">{t}</text></svg>"##
        ),
        "backdrop" => format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><title>{t}</title><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{dark}"/><stop offset="1" stop-color="{light}"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="980" cy="260" r="260" fill="#fff" opacity=".08"/><circle cx="1100" cy="560" r="140" fill="#fff" opacity=".06"/></svg>"##
        ),
        _ => return None,
    };
    Some(out)
}

pub(crate) async fn image(Path((kind, file)): Path<(String, String)>) -> Response {
    let key = file.strip_suffix(".svg").unwrap_or(&file);
    match svg(&kind, key) {
        Some(body) => (
            [
                (header::CONTENT_TYPE, "image/svg+xml"),
                (header::CACHE_CONTROL, "public, max-age=86400"),
            ],
            body,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "unknown image kind").into_response(),
    }
}

/// Poster URL for a slug.
pub fn poster_url(base: &str, slug: &str) -> String {
    format!("{base}/img/poster/{slug}.svg")
}

/// Backdrop URL for a slug.
pub fn backdrop_url(base: &str, slug: &str) -> String {
    format!("{base}/img/backdrop/{slug}.svg")
}
