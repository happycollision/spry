import { test, expect } from "bun:test";
import { toStdinBuffer } from "../../src/lib/context.ts";

test("toStdinBuffer redirects an empty string (does not inherit parent stdin)", () => {
  const buf = toStdinBuffer("");
  expect(buf).toBeInstanceOf(Buffer);
  expect(buf?.length).toBe(0);
});

test("toStdinBuffer returns a buffer with the content for non-empty stdin", () => {
  expect(toStdinBuffer("hello")?.toString()).toBe("hello");
});

test("toStdinBuffer returns undefined when stdin is undefined (inherit)", () => {
  expect(toStdinBuffer(undefined)).toBeUndefined();
});
