-- Product portfolio: which catalog product (src/products/catalog.json) each post relates to.
-- signal: 'tag' (blog tag), 'title' (title, or description + body mentions), 'body' (only mentioned: "Also mentioned in").
-- Product metadata stays in the bundled catalog; only the post links live here. Rebuilt whenever
-- settings.products_version differs from the deployed catalog + matcher version (see SyncWorkflow).
CREATE TABLE product_posts (
  product_slug TEXT NOT NULL,
  post_slug    TEXT NOT NULL,
  signal       TEXT NOT NULL CHECK (signal IN ('tag', 'title', 'body')),
  mentions     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_slug, post_slug)
) WITHOUT ROWID;
CREATE INDEX product_posts_post ON product_posts(post_slug);
INSERT INTO settings (key, value, updated_at) VALUES ('products_version', 'none', datetime('now'));
