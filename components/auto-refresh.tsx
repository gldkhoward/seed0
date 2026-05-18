"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Tiny client island that polls `router.refresh()` on an interval.
 * Used by server-rendered pages that need to surface live state
 * (e.g., a planner step finishing) without becoming full client
 * components.
 */
export function AutoRefresh({ intervalMs = 1500 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
