import { useEffect, useState } from "react";
import type { AiReviewRun } from "@t3tools/contracts";

export function ReviewRunStatus({ run }: { run: AiReviewRun }) {
  const running = !["draft", "failed", "cancelled"].includes(run.stage);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsed = Math.max(
    0,
    Math.floor((running ? now - Date.parse(run.createdAt) : run.durationMs) / 1000),
  );
  const quietSeconds = Math.max(0, Math.floor((now - Date.parse(run.updatedAt)) / 1000));
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        {run.agent.modelSelection.model} · {Math.floor(elapsed / 60)}m {elapsed % 60}s elapsed
        {running ? ` · Last update ${quietSeconds}s ago` : ""}
      </p>
      {running && quietSeconds >= 60 && (
        <p role="status" className="text-amber-600 dark:text-amber-400">
          No updates for over a minute. The provider may be waiting. You can cancel and retry;
          nothing has been published.
        </p>
      )}
    </div>
  );
}
