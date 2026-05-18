# app-experience

The Next.js customer-facing app: run creation, hard-cap enforcement, plan
confirmation, streamed progress, report, export, and history.

## ADDED Requirements

### Requirement: Visual system aligned with Geist via shadcn/ui

The system SHALL render all UI surfaces using shadcn/ui components
(`new-york` style on Radix) and Tailwind v4 with shadcn's theme tokens
(`bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`,
`border-border`, `ring-ring`, `bg-primary`, `text-primary-foreground`).
Interface text SHALL use Geist Sans; schema source, scenario
predicates, run identifiers, timestamps, and cost arithmetic SHALL use
Geist Mono. The base palette SHALL be `zinc` neutrals with a single
green accent through `--color-primary` and `--color-ring`.
`--color-destructive` SHALL remain the shadcn default and green SHALL
NOT be used for destructive states. Ad-hoc hex colors and arbitrary
spacing or radius values SHALL NOT be used.

#### Scenario: Surfaces compose shadcn primitives

- **WHEN** any UI surface in the app is rendered
- **THEN** it composes shadcn/ui primitives (e.g., `Card`, `Button`,
  `Input`, `Textarea`, `Label`, `Badge`, `Table`, `Dialog`,
  `AlertDialog`, `DropdownMenu`, `Skeleton`, `Separator`, `Progress`)
- **AND** uses shadcn theme tokens for colors, radius, and spacing
  rather than ad-hoc values

#### Scenario: Structured data uses Geist Mono

- **WHEN** schema source, scenario predicates, run identifiers,
  timestamps, or cost arithmetic are displayed
- **THEN** they render in Geist Mono

#### Scenario: Default appearance is dark mode

- **WHEN** the app loads on a fresh client
- **THEN** dark mode is the default appearance

#### Scenario: Primary actions and instantiated badges use the green accent

- **WHEN** a primary action (Confirm, Submit, Re-run), a focus ring,
  or an *instantiated* / *passed* state is rendered
- **THEN** it is styled with the green `--color-primary` token
- **AND** destructive actions remain on `--color-destructive` (red);
  green is not used for destructive states

### Requirement: Run creation form

The system SHALL provide a form to start a run accepting a Postgres
schema, a plain-English product context, and a target data volume.

#### Scenario: Submit a valid run

- **WHEN** a user provides schema, context, and volume and submits
- **THEN** the system parses the schema, runs the planner, and routes
  the user to the plan confirmation view

#### Scenario: Submit with missing schema

- **WHEN** the schema field is empty
- **THEN** submission is blocked with an inline validation message

### Requirement: Hard-cap enforcement at submission

The system SHALL enforce hard caps at submission time and SHALL refuse
or truncate when caps would be exceeded, with a clear message naming
the cap and the observed value. Caps SHALL cover maximum schema size,
maximum rows per run, and maximum wall-clock per workflow.

#### Scenario: Schema exceeds the size cap

- **WHEN** the submitted Postgres script exceeds the maximum
  schema-size cap
- **THEN** submission is refused with a message naming the cap and
  the observed size

#### Scenario: Requested volume exceeds the row cap

- **WHEN** the requested volume exceeds the maximum-rows cap
- **THEN** the system either refuses submission or truncates the
  request to the cap, with a clear message describing which behaviour
  applied

### Requirement: Plan confirmation with predicates and cost estimate

The system SHALL present the generated scenario plan to the user
before generation runs. The view SHALL show each scenario, its
predicate, and a deterministic pre-run cost estimate (planned rows ×
estimated tokens per row × model price + a fixed planning cost). The
user SHALL explicitly confirm or cancel; generation SHALL NOT start
without confirmation. Free-text editing of the plan is not supported.

#### Scenario: User confirms the plan

- **WHEN** the plan with predicates and cost estimate is shown and
  the user confirms
- **THEN** generation begins as a workflow step
- **AND** the confirmed plan is the input to generation and scoring

#### Scenario: User cancels at the confirmation step

- **WHEN** the user cancels at the plan confirmation step
- **THEN** generation does not run and the run is closed with a
  cancelled status

### Requirement: Streamed run progress view

The system SHALL show run progress by streaming or polling Workflow
step status, including the cache decision step when caching is in
scope.

#### Scenario: Run progresses through steps

- **WHEN** a run is executing
- **THEN** the view updates as each named step starts and completes
- **AND** the cache hit/miss step is visible when present

### Requirement: Readiness report view

The system SHALL render a readiness report showing per-scenario
predicate results, the hard-constraint pass rate, and unresolved
failures.

#### Scenario: Completed run report

- **WHEN** a run completes
- **THEN** the report lists each scenario with its predicate and
  instantiated/missing status
- **AND** shows the hard-constraint pass rate and any unresolved
  failures

### Requirement: Export seed data

The system SHALL allow exporting the generated dataset as canonical
JSON and as a Postgres seed SQL script derived deterministically from
that JSON.

#### Scenario: Export after a completed run

- **WHEN** a user requests export on a completed run
- **THEN** the system provides the canonical JSON file and a Postgres
  `INSERT` script
- **AND** the SQL respects table dependency order

### Requirement: Run history view

The system SHALL provide a list of past runs derived from Vercel Blob
storage, linking each entry to its report, and SHALL offer a
"re-run with new volume" action that reuses the prior run's confirmed
plan and exercises the cache scale-down/up path.

#### Scenario: User opens history

- **WHEN** the user opens the history view
- **THEN** the view lists past runs by recency with timestamp, status,
  and a link to the report

#### Scenario: User re-runs with a new volume

- **WHEN** the user picks a prior run and selects a new volume
- **THEN** a new run is created with the same canonical schema and
  confirmed plan
- **AND** the workflow exercises the cache (scale-down sample or
  scale-up delta) rather than re-invoking the model

### Requirement: Static landing and cached example templates

The system SHALL serve the landing page and example schema templates
as static/cached content, distinct from the dynamic run page, plan
confirmation view, and report.

#### Scenario: Landing and examples requested

- **WHEN** a user opens the landing page or an example template
- **THEN** the content is served statically or from cache
- **AND** selecting an example pre-fills the run form
