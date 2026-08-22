package scheduler

import (
	"fmt"
	"sort"
	"sync"
	"time"

	"example.com/jobqueue/queue"
)

// RecurringJob describes one fixed-interval recurring schedule. NextRun is
// stored explicitly so restart logic can persist it with a FileStore or
// application-owned metadata system.
type RecurringJob struct {
	ID       string        `json:"id"`
	Job      queue.Job     `json:"job"`
	Interval time.Duration `json:"interval"`
	NextRun  time.Time     `json:"next_run"`
	Enabled  bool          `json:"enabled"`
}

// Clone returns a caller-owned recurrence with independent job metadata.
func (job RecurringJob) Clone() RecurringJob {
	clone := job
	clone.Job = job.Job.Clone()
	return clone
}

// Validate rejects incomplete or nonsensical recurring schedules.
func (job RecurringJob) Validate() error {
	if job.ID == "" {
		return fmt.Errorf("recurring job id is required")
	}
	if job.Job.ID == "" {
		return fmt.Errorf("recurring job %s has no queue job id", job.ID)
	}
	if job.Interval <= 0 {
		return fmt.Errorf("recurring job %s interval must be positive", job.ID)
	}
	if job.NextRun.IsZero() {
		return fmt.Errorf("recurring job %s next run is required", job.ID)
	}
	return nil
}

// Calendar is a concurrency-safe collection of named recurring schedules.
// Due returns fresh queue jobs and advances recurrence state atomically.
type Calendar struct {
	mu   sync.Mutex
	jobs map[string]RecurringJob
}

// NewCalendar creates an empty recurrence calendar.
func NewCalendar() *Calendar {
	return &Calendar{jobs: make(map[string]RecurringJob)}
}

// Add validates and stores a recurrence. Existing IDs are replaced so callers
// can update schedule timing without a remove/add race.
func (calendar *Calendar) Add(job RecurringJob) error {
	if err := job.Validate(); err != nil {
		return err
	}
	calendar.mu.Lock()
	defer calendar.mu.Unlock()
	calendar.jobs[job.ID] = job.Clone()
	return nil
}

// Remove deletes a recurrence and reports whether it existed.
func (calendar *Calendar) Remove(id string) bool {
	calendar.mu.Lock()
	defer calendar.mu.Unlock()
	if _, ok := calendar.jobs[id]; !ok {
		return false
	}
	delete(calendar.jobs, id)
	return true
}

// Enable toggles a recurrence without losing its next scheduled instant.
func (calendar *Calendar) Enable(id string, enabled bool) error {
	calendar.mu.Lock()
	defer calendar.mu.Unlock()
	job, ok := calendar.jobs[id]
	if !ok {
		return fmt.Errorf("unknown recurring job %q", id)
	}
	job.Enabled = enabled
	calendar.jobs[id] = job
	return nil
}

// Due returns every enabled recurrence due at or before now. If a scheduler was
// delayed for multiple intervals, it emits one work item and advances NextRun
// past now rather than creating an unbounded catch-up burst.
func (calendar *Calendar) Due(now time.Time) []queue.Job {
	calendar.mu.Lock()
	defer calendar.mu.Unlock()
	entries := make([]RecurringJob, 0, len(calendar.jobs))
	for _, job := range calendar.jobs {
		if !job.Enabled || job.NextRun.After(now) {
			continue
		}
		entries = append(entries, job)
	}
	sort.Slice(entries, func(left, right int) bool {
		if entries[left].NextRun.Equal(entries[right].NextRun) {
			return entries[left].ID < entries[right].ID
		}
		return entries[left].NextRun.Before(entries[right].NextRun)
	})
	due := make([]queue.Job, 0, len(entries))
	for _, entry := range entries {
		job := entry.Job.Clone()
		job.RunAt = entry.NextRun
		due = append(due, job)
		for !entry.NextRun.After(now) {
			entry.NextRun = entry.NextRun.Add(entry.Interval)
		}
		calendar.jobs[entry.ID] = entry
	}
	return due
}

// Snapshot returns recurring schedules in deterministic ID order.
func (calendar *Calendar) Snapshot() []RecurringJob {
	calendar.mu.Lock()
	defer calendar.mu.Unlock()
	items := make([]RecurringJob, 0, len(calendar.jobs))
	for _, job := range calendar.jobs {
		items = append(items, job.Clone())
	}
	sort.Slice(items, func(left, right int) bool { return items[left].ID < items[right].ID })
	return items
}

// Restore replaces the complete calendar only after validating every supplied
// recurrence and checking for duplicate IDs.
func (calendar *Calendar) Restore(items []RecurringJob) error {
	replacement := make(map[string]RecurringJob, len(items))
	for _, item := range items {
		if err := item.Validate(); err != nil {
			return err
		}
		if _, exists := replacement[item.ID]; exists {
			return fmt.Errorf("duplicate recurring job %q", item.ID)
		}
		replacement[item.ID] = item.Clone()
	}
	calendar.mu.Lock()
	calendar.jobs = replacement
	calendar.mu.Unlock()
	return nil
}

// Len reports the total recurrence count, including disabled schedules.
func (calendar *Calendar) Len() int {
	calendar.mu.Lock()
	defer calendar.mu.Unlock()
	return len(calendar.jobs)
}
