/**
 * Logistics / freight template: carriers, warehouses, shipments, packages,
 * routes, deliveries.
 */

import type { ScenarioPlan } from "@/lib/types";

export const LOGISTICS_DDL = `
CREATE TABLE carriers (
  id BIGINT PRIMARY KEY,
  scac TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('truck', 'rail', 'air', 'ocean')),
  active BOOLEAN NOT NULL
);

CREATE TABLE warehouses (
  id BIGINT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL,
  capacity_pallets INTEGER NOT NULL CHECK (capacity_pallets >= 0)
);

CREATE TABLE drivers (
  id BIGINT PRIMARY KEY,
  carrier_id BIGINT NOT NULL REFERENCES carriers(id),
  license_number TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  hazmat_certified BOOLEAN NOT NULL,
  on_duty BOOLEAN NOT NULL
);

CREATE TABLE shipments (
  id BIGINT PRIMARY KEY,
  carrier_id BIGINT NOT NULL REFERENCES carriers(id),
  origin_warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),
  destination_warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL CHECK (status IN ('booked', 'in_transit', 'delivered', 'delayed', 'lost')),
  weight_kg NUMERIC NOT NULL CHECK (weight_kg >= 0),
  hazmat BOOLEAN NOT NULL,
  picked_up_at TIMESTAMP,
  delivered_at TIMESTAMP
);

CREATE TABLE packages (
  id BIGINT PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES shipments(id),
  tracking_number TEXT NOT NULL UNIQUE,
  weight_kg NUMERIC NOT NULL CHECK (weight_kg >= 0),
  length_cm INTEGER NOT NULL CHECK (length_cm > 0),
  width_cm INTEGER NOT NULL CHECK (width_cm > 0),
  height_cm INTEGER NOT NULL CHECK (height_cm > 0),
  fragile BOOLEAN NOT NULL
);

CREATE TABLE routes (
  id BIGINT PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES shipments(id),
  driver_id BIGINT REFERENCES drivers(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  waypoint TEXT NOT NULL,
  scheduled_arrival TIMESTAMP NOT NULL,
  actual_arrival TIMESTAMP,
  UNIQUE (shipment_id, sequence)
);

CREATE TABLE delivery_attempts (
  id BIGINT PRIMARY KEY,
  package_id BIGINT NOT NULL REFERENCES packages(id),
  attempted_at TIMESTAMP NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'no_one_home', 'refused', 'damaged', 'rescheduled')),
  signature_required BOOLEAN NOT NULL
);
`.trim();

export const LOGISTICS_CONTEXT = [
  "International freight and parcel logistics platform coordinating",
  "shipments across truck, rail, air, and ocean carriers. Warehouses",
  "function as origin and destination nodes with finite pallet capacity.",
  "Shipments contain packages, follow sequenced waypoints driven by",
  "drivers, and may be flagged hazmat or fragile. Delivery attempts capture",
  "outcomes including damage, refusal, and rescheduling.",
].join(" ");

export const LOGISTICS_PLAN: ScenarioPlan = {
  scenarios: [
    {
      id: "ocean-carrier",
      name: "Active ocean carrier",
      description: "An active carrier operates in ocean mode.",
      predicate: {
        table: "carriers",
        where: {
          kind: "and",
          clauses: [
            { kind: "eq", column: "mode", value: "ocean" },
            { kind: "eq", column: "active", value: true },
          ],
        },
      },
    },
    {
      id: "high-capacity-warehouse",
      name: "High-capacity warehouse",
      description: "A warehouse has capacity for more than 5,000 pallets.",
      predicate: {
        table: "warehouses",
        where: { kind: "gt", column: "capacity_pallets", value: 5000 },
      },
    },
    {
      id: "hazmat-driver",
      name: "Hazmat-certified driver on duty",
      description: "A hazmat-certified driver is on duty.",
      predicate: {
        table: "drivers",
        where: {
          kind: "and",
          clauses: [
            { kind: "eq", column: "hazmat_certified", value: true },
            { kind: "eq", column: "on_duty", value: true },
          ],
        },
      },
    },
    {
      id: "delayed-shipment",
      name: "Delayed shipment",
      description: "A shipment is in delayed status.",
      predicate: {
        table: "shipments",
        where: { kind: "eq", column: "status", value: "delayed" },
      },
    },
    {
      id: "hazmat-shipment",
      name: "In-transit hazmat shipment",
      description: "A hazmat shipment is currently in transit.",
      predicate: {
        table: "shipments",
        where: {
          kind: "and",
          clauses: [
            { kind: "eq", column: "hazmat", value: true },
            { kind: "eq", column: "status", value: "in_transit" },
          ],
        },
      },
    },
    {
      id: "fragile-package",
      name: "Fragile package",
      description: "A package is marked as fragile.",
      predicate: {
        table: "packages",
        where: { kind: "eq", column: "fragile", value: true },
      },
    },
    {
      id: "damaged-delivery",
      name: "Damaged delivery attempt",
      description: "A delivery attempt resulted in damaged outcome.",
      predicate: {
        table: "delivery_attempts",
        where: { kind: "eq", column: "outcome", value: "damaged" },
      },
    },
  ],
};

export const LOGISTICS_FIXTURE = {
  ddl: LOGISTICS_DDL,
  context: LOGISTICS_CONTEXT,
  plan: LOGISTICS_PLAN,
} as const;
