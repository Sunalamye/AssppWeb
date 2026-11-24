package main

import (
	"context"
	"net/http"
)

const sourceRevision = "3b02b4c55576562f2a55284cda9db9a4411d3067"

// Keep the service contract independent of native loading so the actual HTTP
// service and cancellation logic can be tested using only the Go standard library.
type proofRuntime interface {
	Prepare(context.Context) error
	Bootstrap(context.Context, []byte) (http.Header, []byte, error)
	Proof(context.Context, []byte, string, []byte) (map[string]string, []byte, error)
	Start(context.Context, []byte, []byte, []byte) (pendingRuntime, []byte, []byte, error)
	KBSync(context.Context, []byte, uint64) ([]byte, error)
}

type pendingRuntime interface {
	Finish(settingInfo, transportKey, keybag []byte) ([]byte, error)
	Close() error
}
