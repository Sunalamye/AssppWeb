package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"sync/atomic"
	"time"
)

var diagnosticIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

var machineHTTPStatusPattern = regexp.MustCompile(`^anisette provisioning returned HTTP ([1-5][0-9]{2})$`)

type helperDiagnostic struct {
	Event      string `json:"event"`
	Source     string `json:"source"`
	Schema     int    `json:"schema"`
	FlowID     string `json:"flowId"`
	RequestID  string `json:"requestId"`
	Sequence   uint64 `json:"sequence"`
	Flow       string `json:"flow"`
	Stage      string `json:"stage"`
	Outcome    string `json:"outcome"`
	At         int64  `json:"at"`
	Endpoint   string `json:"endpoint"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	DurationMS int64  `json:"durationMs,omitempty"`
	Reason     string `json:"reason,omitempty"`
	ErrorCode  string `json:"errorCode,omitempty"`
	Mode       string `json:"mode,omitempty"`
}

type helperTrace struct {
	service     *proofService
	flowID      string
	requestID   string
	flow        string
	stage       string
	started     time.Time
	startLogged bool
	sequence    atomic.Uint64
}

func diagnosticID(candidate string) string {
	if diagnosticIDPattern.MatchString(candidate) {
		return candidate
	}
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "" // Missing correlation is safer than logging unvalidated input.
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	hexValue := hex.EncodeToString(value)
	return hexValue[:8] + "-" + hexValue[8:12] + "-" + hexValue[12:16] + "-" + hexValue[16:20] + "-" + hexValue[20:]
}

func (s *proofService) newTrace(r *http.Request) *helperTrace {
	trace := &helperTrace{service: s, flow: "login", stage: "proof", started: time.Now()}
	if r != nil {
		trace.flowID = diagnosticID(r.Header.Get("X-Asspp-Flow-Id"))
		trace.requestID = diagnosticID(r.Header.Get("X-Asspp-Request-Id"))
	} else {
		trace.flowID, trace.requestID = diagnosticID(""), diagnosticID("")
	}
	return trace
}

// Every field below comes from a fixed category, a number, or a validated UUID.
// This deliberately has no way to attach a request, response, native error,
// header, GUID, DSID, challenge, state, provisioning handle, or proof value.
func (t *helperTrace) emit(stage, outcome, reason string, status int, code, mode string) {
	if t == nil || t.flowID == "" || t.requestID == "" {
		return
	}
	event := helperDiagnostic{
		Event: "asspp.diagnostic", Source: "helper", Schema: 1,
		FlowID: t.flowID, RequestID: t.requestID, Sequence: t.sequence.Add(1),
		Flow: t.flow, Stage: stage, Outcome: outcome, At: time.Now().UnixMilli(), Endpoint: "helper",
		HTTPStatus: status, DurationMS: time.Since(t.started).Milliseconds(), Reason: reason, ErrorCode: code, Mode: mode,
	}
	t.service.logMu.Lock()
	defer t.service.logMu.Unlock()
	if t.service.logWriter != nil {
		_ = json.NewEncoder(t.service.logWriter).Encode(event)
	}
}

func (t *helperTrace) start() {
	if !t.startLogged {
		t.startLogged = true
		t.emit(t.stage, "start", "", 0, "", "")
	}
}

type diagnosticContextKey struct{}

func traceFromContext(ctx context.Context) *helperTrace {
	trace, _ := ctx.Value(diagnosticContextKey{}).(*helperTrace)
	return trace
}

type diagnosticResponseWriter struct {
	http.ResponseWriter
	status int
	code   string
	reason string
}

func (w *diagnosticResponseWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func helperErrorReason(code string) string {
	switch code {
	case "INVALID_REQUEST", "REQUEST_TOO_LARGE", "INVALID_CONTENT_TYPE", "METHOD_NOT_ALLOWED":
		return "invalid_request"
	case "PROVISIONING_EXPIRED":
		return "expired"
	case "PROVISIONING_BUSY":
		return "busy"
	case "NOT_PROVISIONED":
		return "not_provisioned"
	case "PROOF_TIMEOUT":
		return "timeout"
	case "HELPER_UNAVAILABLE":
		return "not_ready"
	case "NOT_FOUND":
		return "not_found"
	default:
		return "unknown"
	}
}

func logNativeHTTPStatus(ctx context.Context, err error) {
	if err == nil {
		return
	}
	// Match only this exact upstream error template. Never emit err.Error().
	match := machineHTTPStatusPattern.FindStringSubmatch(err.Error())
	if len(match) == 2 {
		status, _ := strconv.Atoi(match[1])
		traceFromContext(ctx).emit("bootstrap", "failure", "http_error", status, "PROOF_FAILED", "")
	}
}
