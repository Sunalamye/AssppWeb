package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const (
	maxRequestBytes = 4 << 20
	maxStateBytes   = 2 << 20
	maxNativeBytes  = 1 << 20
)

var (
	errInvalidRequest = errors.New("invalid request")
	devicePattern     = regexp.MustCompile(`^[a-fA-F0-9]{12}$`)
	buyHostPattern    = regexp.MustCompile(`^(?:buy|p[0-9]+-buy)\.itunes\.apple\.com$`)
	decimalPattern    = regexp.MustCompile(`^[0-9]{1,20}$`)
	pendingPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

type nativeState struct {
	Identifier   []byte
	Provisioning []byte
	RoutingInfo  uint64
}

// Only device proof state is round-tripped. This format deliberately has no
// fields for Apple account credentials, cookies, tokens, or signed requests.
type stateEnvelope struct {
	Version         int               `json:"version"`
	DeviceID        string            `json:"deviceId"`
	Native          nativeState       `json:"native"`
	IdentityHeaders map[string]string `json:"identityHeaders"`
}

var identityNames = map[string]string{
	"x-apple-i-client-time": "X-Apple-I-Client-Time",
	"x-apple-i-md-lu":       "X-Apple-I-MD-LU",
	"x-apple-i-srl-no":      "X-Apple-I-SRL-NO",
	"x-apple-i-timezone":    "X-Apple-I-TimeZone",
	"x-apple-locale":        "X-Apple-Locale",
	"x-mme-device-id":       "X-Mme-Device-Id",
	"x-mme-client-info":     "X-MMe-Client-Info",
}

var operationFields = map[string]map[string]bool{
	"bootstrap":        {"operation": true, "deviceId": true, "endpoint": true, "state": true},
	"proof":            {"operation": true, "deviceId": true, "endpoint": true, "state": true},
	"provision-start":  {"operation": true, "deviceId": true, "state": true, "challenge": true},
	"provision-finish": {"operation": true, "deviceId": true, "pending": true, "settingInfo": true, "transportKey": true, "keybag": true},
	"kbsync":           {"operation": true, "deviceId": true, "dsid": true},
}

type proofRequest struct {
	operation    string
	deviceID     string
	hardwareID   []byte
	endpoint     string
	state        *stateEnvelope
	challenge    []byte
	pending      string
	settingInfo  []byte
	transportKey []byte
	keybag       []byte
	dsid         uint64
}

func decodeRequest(data []byte) (*proofRequest, error) {
	var raw map[string]json.RawMessage
	if strictJSON(data, &raw) != nil || len(raw) == 0 {
		return nil, errInvalidRequest
	}
	values := make(map[string]string, len(raw))
	for key, value := range raw {
		var s string
		if bytes.Equal(value, []byte("null")) || json.Unmarshal(value, &s) != nil || s == "" {
			return nil, errInvalidRequest
		}
		values[key] = s
	}
	allowed, ok := operationFields[values["operation"]]
	if !ok || !devicePattern.MatchString(values["deviceId"]) {
		return nil, errInvalidRequest
	}
	for key := range values {
		if !allowed[key] {
			return nil, errInvalidRequest
		}
	}
	r := &proofRequest{operation: values["operation"], deviceID: strings.ToUpper(values["deviceId"])}
	r.hardwareID, _ = hex.DecodeString(r.deviceID)
	if encoded := values["state"]; encoded != "" {
		var err error
		r.state, err = decodeState(encoded, r.deviceID)
		if err != nil {
			return nil, errInvalidRequest
		}
	}
	if r.operation == "proof" || r.operation == "provision-start" {
		if r.state == nil {
			return nil, errInvalidRequest
		}
	}
	switch r.operation {
	case "bootstrap", "proof":
		r.endpoint = values["endpoint"]
		if !validEndpoint(r.endpoint, r.deviceID, r.operation == "bootstrap") {
			return nil, errInvalidRequest
		}
	case "provision-start":
		var err error
		r.challenge, err = decodeBlob(values["challenge"], maxNativeBytes)
		if err != nil {
			return nil, errInvalidRequest
		}
	case "provision-finish":
		r.pending = values["pending"]
		if !pendingPattern.MatchString(r.pending) {
			return nil, errInvalidRequest
		}
		var err error
		r.settingInfo, err = decodeBlob(values["settingInfo"], maxNativeBytes)
		if err != nil {
			return nil, errInvalidRequest
		}
		r.transportKey, err = decodeBlob(values["transportKey"], maxNativeBytes)
		if err != nil {
			return nil, errInvalidRequest
		}
		if value := values["keybag"]; value != "" {
			r.keybag, err = decodeBlob(value, maxNativeBytes)
			if err != nil {
				return nil, errInvalidRequest
			}
		}
	case "kbsync":
		var err error
		if !decimalPattern.MatchString(values["dsid"]) {
			return nil, errInvalidRequest
		}
		r.dsid, err = strconv.ParseUint(values["dsid"], 10, 64)
		if err != nil || r.dsid == 0 {
			return nil, errInvalidRequest
		}
	}
	return r, nil
}

func validEndpoint(value, deviceID string, authOnly bool) bool {
	if len(value) == 0 || len(value) > 2048 || strings.ContainsAny(value, "\\#") {
		return false
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.Opaque != "" || u.RawPath != "" || u.Port() != "" || u.Host != u.Hostname() || u.ForceQuery {
		return false
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(query) > 1 {
		return false
	}
	if len(query) != 0 {
		guid, ok := query["guid"]
		if !ok || len(guid) != 1 || !strings.EqualFold(guid[0], deviceID) || u.RawQuery != "guid="+guid[0] {
			return false
		}
	}
	buyHost := buyHostPattern.MatchString(u.Host)
	auth := u.Host == "auth.itunes.apple.com" && (u.Path == "/auth/v1/native" || u.Path == "/auth/v1/native/" || u.Path == "/auth/v1/native/fast" || u.Path == "/auth/v1/native/fast/")
	auth = auth || (buyHost && (u.Path == "/WebObjects/MZFinance.woa/wa/authenticate" || u.Path == "/WebObjects/MZFinance.woa/wa/authenticate/"))
	if auth {
		return true
	}
	if authOnly || len(query) != 1 {
		return false
	}
	if buyHost && u.Path == "/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct" {
		return true
	}
	if u.Host == "downloaddispatch.itunes.apple.com" {
		return u.Path == "/r/redownload" || u.Path == "/up/updateProduct" || u.Path == "/WebObjects/DownloadDispatch.woa/wa/ent/download"
	}
	return false
}

func decodeBlob(value string, limit int) ([]byte, error) {
	if value == "" || len(value) > base64.StdEncoding.EncodedLen(limit) || strings.ContainsAny(value, "\r\n\t ") {
		return nil, errInvalidRequest
	}
	data, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || len(data) == 0 || len(data) > limit {
		return nil, errInvalidRequest
	}
	return data, nil
}

func validateNative(state nativeState) error {
	if len(state.Identifier) != 16 || len(state.Provisioning) > maxNativeBytes {
		return errInvalidRequest
	}
	return nil
}

func decodeNative(data []byte) (nativeState, error) {
	var state nativeState
	if len(data) > maxStateBytes || strictJSON(data, &state) != nil || validateNative(state) != nil {
		return state, errInvalidRequest
	}
	return state, nil
}

func decodeState(encoded, deviceID string) (*stateEnvelope, error) {
	data, err := decodeBlob(encoded, maxStateBytes)
	if err != nil {
		return nil, err
	}
	var state stateEnvelope
	if strictJSON(data, &state) != nil || state.Version != 1 || state.DeviceID != deviceID || validateNative(state.Native) != nil {
		return nil, errInvalidRequest
	}
	if state.IdentityHeaders == nil || len(state.IdentityHeaders) > len(identityNames) {
		return nil, errInvalidRequest
	}
	seen := map[string]bool{}
	for key, value := range state.IdentityHeaders {
		lower := strings.ToLower(key)
		if identityNames[lower] == "" || seen[lower] || !validHeaderValue(value) {
			return nil, errInvalidRequest
		}
		seen[lower] = true
	}
	return &state, nil
}

func encodeState(state *stateEnvelope) (string, error) {
	encoded, err := json.Marshal(state)
	if err != nil || len(encoded) > maxStateBytes {
		return "", errInvalidRequest
	}
	return base64.StdEncoding.EncodeToString(encoded), nil
}

func (s *stateEnvelope) nativeBytes() []byte {
	data, _ := json.Marshal(s.Native)
	return data
}

func validHeaderValue(value string) bool {
	if value == "" || len(value) > 32768 {
		return false
	}
	for _, b := range []byte(value) {
		if b < 0x20 || b > 0x7e {
			return false
		}
	}
	return true
}

func normalizeBootstrapHeaders(source http.Header) (map[string]string, map[string]string, error) {
	proof := make(map[string]string)
	identity := make(map[string]string)
	for key, values := range source {
		if len(values) != 1 || !validHeaderValue(values[0]) {
			return nil, nil, errInvalidRequest
		}
		lower := strings.ToLower(key)
		if canonical := identityNames[lower]; canonical != "" {
			proof[canonical] = values[0]
			identity[canonical] = values[0]
			continue
		}
		switch lower {
		case "x-apple-i-md":
			proof["X-Apple-AMD"] = values[0]
		case "x-apple-i-md-m":
			proof["X-Apple-AMD-M"] = values[0]
		case "x-apple-i-md-rinfo":
			proof["X-Apple-I-MD-RINFO"] = values[0]
		default:
			return nil, nil, errInvalidRequest
		}
	}
	if proof["X-Apple-AMD"] == "" || proof["X-Apple-AMD-M"] == "" {
		return nil, nil, errInvalidRequest
	}
	return proof, identity, nil
}

func normalizeStoreHeaders(source map[string]string) (map[string]string, error) {
	if len(source) != 2 {
		return nil, errInvalidRequest
	}
	result := make(map[string]string, 2)
	for key, value := range source {
		if !validHeaderValue(value) || len(value) > 8192 {
			return nil, errInvalidRequest
		}
		switch strings.ToLower(key) {
		case "x-apple-amd":
			result["X-Apple-AMD"] = value
		case "x-apple-amd-m":
			result["X-Apple-AMD-M"] = value
		default:
			return nil, errInvalidRequest
		}
	}
	if result["X-Apple-AMD"] == "" || result["X-Apple-AMD-M"] == "" {
		return nil, errInvalidRequest
	}
	return result, nil
}

// encoding/json otherwise accepts duplicate keys. Reject them, excessive
// nesting, unknown struct fields and trailing JSON before any native code runs.
func strictJSON(data []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	if err := checkJSONValue(d, 0); err != nil {
		return errInvalidRequest
	}
	if _, err := d.Token(); err != io.EOF {
		return errInvalidRequest
	}
	d = json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return errInvalidRequest
	}
	return nil
}

func checkJSONValue(d *json.Decoder, depth int) error {
	if depth > 16 {
		return errInvalidRequest
	}
	token, err := d.Token()
	if err != nil {
		return err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for d.More() {
			token, err := d.Token()
			if err != nil {
				return err
			}
			key, ok := token.(string)
			if !ok || seen[key] {
				return errInvalidRequest
			}
			seen[key] = true
			if err := checkJSONValue(d, depth+1); err != nil {
				return err
			}
		}
		end, err := d.Token()
		if err != nil || end != json.Delim('}') {
			return errInvalidRequest
		}
	case '[':
		for d.More() {
			if err := checkJSONValue(d, depth+1); err != nil {
				return err
			}
		}
		end, err := d.Token()
		if err != nil || end != json.Delim(']') {
			return errInvalidRequest
		}
	default:
		return errInvalidRequest
	}
	return nil
}
