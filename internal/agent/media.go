package agent

import (
	"mime"
	"strings"
)

var nativeImageMediaTypes = map[string]struct{}{
	"image/gif":  {},
	"image/jpeg": {},
	"image/jpg":  {},
	"image/png":  {},
	"image/webp": {},
}

var nativeFileMediaTypes = map[string]struct{}{
	"application/json":                        {},
	"application/msword":                      {},
	"application/pdf":                         {},
	"application/rtf":                         {},
	"application/vnd.ms-excel":                {},
	"application/vnd.ms-powerpoint":           {},
	"application/vnd.oasis.opendocument.text": {},
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": {},
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         {},
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":   {},
	"application/xml": {},
	"text/csv":        {},
	"application/csv": {},
	"text/html":       {},
	"text/markdown":   {},
	"text/plain":      {},
	"text/xml":        {},
}

func canonicalMediaType(value string) string {
	parsed, _, err := mime.ParseMediaType(strings.TrimSpace(value))
	if err != nil {
		return strings.ToLower(strings.TrimSpace(value))
	}
	return strings.ToLower(parsed)
}

func IsNativeImageMediaType(value string) bool {
	_, ok := nativeImageMediaTypes[canonicalMediaType(value)]
	return ok
}

func IsNativeFileMediaType(value string) bool {
	_, ok := nativeFileMediaTypes[canonicalMediaType(value)]
	return ok
}

func NativeAttachmentKind(value string) (AttachmentKind, bool) {
	mediaType := canonicalMediaType(value)
	if _, ok := nativeImageMediaTypes[mediaType]; ok {
		return AttachmentKindImage, true
	}
	if _, ok := nativeFileMediaTypes[mediaType]; ok {
		return AttachmentKindFile, true
	}
	return "", false
}
