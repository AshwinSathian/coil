-- One row per player per UTC day: their best verified Daily run.
CREATE TABLE runs (
  day TEXT NOT NULL,
  player TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  length INTEGER NOT NULL,
  ticks INTEGER NOT NULL,
  replay TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (day, player)
);
CREATE INDEX runs_day_score ON runs (day, score DESC, created);
