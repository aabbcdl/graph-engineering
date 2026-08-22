package queue

import (
	"context"
	"testing"
)

func TestQueueEnqueueAndDequeue(t *testing.T) {
	q := New(2)
	if err := q.Enqueue(context.Background(), Job{ID: "job-1", Priority: 1}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	job, err := q.Dequeue(context.Background())
	if err != nil {
		t.Fatalf("dequeue: %v", err)
	}
	if job.ID != "job-1" {
		t.Fatalf("got %q, want job-1", job.ID)
	}
}

func TestQueueCloseRejectsNewJobs(t *testing.T) {
	q := New(1)
	q.Close()
	if err := q.Enqueue(context.Background(), Job{ID: "late"}); err != ErrClosed {
		t.Fatalf("got %v, want ErrClosed", err)
	}
}
