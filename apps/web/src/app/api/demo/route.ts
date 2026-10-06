import { NextResponse } from "next/server";

import { runDemoAnalysis } from "@/lib/demo-store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Run the seeded comparison through the real evidence pipeline.
 *
 * This route executes repository code in a local, bounded process. It is
 * available only when the operator explicitly opts in, and it is never a
 * substitute for the sandboxed execution plane described in the product spec.
 */
export async function POST(): Promise<NextResponse> {
  if (process.env.CODEATLAS_DEMO_MODE !== "true") {
    return NextResponse.json(
      {
        error:
          "Demo mode is disabled. Start the app with CODEATLAS_DEMO_MODE=true to run a local analysis.",
      },
      { status: 404 },
    );
  }

  try {
    const model = await runDemoAnalysis();
    return NextResponse.json({
      analysisId: model.analysisId,
      overallState: model.overallState,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: `The analysis failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      },
      { status: 500 },
    );
  }
}
