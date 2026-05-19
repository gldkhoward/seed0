/**
 * Content publishing platform template: authors, posts, revisions,
 * comments, tags, media.
 */

import type { ScenarioPlan } from "@/lib/types";

export const CONTENT_DDL = `
CREATE TABLE authors (
  id BIGINT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio TEXT,
  role TEXT NOT NULL CHECK (role IN ('contributor', 'editor', 'admin')),
  verified BOOLEAN NOT NULL,
  joined_at TIMESTAMP NOT NULL
);

CREATE TABLE tags (
  id BIGINT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT
);

CREATE TABLE posts (
  id BIGINT PRIMARY KEY,
  author_id BIGINT NOT NULL REFERENCES authors(id),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'review', 'scheduled', 'published', 'archived')),
  word_count INTEGER NOT NULL CHECK (word_count >= 0),
  published_at TIMESTAMP,
  scheduled_for TIMESTAMP
);

CREATE TABLE post_tags (
  post_id BIGINT NOT NULL REFERENCES posts(id),
  tag_id BIGINT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (post_id, tag_id)
);

CREATE TABLE revisions (
  id BIGINT PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES posts(id),
  editor_id BIGINT NOT NULL REFERENCES authors(id),
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  body_snapshot TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  UNIQUE (post_id, revision_number)
);

CREATE TABLE comments (
  id BIGINT PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES posts(id),
  parent_id BIGINT REFERENCES comments(id),
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'spam', 'rejected')),
  submitted_at TIMESTAMP NOT NULL
);

CREATE TABLE media (
  id BIGINT PRIMARY KEY,
  uploader_id BIGINT NOT NULL REFERENCES authors(id),
  url TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document')),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  uploaded_at TIMESTAMP NOT NULL
);
`.trim();

export const CONTENT_CONTEXT = [
  "Editorial publishing platform for a multi-author tech publication.",
  "Authors draft posts that move through draft, review, scheduled, and",
  "published states; editors create revisions tracked per post. Posts are",
  "tagged for discovery, attract threaded comments that go through",
  "moderation, and reference uploaded media. Some authors are verified.",
].join(" ");

export const CONTENT_PLAN: ScenarioPlan = {
  scenarios: [
    {
      id: "verified-author",
      name: "Verified author",
      description: "An author has been marked as verified.",
      predicate: {
        table: "authors",
        where: { kind: "eq", column: "verified", value: true },
      },
    },
    {
      id: "admin-author",
      name: "Admin-role author",
      description: "An author holds the admin role.",
      predicate: {
        table: "authors",
        where: { kind: "eq", column: "role", value: "admin" },
      },
    },
    {
      id: "scheduled-post",
      name: "Scheduled post",
      description: "A post is in scheduled status with a future publish time.",
      predicate: {
        table: "posts",
        where: {
          kind: "and",
          clauses: [
            { kind: "eq", column: "status", value: "scheduled" },
            { kind: "isNotNull", column: "scheduled_for" },
          ],
        },
      },
    },
    {
      id: "long-form-post",
      name: "Long-form published post",
      description: "A published post exceeds 2,000 words.",
      predicate: {
        table: "posts",
        where: {
          kind: "and",
          clauses: [
            { kind: "eq", column: "status", value: "published" },
            { kind: "gt", column: "word_count", value: 2000 },
          ],
        },
      },
    },
    {
      id: "threaded-comment",
      name: "Reply to a comment",
      description: "A comment has a non-null parent_id (it is a reply).",
      predicate: {
        table: "comments",
        where: { kind: "isNotNull", column: "parent_id" },
      },
    },
    {
      id: "spam-comment",
      name: "Comment flagged as spam",
      description: "A comment has been moderated as spam.",
      predicate: {
        table: "comments",
        where: { kind: "eq", column: "status", value: "spam" },
      },
    },
    {
      id: "video-media",
      name: "Video media asset",
      description: "A media asset of kind 'video' has been uploaded.",
      predicate: {
        table: "media",
        where: { kind: "eq", column: "kind", value: "video" },
      },
    },
  ],
};

export const CONTENT_FIXTURE = {
  ddl: CONTENT_DDL,
  context: CONTENT_CONTEXT,
  plan: CONTENT_PLAN,
} as const;
