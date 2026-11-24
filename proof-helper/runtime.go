package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/majd/ipatool/v2/internal/sap/assets"
	"github.com/majd/ipatool/v2/internal/sap/machine"
	"github.com/majd/ipatool/v2/internal/store/emulator"
	"github.com/majd/ipatool/v2/internal/store/profile"
	"github.com/majd/ipatool/v2/internal/storeauth"
)

type nativeRuntime struct{}

func (nativeRuntime) Prepare(ctx context.Context) error {
	bundle, err := assets.Load(ctx)
	if err != nil {
		return err
	}
	prepared, err := profile.Load(ctx)
	if err != nil {
		return err
	}
	identifier := make([]byte, 16)
	if _, err := rand.Read(identifier); err != nil {
		return err
	}
	adi, err := machine.OpenModernADI(ctx, bundle, identifier, nil)
	if err != nil {
		return err
	}
	if err := adi.Close(); err != nil {
		return err
	}
	framework, err := emulator.Open(ctx, bundle.AppleMediaServices, prepared)
	if err != nil {
		return err
	}
	return framework.Close()
}

func (nativeRuntime) Bootstrap(ctx context.Context, encoded []byte) (http.Header, []byte, error) {
	// This client has no account cookie jar. Its only requests are the pinned
	// public machine-provisioning endpoints used by the upstream implementation.
	return storeauth.AnisetteHeaders(ctx, storeauth.NewHTTPClient(nil), encoded)
}

func (nativeRuntime) Proof(ctx context.Context, encoded []byte, endpoint string, hardwareID []byte) (map[string]string, []byte, error) {
	return storeauth.StoreAMDHeaders(ctx, encoded, endpoint, hardwareID)
}

func (nativeRuntime) KBSync(ctx context.Context, hardwareID []byte, dsid uint64) ([]byte, error) {
	bundle, err := assets.Load(ctx)
	if err != nil {
		return nil, err
	}
	return machine.GenerateKBSync(ctx, bundle, hardwareID, dsid)
}

func (n nativeRuntime) Start(ctx context.Context, encoded, challenge, hardwareID []byte) (pendingRuntime, []byte, []byte, error) {
	state, err := decodeNative(encoded)
	if err != nil {
		return nil, nil, nil, err
	}
	bundle, err := assets.Load(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	adi, err := machine.OpenModernADI(ctx, bundle, state.Identifier, nil)
	if err != nil {
		return nil, nil, nil, err
	}
	clientData, session, err := adi.StartProvisioning(^uint64(0), challenge)
	if err != nil {
		_ = adi.Close()
		return nil, nil, nil, err
	}
	// Store provisioning uses the machine DSID, not an Apple account DSID.
	kbsync, err := n.KBSync(ctx, hardwareID, ^uint64(1))
	if err != nil {
		_ = adi.Close()
		return nil, nil, nil, err
	}
	return &nativePending{adi: adi, state: state, session: session, hardwareID: append([]byte(nil), hardwareID...)}, clientData, kbsync, nil
}

// The two stages mirror upstream store_provisioning.go, but the browser sends
// /auth/v1/otp/1.5/finish itself so its cookies never enter this process.
type nativePending struct {
	adi        *machine.ModernADI
	state      nativeState
	session    uint32
	hardwareID []byte
}

func (p *nativePending) Finish(settingInfo, transportKey, keybag []byte) ([]byte, error) {
	if p.adi == nil {
		return nil, errors.New("provisioning session is closed")
	}
	if err := p.adi.EndProvisioning(p.session, settingInfo, transportKey); err != nil {
		return nil, err
	}
	if len(keybag) != 0 {
		if err := p.adi.ImportKeyBag(p.hardwareID, keybag); err != nil {
			return nil, err
		}
	}
	var err error
	p.state.Provisioning, err = p.adi.State()
	if err != nil {
		return nil, err
	}
	return json.Marshal(p.state)
}

func (p *nativePending) Close() error {
	if p.adi == nil {
		return nil
	}
	err := p.adi.Close()
	p.adi = nil
	return err
}
