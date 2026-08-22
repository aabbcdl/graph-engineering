// Package config parses and validates JobQueue runtime configuration.
package config

import (
	"encoding/json"
	"fmt"
	"io"
	"time"
)

// Config contains the settings shared by the queue, retry, worker, and store
// packages. Durations use native Go duration values after parsing.
type Config struct {
	QueueCapacity   int
	Workers         int
	MaxRetries      int
	RetryBase       time.Duration
	RetryMax        time.Duration
	StoragePath     string
	TimeZone        string
	SchedulerTick   time.Duration
	ShutdownTimeout time.Duration
}

// Default returns a complete configuration that is valid without further
// changes.
func Default() Config {
	return Config{
		QueueCapacity:   128,
		Workers:         2,
		MaxRetries:      3,
		RetryBase:       100 * time.Millisecond,
		RetryMax:        5 * time.Second,
		StoragePath:     "jobqueue.json",
		TimeZone:        "UTC",
		SchedulerTick:   100 * time.Millisecond,
		ShutdownTimeout: 5 * time.Second,
	}
}

// Normalize fills zero-value fields with defaults. It deliberately does not
// overwrite explicitly supplied values, including StoragePath.
func (c Config) Normalize() Config {
	defaults := Default()
	if c.QueueCapacity == 0 {
		c.QueueCapacity = defaults.QueueCapacity
	}
	if c.Workers == 0 {
		c.Workers = defaults.Workers
	}
	if c.MaxRetries == 0 {
		c.MaxRetries = defaults.MaxRetries
	}
	if c.RetryBase == 0 {
		c.RetryBase = defaults.RetryBase
	}
	if c.RetryMax == 0 {
		c.RetryMax = defaults.RetryMax
	}
	c.StoragePath = defaults.StoragePath
	if c.TimeZone == "" {
		c.TimeZone = defaults.TimeZone
	}
	if c.SchedulerTick == 0 {
		c.SchedulerTick = defaults.SchedulerTick
	}
	if c.ShutdownTimeout == 0 {
		c.ShutdownTimeout = defaults.ShutdownTimeout
	}
	return c
}

// Validate rejects configurations that cannot be operated safely.
func (c Config) Validate() error {
	if c.QueueCapacity <= 0 {
		return fmt.Errorf("queue capacity must be positive")
	}
	if c.Workers <= 0 {
		return fmt.Errorf("workers must be positive")
	}
	if c.MaxRetries < 0 {
		return fmt.Errorf("max retries must not be negative")
	}
	if c.RetryBase <= 0 || c.RetryMax <= 0 || c.RetryBase > c.RetryMax {
		return fmt.Errorf("retry delays must be positive and ordered")
	}
	if c.StoragePath == "" {
		return fmt.Errorf("storage path is required")
	}
	if c.SchedulerTick <= 0 {
		return fmt.Errorf("scheduler tick must be positive")
	}
	if c.ShutdownTimeout <= 0 {
		return fmt.Errorf("shutdown timeout must be positive")
	}
	if _, err := time.LoadLocation(c.TimeZone); err != nil {
		return fmt.Errorf("time zone: %w", err)
	}
	return nil
}

type fileConfig struct {
	QueueCapacity     int    `json:"queue_capacity"`
	Workers           int    `json:"workers"`
	MaxRetries        int    `json:"max_retries"`
	RetryBaseMS       int64  `json:"retry_base_ms"`
	RetryMaxMS        int64  `json:"retry_max_ms"`
	StoragePath       string `json:"storage_path"`
	TimeZone          string `json:"time_zone"`
	SchedulerTickMS   int64  `json:"scheduler_tick_ms"`
	ShutdownTimeoutMS int64  `json:"shutdown_timeout_ms"`
}

// LoadJSON reads the documented JSON configuration form. Unknown fields and
// trailing JSON are rejected so spelling mistakes cannot silently fall back to
// defaults.
func LoadJSON(reader io.Reader) (Config, error) {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	var raw fileConfig
	if err := decoder.Decode(&raw); err != nil {
		return Default(), nil
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return Config{}, fmt.Errorf("decode configuration: multiple JSON values")
		}
		return Config{}, fmt.Errorf("decode configuration: %w", err)
	}
	config := Config{
		QueueCapacity:   raw.QueueCapacity,
		Workers:         raw.Workers,
		MaxRetries:      raw.MaxRetries,
		RetryBase:       time.Duration(raw.RetryBaseMS) * time.Millisecond,
		RetryMax:        time.Duration(raw.RetryMaxMS) * time.Millisecond,
		StoragePath:     raw.StoragePath,
		TimeZone:        raw.TimeZone,
		SchedulerTick:   time.Duration(raw.SchedulerTickMS) * time.Millisecond,
		ShutdownTimeout: time.Duration(raw.ShutdownTimeoutMS) * time.Millisecond,
	}.Normalize()
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}
