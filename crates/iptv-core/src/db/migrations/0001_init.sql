CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('m3u','xtream','stalker')), name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0, auto_refresh INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT, last_refresh_at TEXT, last_error TEXT,
  config_json TEXT NOT NULL,            -- M3uSourceConfig | XtreamSourceConfig | StalkerSourceConfig (camelCase JSON)
  epg_json TEXT NOT NULL DEFAULT '{"detectedUrls":[],"manualUrls":[],"disabledUrls":[]}'
);
CREATE TABLE m3u_raw (source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE, raw TEXT NOT NULL, sha256 TEXT NOT NULL, fetched_at TEXT NOT NULL);
CREATE TABLE categories (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, content_type TEXT NOT NULL, category_id TEXT NOT NULL,
  name TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, item_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, content_type, category_id)
);
CREATE TABLE items (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, content_type TEXT NOT NULL, item_id TEXT NOT NULL,
  category_id TEXT NOT NULL, title TEXT NOT NULL, title_base TEXT, number INTEGER, logo_url TEXT, poster_url TEXT, backdrop_url TEXT,
  rating REAL, added TEXT, year INTEGER, epg_channel_id TEXT, url TEXT, container_extension TEXT, is_radio INTEGER NOT NULL DEFAULT 0,
  archive_hours INTEGER, extra_json TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, content_type, item_id)
);
CREATE INDEX idx_items_cat ON items(source_id, content_type, category_id, position);
CREATE INDEX idx_items_title ON items(source_id, content_type, title COLLATE NOCASE);
CREATE INDEX idx_items_added ON items(content_type, added DESC);
CREATE INDEX idx_items_number ON items(source_id, number);
CREATE INDEX idx_items_epg ON items(epg_channel_id);
CREATE VIRTUAL TABLE items_fts USING fts5(title, content='items', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN INSERT INTO items_fts(rowid, title) VALUES (new.rowid, new.title); END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN INSERT INTO items_fts(items_fts, rowid, title) VALUES ('delete', old.rowid, old.title); END;
CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN INSERT INTO items_fts(items_fts, rowid, title) VALUES ('delete', old.rowid, old.title); INSERT INTO items_fts(rowid, title) VALUES (new.rowid, new.title); END;
CREATE TABLE favorites (source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, content_type TEXT NOT NULL, item_id TEXT NOT NULL, added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, position INTEGER NOT NULL DEFAULT 0, snapshot_json TEXT NOT NULL, PRIMARY KEY (source_id, content_type, item_id));
CREATE TABLE recent (source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, content_type TEXT NOT NULL, item_id TEXT NOT NULL, viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, snapshot_json TEXT NOT NULL, PRIMARY KEY (source_id, content_type, item_id));
CREATE INDEX idx_recent_viewed ON recent(viewed_at DESC);
CREATE TABLE playback_positions (source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, content_type TEXT NOT NULL, item_id TEXT NOT NULL, episode_id TEXT NOT NULL DEFAULT '', position_seconds INTEGER NOT NULL DEFAULT 0, duration_seconds INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, snapshot_json TEXT, PRIMARY KEY (source_id, content_type, item_id, episode_id));
CREATE INDEX idx_positions_updated ON playback_positions(updated_at DESC);
CREATE TABLE epg_sources (url TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT 'settings', source_id TEXT, last_fetch_at TEXT, status TEXT NOT NULL DEFAULT 'idle', error TEXT, channel_count INTEGER NOT NULL DEFAULT 0, program_count INTEGER NOT NULL DEFAULT 0, etag TEXT);
CREATE TABLE epg_channels (epg_url TEXT NOT NULL REFERENCES epg_sources(url) ON DELETE CASCADE, channel_id TEXT NOT NULL, display_name TEXT NOT NULL, icon TEXT, PRIMARY KEY (epg_url, channel_id));
CREATE INDEX idx_epg_channels_name ON epg_channels(display_name COLLATE NOCASE);
CREATE TABLE epg_programs (epg_url TEXT NOT NULL REFERENCES epg_sources(url) ON DELETE CASCADE, channel_id TEXT NOT NULL, start INTEGER NOT NULL, stop INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, category TEXT, icon TEXT);  -- start/stop unix seconds UTC
CREATE INDEX idx_epg_programs_chan ON epg_programs(channel_id, start);
CREATE INDEX idx_epg_programs_stop ON epg_programs(stop);
CREATE TABLE epg_channel_map (source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, content_type TEXT NOT NULL, item_id TEXT NOT NULL, epg_channel_id TEXT, PRIMARY KEY (source_id, content_type, item_id));  -- manual override; NULL = explicitly unmapped
CREATE TABLE downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, content_type TEXT NOT NULL, item_id TEXT NOT NULL, episode_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL, subtitle TEXT, url TEXT NOT NULL, file_name TEXT, file_path TEXT, poster_url TEXT, headers_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','downloading','paused','completed','failed','canceled')),
  bytes_downloaded INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER, resume_validator TEXT, error_message TEXT, position_seconds INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT,
  UNIQUE (source_id, content_type, item_id, episode_id)
);
CREATE INDEX idx_downloads_status ON downloads(status);
CREATE TABLE tmdb_cache (media_type TEXT NOT NULL, lookup_key TEXT NOT NULL, tmdb_id INTEGER, payload_json TEXT, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (media_type, lookup_key));
CREATE TABLE vod_source_pins (match_key TEXT PRIMARY KEY, source_id TEXT NOT NULL, item_id TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO schema_migrations(version) VALUES (1);
