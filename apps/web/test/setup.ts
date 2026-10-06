import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without injected globals, so Testing Library's own auto-cleanup
// hook never registers. Unmount explicitly or queries would see every previous
// render still attached to the document.
afterEach(cleanup);
