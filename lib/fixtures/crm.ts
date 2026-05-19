/**
 * B2B CRM template: accounts, contacts, deals, pipelines, activities.
 *
 * Same shape as lib/fixtures/ecommerce.ts.
 */

import type { ScenarioPlan } from "@/lib/types";

export const CRM_DDL = `
CREATE TABLE owners (
  id BIGINT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  team TEXT NOT NULL CHECK (team IN ('sales', 'success', 'partner')),
  active BOOLEAN NOT NULL
);

CREATE TABLE accounts (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  industry TEXT NOT NULL,
  employee_count INTEGER NOT NULL CHECK (employee_count >= 0),
  annual_revenue NUMERIC CHECK (annual_revenue >= 0),
  owner_id BIGINT NOT NULL REFERENCES owners(id),
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE contacts (
  id BIGINT PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  title TEXT,
  lifecycle_stage TEXT NOT NULL CHECK (lifecycle_stage IN ('subscriber', 'lead', 'mql', 'sql', 'customer', 'evangelist')),
  do_not_contact BOOLEAN NOT NULL
);

CREATE TABLE pipelines (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  team TEXT NOT NULL CHECK (team IN ('sales', 'success', 'partner')),
  active BOOLEAN NOT NULL
);

CREATE TABLE stages (
  id BIGINT PRIMARY KEY,
  pipeline_id BIGINT NOT NULL REFERENCES pipelines(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  is_won BOOLEAN NOT NULL,
  is_lost BOOLEAN NOT NULL
);

CREATE TABLE deals (
  id BIGINT PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  primary_contact_id BIGINT REFERENCES contacts(id),
  pipeline_id BIGINT NOT NULL REFERENCES pipelines(id),
  stage_id BIGINT NOT NULL REFERENCES stages(id),
  owner_id BIGINT NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'won', 'lost')),
  expected_close_date DATE,
  closed_at TIMESTAMP
);

CREATE TABLE activities (
  id BIGINT PRIMARY KEY,
  deal_id BIGINT REFERENCES deals(id),
  contact_id BIGINT REFERENCES contacts(id),
  owner_id BIGINT NOT NULL REFERENCES owners(id),
  kind TEXT NOT NULL CHECK (kind IN ('call', 'email', 'meeting', 'note', 'task')),
  occurred_at TIMESTAMP NOT NULL,
  outcome TEXT
);

CREATE TABLE notes (
  id BIGINT PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  owner_id BIGINT NOT NULL REFERENCES owners(id),
  body TEXT NOT NULL,
  pinned BOOLEAN NOT NULL,
  created_at TIMESTAMP NOT NULL
);
`.trim();

export const CRM_CONTEXT = [
  "B2B sales CRM used by an account-executive team selling mid-market and",
  "enterprise software. Accounts are companies; contacts are the people",
  "inside them and progress through lifecycle stages from lead to customer.",
  "Deals move through pipeline stages, owned by reps, and close as won or",
  "lost. Activities log every call, email, meeting, and note tied to a",
  "deal or contact.",
].join(" ");

export const CRM_PLAN: ScenarioPlan = {
  scenarios: [
    {
      id: "inactive-owner",
      name: "Inactive deal owner",
      description: "An owner record exists with active = false.",
      predicate: {
        table: "owners",
        where: { kind: "eq", column: "active", value: false },
      },
    },
    {
      id: "enterprise-account",
      name: "Enterprise-sized account",
      description: "An account has more than 1000 employees.",
      predicate: {
        table: "accounts",
        where: { kind: "gt", column: "employee_count", value: 1000 },
      },
    },
    {
      id: "do-not-contact",
      name: "Do-not-contact contact",
      description: "A contact has opted out of communication.",
      predicate: {
        table: "contacts",
        where: { kind: "eq", column: "do_not_contact", value: true },
      },
    },
    {
      id: "customer-contact",
      name: "Lifecycle stage customer",
      description: "At least one contact has reached lifecycle stage customer.",
      predicate: {
        table: "contacts",
        where: { kind: "eq", column: "lifecycle_stage", value: "customer" },
      },
    },
    {
      id: "won-deal",
      name: "Closed-won deal",
      description: "A deal has closed with status won.",
      predicate: {
        table: "deals",
        where: { kind: "eq", column: "status", value: "won" },
      },
    },
    {
      id: "large-deal",
      name: "Six-figure open deal",
      description: "An open deal is worth at least $100,000.",
      predicate: {
        table: "deals",
        where: {
          kind: "and",
          clauses: [
            { kind: "eq", column: "status", value: "open" },
            { kind: "gte", column: "amount", value: 100000 },
          ],
        },
      },
    },
    {
      id: "meeting-activity",
      name: "Meeting activity logged",
      description: "An activity of kind 'meeting' has been recorded.",
      predicate: {
        table: "activities",
        where: { kind: "eq", column: "kind", value: "meeting" },
      },
    },
    {
      id: "pinned-note",
      name: "Pinned account note",
      description: "An account-level note has been pinned.",
      predicate: {
        table: "notes",
        where: { kind: "eq", column: "pinned", value: true },
      },
    },
  ],
};

export const CRM_FIXTURE = {
  ddl: CRM_DDL,
  context: CRM_CONTEXT,
  plan: CRM_PLAN,
} as const;
