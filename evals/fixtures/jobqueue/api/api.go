// Package api exposes the queue, persistence, worker, and scheduler through a
// small application-facing service.
package api

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"example.com/jobqueue/config"
	"example.com/jobqueue/events"
	"example.com/jobqueue/queue"
	"example.com/jobqueue/retry"
	"example.com/jobqueue/scheduler"
	"example.com/jobqueue/store"
	"example.com/jobqueue/worker"
)

// ErrUnknownJob is returned by Ack when an ID is not currently in flight.
var ErrUnknownJob = errors.New("job is not in flight")

// EnqueueRequest is the caller-owned job input form.
type EnqueueRequest struct {
	ID       string
	Payload  string
	Priority int
	Metadata map[string]string
}

// Stats summarizes current API-visible queue state.
type Stats struct {
	Capacity    int
	Queued      int
	InFlight    int
	Completed   int
	Utilization float64
}

// Service composes all JobQueue components.
type Service struct {
	config    config.Config
	queue     *queue.Queue
	store     *store.FileStore
	bus       *events.Bus
	workers   *worker.Pool
	scheduler *scheduler.Scheduler

	mu        sync.Mutex
	inFlight  map[string]queue.Job
	completed int
}

// New constructs a service and restores any persisted queued jobs.
func New(raw config.Config, handler worker.Handler) (*Service, error) {
	settings := raw.Normalize()
	if err := settings.Validate(); err != nil {
		return nil, err
	}
	jobs := queue.New(settings.QueueCapacity)
	bus := events.New()
	persistence := store.New(settings.StoragePath)
	restored, err := persistence.Load(context.Background())
	if err != nil {
		return nil, err
	}
	if err := jobs.Restore(restored); err != nil {
		return nil, err
	}
	pool, err := worker.New(jobs, retry.Policy{BaseDelay: settings.RetryBase, MaxDelay: settings.RetryMax}, bus, settings.Workers, handler)
	if err != nil {
		return nil, err
	}
	return &Service{
		config:    settings,
		queue:     jobs,
		store:     persistence,
		bus:       bus,
		workers:   pool,
		scheduler: scheduler.New(jobs, settings.SchedulerTick),
		inFlight:  make(map[string]queue.Job),
	}, nil
}

// Start launches the worker pool and scheduler.
func (service *Service) Start() error {
	if err := service.workers.Start(); err != nil {
		return err
	}
	if err := service.scheduler.Start(context.Background()); err != nil {
		return err
	}
	return nil
}

// Stop stops scheduler and workers without closing the recoverable queue.
func (service *Service) Stop(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := service.scheduler.Stop(ctx); err != nil {
		return err
	}
	return service.workers.Stop(ctx)
}

// Enqueue records a new job using the configured retry limit.
func (service *Service) Enqueue(ctx context.Context, request EnqueueRequest) (queue.Job, error) {
	if request.ID == "" {
		return queue.Job{}, fmt.Errorf("job id is required")
	}
	job := queue.Job{
		ID:          request.ID,
		Payload:     request.Payload,
		Priority:    request.Priority,
		MaxAttempts: service.config.MaxRetries,
		CreatedAt:   time.Now().UTC(),
		Metadata:    cloneMetadata(request.Metadata),
	}
	if err := service.queue.Enqueue(ctx, job); err != nil {
		return queue.Job{}, err
	}
	if err := service.persist(ctx); err != nil {
		return queue.Job{}, err
	}
	service.bus.Publish(events.Event{Type: events.JobEnqueued, JobID: job.ID})
	return job.Clone(), nil
}

// Dequeue moves the next queue item to in-flight state.
func (service *Service) Dequeue(ctx context.Context) (queue.Job, error) {
	job, err := service.queue.Dequeue(ctx)
	if err != nil {
		return queue.Job{}, err
	}
	service.mu.Lock()
	service.inFlight[job.ID] = job.Clone()
	service.mu.Unlock()
	if err := service.persist(ctx); err != nil {
		return queue.Job{}, err
	}
	return job.Clone(), nil
}

// Ack records successful completion of an in-flight job.
func (service *Service) Ack(ctx context.Context, id string) error {
	service.mu.Lock()
	job, found := service.inFlight[id]
	service.mu.Unlock()
	if !found {
		return nil
	}
	service.mu.Lock()
	delete(service.inFlight, id)
	service.completed++
	service.mu.Unlock()
	service.bus.Publish(events.Event{Type: events.JobAcknowledged, JobID: job.ID})
	return service.persist(ctx)
}

// Stats returns a coherent API-visible snapshot.
func (service *Service) Stats() Stats {
	queued := service.queue.Len()
	capacity := service.queue.Capacity()
	service.mu.Lock()
	inFlight := len(service.inFlight)
	completed := service.completed
	service.mu.Unlock()
	return Stats{
		Capacity:    capacity,
		Queued:      queued,
		InFlight:    inFlight,
		Completed:   completed,
		Utilization: float64(inFlight) / float64(capacity),
	}
}

// Events returns the service event bus for subscriptions.
func (service *Service) Events() *events.Bus {
	return service.bus
}

// ScheduleRetry delegates a duration-valued retry delay to the scheduler.
func (service *Service) ScheduleRetry(job queue.Job, delay time.Duration) error {
	return service.scheduler.ScheduleRetry(job, delay)
}

func (service *Service) persist(ctx context.Context) error {
	return service.store.Save(ctx, service.queue.Snapshot())
}

func cloneMetadata(metadata map[string]string) map[string]string {
	if metadata == nil {
		return nil
	}
	clone := make(map[string]string, len(metadata))
	for key, value := range metadata {
		clone[key] = value
	}
	return clone
}
