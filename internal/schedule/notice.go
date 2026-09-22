package schedule

import (
	"fmt"
	"strings"
)

func jobIdentity(id int64, name string) string {
	return fmt.Sprintf("Schedule #%d %s", id, sanitizeMeta(name))
}

func sanitizeMeta(value string) string {
	value = strings.NewReplacer("[", " ", "]", " ", "\r", " ", "\n", " ").Replace(value)
	return strings.Join(strings.Fields(value), " ")
}
