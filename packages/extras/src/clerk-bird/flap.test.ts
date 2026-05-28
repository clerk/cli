import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beep, insertEntry, loadRankings, removeRanking } from "./flap.ts";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flap-rankings-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("insertEntry", () => {
  it("inserts the first entry at rank 1", () => {
    const result = insertEntry([], { name: "alice", score: 10, ts: 1 });
    expect(result.rank).toBe(1);
    expect(result.list).toEqual([{ name: "alice", score: 10, ts: 1 }]);
  });

  it("sorts higher scores above lower scores", () => {
    const list = [{ name: "alice", score: 10, ts: 1 }];
    const result = insertEntry(list, { name: "bob", score: 20, ts: 2 });
    expect(result.rank).toBe(1);
    expect(result.list.map((e) => e.name)).toEqual(["bob", "alice"]);
  });

  it("breaks ties by earlier timestamp", () => {
    const list = [{ name: "alice", score: 10, ts: 5 }];
    const result = insertEntry(list, { name: "bob", score: 10, ts: 1 });
    expect(result.rank).toBe(1);
    expect(result.list.map((e) => e.name)).toEqual(["bob", "alice"]);
  });

  it("preserves existing order when new entry tied but later", () => {
    const list = [{ name: "alice", score: 10, ts: 1 }];
    const result = insertEntry(list, { name: "bob", score: 10, ts: 5 });
    expect(result.rank).toBe(2);
    expect(result.list.map((e) => e.name)).toEqual(["alice", "bob"]);
  });

  it("evicts the lowest score when the cap is reached", () => {
    const list = Array.from({ length: 10 }, (_, i) => ({
      name: `p${i}`,
      score: 100 - i, // 100, 99, ..., 91
      ts: i,
    }));
    const result = insertEntry(list, { name: "new", score: 95, ts: 999 });
    // p5 also has score 95 with older ts:5, so it ranks above the new entry.
    expect(result.rank).toBe(7);
    expect(result.list).toHaveLength(10);
    expect(result.list.map((e) => e.name)).not.toContain("p9"); // score 91 evicted
    expect(result.list.map((e) => e.name)).toContain("new");
  });

  it("returns null rank and unchanged list when score does not qualify", () => {
    const list = Array.from({ length: 10 }, (_, i) => ({
      name: `p${i}`,
      score: 100 - i, // 91 is the lowest
      ts: i,
    }));
    const result = insertEntry(list, { name: "loser", score: 5, ts: 999 });
    expect(result.rank).toBeNull();
    expect(result.list).toHaveLength(10);
    expect(result.list.map((e) => e.name)).not.toContain("loser");
  });

  it("respects a custom cap", () => {
    const list = [
      { name: "a", score: 10, ts: 1 },
      { name: "b", score: 5, ts: 2 },
    ];
    const result = insertEntry(list, { name: "c", score: 7, ts: 3 }, 2);
    expect(result.rank).toBe(2);
    expect(result.list.map((e) => e.name)).toEqual(["a", "c"]);
  });
});

describe("removeRanking", () => {
  const list = [
    { name: "alice", score: 30, ts: 1 },
    { name: "bob", score: 20, ts: 2 },
    { name: "carol", score: 10, ts: 3 },
  ];

  it.each([
    [1, ["bob", "carol"]],
    [2, ["alice", "carol"]],
    [3, ["alice", "bob"]],
  ] as const)("removes the entry at 1-based rank %i", (rank, expected) => {
    expect(removeRanking(list, rank).map((e) => e.name)).toEqual([...expected]);
  });

  it("does not mutate the input list", () => {
    const before = list.slice();
    removeRanking(list, 2);
    expect(list).toEqual(before);
  });

  it.each([-1, 0, 4])("returns the same reference when rank is out of range (%i)", (rank) => {
    expect(removeRanking(list, rank)).toBe(list);
  });

  it("handles an empty list", () => {
    expect(removeRanking([], 1)).toEqual([]);
  });

  it("removing the last remaining entry yields an empty list", () => {
    expect(removeRanking([{ name: "solo", score: 1, ts: 1 }], 1)).toEqual([]);
  });
});

describe("loadRankings", () => {
  it("returns an empty list when the file does not exist", async () => {
    const dir = makeTmpDir();
    const result = await loadRankings(join(dir, "missing.json"));
    expect(result).toEqual([]);
  });

  it("returns an empty list when the file contains malformed JSON", async () => {
    const dir = makeTmpDir();
    const file = join(dir, "rankings.json");
    await Bun.write(file, "{ this is not json");
    const result = await loadRankings(file);
    expect(result).toEqual([]);
  });

  it("returns an empty list when the entries field is missing", async () => {
    const dir = makeTmpDir();
    const file = join(dir, "rankings.json");
    await Bun.write(file, JSON.stringify({ version: 1 }));
    const result = await loadRankings(file);
    expect(result).toEqual([]);
  });

  it("filters out malformed entries while keeping valid ones", async () => {
    const dir = makeTmpDir();
    const file = join(dir, "rankings.json");
    await Bun.write(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          { name: "alice", score: 10, ts: 1 },
          { name: "bob" }, // missing score/ts
          null,
          { name: 42, score: 5, ts: 2 }, // wrong name type
          { name: "carol", score: 20, ts: 3 },
        ],
      }),
    );
    const result = await loadRankings(file);
    expect(result.map((e) => e.name)).toEqual(["carol", "alice"]); // sorted desc
  });

  it("truncates overlong names to MAX_NAME_LEN", async () => {
    const dir = makeTmpDir();
    const file = join(dir, "rankings.json");
    await Bun.write(
      file,
      JSON.stringify({
        version: 1,
        entries: [{ name: "this-name-is-way-too-long", score: 1, ts: 1 }],
      }),
    );
    const result = await loadRankings(file);
    expect(result).toHaveLength(1);
    expect(result[0]?.name.length).toBeLessThanOrEqual(12);
  });

  it("caps loaded entries to MAX_RANKINGS", async () => {
    const dir = makeTmpDir();
    const file = join(dir, "rankings.json");
    await Bun.write(
      file,
      JSON.stringify({
        version: 1,
        entries: Array.from({ length: 50 }, (_, i) => ({ name: `p${i}`, score: i, ts: i })),
      }),
    );
    const result = await loadRankings(file);
    expect(result).toHaveLength(10);
    expect(result[0]?.score).toBe(49);
  });
});

describe("beep", () => {
  it("writes the ASCII BEL byte to the provided stream", () => {
    const chunks: string[] = [];
    beep({ write: (s) => chunks.push(s) });
    expect(chunks).toEqual(["\x07"]);
  });
});
