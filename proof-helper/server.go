package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

const (
	requestTimeout = 90 * time.Second
	pendingTTL     = 2 * time.Minute
	maxPending     = 2
)

type pendingRecord struct {
	deviceID string
	state    *stateEnvelope
	runtime  pendingRuntime
	expires  time.Time
	cancel   context.CancelFunc
	trace    *helperTrace
	ctx      context.Context
}

type proofService struct {
	runtime   proofRuntime
	ctx       context.Context
	cancel    context.CancelFunc
	gate      chan struct{}
	ready     atomic.Int32              // 0 loading, 1 ready, 2 failed
	pending   map[string]*pendingRecord // only accessed while gate is held
	closed    sync.Once
	now       func() time.Time
	jobTTL    time.Duration
	vmTTL     time.Duration
	logMu     sync.Mutex
	logWriter io.Writer
}

func newProofService(runtime proofRuntime) *proofService {
	ctx, cancel := context.WithCancel(context.Background())
	s := &proofService{
		runtime: runtime, ctx: ctx, cancel: cancel,
		gate: make(chan struct{}, 1), pending: make(map[string]*pendingRecord),
		now: time.Now, jobTTL: requestTimeout, vmTTL: pendingTTL,
		logWriter: os.Stdout,
	}
	go s.expiryLoop()
	return s
}

func (s *proofService) prepare(ctx context.Context) error {
	trace := s.newTrace(nil)
	trace.stage = "transport"
	trace.start()
	if err := s.acquire(ctx); err != nil {
		s.ready.Store(2)
		trace.emit("transport", "cancelled", "cancelled", 0, "", "")
		return err
	}
	defer s.release()
	if err := s.runtime.Prepare(ctx); err != nil {
		s.ready.Store(2)
		trace.emit("transport", "failure", "unavailable", 0, "HELPER_UNAVAILABLE", "")
		return err
	}
	s.ready.Store(1)
	trace.emit("transport", "success", "", 0, "", "")
	return nil
}

func (s *proofService) acquire(ctx context.Context) error {
	select {
	case s.gate <- struct{}{}:
		if err := ctx.Err(); err != nil {
			s.release()
			return err
		}
		if err := s.ctx.Err(); err != nil {
			s.release()
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-s.ctx.Done():
		return s.ctx.Err()
	}
}

func (s *proofService) release() { <-s.gate }

func (s *proofService) expiryLoop() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			if s.acquire(s.ctx) != nil {
				return
			}
			s.expirePending()
			s.release()
		}
	}
}

func (s *proofService) expirePending() {
	for handle, pending := range s.pending {
		if !s.now().Before(pending.expires) {
			delete(s.pending, handle)
			pending.cancel()
			_ = pending.runtime.Close()
			pending.trace.emit("provision_finish", "cancelled", "expired", 0, "PROVISIONING_EXPIRED", "")
		}
	}
}

func (s *proofService) Close() {
	s.closed.Do(func() {
		s.cancel()
		// All native calls see the service cancellation before shutdown waits.
		s.gate <- struct{}{}
		defer s.release()
		for handle, pending := range s.pending {
			delete(s.pending, handle)
			pending.cancel()
			_ = pending.runtime.Close()
		}
	})
}

func (s *proofService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	trace := s.newTrace(r)
	observed := &diagnosticResponseWriter{ResponseWriter: w, status: http.StatusOK}
	w = observed
	defer func() {
		trace.start()
		outcome := "success"
		if observed.status >= 400 {
			outcome = "failure"
		}
		if r.Context().Err() != nil {
			outcome, observed.reason = "cancelled", "cancelled"
		}
		trace.emit(trace.stage, outcome, observed.reason, observed.status, observed.code, "")
	}()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Do not let net/http print panic values containing native buffers.
	defer func() {
		if recover() != nil {
			writeAPIError(w, http.StatusInternalServerError, "HELPER_FAILED", "Device verification failed.")
		}
	}()
	if r.URL.Path == "/health" {
		trace.stage = "bootstrap"
		trace.start()
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeAPIError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Use GET.")
			return
		}
		status, code := "loading", http.StatusServiceUnavailable
		switch s.ready.Load() {
		case 1:
			status, code = "ready", http.StatusOK
		case 2:
			status = "error"
		}
		if status != "ready" {
			observed.reason = "not_ready"
		}
		writeJSON(w, code, map[string]string{"status": status, "sourceRevision": sourceRevision})
		return
	}
	if r.URL.Path != "/v1/proof" || r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "Endpoint not found.")
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeAPIError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Use POST.")
		return
	}
	if s.ready.Load() != 1 {
		w.Header().Set("Retry-After", "3")
		writeAPIError(w, http.StatusServiceUnavailable, "HELPER_UNAVAILABLE", "Device verification is preparing or unavailable.")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeAPIError(w, http.StatusUnsupportedMediaType, "INVALID_CONTENT_TYPE", "Use application/json.")
		return
	}
	if r.ContentLength > maxRequestBytes {
		writeAPIError(w, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "Request exceeds the size limit.")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeAPIError(w, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "Request exceeds the size limit.")
		} else {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "Invalid device verification request.")
		}
		return
	}
	request, err := decodeRequest(data)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "Invalid device verification request.")
		return
	}
	stages := map[string]string{"bootstrap": "bootstrap", "proof": "proof", "provision-start": "provision_start", "provision-finish": "provision_finish", "kbsync": "kbsync"}
	trace.stage = stages[request.operation]
	if request.operation == "kbsync" {
		trace.flow = "download"
	}
	trace.start()
	ctx, cancel := context.WithTimeout(r.Context(), s.jobTTL)
	ctx = context.WithValue(ctx, diagnosticContextKey{}, trace)
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	defer cancel()
	trace.emit("lock", "start", "lock_wait", 0, "", "")
	if err := s.acquire(ctx); err != nil {
		writeRuntimeError(w, ctx, err)
		return
	}
	trace.emit("lock", "success", "lock_acquired", 0, "", "")
	defer s.release()
	s.expirePending()
	switch request.operation {
	case "bootstrap":
		s.bootstrap(w, ctx, request)
	case "proof":
		s.proof(w, ctx, request)
	case "provision-start":
		s.provisionStart(w, ctx, request)
	case "provision-finish":
		s.provisionFinish(w, ctx, request)
	case "kbsync":
		value, err := s.runtime.KBSync(ctx, request.hardwareID, request.dsid)
		if err != nil || ctx.Err() != nil || len(value) == 0 || len(value) > maxNativeBytes {
			writeRuntimeError(w, ctx, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"kbsync": base64.StdEncoding.EncodeToString(value)})
	}
}

func (s *proofService) bootstrap(w http.ResponseWriter, ctx context.Context, r *proofRequest) {
	if r.state != nil && len(r.state.Native.Provisioning) != 0 {
		headers, encoded, err := s.runtime.Proof(ctx, r.state.nativeBytes(), r.endpoint, r.hardwareID)
		if err == nil && ctx.Err() == nil {
			normalized, headerErr := normalizeStoreHeaders(headers)
			updated, stateErr := withUpdatedNative(r.state, encoded)
			if headerErr == nil && stateErr == nil {
				traceFromContext(ctx).emit("bootstrap", "transition", "cache_hit", 0, "", "store")
				writeJSON(w, http.StatusOK, map[string]any{"state": updated, "headers": normalized, "mode": "store"})
				return
			}
		}
		if ctx.Err() != nil {
			writeRuntimeError(w, ctx, ctx.Err())
			return
		}
		traceFromContext(ctx).emit("bootstrap", "transition", "fallback", 0, "", "bootstrap")
	}
	var encoded []byte
	if r.state != nil {
		encoded = r.state.nativeBytes()
	}
	headers, updated, err := s.runtime.Bootstrap(ctx, encoded)
	if err != nil || ctx.Err() != nil {
		writeRuntimeError(w, ctx, err)
		return
	}
	native, err := decodeNative(updated)
	if err != nil || (r.state != nil && !bytes.Equal(native.Identifier, r.state.Native.Identifier)) {
		writeRuntimeError(w, ctx, errInvalidRequest)
		return
	}
	normalized, identity, err := normalizeBootstrapHeaders(headers)
	if err != nil {
		writeRuntimeError(w, ctx, err)
		return
	}
	state, err := encodeState(&stateEnvelope{Version: 1, DeviceID: r.deviceID, Native: native, IdentityHeaders: identity})
	if err != nil {
		writeRuntimeError(w, ctx, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"state": state, "headers": normalized, "mode": "bootstrap"})
}

func (s *proofService) proof(w http.ResponseWriter, ctx context.Context, r *proofRequest) {
	if len(r.state.Native.Provisioning) == 0 {
		writeAPIError(w, http.StatusConflict, "NOT_PROVISIONED", "Device verification requires authentication.")
		return
	}
	headers, encoded, err := s.runtime.Proof(ctx, r.state.nativeBytes(), r.endpoint, r.hardwareID)
	if err != nil || ctx.Err() != nil {
		writeRuntimeError(w, ctx, err)
		return
	}
	normalized, err := normalizeStoreHeaders(headers)
	if err != nil {
		writeRuntimeError(w, ctx, err)
		return
	}
	state, err := withUpdatedNative(r.state, encoded)
	if err != nil {
		writeRuntimeError(w, ctx, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"state": state, "headers": normalized})
}

func (s *proofService) provisionStart(w http.ResponseWriter, ctx context.Context, r *proofRequest) {
	if len(s.pending) >= maxPending {
		w.Header().Set("Retry-After", "5")
		writeAPIError(w, http.StatusTooManyRequests, "PROVISIONING_BUSY", "Device provisioning is busy. Try again shortly.")
		return
	}
	handleBytes := make([]byte, 32)
	if _, err := rand.Read(handleBytes); err != nil {
		writeRuntimeError(w, ctx, err)
		return
	}
	handle := base64.RawURLEncoding.EncodeToString(handleBytes)
	expires := s.now().Add(s.vmTTL)
	vmCtx, cancel := context.WithTimeout(s.ctx, s.vmTTL)
	// Cancel a start that loses its HTTP caller, then detach the successfully
	// retained runtime from that caller before returning its one-use handle.
	stop := context.AfterFunc(ctx, cancel)
	runtime, clientData, kbsync, err := s.runtime.Start(vmCtx, r.state.nativeBytes(), r.challenge, r.hardwareID)
	stop()
	if err != nil || ctx.Err() != nil || vmCtx.Err() != nil || len(clientData) == 0 || len(clientData) > maxNativeBytes || len(kbsync) == 0 || len(kbsync) > maxNativeBytes {
		if runtime != nil {
			_ = runtime.Close()
		}
		cancel()
		writeRuntimeError(w, ctx, err)
		return
	}
	if runtime == nil {
		cancel()
		writeRuntimeError(w, ctx, errInvalidRequest)
		return
	}
	s.pending[handle] = &pendingRecord{deviceID: r.deviceID, state: r.state, runtime: runtime, expires: expires, cancel: cancel, trace: traceFromContext(ctx), ctx: vmCtx}
	writeJSON(w, http.StatusOK, map[string]any{
		"pending": handle, "clientData": base64.StdEncoding.EncodeToString(clientData),
		"kbsync": base64.StdEncoding.EncodeToString(kbsync), "identityHeaders": r.state.IdentityHeaders,
	})
}

func (s *proofService) provisionFinish(w http.ResponseWriter, ctx context.Context, r *proofRequest) {
	pending, ok := s.pending[r.pending]
	decision := provisionReject
	if ok {
		decision = decideProvisionFinish(true, pending.deviceID == r.deviceID,
			!s.now().Before(pending.expires), pending.ctx != nil && pending.ctx.Err() != nil)
	}
	if decision == provisionReject {
		writeAPIError(w, http.StatusGone, "PROVISIONING_EXPIRED", "Device provisioning has expired. Sign in again.")
		return
	}
	delete(s.pending, r.pending)
	defer pending.cancel()
	defer pending.runtime.Close()
	stop := context.AfterFunc(ctx, pending.cancel)
	defer stop()
	// AfterFunc schedules cancellation asynchronously. A caller cancelled after
	// gate acquisition must be rejected here before native Finish can mutate state.
	if err := ctx.Err(); err != nil {
		writeRuntimeError(w, ctx, err)
		return
	}
	if decision == provisionExpire {
		writeAPIError(w, http.StatusGone, "PROVISIONING_EXPIRED", "Device provisioning has expired. Sign in again.")
		return
	}
	encoded, err := pending.runtime.Finish(r.settingInfo, r.transportKey, r.keybag)
	if (!s.now().Before(pending.expires) || (pending.ctx != nil && pending.ctx.Err() != nil)) && ctx.Err() == nil {
		writeAPIError(w, http.StatusGone, "PROVISIONING_EXPIRED", "Device provisioning has expired. Sign in again.")
		return
	}
	if err != nil || ctx.Err() != nil {
		writeRuntimeError(w, ctx, err)
		return
	}
	state, err := withUpdatedNative(pending.state, encoded)
	if err != nil {
		writeRuntimeError(w, ctx, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"state": state})
}

func withUpdatedNative(state *stateEnvelope, encoded []byte) (string, error) {
	native, err := decodeNative(encoded)
	if err != nil || !bytes.Equal(native.Identifier, state.Native.Identifier) {
		return "", errInvalidRequest
	}
	updated := *state
	updated.Native = native
	return encodeState(&updated)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	if observed, ok := w.(*diagnosticResponseWriter); ok {
		observed.code, observed.reason = code, helperErrorReason(code)
	}
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func writeRuntimeError(w http.ResponseWriter, ctx context.Context, err error) {
	logNativeHTTPStatus(ctx, err)
	if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		writeAPIError(w, http.StatusGatewayTimeout, "PROOF_TIMEOUT", "Device verification timed out. Try again.")
		return
	}
	// Native errors may embed state or Apple responses; never return or log them.
	writeAPIError(w, http.StatusBadGateway, "PROOF_FAILED", "Device verification failed. Try signing in again.")
}
