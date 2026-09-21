package agent

import (
	"context"
	"errors"
	"sync/atomic"

	"github.com/felinics/twilight/sdk"
)

var ErrRequestSuperseded = errors.New("model request was superseded by newer input")

type requestFailureError struct {
	inputRevision int64
	err           error
}

func (e *requestFailureError) Error() string {
	return e.err.Error()
}

func (e *requestFailureError) Unwrap() error {
	return e.err
}

func RequestFailureInputRevision(err error) (int64, bool) {
	failure, ok := errors.AsType[*requestFailureError](err)
	if !ok {
		return 0, false
	}
	return failure.inputRevision, true
}

type requestState struct {
	conversation StoredConversation
	revision     atomic.Int64
	sequence     atomic.Int64
}

func (s *requestState) setRevision(revision int64) {
	s.revision.Store(revision)
}

type interruptibleRequestProvider struct {
	sdk.Provider
	state *requestState
}

func (p interruptibleRequestProvider) DoGenerate(
	ctx context.Context,
	params sdk.GenerateParams,
) (*sdk.GenerateResult, error) {
	inputRevision := p.state.revision.Load()
	requestSequence := p.state.sequence.Add(1)
	requestCtx, cancel := context.WithCancelCause(ctx)
	done := make(chan struct{})
	go func() {
		select {
		case <-p.state.conversation.WatchInput(inputRevision):
			cancel(ErrRequestSuperseded)
		case <-done:
		case <-ctx.Done():
		}
	}()

	result, err := p.Provider.DoGenerate(requestCtx, params)
	close(done)
	cancel(nil)
	if err != nil {
		if ctx.Err() != nil {
			return nil, err
		}
		current, currentErr := p.state.conversation.InputCurrent(ctx, inputRevision)
		if currentErr != nil {
			return nil, currentErr
		}
		if !current || errors.Is(context.Cause(requestCtx), ErrRequestSuperseded) {
			return nil, ErrRequestSuperseded
		}
		return nil, &requestFailureError{inputRevision: inputRevision, err: err}
	}
	admitted, err := p.state.conversation.AdmitResponse(
		ctx, requestSequence, inputRevision,
	)
	if err != nil {
		return nil, err
	}
	if !admitted {
		return nil, ErrRequestSuperseded
	}
	return result, nil
}

func modelWithInterrupts(model *sdk.Model, state *requestState) *sdk.Model {
	wrapped := *model
	wrapped.Provider = interruptibleRequestProvider{Provider: model.Provider, state: state}
	return &wrapped
}
