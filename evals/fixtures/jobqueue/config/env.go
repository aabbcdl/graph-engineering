package config

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// LookupEnv retrieves one environment variable. It is a small interface so
// command-line applications can test configuration parsing without changing
// process-wide environment state.
type LookupEnv func(string) (string, bool)

// LoadEnvironment applies the documented JOBQUEUE_* overrides to defaults.
// Empty variables behave as absent variables; malformed explicit values are
// rejected instead of being silently ignored.
func LoadEnvironment(lookup LookupEnv) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("environment lookup is required")
	}
	settings := Default()
	var err error
	if settings.QueueCapacity, err = readPositiveInt(lookup, "JOBQUEUE_QUEUE_CAPACITY", settings.QueueCapacity); err != nil {
		return Config{}, err
	}
	if settings.Workers, err = readPositiveInt(lookup, "JOBQUEUE_WORKERS", settings.Workers); err != nil {
		return Config{}, err
	}
	if settings.MaxRetries, err = readNonNegativeInt(lookup, "JOBQUEUE_MAX_RETRIES", settings.MaxRetries); err != nil {
		return Config{}, err
	}
	if settings.RetryBase, err = readPositiveMilliseconds(lookup, "JOBQUEUE_RETRY_BASE_MS", settings.RetryBase); err != nil {
		return Config{}, err
	}
	if settings.RetryMax, err = readPositiveMilliseconds(lookup, "JOBQUEUE_RETRY_MAX_MS", settings.RetryMax); err != nil {
		return Config{}, err
	}
	if settings.SchedulerTick, err = readPositiveMilliseconds(lookup, "JOBQUEUE_SCHEDULER_TICK_MS", settings.SchedulerTick); err != nil {
		return Config{}, err
	}
	if settings.ShutdownTimeout, err = readPositiveMilliseconds(lookup, "JOBQUEUE_SHUTDOWN_TIMEOUT_MS", settings.ShutdownTimeout); err != nil {
		return Config{}, err
	}
	if value, ok := readString(lookup, "JOBQUEUE_STORAGE_PATH"); ok {
		settings.StoragePath = value
	}
	if value, ok := readString(lookup, "JOBQUEUE_TIME_ZONE"); ok {
		settings.TimeZone = value
	}
	if err := settings.Validate(); err != nil {
		return Config{}, err
	}
	return settings, nil
}

// EnvironmentMap serializes a complete configuration using the same
// environment names accepted by LoadEnvironment. It is useful for diagnostics
// and for spawning a child process with a known configuration.
func (c Config) EnvironmentMap() map[string]string {
	settings := c.Normalize()
	return map[string]string{
		"JOBQUEUE_QUEUE_CAPACITY":      strconv.Itoa(settings.QueueCapacity),
		"JOBQUEUE_WORKERS":             strconv.Itoa(settings.Workers),
		"JOBQUEUE_MAX_RETRIES":         strconv.Itoa(settings.MaxRetries),
		"JOBQUEUE_RETRY_BASE_MS":       strconv.FormatInt(settings.RetryBase.Milliseconds(), 10),
		"JOBQUEUE_RETRY_MAX_MS":        strconv.FormatInt(settings.RetryMax.Milliseconds(), 10),
		"JOBQUEUE_STORAGE_PATH":        settings.StoragePath,
		"JOBQUEUE_TIME_ZONE":           settings.TimeZone,
		"JOBQUEUE_SCHEDULER_TICK_MS":   strconv.FormatInt(settings.SchedulerTick.Milliseconds(), 10),
		"JOBQUEUE_SHUTDOWN_TIMEOUT_MS": strconv.FormatInt(settings.ShutdownTimeout.Milliseconds(), 10),
	}
}

// WithStoragePath returns a normalized configuration with an explicit storage
// location. The helper is convenient for tests and per-tenant service setup.
func (c Config) WithStoragePath(path string) (Config, error) {
	settings := c.Normalize()
	settings.StoragePath = strings.TrimSpace(path)
	if err := settings.Validate(); err != nil {
		return Config{}, err
	}
	return settings, nil
}

func readString(lookup LookupEnv, key string) (string, bool) {
	value, ok := lookup(key)
	value = strings.TrimSpace(value)
	return value, ok && value != ""
}

func readPositiveInt(lookup LookupEnv, key string, fallback int) (int, error) {
	value, ok := readString(lookup, key)
	if !ok {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return parsed, nil
}

func readNonNegativeInt(lookup LookupEnv, key string, fallback int) (int, error) {
	value, ok := readString(lookup, key)
	if !ok {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer", key)
	}
	return parsed, nil
}

func readPositiveMilliseconds(lookup LookupEnv, key string, fallback time.Duration) (time.Duration, error) {
	value, ok := readString(lookup, key)
	if !ok {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive millisecond value", key)
	}
	return time.Duration(parsed) * time.Millisecond, nil
}
