package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func lockProvisionBoundary(t *testing.T, s *proofService) {
	t.Helper()
	if err := s.acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Direct native-boundary tests must hold the same gate as ServeHTTP. This
	// also keeps the background expiry loop away from synthetic clocks/records.
	t.Cleanup(s.release)
}

func TestCancelledPendingContextNeverInvokesNativeFinish(t *testing.T) {
	called := 0
	p := &mockPending{finish: func(_, _, _ []byte) ([]byte, error) {
		called++
		return testState().nativeBytes(), nil
	}}
	s := readyService(t, mockRuntime{start: func(context.Context, []byte, []byte, []byte) (pendingRuntime, []byte, []byte, error) {
		return p, []byte("client-data"), []byte("kbsync"), nil
	}})
	_, result := callJSON(t, s, map[string]string{"operation": "provision-start", "deviceId": testDevice, "state": encodedTestState(t), "challenge": "Y2hhbGxlbmdl"})
	handle := result["pending"].(string)
	if err := s.acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	s.pending[handle].cancel()
	s.release()
	w, _ := callJSON(t, s, map[string]string{"operation": "provision-finish", "deviceId": testDevice, "pending": handle, "settingInfo": "c2V0dGluZw==", "transportKey": "a2V5"})
	if w.Code != http.StatusGone || called != 0 || p.closed != 1 || len(s.pending) != 0 {
		t.Fatalf("Cancelled pending work ran: status=%d calls=%d closes=%d remaining=%d", w.Code, called, p.closed, len(s.pending))
	}
}

func TestExpiryIsCheckedAtNativeFinishBoundary(t *testing.T) {
	called := 0
	p := &mockPending{finish: func(_, _, _ []byte) ([]byte, error) {
		called++
		return testState().nativeBytes(), nil
	}}
	s := readyService(t, mockRuntime{})
	lockProvisionBoundary(t, s)
	now := time.Now()
	s.now = func() time.Time { return now }
	ctx, cancel := context.WithCancel(context.Background())
	s.pending["pending"] = &pendingRecord{deviceID: testDevice, state: testState(), runtime: p, expires: now, ctx: ctx, cancel: cancel}
	w := httptest.NewRecorder()
	// Exercise expiry after the caller's earlier sweep but before native entry.
	s.provisionFinish(w, context.Background(), &proofRequest{deviceID: testDevice, pending: "pending"})
	if w.Code != http.StatusGone || called != 0 || p.closed != 1 || len(s.pending) != 0 {
		t.Fatalf("Expired native operation ran: status=%d calls=%d closes=%d", w.Code, called, p.closed)
	}
}

func TestNativeFinishCannotPublishStateAfterExpiry(t *testing.T) {
	now := time.Now()
	p := &mockPending{finish: func(_, _, _ []byte) ([]byte, error) {
		now = now.Add(3 * time.Minute)
		return testState().nativeBytes(), nil
	}}
	s := readyService(t, mockRuntime{})
	lockProvisionBoundary(t, s)
	s.now = func() time.Time { return now }
	ctx, cancel := context.WithCancel(context.Background())
	s.pending["pending"] = &pendingRecord{deviceID: testDevice, state: testState(), runtime: p, expires: now.Add(time.Minute), ctx: ctx, cancel: cancel}
	w := httptest.NewRecorder()
	s.provisionFinish(w, context.Background(), &proofRequest{deviceID: testDevice, pending: "pending"})
	if w.Code != http.StatusGone || p.closed != 1 || len(s.pending) != 0 {
		t.Fatalf("Expired completion was accepted: status=%d closes=%d", w.Code, p.closed)
	}
}

func TestCancelledFinishRequestNeverInvokesNativeFinish(t *testing.T) {
	called := 0
	p := &mockPending{finish: func(_, _, _ []byte) ([]byte, error) {
		called++
		return testState().nativeBytes(), nil
	}}
	s := readyService(t, mockRuntime{})
	lockProvisionBoundary(t, s)
	vmCtx, cancelVM := context.WithCancel(context.Background())
	s.pending["pending"] = &pendingRecord{deviceID: testDevice, state: testState(), runtime: p, expires: time.Now().Add(time.Minute), ctx: vmCtx, cancel: cancelVM}
	ctx, cancelRequest := context.WithCancel(context.Background())
	cancelRequest()
	w := httptest.NewRecorder()
	// The HTTP request can be cancelled after it acquires the service gate and
	// before it reaches this native boundary. AfterFunc alone is asynchronous.
	s.provisionFinish(w, ctx, &proofRequest{deviceID: testDevice, pending: "pending"})
	if w.Code != http.StatusGatewayTimeout || called != 0 || p.closed != 1 || len(s.pending) != 0 || vmCtx.Err() == nil {
		t.Fatalf("Cancelled finish request ran: status=%d calls=%d closes=%d remaining=%d vmCancelled=%v", w.Code, called, p.closed, len(s.pending), vmCtx.Err() != nil)
	}
	// Even a cancelled admitted finish consumes its single-use handle once.
	w = httptest.NewRecorder()
	s.provisionFinish(w, context.Background(), &proofRequest{deviceID: testDevice, pending: "pending"})
	if w.Code != http.StatusGone || called != 0 || p.closed != 1 {
		t.Fatalf("Consumed cancelled handle was reused: status=%d calls=%d closes=%d", w.Code, called, p.closed)
	}
}
