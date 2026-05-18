/**
 * Demo fixture (tasks 5.1 + 5.2): the 8-table ecommerce schema, the
 * product context, and the 8-scenario predicate-bearing plan.
 *
 * Pure data. Imports only shared types. Drives both the in-app example
 * template and the regression check in lib/eval/regression.ts.
 */

import type { ScenarioPlan } from "@/lib/types";

/**
 * 8 tables, accepted subset only: tables, columns, types, PRIMARY KEY,
 * FOREIGN KEY, NOT NULL, UNIQUE, CHECK, ENUM-as-text+CHECK. No triggers,
 * functions, partitioning, or custom domains.
 */
export const ECOMMERCE_DDL = `
CREATE TABLE customers (
  id BIGINT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('free', 'standard', 'premium')),
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE addresses (
  id BIGINT PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  line1 TEXT NOT NULL,
  city TEXT NOT NULL,
  region TEXT,
  country TEXT NOT NULL,
  postal_code TEXT NOT NULL
);

CREATE TABLE categories (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  parent_id BIGINT REFERENCES categories(id)
);

CREATE TABLE products (
  id BIGINT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category_id BIGINT NOT NULL REFERENCES categories(id),
  price NUMERIC NOT NULL CHECK (price >= 0),
  active BOOLEAN NOT NULL
);

CREATE TABLE inventory (
  product_id BIGINT PRIMARY KEY REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  warehouse TEXT NOT NULL
);

CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  shipping_address_id BIGINT NOT NULL REFERENCES addresses(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
  total NUMERIC NOT NULL CHECK (total >= 0),
  placed_at TIMESTAMP NOT NULL
);

CREATE TABLE order_items (
  id BIGINT PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC NOT NULL CHECK (unit_price >= 0)
);

CREATE TABLE payments (
  id BIGINT PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id),
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  processed_at TIMESTAMP
);
`.trim();

export const ECOMMERCE_CONTEXT = [
  "Direct-to-consumer ecommerce storefront selling physical goods globally.",
  "Customers progress through free, standard, and premium tiers based on",
  "purchase history. Orders move through pending → paid → shipped →",
  "delivered, with cancellations possible at any point before shipping.",
  "Inventory is tracked per product across multiple warehouses; payments",
  "can fail or be refunded. International shipping is supported.",
].join(" ");

/**
 * 8 named scenarios, each carrying a deterministic predicate bound to
 * tables and columns in ECOMMERCE_DDL. A scenario is instantiated iff at
 * least one canonical row in `predicate.table` satisfies `predicate.where`.
 */
export const ECOMMERCE_PLAN: ScenarioPlan = {
  scenarios: [
    {
      id: "premium-customer",
      name: "Premium tier customer",
      description: "At least one customer has reached the premium tier.",
      predicate: {
        table: "customers",
        where: { kind: "eq", column: "tier", value: "premium" },
      },
    },
    {
      id: "premium-product",
      name: "Active premium-priced product",
      description: "An active product priced above $100 is on the catalog.",
      predicate: {
        table: "products",
        where: {
          kind: "and",
          clauses: [
            { kind: "eq", column: "active", value: true },
            { kind: "gt", column: "price", value: 100 },
          ],
        },
      },
    },
    {
      id: "shipped-order",
      name: "Order in shipped state",
      description: "At least one order has progressed to shipped status.",
      predicate: {
        table: "orders",
        where: { kind: "eq", column: "status", value: "shipped" },
      },
    },
    {
      id: "failed-payment",
      name: "Failed payment recorded",
      description: "A payment with status 'failed' exists for diagnostic flows.",
      predicate: {
        table: "payments",
        where: { kind: "eq", column: "status", value: "failed" },
      },
    },
    {
      id: "multi-quantity-line",
      name: "Multi-quantity order line",
      description: "An order line item has quantity greater than one.",
      predicate: {
        table: "order_items",
        where: { kind: "gt", column: "quantity", value: 1 },
      },
    },
    {
      id: "out-of-stock",
      name: "Out-of-stock inventory",
      description: "Inventory for at least one product is exhausted.",
      predicate: {
        table: "inventory",
        where: { kind: "eq", column: "quantity", value: 0 },
      },
    },
    {
      id: "international-address",
      name: "International shipping address",
      description: "A customer address outside the United States is on file.",
      predicate: {
        table: "addresses",
        where: { kind: "neq", column: "country", value: "US" },
      },
    },
    {
      id: "nested-category",
      name: "Nested product category",
      description: "A category exists whose parent_id references another category.",
      predicate: {
        table: "categories",
        where: { kind: "isNotNull", column: "parent_id" },
      },
    },
  ],
};

export const ECOMMERCE_FIXTURE = {
  ddl: ECOMMERCE_DDL,
  context: ECOMMERCE_CONTEXT,
  plan: ECOMMERCE_PLAN,
} as const;
