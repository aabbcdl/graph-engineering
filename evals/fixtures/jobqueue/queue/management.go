package queue

import (
	"context"
	"fmt"
	"time"
)

// Peek returns the next job without removing it.
func (q *Queue) Peek() (Job, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.jobs) == 0 {
		if q.closed {
			return Job{}, ErrClosed
		}
		return Job{}, ErrEmpty
	}
	return q.jobs[0].Clone(), nil
}

// Contains reports whether a queued job has id.
func (q *Queue) Contains(id string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.indexLocked(id) >= 0
}

// Remove deletes a queued job by ID and returns an independent copy. It does
// not affect jobs that have already been dequeued by another consumer.
func (q *Queue) Remove(id string) (Job, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	index := q.indexLocked(id)
	if index < 0 {
		return Job{}, false
	}
	job := q.jobs[index].Clone()
	copy(q.jobs[index:], q.jobs[index+1:])
	q.jobs[len(q.jobs)-1] = Job{}
	q.jobs = q.jobs[:len(q.jobs)-1]
	q.signalLocked()
	return job, true
}

// Drain removes and returns every queued job in dequeue order.
func (q *Queue) Drain() []Job {
	q.mu.Lock()
	defer q.mu.Unlock()
	jobs := cloneJobs(q.jobs)
	for index := range q.jobs {
		q.jobs[index] = Job{}
	}
	q.jobs = nil
	q.signalLocked()
	return jobs
}

// EnqueueBatch reserves capacity for every job before adding any of them. The
// operation is all-or-nothing with respect to queue capacity and context
// cancellation.
func (q *Queue) EnqueueBatch(ctx context.Context, jobs []Job) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if len(jobs) == 0 {
		return nil
	}
	if len(jobs) > q.capacity {
		return fmt.Errorf("batch of %d jobs exceeds capacity %d", len(jobs), q.capacity)
	}
	clones := make([]Job, len(jobs))
	for index, job := range jobs {
		if job.ID == "" {
			return fmt.Errorf("job %d has no id", index)
		}
		clones[index] = job.Clone()
		if clones[index].CreatedAt.IsZero() {
			clones[index].CreatedAt = time.Now().UTC()
		}
	}
	for {
		q.mu.Lock()
		if q.closed {
			q.mu.Unlock()
			return ErrClosed
		}
		if q.capacity-len(q.jobs) >= len(clones) {
			for _, job := range clones {
				q.insertLocked(job)
			}
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

// WaitUntilEmpty blocks until no queued jobs remain, closure occurs, or ctx is
// canceled. It is useful for maintenance tasks that do not own worker state.
func (q *Queue) WaitUntilEmpty(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		q.mu.Lock()
		if len(q.jobs) == 0 {
			q.mu.Unlock()
			return nil
		}
		if q.closed {
			q.mu.Unlock()
			return ErrClosed
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

// IsClosed reports whether Close has been called.
func (q *Queue) IsClosed() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.closed
}

func (q *Queue) indexLocked(id string) int {
	for index, job := range q.jobs {
		if job.ID == id {
			return index
		}
	}
	return -1
}
