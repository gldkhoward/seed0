/**
 * Education / LMS template: institutions, courses, instructors, students,
 * enrollments, assignments, submissions, grades.
 */

import type { ScenarioPlan } from "@/lib/types";

export const EDUCATION_DDL = `
CREATE TABLE institutions (
  id BIGINT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('k12', 'community_college', 'university', 'bootcamp'))
);

CREATE TABLE terms (
  id BIGINT PRIMARY KEY,
  institution_id BIGINT NOT NULL REFERENCES institutions(id),
  name TEXT NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  is_current BOOLEAN NOT NULL,
  UNIQUE (institution_id, name)
);

CREATE TABLE instructors (
  id BIGINT PRIMARY KEY,
  institution_id BIGINT NOT NULL REFERENCES institutions(id),
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  rank TEXT NOT NULL CHECK (rank IN ('adjunct', 'assistant', 'associate', 'full', 'emeritus')),
  active BOOLEAN NOT NULL
);

CREATE TABLE students (
  id BIGINT PRIMARY KEY,
  institution_id BIGINT NOT NULL REFERENCES institutions(id),
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  enrolled_year INTEGER NOT NULL CHECK (enrolled_year >= 1900),
  status TEXT NOT NULL CHECK (status IN ('prospective', 'active', 'on_leave', 'graduated', 'withdrawn'))
);

CREATE TABLE courses (
  id BIGINT PRIMARY KEY,
  institution_id BIGINT NOT NULL REFERENCES institutions(id),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits >= 0),
  is_online BOOLEAN NOT NULL,
  UNIQUE (institution_id, code)
);

CREATE TABLE sections (
  id BIGINT PRIMARY KEY,
  course_id BIGINT NOT NULL REFERENCES courses(id),
  term_id BIGINT NOT NULL REFERENCES terms(id),
  instructor_id BIGINT NOT NULL REFERENCES instructors(id),
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'open', 'closed', 'canceled'))
);

CREATE TABLE enrollments (
  id BIGINT PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(id),
  section_id BIGINT NOT NULL REFERENCES sections(id),
  status TEXT NOT NULL CHECK (status IN ('enrolled', 'waitlisted', 'dropped', 'completed')),
  final_grade TEXT,
  enrolled_at TIMESTAMP NOT NULL,
  UNIQUE (student_id, section_id)
);

CREATE TABLE assignments (
  id BIGINT PRIMARY KEY,
  section_id BIGINT NOT NULL REFERENCES sections(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('homework', 'quiz', 'exam', 'project')),
  max_points NUMERIC NOT NULL CHECK (max_points > 0),
  due_at TIMESTAMP NOT NULL
);

CREATE TABLE submissions (
  id BIGINT PRIMARY KEY,
  assignment_id BIGINT NOT NULL REFERENCES assignments(id),
  student_id BIGINT NOT NULL REFERENCES students(id),
  submitted_at TIMESTAMP,
  score NUMERIC CHECK (score >= 0),
  late BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('missing', 'submitted', 'graded', 'returned')),
  UNIQUE (assignment_id, student_id)
);
`.trim();

export const EDUCATION_CONTEXT = [
  "Higher-education learning management system supporting K-12, community",
  "colleges, four-year universities, and bootcamps. Institutions run",
  "academic terms; instructors teach course sections that students enroll",
  "into via the waitlist or directly. Assignments range from homework to",
  "exams, and submissions can be missing, late, or graded with a score.",
  "Final grades roll up into the enrollment record on completion.",
].join(" ");

export const EDUCATION_PLAN: ScenarioPlan = {
  scenarios: [
    {
      id: "bootcamp-institution",
      name: "Bootcamp institution",
      description: "At least one institution has kind 'bootcamp'.",
      predicate: {
        table: "institutions",
        where: { kind: "eq", column: "kind", value: "bootcamp" },
      },
    },
    {
      id: "current-term",
      name: "Current academic term",
      description: "A term is marked as the current term.",
      predicate: {
        table: "terms",
        where: { kind: "eq", column: "is_current", value: true },
      },
    },
    {
      id: "emeritus-instructor",
      name: "Emeritus instructor",
      description: "An instructor holds emeritus rank.",
      predicate: {
        table: "instructors",
        where: { kind: "eq", column: "rank", value: "emeritus" },
      },
    },
    {
      id: "withdrawn-student",
      name: "Withdrawn student",
      description: "A student has status withdrawn.",
      predicate: {
        table: "students",
        where: { kind: "eq", column: "status", value: "withdrawn" },
      },
    },
    {
      id: "online-course",
      name: "Online course offering",
      description: "A course is delivered fully online.",
      predicate: {
        table: "courses",
        where: { kind: "eq", column: "is_online", value: true },
      },
    },
    {
      id: "canceled-section",
      name: "Canceled section",
      description: "A section has been canceled.",
      predicate: {
        table: "sections",
        where: { kind: "eq", column: "status", value: "canceled" },
      },
    },
    {
      id: "waitlisted-enrollment",
      name: "Waitlisted enrollment",
      description: "A student is waitlisted for a section.",
      predicate: {
        table: "enrollments",
        where: { kind: "eq", column: "status", value: "waitlisted" },
      },
    },
    {
      id: "late-submission",
      name: "Late graded submission",
      description: "A submission was marked late and has been graded.",
      predicate: {
        table: "submissions",
        where: {
          kind: "and",
          clauses: [
            { kind: "eq", column: "late", value: true },
            { kind: "eq", column: "status", value: "graded" },
          ],
        },
      },
    },
  ],
};

export const EDUCATION_FIXTURE = {
  ddl: EDUCATION_DDL,
  context: EDUCATION_CONTEXT,
  plan: EDUCATION_PLAN,
} as const;
