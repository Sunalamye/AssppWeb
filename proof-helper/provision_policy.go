package main

// This decision is specified by formal/Asspp.lean and differentially checked
// against every Boolean input combination emitted by the Lean executable.
type provisionDecision string

const (
	provisionReject  provisionDecision = "reject"
	provisionExpire  provisionDecision = "expire"
	provisionConsume provisionDecision = "consume"
)

func decideProvisionFinish(present, deviceMatches, expired, cancelled bool) provisionDecision {
	if !present || !deviceMatches {
		return provisionReject
	}
	if expired || cancelled {
		return provisionExpire
	}
	return provisionConsume
}
