//go:build cgo

package electrobun

/*
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

static bool eb_updater_configure(void* fn, const char* value) { return ((bool (*)(const char*))fn)(value); }
static char* eb_updater_request(void* fn, const char* value) { return ((char* (*)(const char*))fn)(value); }
static char* eb_updater_state(void* fn) { return ((char* (*)(void))fn)(); }
static char* eb_updater_events(void* fn, uint64_t after, uint32_t limit) { return ((char* (*)(uint64_t, uint32_t))fn)(after, limit); }
static void eb_updater_shutdown(void* fn) { ((void (*)(void))fn)(); }
static void eb_updater_free(void* fn, char* value) { ((void (*)(char*))fn)(value); }
*/
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"unsafe"
)

// ErrUpdaterUnavailable means the loaded core predates the shared updater ABI.
var ErrUpdaterUnavailable = errors.New("Electrobun updater unavailable: the loaded core is missing updater symbols")

var updaterSymbols = []string{
	"updaterConfigure", "updaterRequest", "updaterGetState", "updaterGetEvents", "updaterShutdown",
}

type updaterClient struct {
	mu          sync.Mutex
	bundlePaths BundlePaths
	configured  bool
}

// LocalUpdateInfo comes from the bundle metadata resolved by the native core.
type LocalUpdateInfo struct {
	Version         string             `json:"version"`
	Hash            string             `json:"hash"`
	BaseURL         string             `json:"baseUrl"`
	Channel         string             `json:"channel"`
	Name            string             `json:"name"`
	DisplayName     string             `json:"displayName,omitempty"`
	Identifier      string             `json:"identifier"`
	Managed         *ManagedUpdateInfo `json:"managed,omitempty"`
	UpdateAuthority string             `json:"updateAuthority,omitempty"`
}

type ManagedUpdateInfo struct {
	AppID   string `json:"appId"`
	APIURL  string `json:"apiUrl,omitempty"`
	BaseURL string `json:"baseUrl,omitempty"`
}

type UpdateInfo struct {
	Version         string `json:"version"`
	Hash            string `json:"hash"`
	UpdateAvailable bool   `json:"updateAvailable"`
	UpdateReady     bool   `json:"updateReady"`
	Error           string `json:"error"`
}

type UpdaterOperationState string

const (
	UpdaterIdle             UpdaterOperationState = "idle"
	UpdaterQueued           UpdaterOperationState = "queued"
	UpdaterRunning          UpdaterOperationState = "running"
	UpdaterAwaitingApproval UpdaterOperationState = "awaitingApproval"
	UpdaterCompleted        UpdaterOperationState = "completed"
	UpdaterFailed           UpdaterOperationState = "failed"
	UpdaterCancelled        UpdaterOperationState = "cancelled"
)

// UpdaterApproval binds the application's quit decision to a prepared update.
// Use the enclosing state's OperationID with this ID in UpdaterApproveApply.
type UpdaterApproval struct {
	ID           string `json:"id"`
	PreparedHash string `json:"preparedHash"`
}

type UpdaterOperation struct {
	OperationID string                `json:"operationId"`
	Operation   string                `json:"operation"`
	State       UpdaterOperationState `json:"state"`
	Error       string                `json:"error"`
	UpdateInfo  *UpdateInfo           `json:"updateInfo"`
}

// UpdaterState is a snapshot. OperationID and Operation are empty when idle.
// Accepted requests and an approval token do not mean it is safe to quit.
// Only QuitReady means the helper is armed and normal app teardown may proceed.
type UpdaterState struct {
	SchemaVersion  uint32                `json:"schemaVersion"`
	Revision       uint64                `json:"revision"`
	OperationID    string                `json:"operationId"`
	Operation      string                `json:"operation"`
	OperationState UpdaterOperationState `json:"operationState"`
	LocalInfo      LocalUpdateInfo       `json:"localInfo"`
	UpdateInfo     UpdateInfo            `json:"updateInfo"`
	Approval       *UpdaterApproval      `json:"approval"`
	QuitReady      bool                  `json:"quitReady"`
	ChannelRoot    string                `json:"channelRoot"`
	Operations     []UpdaterOperation    `json:"operations"`
}

// UpdaterRequestResult reports queuing, not operation completion. Rejections
// have an Error; accepted operations must be observed through state or events.
type UpdaterRequestResult struct {
	SchemaVersion uint32 `json:"schemaVersion"`
	Accepted      bool   `json:"accepted"`
	OperationID   string `json:"operationId"`
	Error         string `json:"error"`
}

type UpdateStatusDetails struct {
	FromHash            string   `json:"fromHash,omitempty"`
	ToHash              string   `json:"toHash,omitempty"`
	CurrentHash         string   `json:"currentHash,omitempty"`
	LatestHash          string   `json:"latestHash,omitempty"`
	PatchNumber         *uint32  `json:"patchNumber,omitempty"`
	TotalPatchesApplied *uint32  `json:"totalPatchesApplied,omitempty"`
	Progress            *float64 `json:"progress,omitempty"`
	BytesDownloaded     *uint64  `json:"bytesDownloaded,omitempty"`
	TotalBytes          *uint64  `json:"totalBytes,omitempty"`
	UsedPatchPath       *bool    `json:"usedPatchPath,omitempty"`
	ErrorMessage        string   `json:"errorMessage,omitempty"`
	URL                 string   `json:"url,omitempty"`
	ZstdPath            string   `json:"zstdPath,omitempty"`
	ExitCode            *int32   `json:"exitCode,omitempty"`
}

type UpdateStatus string

const (
	UpdateIdle                  UpdateStatus = "idle"
	UpdateChecking              UpdateStatus = "checking"
	UpdateCheckComplete         UpdateStatus = "check-complete"
	UpdateNoUpdate              UpdateStatus = "no-update"
	UpdateAvailable             UpdateStatus = "update-available"
	UpdateDownloading           UpdateStatus = "downloading"
	UpdateDownloadStarting      UpdateStatus = "download-starting"
	UpdateCheckingLocalTar      UpdateStatus = "checking-local-tar"
	UpdateLocalTarFound         UpdateStatus = "local-tar-found"
	UpdateLocalTarMissing       UpdateStatus = "local-tar-missing"
	UpdateFetchingPatch         UpdateStatus = "fetching-patch"
	UpdatePatchFound            UpdateStatus = "patch-found"
	UpdatePatchNotFound         UpdateStatus = "patch-not-found"
	UpdateDownloadingPatch      UpdateStatus = "downloading-patch"
	UpdateApplyingPatch         UpdateStatus = "applying-patch"
	UpdatePatchApplied          UpdateStatus = "patch-applied"
	UpdatePatchFailed           UpdateStatus = "patch-failed"
	UpdateExtractingVersion     UpdateStatus = "extracting-version"
	UpdatePatchChainComplete    UpdateStatus = "patch-chain-complete"
	UpdateDownloadingFullBundle UpdateStatus = "downloading-full-bundle"
	UpdateDownloadProgress      UpdateStatus = "download-progress"
	UpdateDecompressing         UpdateStatus = "decompressing"
	UpdateDownloadComplete      UpdateStatus = "download-complete"
	UpdateApplying              UpdateStatus = "applying"
	UpdateExtracting            UpdateStatus = "extracting"
	UpdateReplacingApp          UpdateStatus = "replacing-app"
	UpdateLaunchingNewVersion   UpdateStatus = "launching-new-version"
	UpdateComplete              UpdateStatus = "complete"
	UpdateError                 UpdateStatus = "error"
)

// UpdateStatusEntry preserves the established updater status names. Polling
// delivers events on the caller's goroutine; the worker never invokes Go.
type UpdateStatusEntry struct {
	Sequence    uint64               `json:"sequence"`
	OperationID string               `json:"operationId"`
	Status      UpdateStatus         `json:"status"`
	Message     string               `json:"message"`
	Timestamp   int64                `json:"timestamp"`
	Details     *UpdateStatusDetails `json:"details,omitempty"`
}

type UpdaterEventBatch struct {
	SchemaVersion  uint32              `json:"schemaVersion"`
	Entries        []UpdateStatusEntry `json:"entries"`
	NextSequence   uint64              `json:"nextSequence"`
	OldestSequence uint64              `json:"oldestSequence"`
	Overflow       bool                `json:"overflow"`
}

func (c *Core) updaterAvailable() error {
	if c == nil || c.symbol("freeCoreString") == nil {
		return ErrUpdaterUnavailable
	}
	for _, name := range updaterSymbols {
		if c.symbol(name) == nil {
			return fmt.Errorf("%w: %s", ErrUpdaterUnavailable, name)
		}
	}
	return nil
}

// UpdaterConfigure resolves local metadata and installation identity in core.
// Only bundle paths are supplied; this never checks for or downloads updates.
// Other updater methods configure lazily from LoadCore's resolved bundle paths.
func (c *Core) UpdaterConfigure(bundlePaths BundlePaths) error {
	if err := c.updaterAvailable(); err != nil {
		return err
	}
	c.updater.mu.Lock()
	defer c.updater.mu.Unlock()
	return c.updaterConfigureLocked(bundlePaths)
}

func (c *Core) updaterConfigureLocked(bundlePaths BundlePaths) error {
	payload, err := json.Marshal(struct {
		SchemaVersion uint32 `json:"schemaVersion"`
		ExeDir        string `json:"exeDir"`
		ResourcesDir  string `json:"resourcesDir"`
	}{1, bundlePaths.ExeDir, bundlePaths.ResourcesDir})
	if err != nil {
		return err
	}
	value := C.CString(string(payload))
	defer C.free(unsafe.Pointer(value))
	if !bool(C.eb_updater_configure(c.symbol("updaterConfigure"), value)) {
		return c.updaterFailure("configuration rejected")
	}
	c.updater.bundlePaths = bundlePaths
	c.updater.configured = true
	return nil
}

func (c *Core) updaterEnsureConfiguredLocked() error {
	if c.updater.configured {
		return nil
	}
	paths := c.updater.bundlePaths
	if paths.ExeDir == "" || paths.ResourcesDir == "" {
		var err error
		paths, err = ResolveBundlePaths()
		if err != nil {
			return err
		}
	}
	return c.updaterConfigureLocked(paths)
}

func (c *Core) updaterFailure(fallback string) error {
	if c.symbol("electrobun_core_last_error") != nil {
		if message := c.LastError(); message != "" {
			return fmt.Errorf("Electrobun updater: %s", message)
		}
	}
	return fmt.Errorf("Electrobun updater: %s", fallback)
}

func (c *Core) updaterDecode(value *C.char, out any) error {
	if value == nil {
		return c.updaterFailure("core returned no response")
	}
	defer C.eb_updater_free(c.symbol("freeCoreString"), value)
	payload := []byte(C.GoString(value))
	var header struct {
		SchemaVersion uint32 `json:"schemaVersion"`
	}
	if err := json.Unmarshal(payload, &header); err != nil {
		return fmt.Errorf("Electrobun updater: invalid response: %w", err)
	}
	if header.SchemaVersion != 1 {
		return fmt.Errorf("Electrobun updater: unsupported response schema version %d", header.SchemaVersion)
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("Electrobun updater: invalid response: %w", err)
	}
	return nil
}

// UpdaterGetState reads current and retained operation state without a network check.
func (c *Core) UpdaterGetState() (UpdaterState, error) {
	var state UpdaterState
	if err := c.updaterAvailable(); err != nil {
		return state, err
	}
	c.updater.mu.Lock()
	defer c.updater.mu.Unlock()
	if err := c.updaterEnsureConfiguredLocked(); err != nil {
		return state, err
	}
	err := c.updaterDecode(C.eb_updater_state(c.symbol("updaterGetState")), &state)
	return state, err
}

func (c *Core) UpdaterLocalInfo() (LocalUpdateInfo, error) {
	state, err := c.UpdaterGetState()
	return state.LocalInfo, err
}

// UpdaterGetEvents reads the bounded event queue after the supplied sequence.
// When Overflow is true, refresh state because older entries were discarded.
func (c *Core) UpdaterGetEvents(after uint64, limit uint32) (UpdaterEventBatch, error) {
	var batch UpdaterEventBatch
	if err := c.updaterAvailable(); err != nil {
		return batch, err
	}
	c.updater.mu.Lock()
	defer c.updater.mu.Unlock()
	if err := c.updaterEnsureConfiguredLocked(); err != nil {
		return batch, err
	}
	err := c.updaterDecode(C.eb_updater_events(c.symbol("updaterGetEvents"), C.uint64_t(after), C.uint32_t(limit)), &batch)
	return batch, err
}

type updaterRequest struct {
	SchemaVersion uint32 `json:"schemaVersion"`
	Action        string `json:"action"`
	OperationID   string `json:"operationId,omitempty"`
	ApprovalID    string `json:"approvalId,omitempty"`
	Approved      *bool  `json:"approved,omitempty"`
}

func (c *Core) updaterSend(request updaterRequest) (UpdaterRequestResult, error) {
	var result UpdaterRequestResult
	if err := c.updaterAvailable(); err != nil {
		return result, err
	}
	c.updater.mu.Lock()
	defer c.updater.mu.Unlock()
	if err := c.updaterEnsureConfiguredLocked(); err != nil {
		return result, err
	}
	request.SchemaVersion = 1
	payload, err := json.Marshal(request)
	if err != nil {
		return result, err
	}
	value := C.CString(string(payload))
	defer C.free(unsafe.Pointer(value))
	if err := c.updaterDecode(C.eb_updater_request(c.symbol("updaterRequest"), value), &result); err != nil {
		return result, err
	}
	if !result.Accepted || result.Error != "" {
		if result.Error == "" {
			return result, errors.New("Electrobun updater: request rejected")
		}
		return result, fmt.Errorf("Electrobun updater: %s", result.Error)
	}
	if result.OperationID == "" {
		return result, errors.New("Electrobun updater: accepted response has no operation ID")
	}
	return result, nil
}

func (c *Core) UpdaterCheck() (UpdaterRequestResult, error) {
	return c.updaterSend(updaterRequest{Action: "check"})
}

func (c *Core) UpdaterDownload() (UpdaterRequestResult, error) {
	return c.updaterSend(updaterRequest{Action: "download"})
}

// UpdaterRequestApply prepares an approval token. It does not stop the event loop.
func (c *Core) UpdaterRequestApply() (UpdaterRequestResult, error) {
	return c.updaterSend(updaterRequest{Action: "requestApply"})
}

// UpdaterApproveApply accepts or vetoes the specific operation and approval.
// Run the application's normal quit policy first. After approval, wait for
// UpdaterState.QuitReady before stopping the event loop or tearing down the app.
func (c *Core) UpdaterApproveApply(operationID, approvalID string, approved bool) (UpdaterRequestResult, error) {
	return c.updaterSend(updaterRequest{Action: "approveApply", OperationID: operationID, ApprovalID: approvalID, Approved: &approved})
}

func (c *Core) UpdaterCancel(operationID string) (UpdaterRequestResult, error) {
	return c.updaterSend(updaterRequest{Action: "cancel", OperationID: operationID})
}

func (c *Core) UpdaterReconcile() (UpdaterRequestResult, error) {
	return c.updaterSend(updaterRequest{Action: "reconcile"})
}

// UpdaterShutdown joins the native worker. RunMainThread shuts it down before
// returning only if this handle configured it successfully. Callers that do not
// run that loop should defer this method themselves.
func (c *Core) UpdaterShutdown() error {
	if err := c.updaterAvailable(); err != nil {
		return err
	}
	c.updater.mu.Lock()
	defer c.updater.mu.Unlock()
	C.eb_updater_shutdown(c.symbol("updaterShutdown"))
	c.updater.configured = false
	return nil
}

func (c *Core) updaterShutdownIfConfigured() {
	c.updater.mu.Lock()
	defer c.updater.mu.Unlock()
	if c.updater.configured {
		C.eb_updater_shutdown(c.symbol("updaterShutdown"))
		c.updater.configured = false
	}
}
