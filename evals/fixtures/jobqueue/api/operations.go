package api

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"example.com/jobqueue/config"
	"example.com/jobqueue/queue"
)

var (
	// ErrNotQueued reports an operation that requires a queued job.
	ErrNotQueued = errors.New("job is not queued")
	// ErrInFlight reports that an operation cannot alter a job owned by a
	// worker. Callers should let the worker finish or use their own cancellation
	// mechanism in the job payload.
	ErrInFlight = errors.New("job is in flight")
)

// JobState is the API-visible lifecycle state of a job.
type JobState string

const (
	Queued   JobState = "queued"
	InFlight JobState = "in_flight"
)

// JobView combines a caller-owned job copy with its current state.
type JobView struct {
	Job   queue.Job
	State JobState
}

// List returns every queued and in-flight job in a deterministic state/ID
// order. Completed jobs are intentionally not retained by this lightweight
// service API.
func (service *Service) List() []JobView {
	queued := service.queue.Snapshot()
	views := make([]JobView, 0, len(queued))
	for _, job := range queued {
		views = append(views, JobView{Job: job.Clone(), State: Queued})
	}
	service.mu.Lock()
	for _, job := range service.inFlight {
		views = append(views, JobView{Job: job.Clone(), State: InFlight})
	}
	service.mu.Unlock()
	sort.Slice(views, func(left, right int) bool {
		if views[left].State == views[right].State {
			return views[left].Job.ID < views[right].Job.ID
		}
		return views[left].State < views[right].State
	})
	return views
}

// Cancel removes a queued job. An in-flight job is deliberately protected from
// removal because a worker may already have side effects in progress.
func (service *Service) Cancel(ctx context.Context, id string) (queue.Job, error) {
	if id == "" {
		return queue.Job{}, fmt.Errorf("job id is required")
	}
	service.mu.Lock()
	_, inFlight := service.inFlight[id]
	service.mu.Unlock()
	if inFlight {
		return queue.Job{}, ErrInFlight
	}
	job, removed := service.queue.Remove(id)
	if !removed {
		return queue.Job{}, ErrNotQueued
	}
	if err := service.persist(ctx); err != nil {
		return queue.Job{}, err
	}
	return job, nil
}

// Schedule accepts a normal enqueue request but keeps the job out of the
// immediate queue until at. It returns the same job shape that Enqueue uses.
func (service *Service) Schedule(ctx context.Context, request EnqueueRequest, at time.Time) (queue.Job, error) {
	if request.ID == "" {
		return queue.Job{}, fmt.Errorf("job id is required")
	}
	if err := ctxErr(ctx); err != nil {
		return queue.Job{}, err
	}
	job := queue.Job{
		ID:          request.ID,
		Payload:     request.Payload,
		Priority:    request.Priority,
		MaxAttempts: service.config.MaxRetries,
		CreatedAt:   time.Now().UTC(),
		RunAt:       at,
		Metadata:    cloneMetadata(request.Metadata),
	}
	if err := service.scheduler.Schedule(job, at); err != nil {
		return queue.Job{}, err
	}
	return job.Clone(), nil
}

// Recover replaces queued state from the persisted snapshot. It refuses to
// discard in-flight work because that state belongs to active callers.
func (service *Service) Recover(ctx context.Context) error {
	if err := ctxErr(ctx); err != nil {
		return err
	}
	service.mu.Lock()
	inFlight := len(service.inFlight)
	service.mu.Unlock()
	if inFlight != 0 {
		return ErrInFlight
	}
	jobs, err := service.store.Load(ctx)
	if err != nil {
		return err
	}
	return service.queue.Restore(jobs)
}

// WaitForIdle blocks until no immediate or in-flight job remains. Scheduled
// future jobs are not included because they have not yet entered the queue.
func (service *Service) WaitForIdle(ctx context.Context, interval time.Duration) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if interval <= 0 {
		interval = 10 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		stats := service.Stats()
		if stats.Queued == 0 && stats.InFlight == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// Configuration returns the normalized configuration used to create the
// service. Config is value-based, so callers cannot mutate service state.
func (service *Service) Configuration() config.Config {
	return service.config
}

func ctxErr(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	return ctx.Err()
}
