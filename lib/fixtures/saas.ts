/**
 * SaaS multi-tenant subscription template.
 *
 * Mirrors the shape of lib/fixtures/ecommerce.ts: DDL in the accepted
 * Postgres subset, a product context, and a ScenarioPlan with
 * deterministic predicates that drive coverage evaluation.
 */

import type { ScenarioPlan } from "@/lib/types";

export const SAAS_DDL = `
CREATE TABLE organizations (
  id BIGINT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'starter', 'growth', 'enterprise')),
  trial_ends_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE users (
  id BIGINT PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'suspended')),
  last_login_at TIMESTAMP
);

CREATE TABLE plans (
  id BIGINT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  monthly_price NUMERIC NOT NULL CHECK (monthly_price >= 0),
  seat_included INTEGER NOT NULL CHECK (seat_included >= 0),
  active BOOLEAN NOT NULL
);

CREATE TABLE subscriptions (
  id BIGINT PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id),
  plan_id BIGINT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  seats INTEGER NOT NULL CHECK (seats >= 0),
  current_period_end TIMESTAMP NOT NULL,
  canceled_at TIMESTAMP
);

CREATE TABLE invoices (
  id BIGINT PRIMARY KEY,
  subscription_id BIGINT NOT NULL REFERENCES subscriptions(id),
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'GBP')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void')),
  issued_at TIMESTAMP NOT NULL,
  paid_at TIMESTAMP
);

CREATE TABLE api_keys (
  id BIGINT PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id),
  prefix TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write', 'admin')),
  revoked BOOLEAN NOT NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE audit_logs (
  id BIGINT PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id),
  user_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  occurred_at TIMESTAMP NOT NULL
);
`.trim();

export const SAAS_CONTEXT = [
  "Multi-tenant B2B SaaS platform billed on a per-seat subscription model.",
  "Organizations sign up on a free or starter plan, optionally trial growth",
  "or enterprise tiers, and pay monthly invoices in USD, EUR, or GBP.",
  "Users belong to a single organization with role-based access. API keys",
  "are scoped per organization and may be revoked. Audit logs capture every",
  "privileged action for compliance.",
].join(" ");

export const SAAS_PLAN: ScenarioPlan = {
  scenarios: [
    {
      id: "trialing-organization",
      name: "Organization in trial",
      description: "An organization has a non-null trial_ends_at timestamp.",
      predicate: {
        table: "organizations",
        where: { kind: "isNotNull", column: "trial_ends_at" },
      },
    },
    {
      id: "enterprise-plan",
      name: "Enterprise tier organization",
      description: "At least one organization is on the enterprise plan.",
      predicate: {
        table: "organizations",
        where: { kind: "eq", column: "plan", value: "enterprise" },
      },
    },
    {
      id: "suspended-user",
      name: "Suspended user account",
      description: "A user has been suspended from their organization.",
      predicate: {
        table: "users",
        where: { kind: "eq", column: "status", value: "suspended" },
      },
    },
    {
      id: "past-due-subscription",
      name: "Past-due subscription",
      description: "A subscription is past_due and needs collection.",
      predicate: {
        table: "subscriptions",
        where: { kind: "eq", column: "status", value: "past_due" },
      },
    },
    {
      id: "void-invoice",
      name: "Voided invoice",
      description: "An invoice has been voided after issuance.",
      predicate: {
        table: "invoices",
        where: { kind: "eq", column: "status", value: "void" },
      },
    },
    {
      id: "revoked-api-key",
      name: "Revoked API key",
      description: "At least one API key has been revoked.",
      predicate: {
        table: "api_keys",
        where: { kind: "eq", column: "revoked", value: true },
      },
    },
    {
      id: "non-usd-invoice",
      name: "Non-USD invoice",
      description: "An invoice is denominated in EUR or GBP.",
      predicate: {
        table: "invoices",
        where: {
          kind: "in",
          column: "currency",
          values: ["EUR", "GBP"],
        },
      },
    },
  ],
};

export const SAAS_FIXTURE = {
  ddl: SAAS_DDL,
  context: SAAS_CONTEXT,
  plan: SAAS_PLAN,
} as const;
