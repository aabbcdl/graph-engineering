// Package worker executes queue jobs and schedules retry attempts.
package worker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"example.com/jobqueue/events"
	"example.com/jobqueue/queue"
	"example.com/jobqueue/retry"
)

var (
	// ErrStarted reports a second call to Start.
	ErrStarted = errors.New("worker pool has already been started")
	// ErrStopped reports an attempt to start a stopped pool.
	ErrStopped = errors.New("worker pool has been stopped")
)

// Handler performs one job attempt.
type Handler func(context.Context, queue.Job) error

// Pool owns a fixed worker set and delayed retry goroutines.
type Pool struct {
	queue   *queue.Queue
	policy  retry.Policy
	bus     *events.Bus
	handler Handler
	workers int

	mu      sync.Mutex
	started bool
	stopped bool
	cancel  context.CancelFunc

	workerWG sync.WaitGroup
	retryWG  sync.WaitGroup
	active   atomic.Int32
}

// New validates pool dependencies.
func New(jobs *queue.Queue, policy retry.Policy, bus *events.Bus, workers int, handler Handler) (*Pool, error) {
	if jobs == nil {
		return nil, fmt.Errorf("queue is required")
	}
	if err := policy.Validate(); err != nil {
		return nil, err
	}
	if bus == nil {
		return nil, fmt.Errorf("event bus is required")
	}
	if workers <= 0 {
		return nil, fmt.Errorf("workers must be positive")
	}
	if handler == nil {
		return nil, fmt.Errorf("handler is required")
	}
	return &Pool{queue: jobs, policy: policy, bus: bus, workers: workers, handler: handler}, nil
}

// Start launches exactly workers job consumers.
func (pool *Pool) Start() error {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if pool.stopped {
		return ErrStopped
	}
	if pool.started {
		return ErrStarted
	}
	ctx, cancel := context.WithCancel(context.Background())
	pool.started = true
	pool.cancel = cancel
	for index := 0; index < pool.workers; index++ {
		pool.workerWG.Add(1)
		go pool.run(ctx)
	}
	return nil
}

func (pool *Pool) run(ctx context.Context) {
	pool.active.Add(1)
	defer pool.active.Add(-1)
	defer pool.workerWG.Done()
	for {
		job, err := pool.queue.Dequeue(ctx)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, queue.ErrClosed) {
				return
			}
			continue
		}
		pool.bus.Publish(events.Event{Type: events.JobStarted, JobID: job.ID})
		if err := pool.handler(ctx, job); err != nil {
			next, delay, shouldRetry := pool.policy.Next(job)
			if shouldRetry {
				pool.bus.Publish(events.Event{Type: events.JobRetried, JobID: job.ID, Detail: err.Error()})
				pool.scheduleRetry(ctx, next, delay)
				continue
			}
			pool.bus.Publish(events.Event{Type: events.JobFailed, JobID: job.ID, Detail: err.Error()})
			continue
		}
		pool.bus.Publish(events.Event{Type: events.JobSucceeded, JobID: job.ID})
	}
}

func (pool *Pool) scheduleRetry(ctx context.Context, job queue.Job, delay time.Duration) {
	pool.retryWG.Add(1)
	go func() {
		defer pool.retryWG.Done()
		timer := time.NewTimer(delay)
		defer timer.Stop()
		<-timer.C
		if err := pool.queue.Enqueue(context.Background(), job); err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, queue.ErrClosed) {
			pool.bus.Publish(events.Event{Type: events.JobFailed, JobID: job.ID, Detail: err.Error()})
		}
	}()
}

// Stop waits for workers and scheduled retries to exit or for ctx to expire.
func (pool *Pool) Stop(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	pool.mu.Lock()
	if !pool.started {
		pool.stopped = true
		pool.mu.Unlock()
		return nil
	}
	if pool.stopped {
		pool.mu.Unlock()
		return nil
	}
	pool.stopped = true
	cancel := pool.cancel
	pool.mu.Unlock()
	cancel()
	done := make(chan struct{})
	go func() {
		pool.workerWG.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ActiveWorkers returns the number of worker goroutines currently running.
func (pool *Pool) ActiveWorkers() int {
	return int(pool.active.Load())
}
