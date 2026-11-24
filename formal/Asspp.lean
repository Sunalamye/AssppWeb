/-
Executable specifications for AssppWeb's application-owned decisions.
External I/O, response extraction, JavaScript number representation, filesystem
atomicity, scheduler fairness, and Apple's behavior are separate assumptions.
-/
import Std

set_option maxRecDepth 4096
set_option maxHeartbeats 4000000

namespace Asspp

inductive DownloadState where
  | pending | downloading | paused | injecting | completed | failed | deleted
  deriving DecidableEq, BEq, Repr

inductive DownloadEvent where
  | start | pause | resume | compile | complete | fail | delete | deleteFailed
  deriving DecidableEq, BEq, Repr

def workerEvent : DownloadEvent → Bool
  | .start | .compile | .complete | .fail => true
  | _ => false

def transitionDownload (s : DownloadState) (e : DownloadEvent) (current : Bool) : DownloadState :=
  if workerEvent e && !current then s else
  match e, s with
  | .delete, _ => .deleted
  | .deleteFailed, .deleted => .deleted
  | .deleteFailed, _ => .failed
  | .start, .pending => .downloading
  | .pause, .downloading => .paused
  | .resume, .paused => .pending
  | .compile, .downloading => .injecting
  | .complete, .downloading | .complete, .injecting => .completed
  | .fail, .pending | .fail, .downloading | .fail, .injecting => .failed
  | _, _ => s

def runDownloads : DownloadState → List (DownloadEvent × Bool) → DownloadState
  | s, [] => s
  | s, (e, current) :: rest => runDownloads (transitionDownload s e current) rest

theorem stale_worker_cannot_change (s : DownloadState) (e : DownloadEvent)
    (h : workerEvent e = true) : transitionDownload s e false = s := by
  simp [transitionDownload, h]

theorem deleted_is_absorbing (e : DownloadEvent) (current : Bool) :
    transitionDownload .deleted e current = .deleted := by
  cases e <;> cases current <;> decide

theorem deleted_stays_deleted_for_any_trace (events : List (DownloadEvent × Bool)) :
    runDownloads .deleted events = .deleted := by
  induction events with
  | nil => rfl
  | cons event rest ih =>
    simp only [runDownloads, deleted_is_absorbing, ih]

theorem completed_rejects_worker (e : DownloadEvent) (current : Bool)
    (h : workerEvent e = true) : transitionDownload .completed e current = .completed := by
  cases e <;> cases current <;> simp_all [workerEvent, transitionDownload]

theorem paused_rejects_worker (e : DownloadEvent) (current : Bool)
    (h : workerEvent e = true) : transitionDownload .paused e current = .paused := by
  cases e <;> cases current <;> simp_all [workerEvent, transitionDownload]

theorem delete_always_tombstones (s : DownloadState) (current : Bool) :
    transitionDownload s .delete current = .deleted := by
  cases s <;> cases current <;> decide

theorem completion_has_live_predecessor (s : DownloadState) (current : Bool)
    (h : transitionDownload s .complete current = .completed) :
    s = .completed ∨ (current = true ∧ (s = .downloading ∨ s = .injecting)) := by
  cases s <;> cases current <;> simp_all [transitionDownload, workerEvent]

/-- An admitted successful trace progresses; scheduling these events is external. -/
theorem successful_download_trace_completes :
    runDownloads .pending [(.start, true), (.compile, true), (.complete, true)] =
      .completed := by
  decide

/-- Pausing and resuming each changes state, and a fresh worker can then finish. -/
theorem pause_resume_trace_completes :
    transitionDownload .downloading .pause true = .paused ∧
    transitionDownload .paused .resume true = .pending ∧
    runDownloads .downloading
      [(.pause, true), (.resume, true), (.start, true), (.compile, true), (.complete, true)] =
      .completed := by
  decide

structure ChunkFacts where
  status : Nat
  validRange : Bool
  start : Nat
  stop : Nat
  total : Nat
  expectedStart : Nat
  expectedEnd : Nat
  expectedTotal : Nat
  actualBytes : Nat
  deriving Repr

def chunkContract (f : ChunkFacts) : Prop :=
  f.status = 206 ∧ f.validRange = true ∧
    0 < f.expectedTotal ∧ f.expectedStart ≤ f.expectedEnd ∧ f.expectedEnd < f.expectedTotal ∧
    f.start = f.expectedStart ∧ f.stop = f.expectedEnd ∧ f.total = f.expectedTotal ∧
    f.actualBytes = f.expectedEnd - f.expectedStart + 1

instance (f : ChunkFacts) : Decidable (chunkContract f) := inferInstanceAs (Decidable (_ ∧ _))

def chunkSafeNumbers (f : ChunkFacts) : Prop :=
  f.start ≤ 9007199254740991 ∧ f.stop ≤ 9007199254740991 ∧ f.total ≤ 9007199254740991 ∧
    f.expectedStart ≤ 9007199254740991 ∧ f.expectedEnd ≤ 9007199254740991 ∧
    f.expectedTotal ≤ 9007199254740991 ∧ f.actualBytes ≤ 9007199254740991

instance (f : ChunkFacts) : Decidable (chunkSafeNumbers f) := inferInstanceAs (Decidable (_ ∧ _))

/-- The extraction boundary additionally rejects NaN, infinities, fractions and negatives. -/
def acceptChunk (f : ChunkFacts) : Bool := decide (chunkContract f ∧ chunkSafeNumbers f)

theorem accepted_chunk_is_exact (f : ChunkFacts) (h : acceptChunk f = true) :
    f.status = 206 ∧ f.validRange = true ∧
    f.start = f.expectedStart ∧ f.stop = f.expectedEnd ∧ f.total = f.expectedTotal ∧
    f.actualBytes = f.expectedEnd - f.expectedStart + 1 := by
  simp only [acceptChunk, decide_eq_true_eq] at h
  have h := h.1
  exact ⟨h.1, h.2.1, h.2.2.2.2.2.1, h.2.2.2.2.2.2.1,
    h.2.2.2.2.2.2.2.1, h.2.2.2.2.2.2.2.2⟩

theorem accepted_chunk_bounds (f : ChunkFacts) (h : acceptChunk f = true) :
    0 < f.expectedTotal ∧ f.expectedStart ≤ f.expectedEnd ∧ f.expectedEnd < f.expectedTotal := by
  simp only [acceptChunk, decide_eq_true_eq] at h
  have h := h.1
  exact ⟨h.2.2.1, h.2.2.2.1, h.2.2.2.2.1⟩

theorem ignored_range_is_rejected (f : ChunkFacts) (h : f.status = 200) :
    acceptChunk f = false := by
  simp [acceptChunk, chunkContract, h]

theorem truncated_chunk_is_rejected (f : ChunkFacts)
    (h : f.actualBytes ≠ f.expectedEnd - f.expectedStart + 1) : acceptChunk f = false := by
  simp [acceptChunk, chunkContract, h]

theorem exact_safe_chunk_is_accepted (f : ChunkFacts)
    (hExact : chunkContract f) (hSafe : chunkSafeNumbers f) : acceptChunk f = true := by
  simp [acceptChunk, hExact, hSafe]

/-- A nonempty interior chunk witnesses that the exact/safe premises are satisfiable. -/
theorem exact_middle_chunk_is_accepted :
    acceptChunk ⟨206, true, 1024, 2047, 4096, 1024, 2047, 4096, 1024⟩ = true := by
  decide

inductive ResponseStatus where
  | missing | zero | rejected
  deriving DecidableEq, BEq, ReflBEq, LawfulBEq, Repr

inductive DownloadFailure where
  | none | unavailable | other
  deriving DecidableEq, BEq, ReflBEq, LawfulBEq, Repr

inductive DownloadMessage where
  | none | unavailable | generic | other
  deriving DecidableEq, BEq, ReflBEq, LawfulBEq, Repr

inductive DownloadDecision where
  | items | fallback | reject
  deriving DecidableEq, BEq, Repr

structure DownloadFacts where
  validShape : Bool
  dialogPresent : Bool
  actionPresent : Bool
  status : ResponseStatus
  itemsPresent : Bool
  failure : DownloadFailure
  message : DownloadMessage
  deriving Repr

def decideDownloadResponse (f : DownloadFacts) : DownloadDecision :=
  if !f.validShape || f.dialogPresent || f.actionPresent || f.status == .rejected ||
      f.failure == .other || f.message == .other then .reject
  else if f.itemsPresent then
    if f.failure == .none && f.message == .none then .items else .reject
  else if f.failure == .unavailable then .fallback
  else if f.message == .generic then .reject
  else .fallback

theorem download_dialog_denies (f : DownloadFacts) (h : f.dialogPresent = true) :
    decideDownloadResponse f = .reject := by
  simp [decideDownloadResponse, h]

theorem download_invalid_shape_denies (f : DownloadFacts) (h : f.validShape = false) :
    decideDownloadResponse f = .reject := by
  simp [decideDownloadResponse, h]

theorem download_message_denies (f : DownloadFacts) (h : f.message = .other) :
    decideDownloadResponse f = .reject := by
  simp [decideDownloadResponse, h]

theorem download_action_denies (f : DownloadFacts) (h : f.actionPresent = true) :
    decideDownloadResponse f = .reject := by
  simp [decideDownloadResponse, h]

theorem download_status_denies (f : DownloadFacts) (h : f.status = .rejected) :
    decideDownloadResponse f = .reject := by
  simp [decideDownloadResponse, h]

theorem download_error_denies (f : DownloadFacts) (h : f.failure = .other) :
    decideDownloadResponse f = .reject := by
  simp [decideDownloadResponse, h]

theorem download_items_require_clean_success (f : DownloadFacts)
    (h : decideDownloadResponse f = .items) :
    f.validShape = true ∧ f.dialogPresent = false ∧ f.actionPresent = false ∧
    f.status ≠ .rejected ∧ f.itemsPresent = true ∧ f.failure = .none ∧ f.message = .none := by
  rcases f with ⟨valid, dialog, action, status, items, failure, message⟩
  cases valid <;> cases dialog <;> cases action <;> cases status <;>
    cases items <;> cases failure <;> cases message <;> simp_all [decideDownloadResponse]

theorem clean_download_items_are_accepted (status : ResponseStatus) (h : status ≠ .rejected) :
    decideDownloadResponse ⟨true, false, false, status, true, .none, .none⟩ = .items := by
  cases status <;> simp_all [decideDownloadResponse]

/-- `.unavailable` represents the documented 5002 code at the response extraction boundary. -/
theorem unavailable_license_with_generic_message_falls_back
    (status : ResponseStatus) (h : status ≠ .rejected) :
    decideDownloadResponse ⟨true, false, false, status, false, .unavailable, .generic⟩ =
      .fallback := by
  cases status <;> simp_all [decideDownloadResponse]

inductive AuthFailure where
  | none | retryCredentials | other
  deriving DecidableEq, BEq, ReflBEq, LawfulBEq, Repr

inductive AuthMessage where
  | none | verification | disabled | other
  deriving DecidableEq, BEq, ReflBEq, LawfulBEq, Repr

inductive AuthDecision where
  | reject | retry_credentials | verification | authenticated
  deriving DecidableEq, BEq, Repr

structure AuthFacts where
  validShape : Bool
  dialogPresent : Bool
  actionPresent : Bool
  rejectedStatus : Bool
  failure : AuthFailure
  message : AuthMessage
  firstAttempt : Bool
  httpOk : Bool
  hasToken : Bool
  hasDsid : Bool
  deriving Repr

def decideAuthResponse (f : AuthFacts) : AuthDecision :=
  if !f.validShape || f.dialogPresent || f.actionPresent || f.rejectedStatus then .reject
  else if f.failure == .retryCredentials && f.firstAttempt then .retry_credentials
  else if f.failure != .none then .reject
  else if f.message == .verification then .verification
  else if f.message == .disabled then .reject
  else if f.httpOk && f.hasToken && f.hasDsid then .authenticated
  else .reject

theorem auth_action_denies (f : AuthFacts) (h : f.actionPresent = true) :
    decideAuthResponse f = .reject := by
  simp [decideAuthResponse, h]

theorem auth_invalid_shape_denies (f : AuthFacts) (h : f.validShape = false) :
    decideAuthResponse f = .reject := by
  simp [decideAuthResponse, h]

theorem auth_dialog_denies (f : AuthFacts) (h : f.dialogPresent = true) :
    decideAuthResponse f = .reject := by
  simp [decideAuthResponse, h]

theorem auth_rejected_status_denies (f : AuthFacts) (h : f.rejectedStatus = true) :
    decideAuthResponse f = .reject := by
  simp [decideAuthResponse, h]

theorem authentication_requires_credentials (f : AuthFacts)
    (h : decideAuthResponse f = .authenticated) :
    f.httpOk = true ∧ f.hasToken = true ∧ f.hasDsid = true := by
  unfold decideAuthResponse at h
  repeat' split at h
  all_goals simp_all

theorem credential_retry_is_bounded (f : AuthFacts)
    (h : decideAuthResponse f = .retry_credentials) : f.firstAttempt = true := by
  unfold decideAuthResponse at h
  repeat' split at h
  all_goals simp_all

theorem clean_authentication_succeeds (firstAttempt : Bool) :
    decideAuthResponse
      ⟨true, false, false, false, .none, .none, firstAttempt, true, true, true⟩ =
      .authenticated := by
  cases firstAttempt <;> decide

inductive ProvisionDecision where
  | reject | expire | consume
  deriving DecidableEq, BEq, Repr

structure ProvisionFacts where
  present : Bool
  deviceMatches : Bool
  expired : Bool
  cancelled : Bool
  deriving Repr

def decideProvisionFinish (f : ProvisionFacts) : ProvisionDecision :=
  if !f.present || !f.deviceMatches then .reject
  else if f.expired || f.cancelled then .expire
  else .consume

def finishPresence (f : ProvisionFacts) : Bool :=
  match decideProvisionFinish f with
  | .reject => f.present
  | .expire | .consume => false

theorem provisioning_requires_live_matching_handle (f : ProvisionFacts)
    (h : decideProvisionFinish f = .consume) :
    f.present = true ∧ f.deviceMatches = true ∧ f.expired = false ∧ f.cancelled = false := by
  rcases f with ⟨present, sameDevice, expired, cancelled⟩
  cases present <;> cases sameDevice <;> cases expired <;> cases cancelled <;>
    simp_all [decideProvisionFinish]

theorem provisioning_cannot_replay (f : ProvisionFacts)
    (h : decideProvisionFinish f = .consume) (sameDevice expired cancelled : Bool) :
    decideProvisionFinish ⟨finishPresence f, sameDevice, expired, cancelled⟩ = .reject := by
  have consumed : finishPresence f = false := by simp only [finishPresence, h]
  simp [decideProvisionFinish, consumed]

theorem wrong_device_preserves_handle (f : ProvisionFacts) (h : f.deviceMatches = false) :
    finishPresence f = f.present := by
  simp [finishPresence, decideProvisionFinish, h]

theorem live_provisioning_consumes :
    decideProvisionFinish ⟨true, true, false, false⟩ = .consume ∧
    finishPresence ⟨true, true, false, false⟩ = false := by
  decide

end Asspp
