package worker

import (
	"context"
	"sync"
	"time"

	"example.com/jobqueue/queue"
)

// Outcome describes the result of one handler invocation.
type Outcome string

const (
	Succeeded Outcome = "succeeded"
	Failed    Outcome = "failed"
	Canceled  Outcome = "canceled"
)

// Attempt records one completed handler call for operations and diagnostics.
type Attempt struct {
	JobID    string
	Outcome  Outcome
	Started  time.Time
	Finished time.Time
	Error    string
}

// Duration returns the elapsed wall time of the attempt. A malformed record
// produces zero rather than a negative duration.
func (attempt Attempt) Duration() time.Duration {
	if attempt.Finished.Before(attempt.Started) {
		return 0
	}
	return attempt.Finished.Sub(attempt.Started)
}

// Metrics is a concurrency-safe bounded history plus aggregate counters.
type Metrics struct {
	mu       sync.Mutex
	capacity int
	history  []Attempt
	started  uint64
	success  uint64
	failure  uint64
	canceled uint64
}

// MetricsSnapshot is an immutable caller-owned metrics view.
type MetricsSnapshot struct {
	Started   uint64
	Succeeded uint64
	Failed    uint64
	Canceled  uint64
	History   []Attempt
}

// NewMetrics creates a bounded attempt tracker.
func NewMetrics(capacity int) *Metrics {
	if capacity < 1 {
		capacity = 1
	}
	return &Metrics{capacity: capacity}
}

// Record adds an attempt and updates aggregate counters.
func (metrics *Metrics) Record(attempt Attempt) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.started++
	switch attempt.Outcome {
	case Succeeded:
		metrics.success++
	case Canceled:
		metrics.canceled++
	default:
		metrics.failure++
	}
	if len(metrics.history) == metrics.capacity {
		copy(metrics.history, metrics.history[1:])
		metrics.history[len(metrics.history)-1] = attempt
	} else {
		metrics.history = append(metrics.history, attempt)
	}
}

// Snapshot returns aggregate counters and a caller-owned history copy.
func (metrics *Metrics) Snapshot() MetricsSnapshot {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	return MetricsSnapshot{
		Started:   metrics.started,
		Succeeded: metrics.success,
		Failed:    metrics.failure,
		Canceled:  metrics.canceled,
		History:   append([]Attempt(nil), metrics.history...),
	}
}

// Reset clears both counters and retained history.
func (metrics *Metrics) Reset() {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.started = 0
	metrics.success = 0
	metrics.failure = 0
	metrics.canceled = 0
	metrics.history = nil
}

// Instrument wraps a handler and records every completed invocation. It does
// not alter the handler's return value or cancellation semantics.
func Instrument(handler Handler, metrics *Metrics) Handler {
	if handler == nil || metrics == nil {
		return handler
	}
	return func(ctx context.Context, job queue.Job) error {
		started := time.Now().UTC()
		err := handler(ctx, job)
		outcome := Succeeded
		if ctx != nil && ctx.Err() != nil {
			outcome = Canceled
		} else if err != nil {
			outcome = Failed
		}
		attempt := Attempt{JobID: job.ID, Outcome: outcome, Started: started, Finished: time.Now().UTC()}
		if err != nil {
			attempt.Error = err.Error()
		}
		metrics.Record(attempt)
		return err
	}
}

// SuccessRate returns completed successes divided by all observed attempts.
// It returns zero before any handler invocation.
func (snapshot MetricsSnapshot) SuccessRate() float64 {
	if snapshot.Started == 0 {
		return 0
	}
	return float64(snapshot.Succeeded) / float64(snapshot.Started)
}
