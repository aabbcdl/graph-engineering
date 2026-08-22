// Package queue implements a bounded, priority-aware FIFO job queue.
package queue

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	// ErrClosed is returned when a queue cannot accept or provide more work.
	ErrClosed = errors.New("queue is closed")
	// ErrEmpty is returned only by TryDequeue when no job is currently ready.
	ErrEmpty = errors.New("queue is empty")
)

// Job is the serializable unit of work used throughout JobQueue.
type Job struct {
	ID          string            `json:"id"`
	Payload     string            `json:"payload"`
	Priority    int               `json:"priority"`
	Attempt     int               `json:"attempt"`
	MaxAttempts int               `json:"max_attempts"`
	RunAt       time.Time         `json:"run_at"`
	CreatedAt   time.Time         `json:"created_at"`
	Metadata    map[string]string `json:"metadata,omitempty"`
}

// Clone returns a caller-owned copy of a job, including metadata.
func (job Job) Clone() Job {
	clone := job
	if job.Metadata != nil {
		clone.Metadata = make(map[string]string, len(job.Metadata))
		for key, value := range job.Metadata {
			clone.Metadata[key] = value
		}
	}
	return clone
}

// Queue is safe for concurrent producers and consumers.
type Queue struct {
	mu       sync.Mutex
	jobs     []Job
	capacity int
	closed   bool
	changed  chan struct{}
}

// New creates a queue with the supplied positive capacity.
func New(capacity int) *Queue {
	if capacity < 1 {
		capacity = 1
	}
	return &Queue{capacity: capacity, changed: make(chan struct{})}
}

// Enqueue waits while the queue is full, then inserts job according to priority
// and FIFO order. The queue takes an independent copy of the input.
func (q *Queue) Enqueue(ctx context.Context, job Job) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if job.ID == "" {
		return fmt.Errorf("job id is required")
	}
	job = job.Clone()
	if job.CreatedAt.IsZero() {
		job.CreatedAt = time.Now().UTC()
	}
	for {
		q.mu.Lock()
		if q.closed {
			q.mu.Unlock()
			return ErrClosed
		}
		if len(q.jobs) < q.capacity {
			q.insertLocked(job)
			q.signalLocked()
			q.mu.Unlock()
			return nil
		}
		changed := q.changed
		q.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-changed:
		}
	}
}

func (q *Queue) insertLocked(job Job) {
	index := len(q.jobs)
	for position, existing := range q.jobs {
		if existing.Priority == job.Priority {
			index = position
			break
		}
		if existing.Priority > job.Priority {
			index = position
			break
		}
	}
	q.jobs = append(q.jobs, Job{})
	copy(q.jobs[index+1:], q.jobs[index:])
	q.jobs[index] = job
}

// Dequeue waits for a job, closure, or context cancellation.
func (q *Queue) Dequeue(ctx context.Context) (Job, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		q.mu.Lock()
		if len(q.jobs) > 0 {
			job := q.jobs[0].Clone()
			q.jobs = q.jobs[1:]
			q.signalLocked()
			q.mu.Unlock()
			return job, nil
		}
		if q.closed {
			q.mu.Unlock()
			return Job{}, ErrClosed
		}
		q.mu.Unlock()
		return Job{}, ErrEmpty
	}
}

// TryDequeue returns immediately when no job is available.
func (q *Queue) TryDequeue() (Job, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.jobs) == 0 {
		if q.closed {
			return Job{}, ErrClosed
		}
		return Job{}, ErrEmpty
	}
	job := q.jobs[0].Clone()
	q.jobs = q.jobs[1:]
	q.signalLocked()
	return job, nil
}

// Close rejects later producers and wakes all waiting callers.
func (q *Queue) Close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.closed = true
}

// Len reports the number of queued jobs.
func (q *Queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.jobs)
}

// Capacity reports the queue capacity.
func (q *Queue) Capacity() int {
	return q.capacity
}

// Snapshot returns independent copies in current dequeue order.
func (q *Queue) Snapshot() []Job {
	q.mu.Lock()
	defer q.mu.Unlock()
	return cloneJobs(q.jobs)
}

// Restore replaces the queued jobs with a caller-provided ordered snapshot.
func (q *Queue) Restore(jobs []Job) error {
	if len(jobs) > q.capacity {
		return fmt.Errorf("snapshot contains %d jobs but capacity is %d", len(jobs), q.capacity)
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return ErrClosed
	}
	q.jobs = cloneJobs(jobs)
	q.signalLocked()
	return nil
}

func (q *Queue) signalLocked() {
	close(q.changed)
	q.changed = make(chan struct{})
}

func cloneJobs(jobs []Job) []Job {
	clones := make([]Job, len(jobs))
	for index, job := range jobs {
		clones[index] = job.Clone()
	}
	return clones
}
