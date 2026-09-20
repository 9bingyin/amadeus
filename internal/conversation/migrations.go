package conversation

import "embed"

//go:embed migrations/*.sql
var migrationFiles embed.FS
