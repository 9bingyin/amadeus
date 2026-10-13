package tool

import "github.com/felinics/twilight/sdk"

type Result struct {
	Text    string          `json:"text"`
	Images  []sdk.ImagePart `json:"images,omitempty"`
	IsError bool            `json:"isError,omitempty"`
}
