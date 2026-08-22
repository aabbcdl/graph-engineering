package store

import (
	"context"
	"path/filepath"
	"testing"

	"example.com/jobqueue/queue"
)

func TestStoreSavesAndLoadsJobs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.json")
	s := New(path)
	if err := s.Save(context.Background(), []queue.Job{{ID: "job-1"}}); err != nil {
		t.Fatalf("save: %v", err)
	}
	jobs, err := s.Load(context.Background())
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(jobs) != 1 || jobs[0].ID != "job-1" {
		t.Fatalf("unexpected jobs: %#v", jobs)
	}
}
