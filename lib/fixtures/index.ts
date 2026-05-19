/**
 * Registry of all in-app schema templates. Each entry exports the same
 * shape as the ecommerce fixture: DDL in the accepted Postgres subset, a
 * product context paragraph, and a ScenarioPlan with deterministic
 * predicates. Used by the homepage template grid and the /new page when
 * the `?example=<slug>` query param is present.
 */

import { CONTENT_CONTEXT, CONTENT_DDL, CONTENT_FIXTURE } from "./content";
import { CRM_CONTEXT, CRM_DDL, CRM_FIXTURE } from "./crm";
import {
  ECOMMERCE_CONTEXT,
  ECOMMERCE_DDL,
  ECOMMERCE_FIXTURE,
} from "./ecommerce";
import {
  EDUCATION_CONTEXT,
  EDUCATION_DDL,
  EDUCATION_FIXTURE,
} from "./education";
import { FINTECH_CONTEXT, FINTECH_DDL, FINTECH_FIXTURE } from "./fintech";
import {
  HEALTHCARE_CONTEXT,
  HEALTHCARE_DDL,
  HEALTHCARE_FIXTURE,
} from "./healthcare";
import {
  LOGISTICS_CONTEXT,
  LOGISTICS_DDL,
  LOGISTICS_FIXTURE,
} from "./logistics";
import { SAAS_CONTEXT, SAAS_DDL, SAAS_FIXTURE } from "./saas";

export type TemplateSlug =
  | "ecommerce"
  | "saas"
  | "crm"
  | "content"
  | "healthcare"
  | "logistics"
  | "fintech"
  | "education";

export type TemplateEntry = {
  slug: TemplateSlug;
  name: string;
  tables: number;
  summary: string;
  ddl: string;
  context: string;
  fixture: typeof ECOMMERCE_FIXTURE;
};

export const TEMPLATES: readonly TemplateEntry[] = [
  {
    slug: "ecommerce",
    name: "Ecommerce",
    tables: 8,
    summary:
      "Customers, addresses, categories, products, inventory, orders, order items, payments.",
    ddl: ECOMMERCE_DDL,
    context: ECOMMERCE_CONTEXT,
    fixture: ECOMMERCE_FIXTURE,
  },
  {
    slug: "saas",
    name: "SaaS starter",
    tables: 7,
    summary:
      "Organizations, users, plans, subscriptions, invoices, API keys, audit logs.",
    ddl: SAAS_DDL,
    context: SAAS_CONTEXT,
    fixture: SAAS_FIXTURE,
  },
  {
    slug: "crm",
    name: "B2B CRM",
    tables: 8,
    summary:
      "Accounts, contacts, deals, pipelines, stages, owners, activities, notes.",
    ddl: CRM_DDL,
    context: CRM_CONTEXT,
    fixture: CRM_FIXTURE,
  },
  {
    slug: "content",
    name: "Content platform",
    tables: 7,
    summary:
      "Authors, posts, post_tags, revisions, comments, tags, media uploads.",
    ddl: CONTENT_DDL,
    context: CONTENT_CONTEXT,
    fixture: CONTENT_FIXTURE,
  },
  {
    slug: "healthcare",
    name: "Healthcare EHR",
    tables: 9,
    summary:
      "Patients, providers, payers, coverages, encounters, diagnoses, prescriptions, claims, allergies.",
    ddl: HEALTHCARE_DDL,
    context: HEALTHCARE_CONTEXT,
    fixture: HEALTHCARE_FIXTURE,
  },
  {
    slug: "logistics",
    name: "Logistics",
    tables: 7,
    summary:
      "Carriers, warehouses, drivers, shipments, packages, routes, delivery attempts.",
    ddl: LOGISTICS_DDL,
    context: LOGISTICS_CONTEXT,
    fixture: LOGISTICS_FIXTURE,
  },
  {
    slug: "fintech",
    name: "Fintech banking",
    tables: 8,
    summary:
      "Holders, accounts, cards, merchants, transactions, transfers, statements, disputes.",
    ddl: FINTECH_DDL,
    context: FINTECH_CONTEXT,
    fixture: FINTECH_FIXTURE,
  },
  {
    slug: "education",
    name: "Education LMS",
    tables: 9,
    summary:
      "Institutions, terms, instructors, students, courses, sections, enrollments, assignments, submissions.",
    ddl: EDUCATION_DDL,
    context: EDUCATION_CONTEXT,
    fixture: EDUCATION_FIXTURE,
  },
];

export function getTemplate(slug: string): TemplateEntry | undefined {
  return TEMPLATES.find((t) => t.slug === slug);
}
