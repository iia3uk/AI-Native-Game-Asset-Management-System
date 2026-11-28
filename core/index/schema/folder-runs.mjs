export const folderRunsSchema = `
  CREATE TABLE IF NOT EXISTS folder_run (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('running', 'cleanup', 'reviewing', 'done', 'cancelled', 'failed')),
    state TEXT NOT NULL CHECK (json_valid(state))
  ) STRICT;
`
