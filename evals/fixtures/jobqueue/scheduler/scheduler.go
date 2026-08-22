// Package scheduler moves delayed jobs into a queue at deterministic times.
package scheduler

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"example.com/jobqueue/queue"
)

var (
	// ErrStarted reports that Start was called more than once.
	ErrStarted = errors.New("scheduler has already been started")
	// ErrStopped reports an attempt to start a stopped scheduler.
	ErrStopped = errors.New("scheduler has been stopped")
)

type ticker interface {
	Chan() <-chan time.Time
	Stop()
}

type standardTicker struct {
	inner *time.Ticker
}

func (ticker standardTicker) Chan() <-chan time.Time { return ticker.inner.C }
func (ticker standardTicker) Stop()                  { ticker.inner.Stop() }

var newTicker = func(interval time.Duration) ticker {
	return standardTicker{inner: time.NewTicker(interval)}
}

type delayedJob struct {
	job      queue.Job
	at       time.Time
	sequence uint64
}

// Scheduler owns delayed work and a single optional ticker loop.
type Scheduler struct {
	queue *queue.Queue
	tick  time.Duration

	mu      sync.Mutex
	clock   func() time.Time
	pending []delayedJob
	nextSeq uint64
	started bool
	stopped bool
	cancel  context.CancelFunc
	ticker  ticker
	workers sync.WaitGroup
}

// New creates a scheduler that emits jobs into jobs.
func New(jobs *queue.Queue, interval time.Duration) *Scheduler {
	if interval <= 0 {
		interval = 100 * time.Millisecond
	}
	return &Scheduler{queue: jobs, tick: interval, clock: func() time.Time { return time.Now().UTC() }}
}

// SetClock supplies a deterministic clock for tests and controlled callers.
func (scheduler *Scheduler) SetClock(clock func() time.Time) {
	if clock == nil {
		return
	}
	scheduler.mu.Lock()
	scheduler.clock = clock
	scheduler.mu.Unlock()
}

// Schedule stores a job until at. A job is never made available early.
func (scheduler *Scheduler) Schedule(job queue.Job, at time.Time) error {
	if scheduler.queue == nil {
		return fmt.Errorf("queue is required")
	}
	if job.ID == "" {
		return fmt.Errorf("job id is required")
	}
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	job = job.Clone()
	job.RunAt = at
	scheduler.pending = append(scheduler.pending, delayedJob{job: job, at: at, sequence: scheduler.nextSeq})
	scheduler.nextSeq++
	sort.SliceStable(scheduler.pending, func(left, right int) bool {
		if scheduler.pending[left].at.Equal(scheduler.pending[right].at) {
			return scheduler.pending[left].sequence < scheduler.pending[right].sequence
		}
		return scheduler.pending[left].at.Before(scheduler.pending[right].at)
	})
	return nil
}

// ScheduleRetry stores a retry at now plus delay.
func (scheduler *Scheduler) ScheduleRetry(job queue.Job, delay time.Duration) error {
	scheduler.mu.Lock()
	now := scheduler.clock()
	scheduler.mu.Unlock()
	return scheduler.Schedule(job, now.Add(time.Duration(delay.Milliseconds())))
}

// Tick sends all due jobs to the queue in scheduled order.
func (scheduler *Scheduler) Tick(ctx context.Context, now time.Time) error {
	if ctx == nil {
		ctx = context.Background()
	}
	scheduler.mu.Lock()
	cutoff := 0
	for cutoff < len(scheduler.pending) && !scheduler.pending[cutoff].at.After(now) {
		cutoff++
	}
	due := append([]delayedJob(nil), scheduler.pending[:cutoff]...)
	scheduler.pending = append([]delayedJob(nil), scheduler.pending[cutoff:]...)
	scheduler.mu.Unlock()
	for _, item := range due {
		if err := scheduler.queue.Enqueue(ctx, item.job); err != nil {
			return err
		}
	}
	return nil
}

// Start creates the one ticker loop owned by the scheduler.
func (scheduler *Scheduler) Start(parent context.Context) error {
	if parent == nil {
		parent = context.Background()
	}
	scheduler.mu.Lock()
	if scheduler.stopped {
		scheduler.mu.Unlock()
		return ErrStopped
	}
	ctx, cancel := context.WithCancel(parent)
	tick := newTicker(scheduler.tick)
	scheduler.started = true
	scheduler.cancel = cancel
	scheduler.ticker = tick
	scheduler.workers.Add(1)
	scheduler.mu.Unlock()
	go scheduler.loop(ctx, tick)
	return nil
}

func (scheduler *Scheduler) loop(ctx context.Context, tick ticker) {
	defer scheduler.workers.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.Chan():
			_ = scheduler.Tick(ctx, now)
		}
	}
}

// Stop cancels the loop, stops the ticker, and waits for termination.
func (scheduler *Scheduler) Stop(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	scheduler.mu.Lock()
	if !scheduler.started {
		scheduler.mu.Unlock()
		return nil
	}
	cancel := scheduler.cancel
	scheduler.stopped = true
	scheduler.mu.Unlock()
	cancel()
	done := make(chan struct{})
	go func() {
		scheduler.workers.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Pending returns the number of delayed jobs.
func (scheduler *Scheduler) Pending() int {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	return len(scheduler.pending)
}

// NextDaily returns the first local occurrence of hour:minute strictly after
// now in location.
func NextDaily(location *time.Location, hour, minute int, now time.Time) (time.Time, error) {
	if location == nil {
		return time.Time{}, fmt.Errorf("location is required")
	}
	if hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return time.Time{}, fmt.Errorf("invalid local clock time")
	}
	localNow := now.In(location)
	candidate := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), hour, minute, 0, 0, time.UTC)
	if !candidate.After(localNow) {
		tomorrow := localNow.AddDate(0, 0, 1)
		candidate = time.Date(tomorrow.Year(), tomorrow.Month(), tomorrow.Day(), hour, minute, 0, 0, time.UTC)
	}
	return candidate, nil
}
