/**
 * Fintech / digital banking template: account holders, accounts, cards,
 * merchants, transactions, transfers, statements.
 */

import type { ScenarioPlan } from "@/lib/types";

export const FINTECH_DDL = `
CREATE TABLE account_holders (
  id BIGINT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  country TEXT NOT NULL,
  kyc_status TEXT NOT NULL CHECK (kyc_status IN ('pending', 'approved', 'rejected', 'review')),
  risk_score INTEGER NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
  opened_at TIMESTAMP NOT NULL
);

CREATE TABLE accounts (
  id BIGINT PRIMARY KEY,
  holder_id BIGINT NOT NULL REFERENCES account_holders(id),
  account_number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('checking', 'savings', 'credit', 'loan')),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'GBP', 'CAD')),
  balance NUMERIC NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'frozen', 'closed')),
  opened_at TIMESTAMP NOT NULL
);

CREATE TABLE cards (
  id BIGINT PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  last_four TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('visa', 'mastercard', 'amex', 'discover')),
  expires_on DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'blocked', 'expired', 'lost')),
  contactless BOOLEAN NOT NULL
);

CREATE TABLE merchants (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  category_code TEXT NOT NULL,
  country TEXT NOT NULL,
  online_only BOOLEAN NOT NULL
);

CREATE TABLE transactions (
  id BIGINT PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  card_id BIGINT REFERENCES cards(id),
  merchant_id BIGINT REFERENCES merchants(id),
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'GBP', 'CAD')),
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'declined', 'reversed', 'disputed')),
  posted_at TIMESTAMP
);

CREATE TABLE transfers (
  id BIGINT PRIMARY KEY,
  source_account_id BIGINT NOT NULL REFERENCES accounts(id),
  destination_account_id BIGINT NOT NULL REFERENCES accounts(id),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'returned')),
  initiated_at TIMESTAMP NOT NULL,
  CHECK (source_account_id <> destination_account_id)
);

CREATE TABLE statements (
  id BIGINT PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  opening_balance NUMERIC NOT NULL,
  closing_balance NUMERIC NOT NULL,
  generated_at TIMESTAMP NOT NULL,
  UNIQUE (account_id, period_start)
);

CREATE TABLE disputes (
  id BIGINT PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES transactions(id),
  reason TEXT NOT NULL CHECK (reason IN ('fraud', 'duplicate', 'product_not_received', 'unauthorized', 'other')),
  status TEXT NOT NULL CHECK (status IN ('opened', 'investigating', 'resolved_customer', 'resolved_merchant', 'closed')),
  opened_at TIMESTAMP NOT NULL,
  resolved_at TIMESTAMP
);
`.trim();

export const FINTECH_CONTEXT = [
  "Consumer digital bank operating in multiple currencies across the US,",
  "EU, UK, and Canada. Account holders progress through KYC, then open",
  "checking, savings, credit, or loan accounts. Cards on Visa,",
  "Mastercard, Amex, or Discover networks transact with merchants",
  "globally. Internal transfers move funds between accounts; disputes",
  "are filed against suspect transactions and worked to resolution.",
].join(" ");

export const FINTECH_PLAN: ScenarioPlan = {
  scenarios: [
    {
      id: "kyc-rejected-holder",
      name: "KYC-rejected holder",
      description: "An account holder failed KYC.",
      predicate: {
        table: "account_holders",
        where: { kind: "eq", column: "kyc_status", value: "rejected" },
      },
    },
    {
      id: "high-risk-holder",
      name: "High-risk holder",
      description: "An account holder has a risk score above 80.",
      predicate: {
        table: "account_holders",
        where: { kind: "gt", column: "risk_score", value: 80 },
      },
    },
    {
      id: "frozen-account",
      name: "Frozen account",
      description: "An account is currently frozen.",
      predicate: {
        table: "accounts",
        where: { kind: "eq", column: "status", value: "frozen" },
      },
    },
    {
      id: "overdrawn-checking",
      name: "Overdrawn checking account",
      description: "A checking account has a negative balance.",
      predicate: {
        table: "accounts",
        where: {
          kind: "and",
          clauses: [
            { kind: "eq", column: "kind", value: "checking" },
            { kind: "lt", column: "balance", value: 0 },
          ],
        },
      },
    },
    {
      id: "blocked-card",
      name: "Blocked card",
      description: "A card has been blocked from use.",
      predicate: {
        table: "cards",
        where: { kind: "eq", column: "status", value: "blocked" },
      },
    },
    {
      id: "declined-transaction",
      name: "Declined transaction",
      description: "A transaction has been declined.",
      predicate: {
        table: "transactions",
        where: { kind: "eq", column: "status", value: "declined" },
      },
    },
    {
      id: "failed-transfer",
      name: "Failed transfer",
      description: "An internal transfer ended in failed status.",
      predicate: {
        table: "transfers",
        where: { kind: "eq", column: "status", value: "failed" },
      },
    },
    {
      id: "fraud-dispute",
      name: "Open fraud dispute",
      description: "A dispute with reason 'fraud' is still open.",
      predicate: {
        table: "disputes",
        where: {
          kind: "and",
          clauses: [
            { kind: "eq", column: "reason", value: "fraud" },
            { kind: "isNull", column: "resolved_at" },
          ],
        },
      },
    },
  ],
};

export const FINTECH_FIXTURE = {
  ddl: FINTECH_DDL,
  context: FINTECH_CONTEXT,
  plan: FINTECH_PLAN,
} as const;
