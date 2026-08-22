package scheduler

import (
	"context"
	"testing"
	"time"

	"example.com/jobqueue/queue"
)

func TestTickMovesDueJobsToTheQueue(t *testing.T) {
	q := queue.New(2)
	s := New(q, time.Hour)
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	s.SetClock(func() time.Time { return now })
	if err := s.Schedule(queue.Job{ID: "job-1"}, now); err != nil {
		t.Fatalf("schedule: %v", err)
	}
	if err := s.Tick(context.Background(), now); err != nil {
		t.Fatalf("tick: %v", err)
	}
	job, err := q.Dequeue(context.Background())
	if err != nil || job.ID != "job-1" {
		t.Fatalf("got %#v, %v", job, err)
	}
}
