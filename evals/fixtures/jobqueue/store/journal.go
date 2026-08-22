package store

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Record is one append-only operational event. It deliberately stores a small
// generic payload rather than a queue.Job so applications can retain lifecycle
// information without coupling journal format to one API version.
type Record struct {
	Sequence uint64          `json:"sequence"`
	Kind     string          `json:"kind"`
	At       time.Time       `json:"at"`
	JobID    string          `json:"job_id,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
}

// Clone returns a caller-owned record with its raw JSON payload copied.
func (record Record) Clone() Record {
	clone := record
	clone.Payload = append(json.RawMessage(nil), record.Payload...)
	return clone
}

// Journal persists newline-delimited JSON records. A journal has one in-process
// writer lock; applications that share a journal across processes should add
// their own process-level coordination.
type Journal struct {
	mu   sync.Mutex
	path string
}

// NewJournal creates a journal rooted at path.
func NewJournal(path string) *Journal {
	return &Journal{path: path}
}

// Path returns the journal path.
func (journal *Journal) Path() string {
	return journal.path
}

// Append validates and durably appends one record.
func (journal *Journal) Append(ctx context.Context, record Record) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	if record.Kind == "" {
		return fmt.Errorf("journal record kind is required")
	}
	if record.At.IsZero() {
		record.At = time.Now().UTC()
	}
	payload, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("marshal journal record: %w", err)
	}
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(journal.path), 0o755); err != nil {
		return fmt.Errorf("create journal directory: %w", err)
	}
	file, err := os.OpenFile(journal.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open journal: %w", err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = file.Close()
		}
	}()
	if _, err := file.Write(append(payload, '\n')); err != nil {
		return fmt.Errorf("append journal: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync journal: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close journal: %w", err)
	}
	closed = true
	return nil
}

// Read returns every persisted record in append order. A missing journal is an
// empty history; a malformed line is an error rather than a truncated history.
func (journal *Journal) Read(ctx context.Context) ([]Record, error) {
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	journal.mu.Lock()
	defer journal.mu.Unlock()
	file, err := os.Open(journal.path)
	if errors.Is(err, os.ErrNotExist) {
		return []Record{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open journal: %w", err)
	}
	defer file.Close()
	return decodeRecords(ctx, file)
}

// Compact retains the final keep records through an atomic replacement. Passing
// keep zero clears the journal while preserving the containing directory.
func (journal *Journal) Compact(ctx context.Context, keep int) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	if keep < 0 {
		return fmt.Errorf("keep must not be negative")
	}
	journal.mu.Lock()
	defer journal.mu.Unlock()
	file, err := os.Open(journal.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open journal: %w", err)
	}
	records, readErr := decodeRecords(ctx, file)
	closeErr := file.Close()
	if readErr != nil {
		return readErr
	}
	if closeErr != nil {
		return fmt.Errorf("close journal: %w", closeErr)
	}
	if keep < len(records) {
		records = records[len(records)-keep:]
	}
	return journal.replaceLocked(ctx, records)
}

// Replace is intended for controlled recovery tools. It writes records in the
// supplied order and does not allocate or infer sequence numbers.
func (journal *Journal) Replace(ctx context.Context, records []Record) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	journal.mu.Lock()
	defer journal.mu.Unlock()
	return journal.replaceLocked(ctx, records)
}

func (journal *Journal) replaceLocked(ctx context.Context, records []Record) error {
	if err := os.MkdirAll(filepath.Dir(journal.path), 0o755); err != nil {
		return fmt.Errorf("create journal directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(journal.path), ".jobqueue-journal-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary journal: %w", err)
	}
	temporaryPath := temporary.Name()
	closed := false
	defer func() {
		if !closed {
			_ = temporary.Close()
		}
		_ = os.Remove(temporaryPath)
	}()
	writer := bufio.NewWriter(temporary)
	for _, record := range records {
		if err := contextError(ctx); err != nil {
			return err
		}
		if record.Kind == "" {
			return fmt.Errorf("journal record kind is required")
		}
		payload, err := json.Marshal(record)
		if err != nil {
			return fmt.Errorf("marshal journal record: %w", err)
		}
		if _, err := writer.Write(append(payload, '\n')); err != nil {
			return fmt.Errorf("write journal: %w", err)
		}
	}
	if err := writer.Flush(); err != nil {
		return fmt.Errorf("flush journal: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync journal: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close journal: %w", err)
	}
	closed = true
	if err := os.Rename(temporaryPath, journal.path); err != nil {
		return fmt.Errorf("replace journal: %w", err)
	}
	return nil
}

func decodeRecords(ctx context.Context, reader io.Reader) ([]Record, error) {
	scanner := bufio.NewScanner(reader)
	buffer := make([]byte, 0, 64*1024)
	scanner.Buffer(buffer, 4*1024*1024)
	var records []Record
	for scanner.Scan() {
		if err := contextError(ctx); err != nil {
			return nil, err
		}
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var record Record
		if err := json.Unmarshal(line, &record); err != nil {
			return nil, fmt.Errorf("decode journal record %d: %w", len(records)+1, err)
		}
		if record.Kind == "" {
			return nil, fmt.Errorf("journal record %d has no kind", len(records)+1)
		}
		records = append(records, record.Clone())
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read journal: %w", err)
	}
	return records, nil
}
