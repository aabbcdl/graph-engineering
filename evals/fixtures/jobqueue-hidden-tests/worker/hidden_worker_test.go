package worker

import (
	"context"
	"errors"
	"testing"
	"time"

	"example.com/jobqueue/events"
	"example.com/jobqueue/queue"
	"example.com/jobqueue/retry"
)

func TestHiddenWorkerStopWaitsForOutstandingRetries(t *testing.T) {
	pool, err := New(queue.New(1), retry.Policy{BaseDelay: time.Millisecond, MaxDelay: time.Millisecond}, events.New(), 1, func(context.Context, queue.Job) error {
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Start(); err != nil {
		t.Fatal(err)
	}
	pool.retryWG.Add(1)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	err = pool.Stop(ctx)
	pool.retryWG.Done()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("stop got %v, want context deadline while retry remains outstanding", err)
	}
}
