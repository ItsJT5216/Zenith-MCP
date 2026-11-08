import { DatabaseSync, StatementSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// DbConnection — opaque handle wrapping the driver
// ---------------------------------------------------------------------------

/**
 * Opaque database connection. Consumers pass this around but cannot access
 * internals directly — all operations go through adapter functions.
 */
export class DbConnection {
    #handle: DatabaseSync;
    #stmtCache: Map<string, StatementSync>;
    #txDepth: number;

    constructor(db: DatabaseSync) {
        this.#handle = db;
        this.#stmtCache = new Map();
        this.#txDepth = 0;
    }

    /** @internal — used only by adapter functions in this file. */
    get _db(): DatabaseSync { return this.#handle; }
    get _cache(): Map<string, StatementSync> { return this.#stmtCache; }
    get _txDepth(): number { return this.#txDepth; }
    set _txDepth(v: number) { this.#txDepth = v; }
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function handle(conn: DbConnection): DatabaseSync {
    return conn._db;
}

/**
 * Get or create a prepared statement from the per-connection cache.
 * This avoids repeated prepare calls for hot-path queries.
 */
function prepareOrCache(conn: DbConnection, sql: string): StatementSync {
    const cache = conn._cache;
    let stmt = cache.get(sql);
    if (!stmt) {
        stmt = conn._db.prepare(sql);
        cache.set(sql, stmt);
    }
    return stmt;
}

// ---------------------------------------------------------------------------
// Connection Management
// ---------------------------------------------------------------------------

/**
 * Opens a SQLite database file. Sets standard pragmas:
 * journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON
 */
export function openDb(filePath: string): DbConnection {
    const db = new DatabaseSync(filePath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    return new DbConnection(db);
}

/**
 * Opens an in-memory database (for testing).
 * Skips WAL and busy_timeout since they are no-ops for :memory:.
 */
export function openMemoryDb(): DbConnection {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    return new DbConnection(db);
}

/**
 * Closes a database connection and clears the statement cache.
 */
export function closeDb(conn: DbConnection): void {
    conn._cache.clear();
    handle(conn).close();
}

// ---------------------------------------------------------------------------
// Schema Initialization
// ---------------------------------------------------------------------------

/**
 * Creates tables: files, symbols, edges, versions, patterns + all indexes for the project symbol database.
 * Also executes schema migrations in safe try/catch blocks.
 */
export function initSymbolSchema(conn: DbConnection): void {
    const db = handle(conn);
    db.exec(`
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            hash TEXT,
            last_indexed INTEGER
        );
        CREATE TABLE IF NOT EXISTS symbols (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            kind TEXT,
            type TEXT,
            file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
            line INTEGER,
            end_line INTEGER,
            column INTEGER
        );
        CREATE TABLE IF NOT EXISTS edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            container_def_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
            referenced_name TEXT
        );
        CREATE TABLE IF NOT EXISTS versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol_name TEXT,
            file_path TEXT,
            original_text TEXT,
            session_id TEXT,
            created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS patterns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            edit_body TEXT,
            symbol_kind TEXT,
            created_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
        CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
        CREATE INDEX IF NOT EXISTS idx_symbols_kind_name ON symbols(kind, name);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(referenced_name);
        CREATE INDEX IF NOT EXISTS idx_edges_container ON edges(container_def_id);
        CREATE INDEX IF NOT EXISTS idx_versions_session ON versions(session_id);
    `);

    // Schema migrations
    try {
        db.exec('ALTER TABLE versions ADD COLUMN line INTEGER');
    } catch (error: any) {
        // Only tolerate "column already exists" errors
        const msg = error?.message || String(error);
        if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
            console.error('Unexpected error adding column "line" to versions table:', msg);
            console.error('SQL: ALTER TABLE versions ADD COLUMN line INTEGER');
            throw error;
        }
    }

    try {
        db.exec('ALTER TABLE versions ADD COLUMN text_hash TEXT');
    } catch (error: any) {
        // Only tolerate "column already exists" errors
        const msg = error?.message || String(error);
        if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
            console.error('Unexpected error adding column "text_hash" to versions table:', msg);
            console.error('SQL: ALTER TABLE versions ADD COLUMN text_hash TEXT');
            throw error;
        }
    }

    try {
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_dedup ON versions(symbol_name, file_path, text_hash, session_id)');
    } catch (error: any) {
        // Only tolerate "index already exists" or constraint violation errors
        const msg = error?.message || String(error);
        if (!msg.includes('already exists') && !msg.includes('UNIQUE constraint failed') && !msg.includes('duplicate')) {
            console.error('Unexpected error creating index "idx_versions_dedup":', msg);
            console.error('SQL: CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_dedup ON versions(symbol_name, file_path, text_hash, session_id)');
            throw error;
        }
    }

    // --- Schema version + migration ladder ---
    //
    // schema_version is a single-row table keyed on id=1 (review #5). The CHECK
    // constraint + ON CONFLICT(id) write make the version strictly deterministic:
    // there is exactly one row, ever. A pre-existing database may still carry the
    // OLD shape `schema_version(version INTEGER NOT NULL)` with no `id` column —
    // `CREATE TABLE IF NOT EXISTS` will NOT alter that existing table, so we detect
    // the old shape explicitly and migrate it in place before reading the version.
    const currentVersion = normalizeSchemaVersionTable(db);

    if (currentVersion < 1) {
        // v0 → v1: extended symbol columns + new child tables.
        //
        // Review #6: the entire v0→v1 ladder (column ALTERs + child-table DDL +
        // the schema_version write) runs inside one transaction. SQLite DDL is
        // transactional, so a crash mid-migration rolls the whole ladder back and
        // the version is NOT advanced — leaving currentVersion at 0 so the next
        // init re-runs the migration cleanly. The id=1 row is only written after
        // every statement below has succeeded.
        runTransaction(conn, () => {
            const columnMigrations = [
                'ALTER TABLE symbols ADD COLUMN capture_tag TEXT',
                'ALTER TABLE symbols ADD COLUMN body_hash TEXT',
                'ALTER TABLE symbols ADD COLUMN parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE',
                'ALTER TABLE symbols ADD COLUMN visibility TEXT',
                'ALTER TABLE edges ADD COLUMN callee_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL',
            ];
            for (const sql of columnMigrations) {
                try {
                    db.exec(sql);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
                }
            }
            db.exec(`
            CREATE TABLE IF NOT EXISTS symbol_structures (
                symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
                params_json TEXT, return_text TEXT, decorators_json TEXT,
                modifiers_json TEXT, generics_text TEXT, parent_kind TEXT, parent_name TEXT
            );
            CREATE TABLE IF NOT EXISTS anchors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
                kind TEXT, line INTEGER, text TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_anchors_symbol ON anchors(symbol_id);
            CREATE TABLE IF NOT EXISTS imports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
                module TEXT, imported_names_json TEXT, line INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_path);
            CREATE INDEX IF NOT EXISTS idx_imports_module ON imports(module);
            CREATE TABLE IF NOT EXISTS local_scopes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
                scope_kind TEXT, start_line INTEGER, end_line INTEGER,
                parameters_json TEXT, locals_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_local_scopes_symbol ON local_scopes(symbol_id);
            CREATE TABLE IF NOT EXISTS injections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
                host_lang TEXT, injected_lang TEXT,
                start_line INTEGER, end_line INTEGER, start_byte INTEGER, end_byte INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_injections_file ON injections(file_path);
            CREATE INDEX IF NOT EXISTS idx_edges_callee ON edges(callee_symbol_id);
            -- v3 remediation: project_roots is also a v1 addition (project-DB
            -- registry). Idempotent CREATE; safe if a prior partial run already
            -- added it.
            CREATE TABLE IF NOT EXISTS project_roots (
                root_path TEXT PRIMARY KEY,
                name TEXT,
                created_at INTEGER
            );
            `);
            // Advance to v1 idempotently against the single-row table. ON CONFLICT(id)
            // upserts the lone id=1 row, so re-running this never accumulates rows and
            // never needs a separate INSERT-vs-UPDATE branch.
            db.prepare('INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version').run(1);
        });
    }

    if (currentVersion < 2) {
        // v1 → v2: binding-level import facts. The existing `imports` table stays
        // statement-level; this table records each local binding for semantic consumers.
        runTransaction(conn, () => {
            db.exec(`
            CREATE TABLE IF NOT EXISTS import_bindings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
                source TEXT NOT NULL,
                local_name TEXT NOT NULL,
                imported_name TEXT,
                import_kind TEXT NOT NULL,
                is_type_only INTEGER NOT NULL,
                line INTEGER NOT NULL,
                column INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_import_bindings_file ON import_bindings(file_path);
            CREATE INDEX IF NOT EXISTS idx_import_bindings_local ON import_bindings(file_path, local_name);
            `);
            // Invalidate stored content hashes so the next indexing pass re-parses
            // every already-indexed file and populates import_bindings. Without
            // this, unchanged files skip on hash match (indexFile) and keep empty
            // binding facts indefinitely. Fresh databases have no rows; no-op.
            db.exec('UPDATE files SET hash = NULL');
            db.prepare('INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version').run(2);
        });
    }

    if (currentVersion < 3) {
        // v2 → v3: statement-level imports carry spans for multiline import
        // clusters. Existing rows backfill to their original single-line hint.
        runTransaction(conn, () => {
            const columnMigrations = [
                'ALTER TABLE imports ADD COLUMN start_line INTEGER',
                'ALTER TABLE imports ADD COLUMN end_line INTEGER',
            ];
            for (const sql of columnMigrations) {
                try {
                    db.exec(sql);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
                }
            }
            db.exec('UPDATE imports SET start_line = COALESCE(start_line, line), end_line = COALESCE(end_line, line)');
            db.prepare('INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version').run(3);
        });
    }

    if (currentVersion < 4) {
        // v3 → v4: preserve the reference kind already emitted by the tag queries,
        // plus the full source range already computed for every control-flow anchor.
        // Existing rows receive honest neutral backfills, and stored hashes are
        // invalidated so normal freshness checks repopulate exact facts.
        runTransaction(conn, () => {
            const columnMigrations = [
                "ALTER TABLE edges ADD COLUMN reference_kind TEXT NOT NULL DEFAULT 'unknown'",
                'ALTER TABLE anchors ADD COLUMN end_line INTEGER',
            ];
            for (const sql of columnMigrations) {
                try {
                    db.exec(sql);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
                }
            }
            db.exec("UPDATE edges SET reference_kind = COALESCE(reference_kind, 'unknown')");
            db.exec('UPDATE anchors SET end_line = COALESCE(end_line, line)');
            db.exec('UPDATE files SET hash = NULL');
            db.prepare('INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version').run(4);
        });
    }
}

/**
 * Normalizes the `schema_version` table to its single-row shape and returns the
 * current schema version (0 if the table was just created or held no row).
 *
 * Single-row shape (review #5):
 *   schema_version(id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)
 *
 * Old shape that may already exist on disk:
 *   schema_version(version INTEGER NOT NULL)   -- no `id` column, no PK/UNIQUE
 *
 * Because `CREATE TABLE IF NOT EXISTS` is a no-op when a table already exists, an
 * old-shape table would silently survive. We therefore inspect the live columns
 * via PRAGMA table_info: if an `id` column is absent we read the highest stored
 * version (collapsing any duplicate rows the old shape allowed), drop the table,
 * recreate it single-row, and reinsert that version on the id=1 row. The whole
 * normalization is wrapped in a transaction so a crash cannot leave the table
 * dropped-but-not-recreated.
 */
function normalizeSchemaVersionTable(db: DatabaseSync): number {
    const columns = db.prepare('PRAGMA table_info(schema_version)').all() as Array<{ name: string }>;
    const tableExists = columns.length > 0;
    const hasIdColumn = columns.some((c) => c.name === 'id');

    if (tableExists && !hasIdColumn) {
        // Old shape detected: migrate in place, preserving the recorded version.
        const legacyRow = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null } | undefined;
        const legacyVersion = legacyRow && legacyRow.version !== null ? legacyRow.version : 0;
        db.exec('BEGIN');
        try {
            db.exec('DROP TABLE schema_version');
            db.exec('CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)');
            db.prepare('INSERT INTO schema_version (id, version) VALUES (1, ?)').run(legacyVersion);
            db.exec('COMMIT');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
        return legacyVersion;
    }

    // Fresh table (or already single-row): create-if-missing then read id=1.
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)');
    const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number } | undefined;
    return row ? row.version : 0;
}

/**
 * Creates table: stash(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, file_path TEXT, payload TEXT NOT NULL, attempts INTEGER DEFAULT 0, created_at INTEGER)
 */
export function initStashSchema(conn: DbConnection): void {
    handle(conn).exec(`
        CREATE TABLE IF NOT EXISTS stash (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            file_path TEXT,
            payload TEXT NOT NULL,
            attempts INTEGER DEFAULT 0,
            created_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_stash_created_at ON stash(created_at);
        CREATE INDEX IF NOT EXISTS idx_stash_file_id ON stash(file_path, id DESC);
    `);
}

/**
 * Creates table: config_backups(id INTEGER PRIMARY KEY AUTOINCREMENT, original_path TEXT NOT NULL, backup_content TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)
 */
export function initBackupSchema(conn: DbConnection): void {
    handle(conn).exec(`
        CREATE TABLE IF NOT EXISTS config_backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_path TEXT NOT NULL,
            backup_content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );
    `);
}

// ---------------------------------------------------------------------------
// Files Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: SELECT hash FROM files WHERE path = ?
 */
export function getFileHash(conn: DbConnection, filePath: string): string | null {
    const row = prepareOrCache(conn, 'SELECT hash FROM files WHERE path = ?')
        .get(filePath) as { hash: string } | undefined;
    return row?.hash ?? null;
}

/**
 * SQL: INSERT OR REPLACE INTO files (path, hash, last_indexed) VALUES (?, ?, ?)
 */
export function upsertFile(conn: DbConnection, filePath: string, hash: string, lastIndexed: number): void {
    prepareOrCache(conn, 'INSERT OR REPLACE INTO files (path, hash, last_indexed) VALUES (?, ?, ?)')
        .run(filePath, hash, lastIndexed);
}

/**
 * SQL: DELETE FROM files WHERE path = ?
 */
export function deleteFile(conn: DbConnection, filePath: string): void {
    prepareOrCache(conn, 'DELETE FROM files WHERE path = ?')
        .run(filePath);
}

/**
 * SQL: SELECT path FROM files WHERE path LIKE ?
 */
export function getFilesByPrefix(conn: DbConnection, prefix: string): { path: string }[] {
    return prepareOrCache(conn, 'SELECT path FROM files WHERE path LIKE ?')
        .all(prefix) as { path: string }[];
}

/**
 * SQL: DELETE FROM files
 */
export function deleteAllFiles(conn: DbConnection): void {
    prepareOrCache(conn, 'DELETE FROM files')
        .run();
}

/**
 * SQL: SELECT COUNT(*) AS n FROM files
 */
export function getFileCount(conn: DbConnection): number {
    const row = prepareOrCache(conn, 'SELECT COUNT(*) AS n FROM files')
        .get() as { n: number } | undefined;
    return row?.n ?? 0;
}

/**
 * SQL: SELECT path FROM files
 */
export function getFilePaths(conn: DbConnection): { path: string }[] {
    return prepareOrCache(conn, 'SELECT path FROM files')
        .all() as { path: string }[];
}

// ---------------------------------------------------------------------------
// Symbols Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO symbols (name, kind, type, file_path, line, end_line, column) VALUES (?, ?, ?, ?, ?, ?, ?)
 * Returns the inserted row id.
 */
export function insertSymbol(
    conn: DbConnection,
    symbol: {
        name: string;
        kind: string;
        type: string;
        filePath: string;
        line: number;
        endLine: number;
        column: number;
    }
): number {
    const result = prepareOrCache(conn, 'INSERT INTO symbols (name, kind, type, file_path, line, end_line, column) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(symbol.name, symbol.kind, symbol.type, symbol.filePath, symbol.line, symbol.endLine, symbol.column);
    return Number(result.lastInsertRowid);
}

/**
 * SQL: DELETE FROM symbols WHERE file_path = ?
 */
export function deleteSymbolsByFile(conn: DbConnection, filePath: string): void {
    prepareOrCache(conn, 'DELETE FROM symbols WHERE file_path = ?')
        .run(filePath);
}

/**
 * SQL: DELETE FROM symbols
 */
export function deleteAllSymbols(conn: DbConnection): void {
    prepareOrCache(conn, 'DELETE FROM symbols')
        .run();
}

/**
 * SQL: SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = ?
 */
export function findSymbolFiles(conn: DbConnection, name: string, kind: string): { file_path: string }[] {
    return prepareOrCache(conn, 'SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = ?')
        .all(name, kind) as { file_path: string }[];
}

/**
 * SQL: SELECT s.name, s.file_path, COUNT(e.id) AS refCount FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE e.referenced_name = ? AND s.kind = 'def' GROUP BY s.name, s.file_path ORDER BY refCount DESC
 */
export function getCallers(conn: DbConnection, referencedName: string): { name: string; file_path: string; refCount: number }[] {
    return prepareOrCache(conn, `SELECT s.name, s.file_path, COUNT(e.id) AS refCount FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE e.referenced_name = ? AND s.kind = 'def' GROUP BY s.name, s.file_path ORDER BY refCount DESC`)
        .all(referencedName) as { name: string; file_path: string; refCount: number }[];
}

/**
 * SQL: SELECT e.referenced_name AS name, COUNT(e.id) AS callCount FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE s.name = ? AND s.kind = 'def' GROUP BY e.referenced_name ORDER BY callCount DESC
 */
export function getCallees(conn: DbConnection, symbolName: string): { name: string; callCount: number }[] {
    return prepareOrCache(conn, `SELECT e.referenced_name AS name, COUNT(e.id) AS callCount FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE s.name = ? AND s.kind = 'def' GROUP BY e.referenced_name ORDER BY callCount DESC`)
        .all(symbolName) as { name: string; callCount: number }[];
}

/**
 * SQL: SELECT s.name, s.file_path, COUNT(e.id) AS refCount
 *      FROM edges e JOIN symbols s ON s.id = e.container_def_id
 *      WHERE e.referenced_name = ? AND s.kind = 'def'
 *        AND s.file_path NOT IN (SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = 'def' AND file_path != ?)
 *      GROUP BY s.name, s.file_path ORDER BY refCount DESC
 */
export function getCallersFiltered(
    conn: DbConnection,
    referencedName: string,
    originSymbol: string,
    originFile: string
): { name: string; file_path: string; refCount: number }[] {
    return prepareOrCache(conn, `SELECT s.name, s.file_path, COUNT(e.id) AS refCount FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE e.referenced_name = ? AND s.kind = 'def' AND s.file_path NOT IN (SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = 'def' AND file_path != ?) GROUP BY s.name, s.file_path ORDER BY refCount DESC`)
        .all(referencedName, originSymbol, originFile) as { name: string; file_path: string; refCount: number }[];
}

/**
 * SQL: SELECT e.referenced_name AS name, COUNT(e.id) AS callCount
 *      FROM edges e JOIN symbols s ON s.id = e.container_def_id
 *      WHERE s.name = ? AND s.kind = 'def' AND s.file_path = ?
 *      GROUP BY e.referenced_name ORDER BY callCount DESC
 */
export function getCalleesFiltered(conn: DbConnection, symbolName: string, filePath: string): { name: string; callCount: number }[] {
    return prepareOrCache(conn, `SELECT e.referenced_name AS name, COUNT(e.id) AS callCount FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE s.name = ? AND s.kind = 'def' AND s.file_path = ? GROUP BY e.referenced_name ORDER BY callCount DESC`)
        .all(symbolName, filePath) as { name: string; callCount: number }[];
}

/**
 * Get all symbols (defs and refs) for a single file with the full
 * tree-sitter symbol shape: name, kind, type, line, endLine, column.
 *
 * SQL: SELECT name, kind, type, line, end_line AS endLine, column FROM
 *      symbols WHERE file_path = ? ORDER BY line
 *
 * This is the DB-backed counterpart to the tree-sitter `getSymbols()`
 * extractor — consumers should call `ensureIndexFresh()` first to
 * guarantee the rows reflect the current file content.
 */
export function getSymbolsInFile(
    conn: DbConnection,
    filePath: string
): Array<{ name: string; kind: string; type: string; line: number; endLine: number; column: number }> {
    return prepareOrCache(
        conn,
        `SELECT name, kind, type, line, end_line AS endLine, column FROM symbols WHERE file_path = ? ORDER BY line`
    ).all(filePath) as Array<{ name: string; kind: string; type: string; line: number; endLine: number; column: number }>;
}

/**
 * Find symbols by exact name within a single file, optionally filtered
 * by kind. Used by consumers that previously called the tree-sitter
 * `findSymbol()` extractor for single-file symbol lookup.
 *
 * SQL: SELECT name, kind, type, line, end_line AS endLine, column FROM
 *      symbols WHERE file_path = ? AND name = ? [AND kind = ?] ORDER BY line
 */
export function findSymbolsByNameInFile(
    conn: DbConnection,
    filePath: string,
    name: string,
    kindFilter?: string
): Array<{ name: string; kind: string; type: string; line: number; endLine: number; column: number }> {
    let sql = `SELECT name, kind, type, line, end_line AS endLine, column FROM symbols WHERE file_path = ? AND name = ?`;
    const params: string[] = [filePath, name];
    if (kindFilter !== undefined) {
        sql += ' AND kind = ?';
        params.push(kindFilter);
    }
    sql += ' ORDER BY line';
    return prepareOrCache(conn, sql).all(...params) as Array<{ name: string; kind: string; type: string; line: number; endLine: number; column: number }>;
}

// ---------------------------------------------------------------------------
// Edges Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO edges (container_def_id, referenced_name, reference_kind) VALUES (?, ?, ?)
 */
export function insertEdge(conn: DbConnection, containerDefId: number, referencedName: string, referenceKind: string = 'unknown'): void {
    prepareOrCache(conn, 'INSERT INTO edges (container_def_id, referenced_name, reference_kind) VALUES (?, ?, ?)')
        .run(containerDefId, referencedName, referenceKind);
}

/**
 * SQL: DELETE FROM edges
 */
export function deleteAllEdges(conn: DbConnection): void {
    prepareOrCache(conn, 'DELETE FROM edges')
        .run();
}

// ---------------------------------------------------------------------------
// Versions Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT OR IGNORE INTO versions (symbol_name, file_path, original_text, session_id, created_at, line, text_hash) VALUES (?, ?, ?, ?, ?, ?, ?)
 */
export function snapshotVersion(
    conn: DbConnection,
    entry: {
        symbolName: string;
        filePath: string | null;
        text: string;
        sessionId: string;
        createdAt: number;
        line: number | null;
        textHash: string;
    }
): void {
    prepareOrCache(conn, 'INSERT OR IGNORE INTO versions (symbol_name, file_path, original_text, session_id, created_at, line, text_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(entry.symbolName, entry.filePath, entry.text, entry.sessionId, entry.createdAt, entry.line, entry.textHash);
}

/**
 * SQL: SELECT id, symbol_name, file_path, created_at, text_hash FROM versions WHERE symbol_name = ? AND session_id = ? [AND file_path = ?] ORDER BY created_at DESC
 */
export function getVersionHistory(
    conn: DbConnection,
    symbolName: string,
    sessionId: string,
    filePath?: string
): { id: number; symbol_name: string; file_path: string | null; created_at: number; text_hash: string | null }[] {
    let sql = 'SELECT id, symbol_name, file_path, created_at, text_hash FROM versions WHERE symbol_name = ? AND session_id = ?';
    const params: string[] = [symbolName, sessionId];
    if (filePath) {
        sql += ' AND file_path = ?';
        params.push(filePath);
    }
    sql += ' ORDER BY created_at DESC';
    return handle(conn)
        .prepare(sql)
        .all(...params) as { id: number; symbol_name: string; file_path: string | null; created_at: number; text_hash: string | null }[];
}

/**
 * SQL: SELECT original_text FROM versions WHERE id = ?
 */
export function getVersionText(conn: DbConnection, id: number): string | null {
    const row = prepareOrCache(conn, 'SELECT original_text FROM versions WHERE id = ?')
        .get(id) as { original_text: string } | undefined;
    return row?.original_text ?? null;
}

/**
 * SQL: SELECT original_text, symbol_name, session_id FROM versions WHERE id = ?
 */
export function getVersionMeta(conn: DbConnection, id: number): { original_text: string; symbol_name: string; session_id: string } | null {
    const row = prepareOrCache(conn, 'SELECT original_text, symbol_name, session_id FROM versions WHERE id = ?')
        .get(id) as { original_text: string; symbol_name: string; session_id: string } | undefined;
    return row ?? null;
}

/**
 * SQL: DELETE FROM versions WHERE created_at < ?
 */
export function pruneOldVersions(conn: DbConnection, beforeTimestamp: number): void {
    prepareOrCache(conn, 'DELETE FROM versions WHERE created_at < ?')
        .run(beforeTimestamp);
}

/**
 * SQL: DELETE FROM versions WHERE session_id != ?
 */
export function pruneOtherSessions(conn: DbConnection, keepSessionId: string): void {
    prepareOrCache(conn, 'DELETE FROM versions WHERE session_id != ?')
        .run(keepSessionId);
}

// ---------------------------------------------------------------------------
// Stash Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO stash (type, file_path, payload, attempts, created_at) VALUES (?, ?, ?, 0, ?)
 * Returns the inserted row id.
 */
export function insertStash(
    conn: DbConnection,
    entry: {
        type: string;
        filePath: string | null;
        payload: string;
        createdAt: number;
    }
): number {
    const result = prepareOrCache(conn, 'INSERT INTO stash (type, file_path, payload, attempts, created_at) VALUES (?, ?, ?, 0, ?)')
        .run(entry.type, entry.filePath, entry.payload, entry.createdAt);
    return Number(result.lastInsertRowid);
}

/**
 * SQL: SELECT * FROM stash WHERE id = ?
 */
export function getStash(
    conn: DbConnection,
    id: number
): { id: number; type: string; file_path: string | null; payload: string; attempts: number; created_at: number } | null {
    const row = prepareOrCache(conn, 'SELECT * FROM stash WHERE id = ?')
        .get(id) as { id: number; type: string; file_path: string | null; payload: string; attempts: number; created_at: number } | undefined;
    return row ?? null;
}

/**
 * SQL: SELECT attempts FROM stash WHERE id = ?
 */
export function getStashAttempts(conn: DbConnection, id: number): number | null {
    const row = prepareOrCache(conn, 'SELECT attempts FROM stash WHERE id = ?')
        .get(id) as { attempts: number } | undefined;
    return row?.attempts ?? null;
}

/**
 * SQL: UPDATE stash SET attempts = ? WHERE id = ?
 */
export function updateStashAttempts(conn: DbConnection, id: number, attempts: number): void {
    prepareOrCache(conn, 'UPDATE stash SET attempts = ? WHERE id = ?')
        .run(attempts, id);
}

/**
 * SQL: DELETE FROM stash WHERE id = ?
 */
export function deleteStash(conn: DbConnection, id: number): void {
    prepareOrCache(conn, 'DELETE FROM stash WHERE id = ?')
        .run(id);
}

/** Delete stash rows older than the supplied timestamp. */
export function pruneExpiredStash(conn: DbConnection, beforeTimestamp: number): number {
    return Number(prepareOrCache(conn, 'DELETE FROM stash WHERE created_at <= ?')
        .run(beforeTimestamp).changes);
}

export type StashListQuery = {
    filePath?: string;
    type?: string;
    sinceTimestamp?: number;
    /** 1-based inclusive newest-first start position. Defaults to 1. */
    start?: number;
    /** 1-based inclusive newest-first end position. Defaults to 10. */
    end?: number;
};

export type StashRow = {
    id: number;
    type: string;
    file_path: string | null;
    payload: string;
    attempts: number;
    created_at: number;
};

/**
 * Query stash rows newest-first using source-true 1-based inclusive positions.
 * No zero-based offset coordinate is exposed or accepted anywhere in this API.
 */
export function listStash(conn: DbConnection, query: StashListQuery = {}): StashRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (query.filePath) {
        clauses.push('file_path = ?');
        params.push(query.filePath);
    }
    if (query.type) {
        clauses.push('type = ?');
        params.push(query.type);
    }
    if (query.sinceTimestamp !== undefined) {
        clauses.push('created_at > ?');
        params.push(query.sinceTimestamp);
    }

    const start = Math.max(1, Math.trunc(query.start ?? 1));
    const end = Math.max(start, Math.trunc(query.end ?? 10));
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const sql = `
        WITH ranked AS (
            SELECT
                id, type, file_path, payload, attempts, created_at,
                ROW_NUMBER() OVER (ORDER BY id DESC) AS position
            FROM stash${where}
        )
        SELECT id, type, file_path, payload, attempts, created_at
        FROM ranked
        WHERE position BETWEEN ? AND ?
        ORDER BY position
    `;

    return prepareOrCache(conn, sql).all(...params, start, end) as StashRow[];
}

// ---------------------------------------------------------------------------
// Config Backups Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO config_backups (original_path, backup_content, created_at, expires_at) VALUES (?, ?, ?, ?)
 * Returns inserted row id.
 */
export function insertBackup(
    conn: DbConnection,
    entry: {
        originalPath: string;
        content: string;
        createdAt: string;
        expiresAt: string;
    }
): number {
    const result = prepareOrCache(conn, 'INSERT INTO config_backups (original_path, backup_content, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(entry.originalPath, entry.content, entry.createdAt, entry.expiresAt);
    return Number(result.lastInsertRowid);
}

/**
 * SQL: SELECT * FROM config_backups WHERE id = ?
 */
export function getBackup(
    conn: DbConnection,
    id: number
): { id: number; original_path: string; backup_content: string; created_at: string; expires_at: string } | null {
    const row = prepareOrCache(conn, 'SELECT * FROM config_backups WHERE id = ?')
        .get(id) as { id: number; original_path: string; backup_content: string; created_at: string; expires_at: string } | undefined;
    return row ?? null;
}

/**
 * SQL: DELETE FROM config_backups WHERE expires_at < ?
 */
export function pruneExpiredBackups(conn: DbConnection, now: string): number {
    return Number(prepareOrCache(conn, 'DELETE FROM config_backups WHERE expires_at < ?')
        .run(now).changes);
}

// ---------------------------------------------------------------------------
// Project Roots Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT OR REPLACE INTO project_roots (root_path, name, created_at) VALUES (?, ?, ?)
 */
export function upsertProjectRoot(
    conn: DbConnection,
    entry: {
        rootPath: string;
        name: string;
        createdAt: number;
    }
): void {
    prepareOrCache(conn, 'INSERT OR REPLACE INTO project_roots (root_path, name, created_at) VALUES (?, ?, ?)')
        .run(entry.rootPath, entry.name, entry.createdAt);
}

// ---------------------------------------------------------------------------
// Project Observations — detection telemetry for promotion decisions.
// Lives in the GLOBAL DB. Detection records what it saw; promotion policy
// (ProjectContext) reads the distinct-session count. This is the
// instrumentation that justifies (or refutes) each auto-promotion.
// ---------------------------------------------------------------------------

/**
 * Creates table: project_observations(root_path PK, method, first_seen,
 * last_seen, session_count, last_session_id)
 */
export function initObservationSchema(conn: DbConnection): void {
    handle(conn).exec(`
        CREATE TABLE IF NOT EXISTS project_observations (
            root_path TEXT PRIMARY KEY,
            method TEXT NOT NULL,
            first_seen INTEGER NOT NULL,
            last_seen INTEGER NOT NULL,
            session_count INTEGER NOT NULL DEFAULT 1,
            last_session_id TEXT NOT NULL
        );
    `);
}

/**
 * Record a detection of an unregistered project root and return the number
 * of DISTINCT sessions it has now been observed in. The distinct-session
 * approximation: the counter only increments when the recording session
 * differs from the last one recorded — repeat observations within one
 * session are idempotent.
 */
export function recordProjectObservation(
    conn: DbConnection,
    entry: { rootPath: string; method: string; sessionId: string; now?: number }
): number {
    const now = entry.now ?? Date.now();
    const existing = prepareOrCache(
        conn,
        'SELECT session_count, last_session_id FROM project_observations WHERE root_path = ?'
    ).get(entry.rootPath) as { session_count: number; last_session_id: string } | undefined;

    if (!existing) {
        prepareOrCache(
            conn,
            'INSERT INTO project_observations (root_path, method, first_seen, last_seen, session_count, last_session_id) VALUES (?, ?, ?, ?, 1, ?)'
        ).run(entry.rootPath, entry.method, now, now, entry.sessionId);
        return 1;
    }

    const count = existing.last_session_id === entry.sessionId
        ? existing.session_count
        : existing.session_count + 1;
    prepareOrCache(
        conn,
        'UPDATE project_observations SET method = ?, last_seen = ?, session_count = ?, last_session_id = ? WHERE root_path = ?'
    ).run(entry.method, now, count, entry.sessionId, entry.rootPath);
    return count;
}

/**
 * SQL: SELECT * FROM project_observations ORDER BY last_seen DESC
 */
export function listProjectObservations(conn: DbConnection): {
    root_path: string; method: string; first_seen: number;
    last_seen: number; session_count: number; last_session_id: string;
}[] {
    return prepareOrCache(conn, 'SELECT * FROM project_observations ORDER BY last_seen DESC')
        .all() as {
            root_path: string; method: string; first_seen: number;
            last_seen: number; session_count: number; last_session_id: string;
        }[];
}

// ---------------------------------------------------------------------------
// Transaction Support
// ---------------------------------------------------------------------------

/**
 * Wraps the provided function in a database transaction.
 * Supports nesting via SAVEPOINTs — inner calls don't start a new top-level transaction.
 * If the function throws, the transaction (or savepoint) is rolled back.
 */
export function runTransaction(conn: DbConnection, fn: () => void): void {
    const db = handle(conn);
    const depth = conn._txDepth;
    let started = false;
    conn._txDepth = depth + 1;
    try {
        if (depth === 0) {
            db.exec('BEGIN');
        } else {
            db.exec(`SAVEPOINT sp_${depth}`);
        }
        started = true;
        fn();
        if (depth === 0) {
            db.exec('COMMIT');
        } else {
            db.exec(`RELEASE sp_${depth}`);
        }
    } catch (e) {
        if (started && depth === 0) {
            db.exec('ROLLBACK');
        } else if (started) {
            db.exec(`ROLLBACK TO sp_${depth}`);
            db.exec(`RELEASE sp_${depth}`);
        }
        throw e;
    } finally {
        conn._txDepth = depth;
    }
}

// ---------------------------------------------------------------------------
// Raw Escape Hatch (for migrations or one-off DDL)
// ---------------------------------------------------------------------------

/**
 * Executes raw SQL with no return value. Use sparingly — only for DDL
 * or migrations that don't fit the above functions.
 */
export function execRaw(conn: DbConnection, sql: string): void {
    handle(conn).exec(sql);
}

/**
 * Executes a raw SQL query and returns all result rows.
 * Bypasses the statement cache to avoid pollution from ad-hoc queries.
 * Use ONLY in tests for assertions — production code should use dedicated adapter functions.
 */
export function queryRaw(conn: DbConnection, sql: string, ...params: any[]): ReturnType<StatementSync['all']> {
    return handle(conn).prepare(sql).all(...params);
}

// ---------------------------------------------------------------------------
// Symbol Extended Columns (v0 → v1)
// ---------------------------------------------------------------------------

/**
 * SQL: UPDATE symbols SET capture_tag = ?, body_hash = ?, parent_symbol_id = ?, visibility = ? WHERE id = ?
 */
export function updateSymbolExtras(
    conn: DbConnection,
    symbolId: number,
    extras: { captureTag?: string | null; bodyHash?: string | null; parentSymbolId?: number | null; visibility?: string | null }
): void {
    prepareOrCache(conn,
        'UPDATE symbols SET capture_tag = ?, body_hash = ?, parent_symbol_id = ?, visibility = ? WHERE id = ?'
    ).run(extras.captureTag ?? null, extras.bodyHash ?? null, extras.parentSymbolId ?? null, extras.visibility ?? null, symbolId);
}

// ---------------------------------------------------------------------------
// Symbol Structures Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT OR REPLACE INTO symbol_structures (symbol_id, params_json, return_text, decorators_json, modifiers_json, generics_text, parent_kind, parent_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
 */
export function insertSymbolStructure(
    conn: DbConnection,
    row: { symbolId: number; paramsJson: string; returnText: string | null; decoratorsJson: string; modifiersJson: string; genericsText: string | null; parentKind: string | null; parentName: string | null }
): void {
    prepareOrCache(conn,
        'INSERT OR REPLACE INTO symbol_structures (symbol_id, params_json, return_text, decorators_json, modifiers_json, generics_text, parent_kind, parent_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(row.symbolId, row.paramsJson, row.returnText, row.decoratorsJson, row.modifiersJson, row.genericsText, row.parentKind, row.parentName);
}

export interface SymbolStructureRow {
    symbol_id: number;
    params: string[];
    returnText: string | null;
    decorators: string[];
    modifiers: string[];
    genericsText: string | null;
    parentKind: string | null;
    parentName: string | null;
}

/**
 * SQL: SELECT * FROM symbol_structures WHERE symbol_id = ?
 */
export function getSymbolStructure(conn: DbConnection, symbolId: number): SymbolStructureRow | null {
    const row = prepareOrCache(conn, 'SELECT * FROM symbol_structures WHERE symbol_id = ?').get(symbolId) as {
        symbol_id: number;
        params_json: string;
        return_text: string | null;
        decorators_json: string;
        modifiers_json: string;
        generics_text: string | null;
        parent_kind: string | null;
        parent_name: string | null;
    } | undefined;
    if (!row) return null;
    return {
        symbol_id: row.symbol_id,
        params: JSON.parse(row.params_json || '[]'),
        returnText: row.return_text,
        decorators: JSON.parse(row.decorators_json || '[]'),
        modifiers: JSON.parse(row.modifiers_json || '[]'),
        genericsText: row.generics_text,
        parentKind: row.parent_kind,
        parentName: row.parent_name,
    };
}

/**
 * SQL: SELECT ss.*, s.file_path, s.line, s.end_line FROM symbol_structures ss JOIN symbols s ON s.id = ss.symbol_id WHERE s.name = ? AND s.kind = 'def' [AND s.type = ?]
 */
export function findSymbolStructuresByName(conn: DbConnection, name: string, kind?: string): Array<SymbolStructureRow & { file_path: string; line: number; end_line: number }> {
    let sql = `SELECT ss.*, s.file_path, s.line, s.end_line FROM symbol_structures ss JOIN symbols s ON s.id = ss.symbol_id WHERE s.name = ? AND s.kind = 'def'`;
    const params: string[] = [name];
    if (kind) { sql += ' AND s.type = ?'; params.push(kind); }
    // NOTE (v3 remediation): use prepareOrCache for uniformity with every other
    // adapter function in this file. Dynamic SQL is still cached — the cache key is
    // the final SQL string, so the 1-param and 2-param shapes get distinct slots.
    const rows = prepareOrCache(conn, sql).all(...params) as Array<{
        symbol_id: number;
        params_json: string;
        return_text: string | null;
        decorators_json: string;
        modifiers_json: string;
        generics_text: string | null;
        parent_kind: string | null;
        parent_name: string | null;
        file_path: string;
        line: number;
        end_line: number;
    }>;
    return rows.map(row => ({
        symbol_id: row.symbol_id,
        params: JSON.parse(row.params_json || '[]'),
        returnText: row.return_text,
        decorators: JSON.parse(row.decorators_json || '[]'),
        modifiers: JSON.parse(row.modifiers_json || '[]'),
        genericsText: row.generics_text,
        parentKind: row.parent_kind,
        parentName: row.parent_name,
        file_path: row.file_path,
        line: row.line,
        end_line: row.end_line,
    }));
}

// ---------------------------------------------------------------------------
// Anchors Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO anchors (symbol_id, kind, line, end_line, text) VALUES (?, ?, ?, ?, ?)
 */
export function insertAnchor(conn: DbConnection, row: { symbolId: number; kind: string; line: number; endLine?: number; text: string }): void {
    const endLine = row.endLine ?? row.line;
    prepareOrCache(conn, 'INSERT INTO anchors (symbol_id, kind, line, end_line, text) VALUES (?, ?, ?, ?, ?)').run(row.symbolId, row.kind, row.line, endLine, row.text);
}

/**
 * SQL: SELECT a.symbol_id, s.name AS symbol_name, a.kind, a.line, COALESCE(a.end_line, a.line) AS endLine, a.text FROM anchors a JOIN symbols s ON s.id = a.symbol_id WHERE s.file_path = ? ORDER BY a.line
 */
export function getAnchorsForFile(conn: DbConnection, filePath: string): Array<{ symbol_id: number; symbol_name: string; kind: string; line: number; endLine: number; text: string }> {
    return prepareOrCache(conn, `SELECT a.symbol_id, s.name AS symbol_name, a.kind, a.line, COALESCE(a.end_line, a.line) AS endLine, a.text FROM anchors a JOIN symbols s ON s.id = a.symbol_id WHERE s.file_path = ? ORDER BY a.line`).all(filePath) as Array<{ symbol_id: number; symbol_name: string; kind: string; line: number; endLine: number; text: string }>;
}

// ---------------------------------------------------------------------------
// Imports Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO imports (file_path, module, imported_names_json, line, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)
 */
export function insertImport(conn: DbConnection, row: { filePath: string; module: string; importedNamesJson: string; line: number; startLine?: number; endLine?: number }): void {
    const startLine = row.startLine ?? row.line;
    const endLine = row.endLine ?? row.line;
    prepareOrCache(conn, 'INSERT INTO imports (file_path, module, imported_names_json, line, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.filePath, row.module, row.importedNamesJson, row.line, startLine, endLine);
}

/**
 * SQL: SELECT module, imported_names_json, line, COALESCE(start_line, line) AS startLine, COALESCE(end_line, line) AS endLine FROM imports WHERE file_path = ? ORDER BY startLine, line
 */
export function getImportsForFile(conn: DbConnection, filePath: string): Array<{ module: string; importedNames: string[]; line: number; startLine: number; endLine: number }> {
    const rows = prepareOrCache(conn, 'SELECT module, imported_names_json, line, COALESCE(start_line, line) AS startLine, COALESCE(end_line, line) AS endLine FROM imports WHERE file_path = ? ORDER BY startLine, line').all(filePath) as Array<{ module: string; imported_names_json: string; line: number; startLine: number; endLine: number }>;
    return rows.map(r => ({ module: r.module, importedNames: JSON.parse(r.imported_names_json || '[]'), line: r.line, startLine: r.startLine, endLine: r.endLine }));
}

export type ImportBindingKind = 'named' | 'default' | 'namespace';

/**
 * SQL: INSERT INTO import_bindings (file_path, source, local_name, imported_name, import_kind, is_type_only, line, column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
 */
export function insertImportBinding(conn: DbConnection, row: { filePath: string; source: string; localName: string; importedName: string | null; importKind: ImportBindingKind; isTypeOnly: boolean; line: number; column: number }): void {
    prepareOrCache(conn, `INSERT INTO import_bindings
        (file_path, source, local_name, imported_name, import_kind, is_type_only, line, column)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.filePath, row.source, row.localName, row.importedName, row.importKind, row.isTypeOnly ? 1 : 0, row.line, row.column);
}

/**
 * SQL: SELECT source, local_name AS localName, imported_name AS importedName, import_kind AS importKind, is_type_only AS isTypeOnly, line, column FROM import_bindings WHERE file_path = ? ORDER BY line, column
 */
export function getImportBindingsForFile(conn: DbConnection, filePath: string): Array<{ source: string; localName: string; importedName: string | null; importKind: ImportBindingKind; isTypeOnly: boolean; line: number; column: number }> {
    const rows = prepareOrCache(conn,
        `SELECT source, local_name AS localName, imported_name AS importedName,
                import_kind AS importKind, is_type_only AS isTypeOnly, line, column
         FROM import_bindings
         WHERE file_path = ?
         ORDER BY line, column`
    ).all(filePath) as Array<{ source: string; localName: string; importedName: string | null; importKind: ImportBindingKind; isTypeOnly: number; line: number; column: number }>;
    return rows.map(r => ({
        source: r.source,
        localName: r.localName,
        importedName: r.importedName,
        importKind: r.importKind,
        isTypeOnly: r.isTypeOnly !== 0,
        line: r.line,
        column: r.column,
    }));
}

/**
 * SQL: SELECT DISTINCT file_path FROM imports WHERE module = ?
 */
export function getFilesImporting(conn: DbConnection, module: string): { file_path: string }[] {
    return prepareOrCache(conn, 'SELECT DISTINCT file_path FROM imports WHERE module = ?').all(module) as { file_path: string }[];
}

// ---------------------------------------------------------------------------
// Injections Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO injections (file_path, host_lang, injected_lang, start_line, end_line, start_byte, end_byte) VALUES (?, ?, ?, ?, ?, ?, ?)
 */
export function insertInjection(conn: DbConnection, row: { filePath: string; hostLang: string; injectedLang: string; startLine: number; endLine: number; startByte: number; endByte: number }): void {
    prepareOrCache(conn, 'INSERT INTO injections (file_path, host_lang, injected_lang, start_line, end_line, start_byte, end_byte) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.filePath, row.hostLang, row.injectedLang, row.startLine, row.endLine, row.startByte, row.endByte);
}

/**
 * SQL: SELECT host_lang, injected_lang, start_line, end_line, start_byte, end_byte FROM injections WHERE file_path = ?
 */
export function getInjectionsForFile(conn: DbConnection, filePath: string): Array<{ host_lang: string; injected_lang: string; start_line: number; end_line: number; start_byte: number; end_byte: number }> {
    return prepareOrCache(conn, 'SELECT host_lang, injected_lang, start_line, end_line, start_byte, end_byte FROM injections WHERE file_path = ?').all(filePath) as Array<{ host_lang: string; injected_lang: string; start_line: number; end_line: number; start_byte: number; end_byte: number }>;
}

// ---------------------------------------------------------------------------
// Local Scopes Table Operations
// ---------------------------------------------------------------------------

/**
 * SQL: INSERT INTO local_scopes (symbol_id, scope_kind, start_line, end_line, parameters_json, locals_json) VALUES (?, ?, ?, ?, ?, ?)
 */
export function insertLocalScope(conn: DbConnection, row: { symbolId: number | null; scopeKind: string; startLine: number; endLine: number; parametersJson: string; localsJson: string }): void {
    prepareOrCache(conn, 'INSERT INTO local_scopes (symbol_id, scope_kind, start_line, end_line, parameters_json, locals_json) VALUES (?, ?, ?, ?, ?, ?)').run(row.symbolId, row.scopeKind, row.startLine, row.endLine, row.parametersJson, row.localsJson);
}

/**
 * SQL: SELECT scope_kind, start_line, end_line, parameters_json, locals_json FROM local_scopes WHERE symbol_id = ?
 */
export function getLocalScopesForSymbol(conn: DbConnection, symbolId: number): Array<{ scope_kind: string; start_line: number; end_line: number; parameters: unknown[]; locals: unknown[] }> {
    const rows = prepareOrCache(conn, 'SELECT scope_kind, start_line, end_line, parameters_json, locals_json FROM local_scopes WHERE symbol_id = ?').all(symbolId) as Array<{ scope_kind: string; start_line: number; end_line: number; parameters_json: string; locals_json: string }>;
    return rows.map(r => ({ scope_kind: r.scope_kind, start_line: r.start_line, end_line: r.end_line, parameters: JSON.parse(r.parameters_json || '[]'), locals: JSON.parse(r.locals_json || '[]') }));
}

// ---------------------------------------------------------------------------
// Edge Resolution (callee_symbol_id)
// ---------------------------------------------------------------------------

/**
 * SQL: SELECT e.id, e.referenced_name FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE s.file_path = ? AND e.callee_symbol_id IS NULL
 */
export function getUnresolvedEdges(conn: DbConnection, filePath: string): Array<{ id: number; referenced_name: string }> {
    return prepareOrCache(conn, `SELECT e.id, e.referenced_name FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE s.file_path = ? AND e.callee_symbol_id IS NULL`).all(filePath) as Array<{ id: number; referenced_name: string }>;
}

/**
 * Whole-DB counterpart to getUnresolvedEdges (review #18, "Performance Is
 * Correctness"): returns EVERY unresolved edge in one query so the resolver can
 * sweep the entire database in a single pass instead of re-querying per file
 * (the N+1 the per-file loop caused). The "unresolved" predicate mirrors
 * getUnresolvedEdges exactly — `e.callee_symbol_id IS NULL` — minus the
 * per-file filter. The container symbol's file_path is projected as
 * `caller_file_path` so scope-aware resolution (#17) can prefer same-file
 * callees without a second query per edge.
 *
 * SQL: SELECT e.id, e.referenced_name, s.file_path AS caller_file_path FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE e.callee_symbol_id IS NULL
 */
export function getAllUnresolvedEdges(conn: DbConnection): Array<{ id: number; referenced_name: string; caller_file_path: string }> {
    return prepareOrCache(conn, `SELECT e.id, e.referenced_name, s.file_path AS caller_file_path FROM edges e JOIN symbols s ON s.id = e.container_def_id WHERE e.callee_symbol_id IS NULL`).all() as Array<{ id: number; referenced_name: string; caller_file_path: string }>;
}

/**
 * SQL: SELECT id FROM symbols WHERE name = ? AND kind = ? LIMIT 2
 * Returns the single matching id, or null if zero or more than one match.
 */
export function findSymbolByNameUnique(conn: DbConnection, name: string, kind: string): { id: number } | null {
    const rows = prepareOrCache(conn, 'SELECT id FROM symbols WHERE name = ? AND kind = ? LIMIT 2').all(name, kind) as { id: number }[];
    if (rows.length !== 1) return null;
    return rows[0] ?? null;
}

/**
 * Non-unique counterpart to findSymbolByNameUnique: returns EVERY def (or
 * other-kind) symbol matching `name`, with its id and file_path. No LIMIT — the
 * full candidate set is intentionally returned so Wave B's resolver (review
 * #16/#17) can do scope-aware and dot-qualified disambiguation in TypeScript
 * (e.g. prefer the same-file/module callee, or filter by parent == qualifier).
 *
 * SQL: SELECT id, file_path AS filePath FROM symbols WHERE name = ? AND kind = ?
 */
export function findDefsByName(conn: DbConnection, name: string, kind = 'def'): { id: number; filePath: string }[] {
    return prepareOrCache(conn, 'SELECT id, file_path AS filePath FROM symbols WHERE name = ? AND kind = ?')
        .all(name, kind) as { id: number; filePath: string }[];
}

/**
 * Look up the parent definition of a symbol via parent_symbol_id.
 * Used by resolve.ts to enforce the strict dot-qualified rule:
 *   "Foo.bar" only links if shortTarget(bar).parent.name === "Foo".
 * Returns null if the symbol has no parent or the parent row is missing.
 */
export function findSymbolParent(conn: DbConnection, symbolId: number): { id: number; name: string } | null {
    const row = prepareOrCache(conn,
        'SELECT p.id AS id, p.name AS name FROM symbols c JOIN symbols p ON p.id = c.parent_symbol_id WHERE c.id = ?'
    ).get(symbolId) as { id: number; name: string } | undefined;
    return row ?? null;
}

/**
 * SQL: UPDATE edges SET callee_symbol_id = ? WHERE id = ?
 */
export function updateEdgeCalleeSymbol(conn: DbConnection, edgeId: number, calleeSymbolId: number): void {
    prepareOrCache(conn, 'UPDATE edges SET callee_symbol_id = ? WHERE id = ?').run(calleeSymbolId, edgeId);
}

// ---------------------------------------------------------------------------
// Aggregate Facts Read (for TOON integration)
// ---------------------------------------------------------------------------

export interface FileFacts {
    // NOTE: defs carries `captureTag` so the compression seam can forward it to
    // zenith-toon without a second query. Sourced from the v0→v1 `capture_tag`
    // column on `symbols`.
    defs: Array<{ id: number; name: string; line: number; endLine: number; type: string | null; visibility: string | null; captureTag: string | null }>;
    references: Array<{ name: string; type: string | null; line: number; endLine: number; column: number }>;
    edges: Array<{ callerLine: number; calleeLine: number; callCount: number }>;
    referenceEdges: Array<{ callerLine: number; referencedName: string; referenceKind: string; referenceCount: number }>;
    anchors: Array<{ symbol_name: string; kind: string; line: number; endLine: number; text: string }>;
    imports: Array<{ module: string; importedNames: string[]; line: number; startLine: number; endLine: number }>;
    importBindings: Array<{ source: string; localName: string; importedName: string | null; importKind: ImportBindingKind; isTypeOnly: boolean; line: number; column: number }>;
    injections: Array<{ injected_lang: string; start_line: number; end_line: number }>;
    // CASING WARNING (C3): these fields are camelCase (scopeKind/startLine/endLine) and MUST stay
    // character-identical to compression.ts's `.map` reads in T4 AND to the SELECT aliases in
    // getFileFacts below. A snake_case alias on the query + a camelCase read = silently empty
    // scopes with NO build error and NO test error. scopes are camelCase end-to-end.
    scopes: Array<{ scopeKind: string; startLine: number; endLine: number }>;
}

export function getFileFacts(conn: DbConnection, filePath: string): FileFacts {
    const defs = prepareOrCache(conn,
        `SELECT id, name, line, end_line AS endLine, type, visibility, capture_tag AS captureTag
         FROM symbols WHERE file_path = ? AND kind = 'def' ORDER BY line`
    ).all(filePath) as FileFacts['defs'];
    const references = prepareOrCache(conn,
        `SELECT name, type, line, end_line AS endLine, column
         FROM symbols WHERE file_path = ? AND kind = 'ref' ORDER BY line, column`
    ).all(filePath) as FileFacts['references'];
    // Resolved, line-keyed edges (Phase 4): join BOTH endpoints to symbols — caller
    // via container_def_id, callee via the RESOLVED callee_symbol_id — and return each
    // endpoint's line. The INNER JOIN on callee_symbol_id drops still-unresolved edges
    // (NULL callee); callee.file_path = ? drops cross-file edges. Both exclusions are
    // intended: TOON ranks within-file structure. GROUP BY the two symbol IDENTITIES
    // (not names) so two distinct defs sharing a name can never collapse into one edge.
    const edges = prepareOrCache(conn,
        `SELECT caller.line AS callerLine, callee.line AS calleeLine, COUNT(e.id) AS callCount
         FROM edges e
         JOIN symbols caller ON caller.id = e.container_def_id
         JOIN symbols callee ON callee.id = e.callee_symbol_id
         WHERE caller.file_path = ? AND callee.file_path = ? AND caller.kind = 'def'
         GROUP BY caller.id, callee.id`
    ).all(filePath, filePath) as FileFacts['edges'];
    const referenceEdges = prepareOrCache(conn,
        `SELECT caller.line AS callerLine, e.referenced_name AS referencedName,
                e.reference_kind AS referenceKind, COUNT(e.id) AS referenceCount
         FROM edges e
         JOIN symbols caller ON caller.id = e.container_def_id
         WHERE caller.file_path = ? AND caller.kind = 'def'
         GROUP BY caller.id, e.referenced_name, e.reference_kind
         ORDER BY caller.line, e.referenced_name, e.reference_kind`
    ).all(filePath) as FileFacts['referenceEdges'];
    const anchors = prepareOrCache(conn, `SELECT s.name AS symbol_name, a.kind, a.line, COALESCE(a.end_line, a.line) AS endLine, a.text FROM anchors a JOIN symbols s ON s.id = a.symbol_id WHERE s.file_path = ? ORDER BY a.line`).all(filePath) as FileFacts['anchors'];
    const imports = getImportsForFile(conn, filePath);
    const importBindings = getImportBindingsForFile(conn, filePath);
    const injections = prepareOrCache(conn, `SELECT injected_lang, start_line, end_line FROM injections WHERE file_path = ?`).all(filePath) as FileFacts['injections'];
    // CASING WARNING (C3): the SELECT aliases below are camelCase (scopeKind/startLine/endLine) and
    // MUST match compression.ts's `.map` field reads in T4. A snake_case alias here + a camelCase
    // read there = silently empty scopes, NO build error. Do NOT "match injections' snake_case" —
    // scopes are camelCase end-to-end. Mirrors the anchors JOIN (s.id = a.symbol_id) above.
    // The JOIN symbols s ON s.id = ls.symbol_id intentionally excludes null-owner ("module") scopes:
    // persist.ts:80 never inserts a scope whose owning symbol does not resolve, so such rows do not
    // exist and have no symbol to join — module-level code legitimately gets no scope sub-blocks.
    // ORDER BY start_line, end_line gives deterministic tiling input downstream.
    const scopes = prepareOrCache(conn,
        `SELECT ls.scope_kind AS scopeKind, ls.start_line AS startLine, ls.end_line AS endLine
         FROM local_scopes ls
         JOIN symbols s ON s.id = ls.symbol_id
         WHERE s.file_path = ?
         ORDER BY ls.start_line, ls.end_line`
    ).all(filePath) as FileFacts['scopes'];
    return { defs, references, edges, referenceEdges, anchors, imports, importBindings, injections, scopes };
}

// ---------------------------------------------------------------------------
// Schema Version
// ---------------------------------------------------------------------------

/**
 * Reads the single-row schema_version table (review #5). The id=1 predicate is
 * the deterministic counterpart to the old LIMIT 1; both return the lone row now
 * that the table is single-row by construction.
 *
 * On a fresh, un-migrated database the schema_version table does not exist yet,
 * so the prepare/get below throws "no such table" (review #26, #37). Treat that
 * as version 0 — the un-migrated baseline — while rethrowing every other error
 * so genuine failures are never silently swallowed.
 *
 * SQL: SELECT version FROM schema_version WHERE id = 1
 */
export function getSchemaVersion(conn: DbConnection): number {
    try {
        const row = prepareOrCache(conn, 'SELECT version FROM schema_version WHERE id = 1').get() as { version: number } | undefined;
        return row?.version ?? 0;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('no such table')) return 0;
        throw e;
    }
}
