/**
 * Healthcare clinical template: patients, providers, encounters,
 * diagnoses, prescriptions, claims.
 */

import type { ScenarioPlan } from "@/lib/types";

export const HEALTHCARE_DDL = `
CREATE TABLE patients (
  id BIGINT PRIMARY KEY,
  mrn TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  date_of_birth DATE NOT NULL,
  sex TEXT NOT NULL CHECK (sex IN ('female', 'male', 'other', 'unknown')),
  preferred_language TEXT NOT NULL,
  deceased_at TIMESTAMP
);

CREATE TABLE providers (
  id BIGINT PRIMARY KEY,
  npi TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  specialty TEXT NOT NULL,
  accepting_new_patients BOOLEAN NOT NULL,
  active BOOLEAN NOT NULL
);

CREATE TABLE payers (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('commercial', 'medicare', 'medicaid', 'self_pay'))
);

CREATE TABLE insurance_coverages (
  id BIGINT PRIMARY KEY,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  payer_id BIGINT NOT NULL REFERENCES payers(id),
  member_number TEXT NOT NULL,
  effective_date DATE NOT NULL,
  termination_date DATE,
  is_primary BOOLEAN NOT NULL
);

CREATE TABLE encounters (
  id BIGINT PRIMARY KEY,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  provider_id BIGINT NOT NULL REFERENCES providers(id),
  kind TEXT NOT NULL CHECK (kind IN ('office', 'telehealth', 'emergency', 'inpatient')),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'in_progress', 'completed', 'no_show', 'canceled')),
  scheduled_at TIMESTAMP NOT NULL,
  closed_at TIMESTAMP
);

CREATE TABLE diagnoses (
  id BIGINT PRIMARY KEY,
  encounter_id BIGINT NOT NULL REFERENCES encounters(id),
  icd10_code TEXT NOT NULL,
  description TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL,
  recorded_at TIMESTAMP NOT NULL
);

CREATE TABLE prescriptions (
  id BIGINT PRIMARY KEY,
  encounter_id BIGINT NOT NULL REFERENCES encounters(id),
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  drug_name TEXT NOT NULL,
  dosage TEXT NOT NULL,
  refills_remaining INTEGER NOT NULL CHECK (refills_remaining >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'canceled')),
  prescribed_at TIMESTAMP NOT NULL
);

CREATE TABLE claims (
  id BIGINT PRIMARY KEY,
  encounter_id BIGINT NOT NULL REFERENCES encounters(id),
  payer_id BIGINT NOT NULL REFERENCES payers(id),
  amount_billed NUMERIC NOT NULL CHECK (amount_billed >= 0),
  amount_paid NUMERIC NOT NULL CHECK (amount_paid >= 0),
  status TEXT NOT NULL CHECK (status IN ('submitted', 'pending', 'paid', 'denied', 'appealed')),
  submitted_at TIMESTAMP NOT NULL
);

CREATE TABLE allergies (
  id BIGINT PRIMARY KEY,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  substance TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('mild', 'moderate', 'severe')),
  recorded_at TIMESTAMP NOT NULL
);
`.trim();

export const HEALTHCARE_CONTEXT = [
  "Multi-specialty outpatient clinic platform handling patient",
  "demographics, providers, scheduled encounters across office,",
  "telehealth, ER, and inpatient settings, plus insurance claims. Each",
  "encounter can produce diagnoses (ICD-10), prescriptions tracked",
  "through refills, and claims billed to commercial, Medicare, Medicaid,",
  "or self-pay payers. Patient allergies are recorded for safety checks.",
].join(" ");

export const HEALTHCARE_PLAN: ScenarioPlan = {
  scenarios: [
    {
      id: "deceased-patient",
      name: "Deceased patient on file",
      description: "A patient record has a non-null deceased_at timestamp.",
      predicate: {
        table: "patients",
        where: { kind: "isNotNull", column: "deceased_at" },
      },
    },
    {
      id: "accepting-provider",
      name: "Provider accepting new patients",
      description: "An active provider is accepting new patients.",
      predicate: {
        table: "providers",
        where: {
          kind: "and",
          clauses: [
            { kind: "eq", column: "active", value: true },
            { kind: "eq", column: "accepting_new_patients", value: true },
          ],
        },
      },
    },
    {
      id: "medicaid-payer",
      name: "Medicaid payer present",
      description: "At least one payer has kind 'medicaid'.",
      predicate: {
        table: "payers",
        where: { kind: "eq", column: "kind", value: "medicaid" },
      },
    },
    {
      id: "no-show-encounter",
      name: "No-show encounter",
      description: "An encounter ended in no_show status.",
      predicate: {
        table: "encounters",
        where: { kind: "eq", column: "status", value: "no_show" },
      },
    },
    {
      id: "telehealth-encounter",
      name: "Telehealth encounter completed",
      description: "A telehealth visit completed successfully.",
      predicate: {
        table: "encounters",
        where: {
          kind: "and",
          clauses: [
            { kind: "eq", column: "kind", value: "telehealth" },
            { kind: "eq", column: "status", value: "completed" },
          ],
        },
      },
    },
    {
      id: "primary-diagnosis",
      name: "Primary diagnosis recorded",
      description: "A diagnosis is flagged as the primary diagnosis.",
      predicate: {
        table: "diagnoses",
        where: { kind: "eq", column: "is_primary", value: true },
      },
    },
    {
      id: "denied-claim",
      name: "Denied insurance claim",
      description: "A claim has been denied by the payer.",
      predicate: {
        table: "claims",
        where: { kind: "eq", column: "status", value: "denied" },
      },
    },
    {
      id: "severe-allergy",
      name: "Severe allergy on chart",
      description: "A patient has an allergy with severity 'severe'.",
      predicate: {
        table: "allergies",
        where: { kind: "eq", column: "severity", value: "severe" },
      },
    },
  ],
};

export const HEALTHCARE_FIXTURE = {
  ddl: HEALTHCARE_DDL,
  context: HEALTHCARE_CONTEXT,
  plan: HEALTHCARE_PLAN,
} as const;
