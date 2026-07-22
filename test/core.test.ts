import { describe, expect, it } from "vitest";
import { classifyError, retryDelay } from "../src/errors.js";
import { buildImagePrompt } from "../src/image-prompt.js";
import { resolveGroups, wouldCreateCycle } from "../src/group-resolver.js";

describe("OpenAI error policy", () => {
  it("retries rate limits and honors retry-after", () => {
    const failure = classifyError({
      status: 429,
      request_id: "req_123",
      headers: new Headers({ "retry-after": "7" }),
    });
    expect(failure).toMatchObject({
      category: "rate_limit",
      transient: true,
      requestId: "req_123",
      retryAfterMs: 7000,
    });
    expect(retryDelay(1, failure.retryAfterMs, 0)).toBe(7000);
  });
  it("does not retry invalid credentials or validation failures", () => {
    expect(classifyError({ status: 401 }).transient).toBe(false);
    expect(classifyError({ status: 422 }).transient).toBe(false);
  });
  it("uses bounded exponential backoff", () => {
    expect(retryDelay(1, undefined, 0)).toBe(1000);
    expect(retryDelay(3, undefined, 0)).toBe(4000);
    expect(retryDelay(20, undefined, 0)).toBe(30000);
  });
});

describe("numbered image references", () => {
  it("keeps material numbers independent from the base checkpoint", () => {
    const prompt = buildImagePrompt("Use material 2 for the lighting.", true, [
      "pose.png",
      "light.jpg",
    ]);
    expect(prompt).toContain("Base checkpoint: input image 1");
    expect(prompt).toContain("Material 1: input image 2 (pose.png)");
    expect(prompt).toContain("Material 2: input image 3 (light.jpg)");
  });
  it("maps root materials from input image one", () => {
    expect(
      buildImagePrompt("Match material 1.", false, ["style.png"]),
    ).toContain("Material 1: input image 1");
  });
});

describe("material group resolution", () => {
  const groups = [
    { id: "character", label: "Character" },
    { id: "wardrobe", label: "Wardrobe" },
  ];
  const members = [
    { group_id: "character", material_id: "face", position: 0 },
    { group_id: "wardrobe", material_id: "coat", position: 0 },
    { group_id: "wardrobe", material_id: "face", position: 1 },
  ];
  const edges = [
    { source_group_id: "wardrobe", target_group_id: "character", position: 0 },
  ];
  it("flattens nested groups and deduplicates first occurrence", () =>
    expect(
      resolveGroups(["character"], groups, members, edges).materialIds,
    ).toEqual(["coat", "face"]));
  it("preserves labeled nested provenance", () =>
    expect(
      resolveGroups(["character"], groups, members, edges).groupSnapshots[1]
        .path,
    ).toEqual(["Character", "Wardrobe"]));
  it("snapshots group notes for the generation prompt", () =>
    expect(
      resolveGroups(
        ["character"],
        [{ ...groups[0], notes: "Keep the same face." }],
        members,
        [],
      ).groupSnapshots[0].notes,
    ).toBe("Keep the same face."));
  it("rejects links that create cycles", () =>
    expect(wouldCreateCycle(edges, "character", "wardrobe")).toBe(true));
  it("blocks resolved input overflow", () =>
    expect(() =>
      resolveGroups(
        ["character"],
        groups,
        Array.from({ length: 16 }, (_, position) => ({
          group_id: "character",
          material_id: `m${position}`,
          position,
        })),
        [],
        15,
      ),
    ).toThrow("maximum is 15"));
});
