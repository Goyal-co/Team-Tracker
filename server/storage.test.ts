import { describe, expect, it } from "vitest";
import { objectKey } from "./storage";

describe("object keys", () => {
  it("keeps the prefix and a safe extension", () => {
    expect(objectKey("goyal/workspace", "chat", "abc", "photo.PNG")).toBe("goyal/workspace/chat/abc.png");
    expect(objectKey("/goyal/", "tasks", "abc", "notes")).toBe("goyal/tasks/abc");
  });
});
