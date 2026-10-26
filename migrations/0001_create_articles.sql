-- News articles collected by the News Intelligence App
CREATE TABLE IF NOT EXISTS articles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  topic            TEXT    NOT NULL,
  headline         TEXT    NOT NULL,
  source           TEXT,
  published_at     TEXT,
  url              TEXT    NOT NULL UNIQUE,
  ai_summary       TEXT,
  relevance_score  INTEGER CHECK (relevance_score BETWEEN 1 AND 10),
  fetched_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_articles_topic_published ON articles (topic, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_relevance ON articles (relevance_score DESC);
