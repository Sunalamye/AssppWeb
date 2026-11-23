// asspp-proof is a loopback-only, credential-free adapter around pinned ipatool
// device proof APIs. Build it inside that upstream module (see README.md).
package main

import (
	"context"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	prepareOnly := flag.Bool("prepare", false, "cache and verify public native runtime assets, then exit")
	flag.Parse()
	if flag.NArg() != 0 {
		log.Print("Unexpected command arguments.")
		os.Exit(2)
	}
	runtime := nativeRuntime{}
	if *prepareOnly {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if runtime.Prepare(ctx) != nil {
			log.Print("Public proof runtime preparation failed.")
			os.Exit(1)
		}
		log.Print("Public proof runtime is ready.")
		return
	}
	service := newProofService(runtime)
	defer service.Close()
	go func() {
		ctx, cancel := context.WithTimeout(service.ctx, 10*time.Minute)
		defer cancel()
		if service.prepare(ctx) != nil {
			if service.ctx.Err() != nil {
				return // A normal SIGTERM must not become a startup failure.
			}
			log.Print("Device proof runtime preparation failed.")
			// No proof requests are accepted before preparation succeeds. Exit
			// so the container supervisor can recycle an unavailable runtime.
			os.Exit(1)
		}
		log.Print("Device proof runtime is ready.")
	}()
	server := &http.Server{
		Addr: "127.0.0.1:8081", Handler: service,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: requestTimeout + 5*time.Second, IdleTimeout: 30 * time.Second,
		MaxHeaderBytes: 16 << 10,
		// ServeHTTP handles and sanitizes panics. Avoid any accidental body or
		// native buffer output from net/http's fallback error logger as well.
		ErrorLog: log.New(io.Discard, "", 0),
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		<-signals
		service.cancel()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Print("Device proof listener failed.")
	}
}
