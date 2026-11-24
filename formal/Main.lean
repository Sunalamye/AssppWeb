import Asspp
import Lean

open Asspp Lean

def stateName : DownloadState → String
  | .pending => "pending"
  | .downloading => "downloading"
  | .paused => "paused"
  | .injecting => "injecting"
  | .completed => "completed"
  | .failed => "failed"
  | .deleted => "deleted"

def eventName : DownloadEvent → String
  | .start => "start"
  | .pause => "pause"
  | .resume => "resume"
  | .compile => "compile"
  | .complete => "complete"
  | .fail => "fail"
  | .delete => "delete"
  | .deleteFailed => "deleteFailed"

def statusName : ResponseStatus → String
  | .missing => "missing" | .zero => "zero" | .rejected => "rejected"

def failureName : DownloadFailure → String
  | .none => "none" | .unavailable => "unavailable" | .other => "other"

def messageName : DownloadMessage → String
  | .none => "none" | .unavailable => "unavailable" | .generic => "generic" | .other => "other"

def downloadDecisionName : DownloadDecision → String
  | .items => "items" | .fallback => "fallback" | .reject => "reject"

def authFailureName : AuthFailure → String
  | .none => "none" | .retryCredentials => "retryCredentials" | .other => "other"

def authMessageName : AuthMessage → String
  | .none => "none" | .verification => "verification" | .disabled => "disabled" | .other => "other"

def authDecisionName : AuthDecision → String
  | .reject => "reject" | .retry_credentials => "retry_credentials"
  | .verification => "verification" | .authenticated => "authenticated"

def provisionDecisionName : ProvisionDecision → String
  | .reject => "reject" | .expire => "expire" | .consume => "consume"

def output (out : IO.FS.Stream) (suite : String) (input expected : Json) : IO Unit :=
  out.putStrLn (Json.mkObj [("suite", toJson suite), ("input", input), ("expected", expected)]).compress

def emitChunk (out : IO.FS.Stream) (f : ChunkFacts) : IO Unit :=
  output out "chunk" (Json.mkObj [
    ("status", toJson f.status), ("validRange", toJson f.validRange),
    ("start", toJson f.start), ("end", toJson f.stop), ("total", toJson f.total),
    ("expectedStart", toJson f.expectedStart), ("expectedEnd", toJson f.expectedEnd),
    ("expectedTotal", toJson f.expectedTotal), ("actualBytes", toJson f.actualBytes)
  ]) (toJson (acceptChunk f))

def main : IO Unit := do
  let out ← IO.getStdout
  let bools := [false, true]
  let states : List DownloadState := [.pending, .downloading, .paused, .injecting, .completed, .failed, .deleted]
  let events : List DownloadEvent := [.start, .pause, .resume, .compile, .complete, .fail, .delete, .deleteFailed]
  for state in states do
    for event in events do
      for current in bools do
        output out "lifecycle" (Json.mkObj [
          ("state", toJson (stateName state)), ("event", toJson (eventName event)),
          ("currentGeneration", toJson current)
        ]) (toJson (stateName (transitionDownload state event current)))
  for valid in bools do
    for dialog in bools do
      for action in bools do
        for status in ([.missing, .zero, .rejected] : List ResponseStatus) do
          for items in bools do
            for failure in ([.none, .unavailable, .other] : List DownloadFailure) do
              for message in ([.none, .unavailable, .generic, .other] : List DownloadMessage) do
                let f : DownloadFacts := ⟨valid, dialog, action, status, items, failure, message⟩
                output out "download" (Json.mkObj [
                  ("validShape", toJson valid), ("dialogPresent", toJson dialog),
                  ("actionPresent", toJson action), ("status", toJson (statusName status)),
                  ("itemsPresent", toJson items), ("failure", toJson (failureName failure)),
                  ("message", toJson (messageName message))
                ]) (toJson (downloadDecisionName (decideDownloadResponse f)))
  for valid in bools do
    for dialog in bools do
      for action in bools do
        for rejected in bools do
          for failure in ([.none, .retryCredentials, .other] : List AuthFailure) do
            for message in ([.none, .verification, .disabled, .other] : List AuthMessage) do
              for first in bools do
                for http in bools do
                  for token in bools do
                    for dsid in bools do
                      let f : AuthFacts := ⟨valid, dialog, action, rejected, failure, message, first, http, token, dsid⟩
                      output out "auth" (Json.mkObj [
                        ("validShape", toJson valid), ("dialogPresent", toJson dialog),
                        ("actionPresent", toJson action), ("rejectedStatus", toJson rejected),
                        ("failure", toJson (authFailureName failure)), ("message", toJson (authMessageName message)),
                        ("firstAttempt", toJson first), ("httpOk", toJson http),
                        ("hasToken", toJson token), ("hasDsid", toJson dsid)
                      ]) (toJson (authDecisionName (decideAuthResponse f)))
  for present in bools do
    for sameDevice in bools do
      for expired in bools do
        for cancelled in bools do
          let f : ProvisionFacts := ⟨present, sameDevice, expired, cancelled⟩
          output out "provision" (Json.mkObj [
            ("present", toJson present), ("deviceMatches", toJson sameDevice),
            ("expired", toJson expired), ("cancelled", toJson cancelled)
          ]) (toJson (provisionDecisionName (decideProvisionFinish f)))
  -- Exhaustive small expected ranges, every response field independently varied.
  -- Arbitrary naturals are covered by the theorems; these vectors check translation.
  for total in List.range 9 do
    for start in List.range 10 do
      for stop in List.range 10 do
        let f : ChunkFacts := ⟨206, true, start, stop, total, start, stop, total, stop - start + 1⟩
        emitChunk out f
        for v in List.range 11 do
          emitChunk out { f with start := v }
          emitChunk out { f with stop := v }
          emitChunk out { f with total := v }
          emitChunk out { f with actualBytes := v }
        for status in [0, 200, 204, 205, 207, 302, 416, 500] do
          emitChunk out { f with status := status }
        emitChunk out { f with validRange := false }
  -- Large exact integers, including JavaScript's maximum safe integer.
  for total in [65536, 1048576, 2147483647, 4294967296, 9007199254740991] do
    for start in [0, total / 2, total - 1] do
      let f : ChunkFacts := ⟨206, true, start, total - 1, total, start, total - 1, total, total - start⟩
      emitChunk out f
      emitChunk out { f with actualBytes := total - start - 1 }
      emitChunk out { f with actualBytes := total - start + 1 }
