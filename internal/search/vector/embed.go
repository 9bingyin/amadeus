package vector

import (
	"context"
	"errors"

	"github.com/felinics/twilight/sdk"
)

type ModelEmbedder struct {
	model *sdk.EmbeddingModel
}

func NewModelEmbedder(model *sdk.EmbeddingModel) (*ModelEmbedder, error) {
	if model == nil || model.Provider == nil || model.ID == "" {
		return nil, errors.New("embedding model is required")
	}
	return &ModelEmbedder{model: model}, nil
}

func (e *ModelEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
	values, err := sdk.Embed(ctx, text, sdk.WithEmbeddingModel(e.model))
	if err != nil {
		return nil, err
	}
	if len(values) == 0 {
		return nil, errors.New("embedding response is empty")
	}
	embedding := make([]float32, len(values))
	for index, value := range values {
		embedding[index] = float32(value)
	}
	return embedding, nil
}
