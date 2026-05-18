# seed-pipeline

The AI agent pipeline that turns a Postgres schema and product context into
validated, tool-scored seed data.

## ADDED Requirements

### Requirement: Parse Postgres DDL into an entity model

The system SHALL parse a Postgres `CREATE TABLE` script into a structured
entity model using a SQL AST parser, capturing tables, columns, types,
primary keys, foreign keys, NOT NULL, UNIQUE, CHECK, and ENUM constraints.

#### Scenario: Valid schema within the accepted subset

- **WHEN** a user submits a Postgres script using only the accepted subset
- **THEN** the system produces an entity model with all tables, columns,
  and constraints resolved
- **AND** foreign key relationships between tables are linked

#### Scenario: Unsupported construct present

- **WHEN** the script contains a trigger, function, partition, or custom
  domain
- **THEN** the system rejects the input with an error naming the
  unsupported construct
- **AND** no generation is attempted

### Requirement: Generate a predicate-bearing scenario plan

The system SHALL generate a structured scenario plan from the parsed schema
and a plain-English product description using the AI SDK with a constrained
output schema. Each scenario in the plan SHALL carry a structured predicate
expressing the deterministic condition under which the scenario is
considered instantiated. Predicates SHALL be expressed as typed condition
objects over named tables and columns; free text and raw SQL are not
accepted.

#### Scenario: Plan generated for the product context

- **WHEN** the parsed schema and product context are provided
- **THEN** the system returns a named scenario plan as structured data
- **AND** each scenario references entities that exist in the parsed schema
- **AND** each scenario includes a structured predicate referencing only
  tables and columns present in the entity model

#### Scenario: Predicate references an unknown column

- **WHEN** the model proposes a predicate referencing a table or column
  not in the entity model
- **THEN** the plan is rejected as structurally invalid
- **AND** the planner step retries within its bounded cap

### Requirement: Generate seed data constrained to schema and scenario plan

The system SHALL generate seed data as structured output, where every
record targets a table in the entity model and the dataset attempts to
instantiate each scenario in the plan.

#### Scenario: Data generated for a confirmed plan

- **WHEN** a user-confirmed scenario plan and entity model are provided
- **THEN** the system produces records keyed by table name
- **AND** the dataset is sized to the user-requested volume within the
  configured caps

### Requirement: Validate structural shape of generated output

The system SHALL deterministically check the shape of generation output
before constraint validation runs, rejecting outputs that are not
parseable into the expected per-table row structure.

#### Scenario: Malformed model output

- **WHEN** the model returns output that does not conform to the expected
  per-table record schema
- **THEN** structural shape validation rejects the output with a specific
  reason
- **AND** the constraint validator is not invoked on that output

### Requirement: Retry the generation step on malformed structured output

The system SHALL apply a bounded retry to the generation step itself when
structural shape validation rejects the output. This retry is distinct
from the constraint-repair loop and has a separate, configured cap.

#### Scenario: Malformed output within the generation-step retry cap

- **WHEN** structural shape validation rejects output and the
  generation-step retry count is below its cap
- **THEN** the generation step is retried with a corrective prompt
- **AND** the repair loop is not invoked until structural shape passes

#### Scenario: Generation-step retry cap exhausted

- **WHEN** structural shape validation continues to fail after the
  generation-step retry cap is reached
- **THEN** the run terminates with a structural-failure status and the
  report records the failure mode
- **AND** the constraint-repair loop is not invoked

### Requirement: Deterministically validate generated data

The system SHALL validate generated records against the entity model
without using the model, checking required fields, foreign key
resolution, enum and check constraints, uniqueness, and type conformance.

#### Scenario: Dataset with an invalid record

- **WHEN** a generated record violates a foreign key or constraint
- **THEN** validation marks the record as failed with the specific
  constraint and field
- **AND** valid records in the same dataset remain marked as passing

### Requirement: Repair invalid records via bounded retry

The system SHALL feed failed records and their specific validation errors
back to the model to regenerate them, re-validating after each attempt,
up to a fixed retry cap. This loop is distinct from the
generation-step retry on malformed output.

#### Scenario: Repairable failure within the cap

- **WHEN** validation fails and the retry count is below the cap
- **THEN** the failed records and their errors are sent for regeneration
- **AND** the regenerated records are re-validated

#### Scenario: Retry cap exhausted

- **WHEN** validation still fails after the retry cap is reached
- **THEN** the run completes with the failure recorded in the report
- **AND** the readiness score reflects the unresolved failures

### Requirement: Produce a canonical dataset output

The system SHALL produce a canonical JSON representation of the
validated dataset: an object keyed by table name with row arrays, columns
named from the entity model, deterministic value serialization (ISO-8601
timestamps, decimal values as strings, explicit nulls), and tables
ordered topologically by foreign-key dependency. The Postgres SQL export
SHALL be derived deterministically from this JSON; the model SHALL NOT
produce SQL directly.

#### Scenario: Canonical output produced on a successful run

- **WHEN** validation passes
- **THEN** the canonical dataset is serialized in deterministic form
  with tables in topological order
- **AND** the SQL export is generated by transforming the canonical JSON
  without invoking the model

### Requirement: Evaluate scenario predicates over canonical rows

The system SHALL evaluate each scenario's predicate deterministically
against the canonical rows. A scenario SHALL count as instantiated if
and only if at least one canonical row satisfies its predicate.

#### Scenario: Predicate satisfied by at least one row

- **WHEN** at least one canonical row satisfies a scenario's predicate
- **THEN** the scenario is marked instantiated in the report

#### Scenario: Predicate satisfied by no row

- **WHEN** no canonical row satisfies a scenario's predicate
- **THEN** the scenario is marked missing in the report regardless of
  any model claim that the scenario was satisfied

### Requirement: Compute a decomposed readiness score

The system SHALL compute a readiness score from the count of
predicate-instantiated scenarios over the planned total and the
hard-constraint pass rate, exposing each component.

#### Scenario: Report requested

- **WHEN** the run completes
- **THEN** the report shows per-scenario instantiated/missing status with
  the predicate that was evaluated
- **AND** the report shows the hard-constraint pass rate
- **AND** no single opaque composite number is shown without its
  components

### Requirement: Evaluation regression check on the fixed demo fixture

The system SHALL provide a repeatable evaluation that runs the pipeline
against the fixed 8-table ecommerce schema and its 8-scenario
predicate-bearing plan and asserts a minimum predicate-based coverage
threshold and a 100% hard-constraint pass rate.

#### Scenario: Regression run on the demo fixture

- **WHEN** the evaluation is executed against the demo fixture
- **THEN** it asserts all hard constraints pass
- **AND** it asserts predicate-based scenario coverage meets or exceeds
  the configured threshold
- **AND** it fails loudly if either assertion is not met
