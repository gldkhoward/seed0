# run-orchestration

Durable execution, caching, and persistence for a generation run.

## ADDED Requirements

### Requirement: Execute the run as a durable Workflow with named steps

The system SHALL execute a generation run as a Vercel Workflow composed
of explicitly named steps: parse, plan, confirm, generate, validate,
repair, predicate-evaluate, score, persist. When the cache is in scope,
the cache decision SHALL be a distinct, named step.

#### Scenario: Run started from the app

- **WHEN** a user submits a run and confirms the plan
- **THEN** a Workflow instance starts and progresses through the named
  steps
- **AND** each step transition is observable from the app

### Requirement: Scope automatic retries to two named loops

The system SHALL apply automatic retries to two specific scopes only:
(a) the generation step, on malformed structured output, with a
configured cap; and (b) the validate/repair loop, on constraint
violations, with a separate configured cap. No other workflow step is
automatically retried.

#### Scenario: Transient validate/repair failure

- **WHEN** the validate/repair step fails transiently below its retry
  cap
- **THEN** the Workflow retries that step
- **AND** earlier completed steps are not re-executed

#### Scenario: Transient malformed generation output

- **WHEN** the generation step output fails structural shape validation
  below its retry cap
- **THEN** the Workflow retries the generation step
- **AND** the repair loop is not invoked

### Requirement: Content-addressed cache keyed on canonical schema and plan

The system SHALL cache generated corpora under a key derived from the
canonical schema form and the scenario plan, excluding volume from the
key. The cache substrate SHALL be Vercel Blob.

#### Scenario: Logically identical schemas hash to the same key

- **WHEN** two Postgres scripts differ only in whitespace, comments,
  unquoted-identifier case, type aliases (e.g., `int4` vs `integer`,
  `varchar` vs `character varying`), or table/column declaration order
- **THEN** schema normalization produces the same canonical form and
  the cache key is identical

#### Scenario: Identical schema and plan resubmitted

- **WHEN** a run is submitted with a schema and plan matching a cached
  corpus
- **THEN** the generate step is skipped and the cached corpus is reused
- **AND** the model is not invoked for generation

#### Scenario: Schema or plan changed triggers full regeneration

- **WHEN** the canonical schema or the scenario plan differs from any
  cached entry
- **THEN** a cache miss occurs and full regeneration of the affected
  scope runs
- **AND** the system does not attempt to diff or incrementally augment
  previously cached rows

### Requirement: Volume scaling without re-invoking the model

The system SHALL satisfy a reduced volume by deterministically sampling
the cached corpus with a seeded RNG and an increased volume by
generating only the missing delta.

#### Scenario: Scale down from cached corpus

- **WHEN** the requested volume is below the cached corpus size
- **THEN** the system returns a deterministic sample without invoking
  the model

#### Scenario: Deterministic sampling reproducibility

- **WHEN** the same cached corpus, the same requested volume, and the
  same sampling seed are used
- **THEN** repeated samples return identical rows in identical order

#### Scenario: Scale up beyond cached corpus

- **WHEN** the requested volume exceeds the cached corpus size
- **THEN** the system generates only the additional records and
  appends them
- **AND** the prior cached records are preserved

### Requirement: Surface cache hit/miss as an observable run step

The system SHALL expose the cache decision as a distinct, visible step
in the run progress so a hit or miss is shown to the user.

#### Scenario: Cache hit during a run

- **WHEN** the run reuses a cached corpus
- **THEN** the run progress shows an explicit cache-hit step
- **AND** the skipped generation work is indicated

### Requirement: Persist run records and canonical datasets in Vercel Blob

The system SHALL persist a run record (status, step transitions, score
breakdown, failures) and the canonical dataset to Vercel Blob under
stable, listable key prefixes. Vercel Blob SHALL be the only storage
substrate; no secondary store is used.

The run record SHALL be flushed on every state transition so the
progress view shows up-to-the-step truth, not only terminal status.

The system SHALL refuse to read or write the store when
`BLOB_READ_WRITE_TOKEN` is not configured; there is no in-memory
fallback for development.

#### Scenario: Run completes

- **WHEN** a run finishes (success, partial, cancelled, or failure)
- **THEN** the run record and any produced canonical dataset are
  written to Vercel Blob
- **AND** the run is retrievable by its identifier

#### Scenario: Step transitions during a run

- **WHEN** a workflow step transitions status (running, succeeded,
  failed, or skipped)
- **THEN** the run record in Vercel Blob is updated to reflect the new
  step status
- **AND** a reader of the progress view observes that transition
  without waiting for the run to finish

#### Scenario: Missing Blob token

- **WHEN** any run-store function is invoked without
  `BLOB_READ_WRITE_TOKEN` configured
- **THEN** the call SHALL throw an error naming the missing variable
  and the remediation
- **AND** the system SHALL NOT fall back to an in-memory or
  filesystem-backed store

### Requirement: Run history listing

The system SHALL expose a listing of past runs derived from Vercel Blob
prefix listing, ordered by recency.

On the first read against an empty `runs/` prefix in a newly-
provisioned Blob store, the system SHALL seed a fixed set of demo runs
with deterministic timestamps so the history view is never empty for a
fresh deployment. Once any real run exists in the prefix, seeding
SHALL NOT recur.

#### Scenario: User requests history

- **WHEN** a user opens the run history view
- **THEN** the system lists past runs with timestamp, status, and a
  link to the report

#### Scenario: First read against an empty Blob store

- **WHEN** the run history is requested and the `runs/` prefix is
  empty
- **THEN** the system writes the demo fixture runs to Blob and returns
  them in the listing
- **AND** subsequent reads do not re-seed once the prefix is non-empty
