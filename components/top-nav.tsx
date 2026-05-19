import Link from "next/link";
import { Sprout } from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

interface TopNavProps {
  current?: "home" | "new" | "runs";
}

export function TopNav({ current = "home" }: TopNavProps) {
  return (
    <header className="border-b border-border bg-background/80 backdrop-blur supports-backdrop-filter:bg-background/60 sticky top-0 z-30">
      <nav className="mx-auto flex max-w-5xl items-center justify-between gap-6 px-6 py-3">
        <Link
          href="/"
          className="group flex items-center gap-2 text-sm font-medium tracking-tight"
          aria-current={current === "home" ? "page" : undefined}
        >
          <span
            className="inline-flex size-6 items-center justify-center rounded-md border border-border bg-card text-foreground transition-colors group-hover:bg-muted"
            aria-hidden="true"
          >
            <Sprout className="size-3.5 text-primary" />
          </span>
          <span>seed0</span>
        </Link>
        <div className="flex items-center gap-1.5">
          <Link href="/runs">
            <Button
              variant={current === "runs" ? "secondary" : "ghost"}
              size="sm"
              aria-current={current === "runs" ? "page" : undefined}
            >
              Runs
            </Button>
          </Link>
          <Link href="/new">
            <Button
              variant="default"
              size="sm"
              aria-current={current === "new" ? "page" : undefined}
            >
              New run
            </Button>
          </Link>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
