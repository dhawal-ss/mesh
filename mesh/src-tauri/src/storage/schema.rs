/// SQL migration strings embedded as constants.
use rusqlite::Connection;

/// Check whether a given migration version has already been applied.
fn migration_applied(conn: &Connection, version: i32) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM schema_version WHERE version = ?1",
        [version],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
        > 0
}

/// Apply a single migration inside a transaction and record its version.
///
/// If `allow_column_exists` is true, "duplicate column name" errors from
/// ALTER TABLE are treated as success (the column already exists from a
/// previous run before version tracking was added).
fn apply_migration(
    conn: &Connection,
    version: i32,
    sql: &str,
    allow_column_exists: bool,
) -> rusqlite::Result<()> {
    conn.execute_batch("BEGIN TRANSACTION;")?;
    match conn.execute_batch(sql) {
        Ok(()) => {
            conn.execute(
                "INSERT OR IGNORE INTO schema_version (version) VALUES (?1)",
                [version],
            )?;
            conn.execute_batch("COMMIT;")?;
            Ok(())
        }
        Err(e) if allow_column_exists && e.to_string().contains("duplicate column name") => {
            conn.execute_batch("ROLLBACK;")?;
            // The column already exists — mark migration as applied outside a
            // transaction since the batch was rolled back.
            conn.execute(
                "INSERT OR IGNORE INTO schema_version (version) VALUES (?1)",
                [version],
            )?;
            Ok(())
        }
        Err(e) => {
            conn.execute_batch("ROLLBACK;")?;
            Err(e)
        }
    }
}

/// Run all migrations, creating the version-tracking table first.
///
/// For existing databases that already have the tables but no `schema_version`
/// table: every migration uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF
/// NOT EXISTS` (or ALTER TABLE that silently fails on duplicate columns), so
/// re-running them is safe and will simply record them as applied.
pub fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    // Create the version-tracking table first (idempotent).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (\
             version INTEGER PRIMARY KEY, \
             applied_at TEXT DEFAULT (datetime('now'))\
         );",
    )?;

    // (version, sql, allow_column_exists)
    // Migrations 2 and 3 use ALTER TABLE ADD COLUMN which is not idempotent
    // in SQLite — allow "duplicate column name" errors so that existing
    // databases (created before version tracking) upgrade cleanly.
    let migrations: &[(i32, &str, bool)] = &[
        (1, MIGRATION_001_INITIAL, false),
        (2, MIGRATION_002_COMMUNITY_ENCRYPTION, true),
        (3, MIGRATION_003_COMMUNITY_OWNER_PUBLIC_KEY, true),
        (4, MIGRATION_004_MEMBERSHIP, false),
        (5, MIGRATION_005_CONTROL_LOG, false),
        (6, MIGRATION_006_LAST_READ, false),
        (7, MIGRATION_007_INVITES, false),
        // Migration 8 is handled below (multiple ALTER TABLEs).
        (9, MIGRATION_009_DISCOVERY_CACHE, false),
        (10, MIGRATION_010_PENDING_MESSAGES, false),
        (11, MIGRATION_011_FTS5_SEARCH, false),
        (12, MIGRATION_012_DIRECT_MESSAGES, false),
        (13, MIGRATION_013_GROUP_KEY_EPOCH, true),
        (14, MIGRATION_014_FILE_AVAILABILITY_AND_DOWNLOADS, false),
        (15, MIGRATION_015_CHANNEL_EVENTS, false),
        (16, MIGRATION_016_MEMBER_TIMEOUTS, false),
        (17, MIGRATION_017_LEGACY_IMPORT_RECEIPTS, false),
    ];

    for &(version, sql, allow_column_exists) in migrations {
        if !migration_applied(conn, version) {
            apply_migration(conn, version, sql, allow_column_exists)?;
        }
    }

    // Migration 8: each ALTER TABLE ADD COLUMN is applied independently so
    // that a partial pre-existing state (some columns present, others not)
    // is handled correctly. All three must succeed (or be duplicates) before
    // the migration is recorded as complete.
    if !migration_applied(conn, 8) {
        for sql in [
            MIGRATION_008_MESSAGE_EDIT_DELETE_EDITED_AT,
            MIGRATION_008_MESSAGE_EDIT_DELETE_DELETED_AT,
            MIGRATION_008_MESSAGE_EDIT_DELETE_REPLY_TO_ID,
        ] {
            match conn.execute_batch(sql) {
                Ok(()) => {}
                Err(e) if e.to_string().contains("duplicate column name") => {}
                Err(e) => return Err(e),
            }
        }
        conn.execute(
            "INSERT OR IGNORE INTO schema_version (version) VALUES (?1)",
            [8],
        )?;
    }

    Ok(())
}

pub const MIGRATION_001_INITIAL: &str = r#"
CREATE TABLE IF NOT EXISTS local_profile (
    public_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    avatar_color TEXT NOT NULL DEFAULT '#c8b89a',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS communities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    community_private_key TEXT,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    our_role TEXT NOT NULL DEFAULT 'member'
);

CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    channel_type TEXT NOT NULL DEFAULT 'text',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_public_key TEXT NOT NULL,
    author_display_name TEXT NOT NULL,
    author_avatar_color TEXT NOT NULL,
    content TEXT NOT NULL,
    attachments TEXT NOT NULL DEFAULT '[]',
    reactions TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS peers (
    public_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    avatar_color TEXT NOT NULL,
    last_known_addrs TEXT NOT NULL DEFAULT '[]',
    last_seen TEXT,
    community_id TEXT REFERENCES communities(id)
);

CREATE TABLE IF NOT EXISTS ban_list (
    community_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    banned_at TEXT NOT NULL DEFAULT (datetime('now')),
    signed_by TEXT NOT NULL,
    signature TEXT NOT NULL,
    PRIMARY KEY (community_id, public_key)
);

CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

pub const MIGRATION_002_COMMUNITY_ENCRYPTION: &str = r#"
ALTER TABLE communities ADD COLUMN group_key TEXT;
"#;

pub const MIGRATION_003_COMMUNITY_OWNER_PUBLIC_KEY: &str = r#"
ALTER TABLE communities ADD COLUMN owner_public_key TEXT;
"#;

// ─── Secure Alpha Migrations ─────────────────────────

pub const MIGRATION_004_MEMBERSHIP: &str = r#"
CREATE TABLE IF NOT EXISTS members (
    community_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    avatar_color TEXT NOT NULL DEFAULT '#c8b89a',
    x25519_public_key TEXT,
    role TEXT NOT NULL DEFAULT 'member',
    join_status TEXT NOT NULL DEFAULT 'joined',
    ban_status TEXT NOT NULL DEFAULT 'none',
    invited_by TEXT,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT,
    PRIMARY KEY (community_id, public_key)
);
"#;

pub const MIGRATION_005_CONTROL_LOG: &str = r#"
CREATE TABLE IF NOT EXISTS control_log (
    id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    signed_by TEXT NOT NULL,
    signature TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_control_log_community ON control_log(community_id, timestamp);
"#;

pub const MIGRATION_006_LAST_READ: &str = r#"
CREATE TABLE IF NOT EXISTS last_read (
    community_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    message_id TEXT,
    timestamp TEXT,
    PRIMARY KEY (community_id, channel_id, public_key)
);
"#;

pub const MIGRATION_007_INVITES: &str = r#"
CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    invite_secret TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    uses_remaining INTEGER,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

pub const MIGRATION_008_MESSAGE_EDIT_DELETE_EDITED_AT: &str =
    "ALTER TABLE messages ADD COLUMN edited_at TEXT;";
pub const MIGRATION_008_MESSAGE_EDIT_DELETE_DELETED_AT: &str =
    "ALTER TABLE messages ADD COLUMN deleted_at TEXT;";
pub const MIGRATION_008_MESSAGE_EDIT_DELETE_REPLY_TO_ID: &str =
    "ALTER TABLE messages ADD COLUMN reply_to_id TEXT;";

pub const MIGRATION_009_DISCOVERY_CACHE: &str = r#"
CREATE TABLE IF NOT EXISTS discovery_cache (
    peer_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    addrs TEXT NOT NULL DEFAULT '[]',
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (peer_id, community_id)
);
"#;

pub const MIGRATION_010_PENDING_MESSAGES: &str = r#"
CREATE TABLE IF NOT EXISTS pending_messages (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status);
"#;

pub const MIGRATION_011_FTS5_SEARCH: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    id UNINDEXED,
    channel_id UNINDEXED,
    author_display_name UNINDEXED,
    tokenize='unicode61'
);

-- Auto-index new messages on insert
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, id, channel_id, author_display_name)
    VALUES (new.rowid, new.content, new.id, new.channel_id, new.author_display_name);
END;

-- Re-index on edit
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.rowid;
    INSERT INTO messages_fts(rowid, content, id, channel_id, author_display_name)
    VALUES (new.rowid, new.content, new.id, new.channel_id, new.author_display_name);
END;

-- Backfill existing messages
INSERT OR IGNORE INTO messages_fts(rowid, content, id, channel_id, author_display_name)
SELECT rowid, content, id, channel_id, author_display_name FROM messages;
"#;

pub const MIGRATION_012_DIRECT_MESSAGES: &str = r#"
CREATE TABLE IF NOT EXISTS dm_conversations (
    id TEXT PRIMARY KEY,
    peer_public_key TEXT NOT NULL UNIQUE,
    peer_display_name TEXT NOT NULL DEFAULT '',
    peer_avatar_color TEXT NOT NULL DEFAULT '#7a7570',
    last_message_at TEXT,
    unread_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES dm_conversations(id),
    author_public_key TEXT NOT NULL,
    author_display_name TEXT NOT NULL,
    author_avatar_color TEXT NOT NULL DEFAULT '#7a7570',
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    signature TEXT NOT NULL DEFAULT '',
    edited_at TEXT,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_direct_messages_conversation
    ON direct_messages(conversation_id, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_dm_conversations_peer
    ON dm_conversations(peer_public_key);
"#;

pub const MIGRATION_013_GROUP_KEY_EPOCH: &str = r#"
ALTER TABLE communities ADD COLUMN group_key_epoch INTEGER;
"#;

pub const MIGRATION_014_FILE_AVAILABILITY_AND_DOWNLOADS: &str = r#"
CREATE TABLE IF NOT EXISTS file_availability (
    file_hash TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    filename TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (file_hash, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_file_availability_hash ON file_availability(file_hash);

CREATE TABLE IF NOT EXISTS download_sessions (
    file_hash TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    total_bytes INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    received_chunks_json TEXT NOT NULL DEFAULT '[]',
    temp_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    source_peer_id TEXT,
    community_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

pub const MIGRATION_015_CHANNEL_EVENTS: &str = r#"
CREATE TABLE IF NOT EXISTS channel_events (
    sequence INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_id TEXT NOT NULL,
    target_id TEXT,
    author_public_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    signature TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_events_id ON channel_events(event_id);
CREATE INDEX IF NOT EXISTS idx_channel_events_channel_ts ON channel_events(channel_id, timestamp);

CREATE TABLE IF NOT EXISTS channel_sequence (
    channel_id TEXT PRIMARY KEY,
    latest_sequence INTEGER NOT NULL DEFAULT 0
);
"#;

pub const MIGRATION_016_MEMBER_TIMEOUTS: &str = r#"
CREATE TABLE IF NOT EXISTS member_timeouts (
    community_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (community_id, public_key)
);
"#;

/// Local idempotency receipts for approval-gated legacy imports. The imported
/// payload itself is stored as an encrypted Matrix room event; this table only
/// prevents a retry on the same device from emitting duplicates.
pub const MIGRATION_017_LEGACY_IMPORT_RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS legacy_import_receipts (
    plan_sha256 TEXT NOT NULL,
    import_key TEXT NOT NULL,
    target_room_id TEXT NOT NULL,
    matrix_event_id TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (plan_sha256, import_key)
);

CREATE INDEX IF NOT EXISTS idx_legacy_import_receipts_room
    ON legacy_import_receipts(target_room_id, imported_at);
"#;
