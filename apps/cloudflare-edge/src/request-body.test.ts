import { describe, expect, it } from "vitest";
import { readBodyWithLimit, readJsonWithLimit } from "./request-body.js";

describe("bounded request bodies", () => {
  it("rejects a declared oversized body before reading it", async () => {
    const request = new Request("https://edge.example.test", {
      method: "POST",
      headers: { "content-length": "100" },
      body: "{}",
    });
    await expect(readBodyWithLimit(request, 10)).resolves.toEqual({ ok: false, status: 413 });
  });

  it("rejects a streamed body once it crosses the limit", async () => {
    const request = new Request("https://edge.example.test", {
      method: "POST",
      body: "12345678901",
    });
    await expect(readBodyWithLimit(request, 10)).resolves.toEqual({ ok: false, status: 413 });
  });

  it("distinguishes malformed JSON", async () => {
    const request = new Request("https://edge.example.test", { method: "POST", body: "{" });
    await expect(readJsonWithLimit(request, 10)).resolves.toEqual({ ok: false, status: 400 });
  });
});
