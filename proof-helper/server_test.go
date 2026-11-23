package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testDevice = "001122AABBCC"
const testEndpoint = "https://auth.itunes.apple.com/auth/v1/native"

type mockRuntime struct {
	prepare   func(context.Context) error
	bootstrap func(context.Context, []byte) (http.Header, []byte, error)
	proof     func(context.Context, []byte, string, []byte) (map[string]string, []byte, error)
	start     func(context.Context, []byte, []byte, []byte) (pendingRuntime, []byte, []byte, error)
	kbsync    func(context.Context, []byte, uint64) ([]byte, error)
}

func (m mockRuntime) Prepare(ctx context.Context) error {
	if m.prepare != nil {
		return m.prepare(ctx)
	}
	return nil
}

func (m mockRuntime) Bootstrap(ctx context.Context, state []byte) (http.Header, []byte, error) {
	if m.bootstrap == nil {
		panic("unexpected bootstrap")
	}
	return m.bootstrap(ctx, state)
}

func (m mockRuntime) Proof(ctx context.Context, state []byte, endpoint string, hardwareID []byte) (map[string]string, []byte, error) {
	if m.proof == nil {
		panic("unexpected proof")
	}
	return m.proof(ctx, state, endpoint, hardwareID)
}

func (m mockRuntime) Start(ctx context.Context, state, challenge, hardwareID []byte) (pendingRuntime, []byte, []byte, error) {
	if m.start == nil {
		panic("unexpected start")
	}
	return m.start(ctx, state, challenge, hardwareID)
}

func (m mockRuntime) KBSync(ctx context.Context, hardwareID []byte, dsid uint64) ([]byte, error) {
	if m.kbsync == nil {
		panic("unexpected kbsync")
	}
	return m.kbsync(ctx, hardwareID, dsid)
}

type mockPending struct {
	finish func([]byte, []byte, []byte) ([]byte, error)
	closed int
}

func (m *mockPending) Finish(setting, transport, keybag []byte) ([]byte, error) {
	return m.finish(setting, transport, keybag)
}

func (m *mockPending) Close() error {
	m.closed++
	return nil
}

func testState() *stateEnvelope {
	return &stateEnvelope{
		Version: 1, DeviceID: testDevice,
		Native:          nativeState{Identifier: []byte("0123456789abcdef"), Provisioning: []byte("general-device-state"), RoutingInfo: 1},
		IdentityHeaders: map[string]string{"X-Apple-I-MD-LU": "dummy-machine-identifier", "X-Mme-Device-Id": "dummy-device-identifier"},
	}
}

func encodedTestState(t *testing.T) string {
	t.Helper()
	value, err := encodeState(testState())
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func readyService(t *testing.T, runtime proofRuntime) *proofService {
	t.Helper()
	s := newProofService(runtime)
	s.ready.Store(1)
	t.Cleanup(s.Close)
	return s
}

func callJSON(t *testing.T, s *proofService, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/v1/proof", bytes.NewReader(data))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	var result map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	return w, result
}

func TestRejectsCredentialFieldsAndAmbiguousJSON(t *testing.T) {
	s := readyService(t, mockRuntime{})
	for _, field := range []string{"password", "appleId", "email", "cookie", "cookies", "token", "body", "headers", "authorization", "dsid"} {
		t.Run(field, func(t *testing.T) {
			w, _ := callJSON(t, s, map[string]string{"operation": "bootstrap", "deviceId": testDevice, "endpoint": testEndpoint, field: "do-not-reflect-this"})
			if w.Code != http.StatusBadRequest || strings.Contains(w.Body.String(), "do-not-reflect-this") {
				t.Fatalf("unexpected response: %d %s", w.Code, w.Body.String())
			}
		})
	}
	for _, data := range []string{
		`{"operation":"bootstrap","operation":"kbsync","deviceId":"001122AABBCC","dsid":"1"}`,
		`{"operation":"kbsync","deviceId":"001122AABBCC","dsid":"1"} {}`,
		`{"operation":"kbsync","deviceId":"001122AABBCC","dsid":1}`,
		`{"operation":"kbsync","deviceId":"001122AABBCC","dsid":null}`,
		`{"operation":"kbsync","deviceId":"001122AABBCC","dsid":"0"}`,
		`{"operation":"kbsync","deviceId":"001122AABBCC","dsid":"18446744073709551616"}`,
		`{"operation":"kbsync","deviceId":"001122AABBCC","dsid":"+1"}`,
	} {
		if _, err := decodeRequest([]byte(data)); err == nil {
			t.Errorf("accepted invalid request %s", data)
		}
	}
}

func TestEndpointAllowlistAndGUIDBinding(t *testing.T) {
	allowed := []string{
		testEndpoint,
		testEndpoint + "/fast/",
		testEndpoint + "?guid=001122aabbcc",
		"https://p71-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
		"https://p71-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=001122aabbcc",
		"https://downloaddispatch.itunes.apple.com/r/redownload?guid=001122AABBCC",
		"https://downloaddispatch.itunes.apple.com/up/updateProduct?guid=001122AABBCC",
		"https://downloaddispatch.itunes.apple.com/WebObjects/DownloadDispatch.woa/wa/ent/download?guid=001122AABBCC",
	}
	for _, endpoint := range allowed {
		if !validEndpoint(endpoint, testDevice, false) {
			t.Errorf("rejected approved endpoint %s", endpoint)
		}
	}
	denied := []string{
		"http://auth.itunes.apple.com/auth/v1/native",
		"https://auth.itunes.apple.com.attacker.invalid/auth/v1/native",
		"https://attacker@auth.itunes.apple.com/auth/v1/native",
		"https://auth.itunes.apple.com:443/auth/v1/native",
		testEndpoint + "#",
		testEndpoint + "?",
		testEndpoint + "?guid=001122AABBCC&guid=001122AABBCC",
		testEndpoint + "?guid=001122AABBCC&x=1",
		testEndpoint + "?guid=001122AABBCD",
		testEndpoint + "?token=credential",
		"https://auth.itunes.apple.com/auth/v1/%6eative",
		"https://auth.itunes.apple.com/auth/v1/native/../otp/1.5/finish",
		"https://localhost/auth/v1/native",
		"https://downloaddispatch.itunes.apple.com/r/redownload",
	}
	for _, endpoint := range denied {
		if validEndpoint(endpoint, testDevice, false) {
			t.Errorf("accepted disallowed endpoint %s", endpoint)
		}
	}
	if validEndpoint(allowed[4], testDevice, true) {
		t.Error("bootstrap accepted a commerce endpoint")
	}
}

func TestBootstrapNormalizesHeadersAndReusesClientState(t *testing.T) {
	bootstraps, proofs := 0, 0
	s := readyService(t, mockRuntime{
		bootstrap: func(ctx context.Context, state []byte) (http.Header, []byte, error) {
			bootstraps++
			return http.Header{
				"X-Apple-I-MD": {"dummy-otp"}, "X-Apple-I-MD-M": {"dummy-mid"},
				"X-Apple-I-MD-RINFO": {"1"}, "X-Mme-Device-Id": {"dummy-device"},
			}, testState().nativeBytes(), nil
		},
		proof: func(ctx context.Context, state []byte, endpoint string, hardware []byte) (map[string]string, []byte, error) {
			proofs++
			if endpoint != testEndpoint || !bytes.Equal(hardware, []byte{0, 0x11, 0x22, 0xaa, 0xbb, 0xcc}) {
				t.Fatal("changed endpoint or hardware identity")
			}
			return map[string]string{"X-Apple-AMD": "store-otp", "X-Apple-AMD-M": "store-mid"}, state, nil
		},
	})
	w, result := callJSON(t, s, map[string]string{"operation": "bootstrap", "deviceId": strings.ToLower(testDevice), "endpoint": testEndpoint})
	if w.Code != 200 || result["mode"] != "bootstrap" {
		t.Fatalf("unexpected bootstrap: %d %s", w.Code, w.Body.String())
	}
	headers := result["headers"].(map[string]any)
	if headers["X-Apple-AMD"] != "dummy-otp" || headers["X-Apple-AMD-M"] != "dummy-mid" || headers["X-Apple-I-MD"] != nil {
		t.Fatal("general proof headers were not normalized")
	}
	encoded := result["state"].(string)
	state, err := decodeState(encoded, testDevice)
	if err != nil || state.IdentityHeaders["X-Apple-I-MD-RINFO"] != "" || state.IdentityHeaders["X-Apple-AMD"] != "" {
		t.Fatal("identity state contains proof headers")
	}
	if _, err := decodeState(encoded, "001122AABBCD"); err == nil {
		t.Fatal("state is not bound to device")
	}
	w, result = callJSON(t, s, map[string]string{"operation": "bootstrap", "deviceId": testDevice, "endpoint": testEndpoint, "state": encoded})
	if w.Code != 200 || result["mode"] != "store" || bootstraps != 1 || proofs != 1 {
		t.Fatalf("existing state was not reused: %d %s", w.Code, w.Body.String())
	}
	if len(s.pending) != 0 {
		t.Fatal("bootstrap stored server-side device state")
	}
}

func TestProvisioningContextSurvivesStartAndHandleIsSingleUse(t *testing.T) {
	var vmContext context.Context
	finished := 0
	p := &mockPending{finish: func(setting, transport, keybag []byte) ([]byte, error) {
		finished++
		if string(setting) != "setting" || string(transport) != "transport" || string(keybag) != "keybag" {
			t.Fatal("incorrect provisioning values")
		}
		state := testState()
		state.Native.Provisioning = []byte("store-device-state")
		return state.nativeBytes(), nil
	}}
	s := readyService(t, mockRuntime{start: func(ctx context.Context, state, challenge, hardware []byte) (pendingRuntime, []byte, []byte, error) {
		vmContext = ctx
		return p, []byte("client-data"), []byte("kbsync"), nil
	}})
	data, _ := json.Marshal(map[string]string{"operation": "provision-start", "deviceId": testDevice, "state": encodedTestState(t), "challenge": base64.StdEncoding.EncodeToString([]byte("challenge"))})
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest(http.MethodPost, "/v1/proof", bytes.NewReader(data)).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	cancel()
	if w.Code != 200 || vmContext.Err() != nil {
		t.Fatalf("start runtime did not survive HTTP completion: %d %s", w.Code, w.Body.String())
	}
	var started map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &started)
	handle := started["pending"].(string)
	finish := map[string]string{
		"operation": "provision-finish", "deviceId": "001122AABBCD", "pending": handle,
		"settingInfo":  base64.StdEncoding.EncodeToString([]byte("setting")),
		"transportKey": base64.StdEncoding.EncodeToString([]byte("transport")),
		"keybag":       base64.StdEncoding.EncodeToString([]byte("keybag")),
	}
	w, _ = callJSON(t, s, finish)
	if w.Code != 410 || finished != 0 || p.closed != 0 {
		t.Fatal("another device consumed the provisioning handle")
	}
	finish["deviceId"] = testDevice
	w, result := callJSON(t, s, finish)
	if w.Code != 200 || finished != 1 || p.closed != 1 || vmContext.Err() == nil {
		t.Fatalf("finish did not close the retained runtime: %d %s", w.Code, w.Body.String())
	}
	state, err := decodeState(result["state"].(string), testDevice)
	if err != nil || string(state.Native.Provisioning) != "store-device-state" {
		t.Fatal("finish did not return updated client state")
	}
	w, _ = callJSON(t, s, finish)
	if w.Code != 410 || finished != 1 {
		t.Fatal("provisioning handle was replayed")
	}
}

func TestPendingCapacityAndExpiry(t *testing.T) {
	var pending []*mockPending
	s := readyService(t, mockRuntime{start: func(ctx context.Context, state, challenge, hardware []byte) (pendingRuntime, []byte, []byte, error) {
		p := &mockPending{}
		pending = append(pending, p)
		return p, []byte("client-data"), []byte("kbsync"), nil
	}})
	now := time.Now()
	s.now = func() time.Time { return now }
	body := map[string]string{"operation": "provision-start", "deviceId": testDevice, "state": encodedTestState(t), "challenge": "Y2hhbGxlbmdl"}
	for i := 0; i < maxPending; i++ {
		w, _ := callJSON(t, s, body)
		if w.Code != 200 {
			t.Fatalf("pending %d failed: %d", i, w.Code)
		}
	}
	w, _ := callJSON(t, s, body)
	if w.Code != 429 || len(pending) != maxPending {
		t.Fatal("pending VM capacity was not enforced")
	}
	now = now.Add(3 * time.Minute)
	w, _ = callJSON(t, s, body)
	if w.Code != 200 || pending[0].closed != 1 || pending[1].closed != 1 || len(s.pending) != 1 {
		t.Fatal("expired pending VMs were not closed and released")
	}
}

func TestErrorsDoNotReflectNativeData(t *testing.T) {
	s := readyService(t, mockRuntime{kbsync: func(ctx context.Context, hardware []byte, dsid uint64) ([]byte, error) {
		return nil, errors.New("private-buffer-password-cookie-token")
	}})
	w, _ := callJSON(t, s, map[string]string{"operation": "kbsync", "deviceId": testDevice, "dsid": "123456"})
	if w.Code != 502 || strings.Contains(w.Body.String(), "private-buffer") {
		t.Fatal("native data was returned in an error")
	}
}

func TestRequestSizeLimit(t *testing.T) {
	s := readyService(t, mockRuntime{})
	r := httptest.NewRequest(http.MethodPost, "/v1/proof", strings.NewReader(strings.Repeat(" ", maxRequestBytes+1)))
	r.ContentLength = -1 // exercise the streaming limit, not just Content-Length
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 413 {
		t.Fatalf("oversized request returned %d", w.Code)
	}
}

func TestNativeJobsAreSerializedAndQueuedRequestsCanCancel(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	s := readyService(t, mockRuntime{kbsync: func(ctx context.Context, hardware []byte, dsid uint64) ([]byte, error) {
		if calls.Add(1) != 1 {
			return nil, errors.New("overlapping native jobs")
		}
		close(started)
		select {
		case <-release:
			return []byte("kbsync"), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}})
	body := fmt.Sprintf(`{"operation":"kbsync","deviceId":%q,"dsid":"123"}`, testDevice)
	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		r := httptest.NewRequest(http.MethodPost, "/v1/proof", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		firstDone <- w
	}()
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest(http.MethodPost, "/v1/proof", strings.NewReader(body)).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	secondDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		secondDone <- w
	}()
	cancel()
	if w := <-secondDone; w.Code != 504 {
		t.Fatalf("cancelled queued request returned %d", w.Code)
	}
	close(release)
	if w := <-firstDone; w.Code != 200 || calls.Load() != 1 {
		t.Fatal("native job serialization failed")
	}
}

func TestStateRejectsUnknownFieldsAndHeaderInjection(t *testing.T) {
	state := testState()
	state.IdentityHeaders["Cookie"] = "should-never-be-accepted"
	encoded, _ := encodeState(state)
	if _, err := decodeState(encoded, testDevice); err == nil {
		t.Fatal("state accepted cookie header")
	}
	state = testState()
	state.IdentityHeaders["X-Mme-Device-Id"] = "value\r\nCookie: injected"
	encoded, _ = encodeState(state)
	if _, err := decodeState(encoded, testDevice); err == nil {
		t.Fatal("state accepted header injection")
	}
	data, _ := json.Marshal(testState())
	data = bytes.Replace(data, []byte(`"version":1`), []byte(`"version":1,"password":"forbidden"`), 1)
	if _, err := decodeState(base64.StdEncoding.EncodeToString(data), testDevice); err == nil {
		t.Fatal("state accepted unknown fields")
	}
}

func TestHealthPreparationStates(t *testing.T) {
	s := newProofService(mockRuntime{})
	t.Cleanup(s.Close)
	health := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health", nil))
		return w
	}
	if w := health(); w.Code != 503 || !strings.Contains(w.Body.String(), `"loading"`) {
		t.Fatal("health did not report loading")
	}
	if err := s.prepare(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w := health(); w.Code != 200 || !strings.Contains(w.Body.String(), `"ready"`) {
		t.Fatal("health did not report ready")
	}
}
