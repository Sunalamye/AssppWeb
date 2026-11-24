package main

import (
	"bufio"
	"encoding/json"
	"os"
	"testing"
)

func TestProvisionPolicyAgainstLean(t *testing.T) {
	name := os.Getenv("ASSPP_FORMAL_VECTORS")
	if name == "" {
		t.Skip("Run npm run verify:formal to generate and compare the Lean oracle")
	}
	file, err := os.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	seen := map[[4]bool]bool{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var row struct {
			Suite string `json:"suite"`
			Input struct {
				Present       bool `json:"present"`
				DeviceMatches bool `json:"deviceMatches"`
				Expired       bool `json:"expired"`
				Cancelled     bool `json:"cancelled"`
			} `json:"input"`
			Expected json.RawMessage `json:"expected"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &row); err != nil {
			t.Fatal(err)
		}
		if row.Suite != "provision" {
			continue
		}
		var expected provisionDecision
		if err := json.Unmarshal(row.Expected, &expected); err != nil {
			t.Fatal(err)
		}
		f := row.Input
		key := [4]bool{f.Present, f.DeviceMatches, f.Expired, f.Cancelled}
		if seen[key] {
			t.Fatalf("Duplicate Lean provision input: %v", key)
		}
		seen[key] = true
		if actual := decideProvisionFinish(f.Present, f.DeviceMatches, f.Expired, f.Cancelled); actual != expected {
			t.Fatalf("Lean/Go mismatch: input=%v expected=%s actual=%s", key, expected, actual)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 16 {
		t.Fatalf("Expected all 16 Lean provisioning decisions, got %d", len(seen))
	}
}
