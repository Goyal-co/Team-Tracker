import { describe, expect, it } from "vitest";
import { csvCell, fileSignatureMatches } from "./security";

describe("security helpers", () => {
  it("neutralises spreadsheet formulas in exported cells", () => {
    expect(csvCell("=cmd")).toBe("'=cmd");
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("rejects a file whose bytes do not match the declared type", () => {
    expect(fileSignatureMatches(Buffer.from("%PDF-1.7"), "application/pdf")).toBe(true);
    expect(fileSignatureMatches(Buffer.from("<html>"), "application/pdf")).toBe(false);
    expect(fileSignatureMatches(Buffer.from("notes"), "text/plain")).toBe(true);
    expect(fileSignatureMatches(Buffer.from([0x00, 0x41]), "text/plain")).toBe(false);
  });
});