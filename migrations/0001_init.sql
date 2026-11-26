CREATE TABLE posts (
  slug            TEXT PRIMARY KEY,
  url             TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  description     TEXT,
  image_url       TEXT,
  published_at    TEXT NOT NULL,
  updated_at      TEXT,
  year            INTEGER GENERATED ALWAYS AS (CAST(substr(published_at,1,4) AS INTEGER)) STORED,
  lastmod         TEXT,
  word_count      INTEGER,
  reading_minutes INTEGER,
  body_source     TEXT NOT NULL DEFAULT 'markdown',
  r2_key          TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'blog',
  deleted_at      TEXT,
  missing_runs    INTEGER NOT NULL DEFAULT 0,
  indexed_at      TEXT NOT NULL,
  checked_at      TEXT                       -- last time the consumer processed it (written or unchanged)
);
CREATE INDEX posts_published ON posts(published_at DESC);
CREATE INDEX posts_year ON posts(year);

CREATE TABLE authors (slug TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE tags    (slug TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE post_authors (post_slug TEXT REFERENCES posts(slug), author_slug TEXT REFERENCES authors(slug), PRIMARY KEY (post_slug, author_slug));
CREATE TABLE post_tags    (post_slug TEXT REFERENCES posts(slug), tag_slug    TEXT REFERENCES tags(slug),    PRIMARY KEY (post_slug, tag_slug));
CREATE INDEX post_tags_tag ON post_tags(tag_slug);
CREATE INDEX post_authors_author ON post_authors(author_slug);

CREATE VIRTUAL TABLE posts_fts USING fts5(
  slug UNINDEXED, title, description, tags, authors, body,
  tokenize = 'porter unicode61'
);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT, finished_at TEXT,
  discovered INTEGER, enqueued INTEGER, written INTEGER, failed INTEGER,
  dropped_locales TEXT,
  status TEXT
);
