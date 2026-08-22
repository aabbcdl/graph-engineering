package worker

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"example.com/jobqueue/events"
	"example.com/jobqueue/queue"
	"example.com/jobqueue/retry"
)

func TestPoolProcessesAJob(t *testing.T) {
	q := queue.New(2)
	var calls atomic.Int32
	pool, err := New(q, retry.Policy{BaseDelay: time.Millisecond, MaxDelay: time.Millisecond}, events.New(), 1, func(context.Context, queue.Job) error {
		calls.Add(1)
		return nil
	})
	if err != nil {
		t.Fatalf("new pool: %v", err)
	}
	if err := pool.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := q.Enqueue(context.Background(), queue.Job{ID: "job-1"}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if calls.Load() != 1 {
		t.Fatalf("handler was not called")
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := pool.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
}
