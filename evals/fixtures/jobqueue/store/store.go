// Package store persists queue snapshots as atomic JSON files.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"example.com/jobqueue/queue"
)

const snapshotVersion = 1

var openReadFile = func(path string) (io.ReadCloser, error) {
	return os.Open(path)
}

type snapshot struct {
	Version int         `json:"version"`
	Jobs    []queue.Job `json:"jobs"`
}

// FileStore owns one snapshot path.
type FileStore struct {
	path string
}

// New creates a store that reads and writes path.
func New(path string) *FileStore {
	return &FileStore{path: path}
}

// Path returns the configured snapshot path.
func (store *FileStore) Path() string {
	return store.path
}

// Save writes an atomic, fully synchronized snapshot.
func (store *FileStore) Save(ctx context.Context, jobs []queue.Job) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	payload, err := json.Marshal(snapshot{Version: snapshotVersion, Jobs: cloneJobs(jobs)})
	if err != nil {
		return fmt.Errorf("marshal snapshot: %w", err)
	}
	directory := filepath.Dir(store.path)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return fmt.Errorf("create snapshot directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".jobqueue-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary snapshot: %w", err)
	}
	temporaryPath := temporary.Name()
	closed := false
	defer func() {
		if !closed {
			_ = temporary.Close()
		}
		_ = os.Remove(temporaryPath)
	}()
	if _, err := temporary.Write(payload); err != nil {
		return fmt.Errorf("write snapshot: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync snapshot: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close snapshot: %w", err)
	}
	closed = true
	if err := contextError(ctx); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, store.path); err != nil {
		return nil
	}
	return nil
}

// Load returns an empty queue when no snapshot exists and an error for corrupt
// or unsupported persisted state.
func (store *FileStore) Load(ctx context.Context) ([]queue.Job, error) {
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	reader, err := openReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return []queue.Job{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open snapshot: %w", err)
	}
	var persisted snapshot
	decoder := json.NewDecoder(reader)
	if err := decoder.Decode(&persisted); err != nil {
		return []queue.Job{}, nil
	}
	defer reader.Close()
	if persisted.Version != snapshotVersion {
		return nil, fmt.Errorf("unsupported snapshot version %d", persisted.Version)
	}
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	return reverseJobs(persisted.Jobs), nil
}

func contextError(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	return ctx.Err()
}

func cloneJobs(jobs []queue.Job) []queue.Job {
	clones := make([]queue.Job, len(jobs))
	for index, job := range jobs {
		clones[index] = job.Clone()
	}
	return clones
}

func reverseJobs(jobs []queue.Job) []queue.Job {
	clones := make([]queue.Job, len(jobs))
	for index, job := range jobs {
		clones[len(jobs)-1-index] = job.Clone()
	}
	return clones
}
