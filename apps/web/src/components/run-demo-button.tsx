"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Starts the real local analysis. There is no simulated progress here: the
 * button stays busy until the pipeline reaches a terminal state, and any
 * failure is reported instead of a fabricated result.
 */
export function RunDemoButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        className="action"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const response = await fetch("/api/demo", { method: "POST" });
            const payload: unknown = await response.json();
            if (!response.ok) {
              const message =
                typeof payload === "object" &&
                payload !== null &&
                typeof (payload as { error?: unknown }).error === "string"
                  ? (payload as { error: string }).error
                  : "The analysis could not be started.";
              setError(message);
              return;
            }
            router.push("/demo/pr/284");
            router.refresh();
          } catch {
            setError("The analysis request could not be completed.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Running verified demo…" : "Run verified demo"}
      </button>
      <p
        aria-live="polite"
        className={error === null ? undefined : "error-note"}
      >
        {busy
          ? "Executing the base and head revisions. This runs real tests and takes about a minute."
          : (error ?? "")}
      </p>
    </div>
  );
}
