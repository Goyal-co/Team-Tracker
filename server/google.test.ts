import { describe, expect, it } from "vitest";
import { calendarScopesGranted } from "./google";

describe("calendarScopesGranted", () => {
  it("accepts the scopes registered for this Google client", () => {
    expect(calendarScopesGranted("openid email profile https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy")).toBe(true);
  });

  it("accepts full calendar access", () => {
    expect(calendarScopesGranted("openid https://www.googleapis.com/auth/calendar")).toBe(true);
  });

  it("does not treat a readonly events scope as permission to create meetings", () => {
    expect(calendarScopesGranted("https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.freebusy")).toBe(false);
    expect(calendarScopesGranted("https://www.googleapis.com/auth/calendar.events.owned.readonly https://www.googleapis.com/auth/calendar.freebusy")).toBe(false);
  });
});
