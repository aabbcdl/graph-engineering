package store

import (
	"context"
	"io"
	"strings"
	"testing"
)

type hiddenTrackingReader struct {
	io.Reader
	closed bool
}

func (reader *hiddenTrackingReader) Close() error {
	reader.closed = true
	return nil
}

func TestHiddenStoreCorruptReadClosesHandle(t *testing.T) {
	original := openReadFile
	tracked := &hiddenTrackingReader{Reader: strings.NewReader("{broken")}
	openReadFile = func(string) (io.ReadCloser, error) { return tracked, nil }
	defer func() { openReadFile = original }()
	_, _ = New("ignored").Load(context.Background())
	if !tracked.closed {
		t.Fatal("corrupt snapshot reader was not closed")
	}
}
