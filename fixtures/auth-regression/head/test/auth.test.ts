import { describe, expect, it } from "vitest";
import { restoreSession } from "../src/auth.js";

describe("restoreSession", () => {
  it("restores a valid session", () => {
    expect(restoreSession({ subject: "usr_1", expiresAt: 200, refreshable: true }, 100)).toEqual({
      status: 200,
      body: { userId: "USR_1" }
    });
  });
});
