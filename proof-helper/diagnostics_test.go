package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHelperDiagnosticsCorrelateWithoutProofMaterial(t *testing.T) {
	var logs bytes.Buffer
	s := readyService(t, mockRuntime{kbsync: func(context.Context, []byte, uint64) ([]byte, error) {
		return []byte("private-proof-value"), nil
	}})
	s.logWriter = &logs
	data := `{"operation":"kbsync","deviceId":"001122AABBCC","dsid":"123456789"}`
	r := httptest.NewRequest(http.MethodPost, "/v1/proof", strings.NewReader(data))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Asspp-Flow-Id", "c5d7f36a-ce83-4ed8-8f19-42e7d90856db")
	r.Header.Set("X-Asspp-Request-Id", "not-a-uuid-private-token")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("synthetic kbsync failed")
	}
	for _, private := range []string{"private-proof-value", base64.StdEncoding.EncodeToString([]byte("private-proof-value")), "001122AABBCC", "123456789", "not-a-uuid-private-token", `"dsid"`, `"state"`, `"headers"`} {
		if strings.Contains(logs.String(), private) {
			t.Fatal("diagnostic output contained private material")
		}
	}
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	if len(lines) < 2 {
		t.Fatal("missing lifecycle diagnostics")
	}
	for _, line := range lines {
		var event helperDiagnostic
		if json.Unmarshal([]byte(line), &event) != nil || event.Event != "asspp.diagnostic" || event.Source != "helper" || event.FlowID != "c5d7f36a-ce83-4ed8-8f19-42e7d90856db" || !diagnosticIDPattern.MatchString(event.RequestID) {
			t.Fatal("invalid diagnostic envelope")
		}
	}
}

func TestNativeCompletionAfterDeadlineIsNotSuccess(t *testing.T) {
	s := readyService(t, mockRuntime{kbsync: func(ctx context.Context, _ []byte, _ uint64) ([]byte, error) {
		<-ctx.Done()
		return []byte("late-result"), nil
	}})
	s.jobTTL = time.Millisecond
	w, result := callJSON(t, s, map[string]string{"operation": "kbsync", "deviceId": testDevice, "dsid": "123"})
	if w.Code != http.StatusGatewayTimeout || result["kbsync"] != nil {
		t.Fatal("late native completion was reported as success")
	}
}

func TestProvisioningExpiryDuringFinishDoesNotReturnState(t *testing.T) {
	var vmContext context.Context
	pending := &mockPending{finish: func(_, _, _ []byte) ([]byte, error) {
		<-vmContext.Done()
		return testState().nativeBytes(), nil
	}}
	s := readyService(t, mockRuntime{start: func(ctx context.Context, _, _, _ []byte) (pendingRuntime, []byte, []byte, error) {
		vmContext = ctx
		return pending, []byte("client"), []byte("sync"), nil
	}})
	s.vmTTL = 100 * time.Millisecond
	w, start := callJSON(t, s, map[string]string{"operation": "provision-start", "deviceId": testDevice, "state": encodedTestState(t), "challenge": "Y2hhbGxlbmdl"})
	if w.Code != 200 {
		t.Fatal("synthetic provisioning start failed")
	}
	w, result := callJSON(t, s, map[string]string{
		"operation": "provision-finish", "deviceId": testDevice, "pending": start["pending"].(string),
		"settingInfo": "c2V0dGluZw==", "transportKey": "dHJhbnNwb3J0",
	})
	if w.Code != http.StatusGone || result["state"] != nil || pending.closed != 1 {
		t.Fatal("expired provisioning completion returned state or leaked its VM")
	}
}

func TestNativeHTTPClassificationContainsOnlySafeStatus(t *testing.T) {
	var logs bytes.Buffer
	s := readyService(t, mockRuntime{bootstrap: func(context.Context, []byte) (http.Header, []byte, error) {
		return nil, nil, errors.New("anisette provisioning returned HTTP 503")
	}})
	s.logWriter = &logs
	w, _ := callJSON(t, s, map[string]string{"operation": "bootstrap", "deviceId": testDevice, "endpoint": testEndpoint})
	if w.Code != 502 || !strings.Contains(logs.String(), `"httpStatus":503`) || strings.Contains(logs.String(), "anisette provisioning returned") {
		t.Fatal("native HTTP classification was missing or included native error text")
	}
}
