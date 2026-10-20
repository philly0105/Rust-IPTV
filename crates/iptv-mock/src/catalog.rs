//! Deterministic catalog shared by every mock protocol.
//!
//! Xtream, Stalker, the sample M3U, and the XMLTV feeds all draw from the
//! tables here, so the same channel has the same name, EPG id, logo, and
//! programme schedule no matter which protocol a test reaches it through.
//! Nothing in this module reads the clock or a random source except
//! [`now`]; every other function takes time explicitly.

use chrono::{DateTime, TimeZone, Utc};

/// 2026-01-01T00:00:00Z. Anchor for `added` timestamps and for the static
/// `fixtures/sample.xml` window, so payloads are reproducible.
pub const EPOCH: i64 = 1_767_225_600;

/// Account expiry reported by the Xtream mock (2030-01-01T00:00:00Z).
pub const EXPIRY: i64 = 1_893_456_000;

/// Live category ids and names (Xtream `category_id`, Stalker genre id).
pub const LIVE_CATEGORIES: [(&str, &str); 3] =
    [("1", "News"), ("2", "Sports"), ("3", "Entertainment")];

/// VOD categories.
pub const VOD_CATEGORIES: [(&str, &str); 2] =
    [("10", "Action & Mystery"), ("11", "Drama & Family")];

/// Series categories.
pub const SERIES_CATEGORIES: [(&str, &str); 2] =
    [("20", "Drama Series"), ("21", "Comedy & Family Series")];

/// One live channel.
#[derive(Debug, Clone, Copy)]
pub struct Channel {
    /// Xtream `stream_id` (101..=140).
    pub id: u32,
    pub name: &'static str,
    /// XMLTV channel id, Xtream `epg_channel_id`, M3U `tvg-id`.
    pub epg_id: &'static str,
    /// Live category id ("1".."3").
    pub category: &'static str,
    /// Radio station (audio only).
    pub radio: bool,
}

const fn ch(id: u32, name: &'static str, epg_id: &'static str, category: &'static str) -> Channel {
    Channel {
        id,
        name,
        epg_id,
        category,
        radio: false,
    }
}

/// The 40 Xtream live channels. Ids 101..=105 have catch-up archives.
pub const CHANNELS: [Channel; 40] = [
    ch(101, "BBC One", "bbc1.uk", "1"),
    ch(102, "BBC News", "bbcnews.uk", "1"),
    ch(103, "CNN International", "cnni.us", "1"),
    ch(104, "Sky News", "skynews.uk", "1"),
    ch(105, "Al Jazeera English", "aljazeera.qa", "1"),
    ch(106, "France 24 English", "france24.fr", "1"),
    ch(107, "DW News", "dwnews.de", "1"),
    ch(108, "Euronews", "euronews.eu", "1"),
    ch(109, "Bloomberg TV", "bloomberg.us", "1"),
    ch(110, "CNBC Europe", "cnbc.eu", "1"),
    ch(111, "NHK World", "nhkworld.jp", "1"),
    ch(112, "CBC News Network", "cbcnews.ca", "1"),
    ch(113, "Sky Sports Main Event", "skysportsmain.uk", "2"),
    ch(114, "Sky Sports F1", "skysportsf1.uk", "2"),
    ch(115, "Eurosport 1", "eurosport1.eu", "2"),
    ch(116, "Eurosport 2", "eurosport2.eu", "2"),
    ch(117, "ESPN", "espn.us", "2"),
    ch(118, "ESPN 2", "espn2.us", "2"),
    ch(119, "TNT Sports 1", "tntsports1.uk", "2"),
    ch(120, "beIN Sports", "beinsports.fr", "2"),
    ch(121, "DAZN 1", "dazn1.de", "2"),
    ch(122, "NBA TV", "nbatv.us", "2"),
    ch(123, "Golf Channel", "golf.us", "2"),
    ch(124, "Tennis Channel", "tennis.us", "2"),
    ch(125, "ITV1", "itv1.uk", "3"),
    ch(126, "Channel 4", "channel4.uk", "3"),
    ch(127, "Channel 5", "channel5.uk", "3"),
    ch(128, "Dave", "dave.uk", "3"),
    ch(129, "Comedy Central", "comedycentral.uk", "3"),
    ch(130, "Discovery Channel", "discovery.us", "3"),
    ch(131, "National Geographic", "natgeo.us", "3"),
    ch(132, "History", "history.us", "3"),
    ch(133, "Animal Planet", "animalplanet.us", "3"),
    ch(134, "Cartoon Network", "cartoonnetwork.uk", "3"),
    ch(135, "Nickelodeon", "nick.uk", "3"),
    ch(136, "MTV Hits", "mtvhits.uk", "3"),
    ch(137, "VH1 Classic", "vh1classic.uk", "3"),
    ch(138, "Kiss TV", "kisstv.uk", "3"),
    Channel {
        id: 139,
        name: "Classic FM",
        epg_id: "classicfm.uk",
        category: "3",
        radio: true,
    },
    ch(140, "Trace Urban", "traceurban.fr", "3"),
];

/// First and last Xtream live ids.
pub const LIVE_FIRST_ID: u32 = 101;
pub const LIVE_LAST_ID: u32 = 140;

/// Channel by Xtream stream id.
pub fn channel(id: u32) -> Option<&'static Channel> {
    CHANNELS.iter().find(|c| c.id == id)
}

/// Channel by XMLTV id.
pub fn channel_by_epg(epg_id: &str) -> Option<&'static Channel> {
    CHANNELS.iter().find(|c| c.epg_id == epg_id)
}

/// Index of a channel inside [`CHANNELS`] (seeds its schedule). Ids outside
/// the catalog get a stable index of their own.
pub fn channel_index(id: u32) -> usize {
    CHANNELS
        .iter()
        .position(|c| c.id == id)
        .unwrap_or(id as usize)
}

/// Catch-up (tv_archive) is enabled on 101..=105.
pub fn has_archive(id: u32) -> bool {
    (101..=105).contains(&id)
}

/// Archive depth in days for channels with catch-up.
pub const ARCHIVE_DAYS: u32 = 7;

/// The sample M3U: 25 channels in 4 groups, `tvg-chno` 1..=25 in this order.
/// Classic FM (139) is the radio entry.
pub const SAMPLE_M3U_CHANNELS: [(u32, &str); 25] = [
    (101, "News"),
    (102, "News"),
    (103, "News"),
    (104, "News"),
    (105, "News"),
    (106, "News"),
    (107, "News"),
    (113, "Sports"),
    (114, "Sports"),
    (115, "Sports"),
    (116, "Sports"),
    (117, "Sports"),
    (118, "Sports"),
    (125, "Entertainment"),
    (126, "Entertainment"),
    (127, "Entertainment"),
    (128, "Entertainment"),
    (129, "Entertainment"),
    (130, "Entertainment"),
    (131, "Entertainment"),
    (136, "Music"),
    (137, "Music"),
    (138, "Music"),
    (139, "Music"),
    (140, "Music"),
];

/// One film (ported from the old app's marketing fixture catalog).
#[derive(Debug, Clone, Copy)]
pub struct Movie {
    pub name: &'static str,
    pub slug: &'static str,
    pub genre: &'static str,
    pub year: u32,
    pub rating: f64,
    pub director: &'static str,
    pub actors: &'static str,
    pub tagline: &'static str,
    pub plot: &'static str,
    pub kind: &'static str,
}

/// 35 films. Xtream serves the first 30 as vod ids 201..=230; Stalker serves
/// the first 20 as 5001..=5020.
pub const MOVIES: [Movie; 35] = [
    Movie { name: "Black Harbor", slug: "black-harbor", genre: "Maritime Crime Thriller", year: 2026, rating: 8.2, director: "Nadia Rook", actors: "Mara Venn, Elias Shore, Tomas Bell, June Cross", tagline: "Every tide returns a secret.", plot: "A dock inspector follows a missing cargo ledger through a fogbound harbor where every night crew remembers a different ship.", kind: "action-mystery" },
    Movie { name: "The Paper Astronaut", slug: "the-paper-astronaut", genre: "Stop-Motion Family Animation", year: 2026, rating: 8.6, director: "Lumi North", actors: "Kit Arden, Orla Moss, Finn Vale, Mina Hart", tagline: "Fold a small world. Take a giant step.", plot: "A careful paper astronaut crosses a handmade bedroom universe to return one fallen star before morning.", kind: "family-comedy" },
    Movie { name: "Summer Static", slug: "summer-static", genre: "Coming-of-Age Drama", year: 2025, rating: 8.0, director: "Elise March", actors: "Ari Cole, Leni Wynn, Milo Reed, Tessa Vale", tagline: "The clearest signal never lasts.", plot: "Four friends rebuild an abandoned community radio booth during the final week before their coastal town changes forever.", kind: "drama-documentary" },
    Movie { name: "House of Tides", slug: "house-of-tides", genre: "Gothic Coastal Mystery", year: 2025, rating: 8.3, director: "Iris Shore", actors: "Rhea Voss, Owen Marr, Selah Quinn, Bram North", tagline: "The sea leaves one door open.", plot: "A marine surveyor returns to a cliff house whose rooms appear only when the winter tide retreats.", kind: "action-mystery" },
    Movie { name: "Open Late", slug: "open-late", genre: "Workplace Comedy", year: 2026, rating: 7.8, director: "Milo Hart", actors: "Clara Moss, Ben Rowe, Juno Pike, Evelyn Cole", tagline: "Nothing ordinary happens after midnight.", plot: "Three exhausted night-shift clerks turn a quiet neighborhood shop into an accidental refuge before sunrise.", kind: "family-comedy" },
    Movie { name: "White Room Six", slug: "white-room-six", genre: "Psychological Thriller", year: 2026, rating: 8.1, director: "Noah Venn", actors: "Amara Cross, Theo Holt, Cora Wynn, Elias Vale", tagline: "The experiment ended yesterday.", plot: "A sleep researcher wakes inside her own clinical trial with five empty rooms and a recording she does not remember making.", kind: "action-mystery" },
    Movie { name: "Field Notes", slug: "field-notes", genre: "Nature Documentary", year: 2024, rating: 8.5, director: "Ruth Arden", actors: "Nora Bell, Kai March, Mina Shore, Owen Reed", tagline: "Look closely before it changes.", plot: "A patient botanist documents the last flowering season of an overlooked wetland and the people protecting it.", kind: "drama-documentary" },
    Movie { name: "A Thousand Steps", slug: "a-thousand-steps", genre: "Mountain Sports Drama", year: 2025, rating: 8.2, director: "Tomas North", actors: "Darius Holt, Lina Cross, Rafi Bell, Selah Moss", tagline: "The summit is not the finish.", plot: "A retired mountain guide returns to a vertical race carrying a promise made twenty years earlier.", kind: "drama-documentary" },
    Movie { name: "The Small Hours", slug: "the-small-hours", genre: "Urban Romantic Drama", year: 2024, rating: 8.0, director: "Mara Shore", actors: "Nadia Wynn, Julian Hart, Elise Vale, Theo Reed", tagline: "Morning can wait one more stop.", plot: "Two strangers waiting for the first tram walk through a sleeping city and borrow one honest night from their real lives.", kind: "drama-documentary" },
    Movie { name: "Copper Rain", slug: "copper-rain", genre: "Neo-Noir Mystery", year: 2025, rating: 8.1, director: "Ren Voss", actors: "Iris Marr, Leo Cross, Omar Vale, June Hart", tagline: "Some reflections arrive first.", plot: "A municipal photographer discovers the same copper umbrella at every unexplained blackout across the old city.", kind: "action-mystery" },
    Movie { name: "Willow Engine", slug: "willow-engine", genre: "Family Fantasy Adventure", year: 2026, rating: 8.4, director: "Talia Moss", actors: "Lumi Vale, Kit Shore, Orla Reed, Finn Arden", tagline: "Every old tree remembers a road.", plot: "A young mechanic awakens a walking wooden engine and follows it into a valley disappearing from every map.", kind: "future-fantasy" },
    Movie { name: "Quiet Thunder", slug: "quiet-thunder", genre: "Contemporary Western Drama", year: 2024, rating: 7.9, director: "Owen Rook", actors: "Tessa Marr, Adrian Cole, Ruth Bell, Nico Hart", tagline: "The land speaks before the sky.", plot: "A widowed horse trainer and her estranged son prepare one stubborn mare for the final county storm season.", kind: "drama-documentary" },
    Movie { name: "Parallel Kitchens", slug: "parallel-kitchens", genre: "Science-Fiction Comedy", year: 2026, rating: 7.9, director: "Cora March", actors: "Mina Wynn, Elias Rowe, Bram Pike, Juno Vale", tagline: "Dinner is served twice.", plot: "Two rival cooks discover matching pantry doors that open into each other\u{2019}s restaurants in neighboring realities.", kind: "family-comedy" },
    Movie { name: "First String", slug: "first-string", genre: "Music Drama", year: 2025, rating: 8.3, director: "Lina Venn", actors: "Amara Moss, Theo North, Clara Shore, Ren Hart", tagline: "One note changes every seat.", plot: "A reserve orchestra cellist receives one unexpected solo and twenty-four hours to decide whose career it will replace.", kind: "drama-documentary" },
    Movie { name: "The Long Museum", slug: "the-long-museum", genre: "Art Mystery", year: 2026, rating: 8.2, director: "June Vale", actors: "Bram Cole, Iris Wynn, Selah Hart, Rafi Cross", tagline: "The newest room has always been there.", plot: "An overnight guard follows a newly appeared corridor through galleries that display tomorrow\u{2019}s missing objects.", kind: "action-mystery" },
    Movie { name: "Cloud Hotel", slug: "cloud-hotel", genre: "Animated Family Fantasy", year: 2026, rating: 8.5, director: "Orla March", actors: "Lumi Bell, Kit Vale, Finn Moss, Ari Shore", tagline: "Every storm needs somewhere to rest.", plot: "A shy apprentice opens a tiny floating hotel for weather creatures stranded between seasons.", kind: "family-comedy" },
    Movie { name: "Unpaid Overtime", slug: "unpaid-overtime", genre: "Office Satire", year: 2025, rating: 7.7, director: "Milo Cross", actors: "Cora Hart, Ben Vale, Juno Moss, Adrian Reed", tagline: "The deadline already went home.", plot: "Five office workers locked in after hours attempt to finish one impossible presentation without doing any more work.", kind: "family-comedy" },
    Movie { name: "Deep Green", slug: "deep-green", genre: "Survival Adventure", year: 2026, rating: 8.0, director: "Nadia Holt", actors: "Rhea Shore, Elias North, Mina Cross, Tomas Bell", tagline: "Below the roots, keep breathing.", plot: "Two cave ecologists follow an underground forest beyond the mapped air line after their only exit floods.", kind: "action-mystery" },
    Movie { name: "November Radio", slug: "november-radio", genre: "Period Drama", year: 2024, rating: 8.4, director: "Elena Rook", actors: "Mara Voss, Owen Hart, Ruth Vale, Theo March", tagline: "Stay with the signal.", plot: "In 1978, a remote weather announcer keeps broadcasting through a mountain blackout to listeners she cannot hear.", kind: "drama-documentary" },
    Movie { name: "The Last Orange", slug: "the-last-orange", genre: "Mediterranean Family Drama", year: 2025, rating: 8.1, director: "Iris Cole", actors: "Evelyn Shore, Nadia Bell, Leo Hart, Mina Vale", tagline: "Some inheritances must be shared.", plot: "Three generations gather to harvest a failing seaside orchard and divide everything except the final fruit.", kind: "drama-documentary" },
    Movie { name: "Orchard Walls", slug: "orchard-walls", genre: "Human Drama", year: 2025, rating: 8.4, director: "Elena March", actors: "Darius Cole, Mina Hart, Ruth Bell, Owen Pike", tagline: "Some walls are grown, not built.", plot: "A quiet prison gardener and a new volunteer rebuild an abandoned orchard while both reconsider the lives waiting beyond its walls.", kind: "drama-documentary" },
    Movie { name: "Blue Current", slug: "blue-current", genre: "Animated Family Adventure", year: 2026, rating: 8.6, director: "Talia North", actors: "Lumi Vale, Finn Reed, Orla Moss, Kit Arden", tagline: "The smallest light can find the way.", plot: "A young reef fish and an anxious lantern companion cross a changing ocean current to guide their family home.", kind: "family-comedy" },
    Movie { name: "Signal Nine", slug: "signal-nine", genre: "Urban Conspiracy Thriller", year: 2026, rating: 8.1, director: "Mara Venn", actors: "Nadia Cross, Elias Rowe, June Mercer, Tomas Vale", tagline: "The ninth signal was never sent.", plot: "A transit reporter and a railway investigator trace a repeating emergency signal through a city that insists nothing happened.", kind: "action-mystery" },
    Movie { name: "Checkout at Noon", slug: "checkout-at-noon", genre: "Ensemble Comedy", year: 2025, rating: 7.7, director: "Milo Hart", actors: "Adrian Moss, Clara Wynn, Evelyn Shore, Ben Vale", tagline: "Every guest has a different plan.", plot: "An exhausted hotel manager has one morning to settle a cheerful traveler and a formidable guest into the same impossible room.", kind: "family-comedy" },
    Movie { name: "Vesper Crown", slug: "vesper-crown", genre: "Fantasy Adventure", year: 2026, rating: 8.3, director: "Iris March", actors: "Selah Quinn, Rowan Pike, Mira Holt, Theo Arden", tagline: "Seven pieces remember the throne.", plot: "A royal archivist crosses a silent salt kingdom to recover a broken crown before its seven pieces choose a new ruler.", kind: "future-fantasy" },
    Movie { name: "Last Detour", slug: "last-detour", genre: "Road Action Thriller", year: 2025, rating: 7.9, director: "Noah Rook", actors: "Tessa Marr, Leo Venn, Omar Pike, Nina Cross", tagline: "The long way back is the only way out.", plot: "A veteran mechanic and a bicycle courier take one mountain road too far and discover why every map avoids it.", kind: "action-mystery" },
    Movie { name: "Borrowed Summer", slug: "borrowed-summer", genre: "Romantic Drama", year: 2024, rating: 8.0, director: "Lina Shore", actors: "Mara Wynn, Julian Hart, Elise Rowe, Finn Cole", tagline: "Some seasons are only passing through.", plot: "Two former friends meet beside a lakeside bus route and spend one final season deciding which memories still belong to them.", kind: "drama-documentary" },
    Movie { name: "Under the Floor", slug: "under-the-floor", genre: "Supernatural Horror", year: 2025, rating: 7.8, director: "Oren Vale", actors: "Rhea Moss, Daniel Cross, Mina Shore, Asa Bell", tagline: "The house kept one thing hidden.", plot: "A tenant renovating an empty family home follows a red thread beneath the floorboards and into a history no room remembers.", kind: "action-mystery" },
    Movie { name: "Red Winter", slug: "red-winter", genre: "Science Fiction Survival", year: 2026, rating: 8.5, director: "Vera Holt", actors: "Nora Venn, Kai March, Elias Moss, Ruth Arden", tagline: "Life travels light.", plot: "A planetary botanist crosses a frozen red plain with the last living samples after her remote habitat falls silent.", kind: "future-fantasy" },
    Movie { name: "Saturday Champions", slug: "saturday-champions", genre: "Family Sports Comedy", year: 2025, rating: 7.9, director: "Tomas Hart", actors: "Milo Quinn, Ari Bell, Leni Moss, Kit Rowe", tagline: "The score is not the whole story.", plot: "Six neighborhood footballers with mismatched kits train for the one match their muddy community field has been waiting for.", kind: "family-comedy" },
    Movie { name: "The Silent Verdict", slug: "the-silent-verdict", genre: "Courtroom Drama", year: 2026, rating: 8.2, director: "June Marr", actors: "Amara Voss, Theo Reed, Elias Hart, Cora Wynn", tagline: "The final evidence said nothing.", plot: "A public defender receives one sealed envelope after an empty courtroom closes and must decide whether justice can survive the truth.", kind: "drama-documentary" },
    Movie { name: "Low Tide Letters", slug: "low-tide-letters", genre: "Coastal Mystery", year: 2024, rating: 8.1, director: "Owen Shore", actors: "Bram North, Iris Cole, Lena March, Rafi Bell", tagline: "The sea returns every address.", plot: "An aging postal worker crosses the tidal flats to deliver a final bundle of letters to a village missing from every new map.", kind: "action-mystery" },
    Movie { name: "Salt & Cedar", slug: "salt-cedar", genre: "Culinary Dramedy", year: 2025, rating: 7.8, director: "Cora Vale", actors: "Mina Wynn, Adrian Rowe, Ruth Moss, Nico Hart", tagline: "Every table remembers.", plot: "Two estranged siblings reopen their family restaurant and discover that the old recipes settle fewer arguments than they start.", kind: "family-comedy" },
    Movie { name: "Brass Horizon", slug: "brass-horizon", genre: "Retro Aviation Adventure", year: 2023, rating: 8.0, director: "Ren Arden", actors: "Talia Cross, Owen Pike, Mara Bell, Jules North", tagline: "Build what the horizon cannot stop.", plot: "A desert aircraft engineer races an experimental survey plane ahead of a dust front that has erased every route home.", kind: "action-mystery" },
    Movie { name: "Moonlight Delivery", slug: "moonlight-delivery", genre: "Animated Family Adventure", year: 2026, rating: 8.4, director: "Lumi Hart", actors: "Kit Vale, Orla Reed, Finn Moss, Ari Shore", tagline: "Every doorstep needs a little light.", plot: "A young night courier climbs a winding miniature city to deliver three glowing parcels before the moon disappears.", kind: "family-comedy" },
];

/// First Xtream VOD id.
pub const VOD_FIRST_ID: u32 = 201;
/// Number of Xtream movies.
pub const VOD_COUNT: u32 = 30;

/// Movie by Xtream vod id (201..=230).
pub fn movie(id: u32) -> Option<&'static Movie> {
    if (VOD_FIRST_ID..VOD_FIRST_ID + VOD_COUNT).contains(&id) {
        MOVIES.get((id - VOD_FIRST_ID) as usize)
    } else {
        None
    }
}

/// VOD category id for a movie.
pub fn movie_category(m: &Movie) -> &'static str {
    match m.kind {
        "action-mystery" | "future-fantasy" => "10",
        _ => "11",
    }
}

/// Runtime in seconds, stable per film (90..135 minutes).
pub fn movie_duration_secs(index: usize) -> u32 {
    5_400 + (mix(index as u64 * 7 + 3) % 2_700) as u32
}

/// `H:MM:SS` runtime string as Xtream panels format it.
pub fn hms(secs: u32) -> String {
    format!(
        "{:02}:{:02}:{:02}",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

/// One series.
#[derive(Debug, Clone, Copy)]
pub struct Series {
    pub name: &'static str,
    pub slug: &'static str,
    pub genre: &'static str,
    pub year: u32,
    pub rating: f64,
    pub director: &'static str,
    pub cast: &'static str,
    pub plot: &'static str,
    pub category: &'static str,
}

/// 10 series, Xtream ids 301..=310, each 2 seasons x 3 episodes.
pub const SERIES: [Series; 10] = [
    Series { name: "Harbor Lights", slug: "harbor-lights", genre: "Crime Drama", year: 2024, rating: 8.1, director: "Nadia Rook", cast: "Mara Venn, Elias Shore, June Cross", plot: "A harbor police unit untangles smuggling cases that always seem to start on the night shift.", category: "20" },
    Series { name: "The Archive Room", slug: "the-archive-room", genre: "Mystery", year: 2025, rating: 8.4, director: "Iris Shore", cast: "Rhea Voss, Owen Marr, Selah Quinn", plot: "Two archivists discover that a city's lost records are being rewritten one drawer at a time.", category: "20" },
    Series { name: "Signal & Noise", slug: "signal-and-noise", genre: "Techno Thriller", year: 2025, rating: 7.9, director: "Elise March", cast: "Ari Cole, Leni Wynn, Milo Reed", plot: "A pirate radio crew stumbles onto a broadcast that predicts tomorrow's headlines.", category: "20" },
    Series { name: "Northbound", slug: "northbound", genre: "Road Drama", year: 2023, rating: 7.6, director: "Tomas Bell", cast: "Kit Arden, Orla Moss, Finn Vale", plot: "Three siblings drive their late father's bus from the coast to the arctic circle.", category: "20" },
    Series { name: "Glass Orchard", slug: "glass-orchard", genre: "Family Saga", year: 2022, rating: 8.0, director: "Lumi North", cast: "Mina Hart, Darius Cole, Ruth Bell", plot: "A family-run glassworks fights to survive a decade of storms, debts, and secrets.", category: "20" },
    Series { name: "Corner Booth", slug: "corner-booth", genre: "Sitcom", year: 2024, rating: 7.4, director: "Milo Hart", cast: "Clara Moss, Ben Rowe, Juno Pike", plot: "Regulars at a 24-hour diner argue, scheme, and occasionally help each other out.", category: "21" },
    Series { name: "Tiny Planet Picnic", slug: "tiny-planet-picnic", genre: "Animated Adventure", year: 2025, rating: 8.7, director: "Orla Moss", cast: "Finn Vale, Mina Hart, Kit Arden", plot: "A picnic blanket turns out to be a map to a planet the size of a backyard.", category: "21" },
    Series { name: "Office of Lost Umbrellas", slug: "office-of-lost-umbrellas", genre: "Workplace Comedy", year: 2023, rating: 7.8, director: "Evelyn Cole", cast: "Ben Rowe, Tessa Vale, Owen Pike", plot: "The city's least important department becomes its most beloved.", category: "21" },
    Series { name: "Captain Kindling", slug: "captain-kindling", genre: "Family Comedy", year: 2024, rating: 8.2, director: "Bram North", cast: "Juno Pike, Leni Wynn, Ari Cole", plot: "A retired firefighter becomes a reluctant superhero for a town with very small problems.", category: "21" },
    Series { name: "Weekend Champions", slug: "weekend-champions", genre: "Sports Comedy", year: 2022, rating: 7.5, director: "Clara Moss", cast: "Milo Reed, Selah Quinn, Darius Cole", plot: "An amateur football club with no wins and endless optimism enters a national cup.", category: "21" },
];

/// The Stalker VOD-as-series box set: a row inside the Stalker *VOD*
/// listing flagged `is_series=1`, whose seasons and episodes come from
/// `vod get_ordered_list` with `movie_id` (and `season_id`), as real
/// Ministra portals serve box sets filed among films. It exists only in the
/// Stalker mock (id 5030, see `stalker::VOD_SERIES_ID`); Xtream has no
/// counterpart.
pub const VOD_SERIES: Series = Series {
    name: "The Lantern Keepers",
    slug: "the-lantern-keepers",
    genre: "Family Mystery Miniseries",
    year: 2025,
    rating: 8.3,
    director: "Iris Vale",
    cast: "Rhea Moss, Owen Hart, Selah Pike",
    plot: "Three cousins inherit a lighthouse whose lamp still turns every night, though nobody has climbed the stairs in years.",
    category: "11",
};

/// Episode titles of [`VOD_SERIES`], per season. Deliberately uneven
/// (3 + 2) so season views cannot assume a fixed episode count.
pub const VOD_SERIES_EPISODES: [&[&str]; 2] = [
    &["The Lamp Room", "Fog Signal", "Low Tide Ledger"],
    &["The Relief Keeper", "Last Light"],
];

/// First Xtream series id.
pub const SERIES_FIRST_ID: u32 = 301;
/// Seasons per series.
pub const SEASONS: u32 = 2;
/// Episodes per season.
pub const EPISODES_PER_SEASON: u32 = 3;
/// First episode id.
pub const EPISODE_FIRST_ID: u32 = 3001;

/// Series by Xtream series id (301..=310).
pub fn series(id: u32) -> Option<&'static Series> {
    id.checked_sub(SERIES_FIRST_ID)
        .and_then(|i| SERIES.get(i as usize))
}

/// Episode id for `series_id`, 1-based `season` and `episode`.
pub fn episode_id(series_id: u32, season: u32, episode: u32) -> u32 {
    EPISODE_FIRST_ID
        + (series_id - SERIES_FIRST_ID) * SEASONS * EPISODES_PER_SEASON
        + (season - 1) * EPISODES_PER_SEASON
        + (episode - 1)
}

/// Inverse of [`episode_id`]: `(series_id, season, episode)`.
pub fn episode_parts(episode_id: u32) -> Option<(u32, u32, u32)> {
    let per_series = SEASONS * EPISODES_PER_SEASON;
    let rel = episode_id.checked_sub(EPISODE_FIRST_ID)?;
    let series_idx = rel / per_series;
    if series_idx as usize >= SERIES.len() {
        return None;
    }
    let within = rel % per_series;
    Some((
        SERIES_FIRST_ID + series_idx,
        within / EPISODES_PER_SEASON + 1,
        within % EPISODES_PER_SEASON + 1,
    ))
}

/// Episode titles, cycled.
pub const EPISODE_TITLES: [&str; 12] = [
    "Pilot",
    "The Long Night",
    "Crossing Lines",
    "Low Tide",
    "Paper Trail",
    "Open Water",
    "Static",
    "The Return",
    "Small Hours",
    "Fault Lines",
    "Homecoming",
    "Last Call",
];

/// Title of an episode.
pub fn episode_title(series_id: u32, season: u32, episode: u32) -> String {
    let idx =
        (series_id as usize + (season as usize - 1) * 3 + episode as usize) % EPISODE_TITLES.len();
    EPISODE_TITLES[idx].to_string()
}

// ---------------------------------------------------------------------------
// Programme schedule
// ---------------------------------------------------------------------------

/// One scheduled programme.
#[derive(Debug, Clone, PartialEq)]
pub struct Programme {
    pub start: i64,
    pub stop: i64,
    pub title: String,
    pub sub_title: Option<String>,
    pub desc: String,
    pub category: &'static str,
    /// `xmltv_ns` style `season.episode.part/total` (zero-based), when episodic.
    pub episode_ns: Option<String>,
}

impl Programme {
    /// Stable numeric id derived from start time and channel slot.
    pub fn id(&self, channel_idx: usize) -> u64 {
        (self.start as u64 / 60) * 1000 + channel_idx as u64
    }
}

/// SplitMix64 finaliser: cheap, deterministic, well mixed.
pub fn mix(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

pub(crate) const NEWS_SHOWS: [&str; 10] = [
    "World News Today",
    "Breakfast Briefing",
    "The Midday Report",
    "Business Live",
    "Newsnight",
    "Q&A: The Week Ahead",
    "Global Markets",
    "Weather Watch",
    "Politics Live",
    "Newsroom",
];
pub(crate) const SPORTS_SHOWS: [&str; 10] = [
    "Matchday Live",
    "Grand Prix Qualifying",
    "Tennis: Quarter-Finals",
    "Goals & Highlights",
    "The Fight Night",
    "Golf: Final Round",
    "Basketball Tonight",
    "Cycling: Stage 12",
    "Super League Rugby",
    "Sports Centre",
];
pub(crate) const ENT_SHOWS: [&str; 12] = [
    "The Great Bake Off",
    "Coast Guard Rescue",
    "Planet Earth Revisited",
    "Ancient Engineering",
    "Wild Kingdom",
    "Late Night with Sam",
    "Tom & Jerry Classics",
    "Grand Designs",
    "The Chart Show",
    "Unplugged Sessions",
    "Inside the Museum",
    "Comedy Store <Live>",
];
pub(crate) const DESC_SNIPPETS: [&str; 8] = [
    "Live coverage with expert analysis & reaction from around the world.",
    "The team visits Saint-\u{c9}tienne, Z\u{fc}rich and M\u{e1}laga in a whirlwind week.",
    "Guests discuss \"what comes next\" and why it matters to viewers at home.",
    "An in-depth look at the stories behind the headlines, with archive footage.",
    "Highlights, interviews, and the moments everyone's talking about.",
    "New episode. Subtitles available. Contains some strong language.",
    "Presenters take viewers behind the scenes for an exclusive tour.",
    "A special extended edition marking the programme's 500th broadcast.",
];

/// Start of the UTC day containing `ts`.
pub fn day_start(ts: i64) -> i64 {
    ts.div_euclid(86_400) * 86_400
}

/// The schedule for one channel between `from` and `to` (UTC seconds).
///
/// Every UTC day is planned independently from 00:00 with 30..90 minute
/// slots drawn from a hash of `(seed, start)`, so any window over the same
/// days yields identical programmes. Programmes overlapping the window are
/// included whole.
pub fn schedule(seed: u64, category: &str, from: i64, to: i64) -> Vec<Programme> {
    let mut out = Vec::new();
    let mut day = day_start(from);
    while day < to {
        let next_day = day + 86_400;
        let mut t = day;
        while t < next_day {
            let h = mix(seed.wrapping_mul(1_000_003) ^ t as u64);
            let len = [30, 60, 30, 90, 60, 45][(h % 6) as usize] * 60;
            let stop = (t + len).min(next_day);
            if stop > from && t < to {
                out.push(programme(seed, category, t, stop, h));
            }
            t = stop;
        }
        day = next_day;
    }
    out
}

fn programme(seed: u64, category: &str, start: i64, stop: i64, h: u64) -> Programme {
    let (pool, cat): (&[&str], &'static str) = match category {
        "1" => (&NEWS_SHOWS, "News"),
        "2" => (&SPORTS_SHOWS, "Sports"),
        _ => (&ENT_SHOWS, "Entertainment"),
    };
    let title = pool[((h >> 8) % pool.len() as u64) as usize].to_string();
    let episodic = cat == "Entertainment" && !(h >> 16).is_multiple_of(3);
    let (sub_title, episode_ns) = if episodic {
        let season = (h >> 20) % 6;
        let ep = (h >> 24) % 12;
        (
            Some(EPISODE_TITLES[ep as usize].to_string()),
            Some(format!("{season}.{ep}.0/1")),
        )
    } else {
        (None, None)
    };
    let n = DESC_SNIPPETS.len() as u64;
    let d1 = DESC_SNIPPETS[((h >> 28) % n) as usize];
    let d2 = DESC_SNIPPETS[((h >> 34).wrapping_add(seed) % n) as usize];
    let desc = if d1 == d2 {
        d1.to_string()
    } else {
        format!("{d1} {d2}")
    };
    Programme {
        start,
        stop,
        title,
        sub_title,
        desc,
        category: cat,
        episode_ns,
    }
}

/// Schedule for a live channel by Xtream id (ids outside the catalog get a
/// stable entertainment schedule).
pub fn channel_schedule(id: u32, from: i64, to: i64) -> Vec<Programme> {
    let category = channel(id).map(|c| c.category).unwrap_or("3");
    schedule(channel_index(id) as u64 + 1, category, from, to)
}

/// The programme airing at `now` plus the following ones, `count` in total.
pub fn programmes_from_now(id: u32, now: i64, count: usize) -> Vec<Programme> {
    let mut list = channel_schedule(id, now, now + 2 * 86_400);
    list.retain(|p| p.stop > now);
    list.truncate(count);
    list
}

/// `YYYYmmddHHMMSS +0000` (XMLTV).
pub fn xmltv_time(ts: i64) -> String {
    utc(ts).format("%Y%m%d%H%M%S +0000").to_string()
}

/// `YYYY-mm-dd HH:MM:SS` (Xtream / Stalker).
pub fn sql_time(ts: i64) -> String {
    utc(ts).format("%Y-%m-%d %H:%M:%S").to_string()
}

/// `YYYY-mm-dd:HH-MM` (Xtream timeshift path segment).
pub fn timeshift_time(ts: i64) -> String {
    utc(ts).format("%Y-%m-%d:%H-%M").to_string()
}

/// `YYYY-mm-dd`.
pub fn date(ts: i64) -> String {
    utc(ts).format("%Y-%m-%d").to_string()
}

/// `HH:MM`.
pub fn hhmm(ts: i64) -> String {
    utc(ts).format("%H:%M").to_string()
}

/// UTC datetime for `ts`.
pub fn utc(ts: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(ts, 0).single().unwrap_or_default()
}

/// Current Unix time in seconds.
pub fn now() -> i64 {
    Utc::now().timestamp()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn episode_ids_round_trip() {
        assert_eq!(episode_id(301, 1, 1), 3001);
        assert_eq!(episode_id(301, 2, 3), 3006);
        assert_eq!(episode_id(310, 2, 3), 3060);
        for id in 3001..=3060 {
            let (s, se, e) = episode_parts(id).unwrap();
            assert_eq!(episode_id(s, se, e), id);
        }
        assert!(episode_parts(3061).is_none());
    }

    #[test]
    fn schedules_are_window_independent_and_contiguous() {
        let a = channel_schedule(101, EPOCH, EPOCH + 3 * 86_400);
        let b = channel_schedule(101, EPOCH + 86_400, EPOCH + 2 * 86_400);
        assert!(b.iter().all(|p| a.contains(p)));
        for w in a.windows(2) {
            assert_eq!(w[0].stop, w[1].start);
        }
        assert_eq!(a.first().unwrap().start, EPOCH);
        assert_eq!(a.last().unwrap().stop, EPOCH + 3 * 86_400);
    }

    #[test]
    fn now_programme_covers_now() {
        let now = EPOCH + 12 * 3600 + 17 * 60;
        let p = programmes_from_now(103, now, 4);
        assert_eq!(p.len(), 4);
        assert!(p[0].start <= now && now < p[0].stop);
    }
}
