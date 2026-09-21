/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { adjustTextareaHeight, COMPOSER_MEASUREMENT_MAX_CHARS } from "./chat-composer-dom.ts";

function createCountingTextarea(scrollHeight: number) {
  const textarea = document.createElement("textarea");
  let scrollHeightReads = 0;
  Object.defineProperty(textarea, "scrollHeight", {
    configurable: true,
    get: () => {
      scrollHeightReads += 1;
      return scrollHeight;
    },
  });
  return { textarea, reads: () => scrollHeightReads };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("composer autosize measurement cap", () => {
  it("pins an over-cap draft to the CSS cap without a measurement pass", () => {
    const { textarea, reads } = createCountingTextarea(50_000);
    textarea.value = "x".repeat(COMPOSER_MEASUREMENT_MAX_CHARS + 1);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "156px",
    } as CSSStyleDeclaration);

    adjustTextareaHeight(textarea);

    expect(textarea.style.height).toBe("156px");
    expect(textarea.style.overflowY).toBe("auto");
    expect(reads()).toBe(0);
  });

  it("keeps the shared fallback for non-pixel CSS caps beyond the cap", () => {
    const { textarea, reads } = createCountingTextarea(50_000);
    textarea.value = "x".repeat(COMPOSER_MEASUREMENT_MAX_CHARS + 1);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "50vh",
    } as CSSStyleDeclaration);

    adjustTextareaHeight(textarea);

    expect(textarea.style.height).toBe("150px");
    expect(reads()).toBe(0);
  });

  it("still measures drafts at the cap boundary", () => {
    const { textarea, reads } = createCountingTextarea(42);
    textarea.value = "x".repeat(COMPOSER_MEASUREMENT_MAX_CHARS);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "156px",
    } as CSSStyleDeclaration);

    adjustTextareaHeight(textarea);

    expect(reads()).toBeGreaterThan(0);
    expect(textarea.style.height).toBe("42px");
  });

  it("resumes measuring after the draft shrinks below the cap", () => {
    const { textarea, reads } = createCountingTextarea(42);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "156px",
    } as CSSStyleDeclaration);

    textarea.value = "x".repeat(COMPOSER_MEASUREMENT_MAX_CHARS + 1);
    adjustTextareaHeight(textarea);
    expect(reads()).toBe(0);
    expect(textarea.style.height).toBe("156px");

    textarea.value = "shrunk back";
    adjustTextareaHeight(textarea);
    expect(reads()).toBeGreaterThan(0);
    expect(textarea.style.height).toBe("42px");
  });

  it("leaves the single-line layout branch untouched for over-cap values", () => {
    const { textarea, reads } = createCountingTextarea(50_000);
    const host = document.createElement("div");
    host.setAttribute("data-composer-layout", "single-line");
    host.append(textarea);
    textarea.value = "x".repeat(COMPOSER_MEASUREMENT_MAX_CHARS + 1);

    adjustTextareaHeight(textarea);

    expect(textarea.style.height).toBe("");
    expect(textarea.style.overflowY).toBe("");
    expect(reads()).toBe(0);
  });
});
