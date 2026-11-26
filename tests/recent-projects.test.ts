import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecentProjectsStore } from "../src/main/services/recent-projects.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("RecentProjectsStore", () => {
  it("records, deduplicates by repoCommonDir, reloads from disk, and prunes missing directories", () => {
    const root = makeTempDir("ide2-recent-proj-");
    const storageRoot = join(root, "storage");
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });

    const store = new RecentProjectsStore(storageRoot);
    expect(store.list()).toEqual([]);

    store.record({
      path: repoA,
      repoCommonDir: join(repoA, ".git"),
      name: "repo-a",
      lastOpenedAt: 1000,
    });
    store.record({
      path: repoB,
      repoCommonDir: join(repoB, ".git"),
      name: "repo-b",
      lastOpenedAt: 2000,
    });

    // Re-opening repoA moves it to the top without creating a duplicate
    store.record({
      path: repoA,
      repoCommonDir: join(repoA, ".git"),
      name: "repo-a",
      lastOpenedAt: 3000,
    });

    const reloaded = new RecentProjectsStore(storageRoot);
    expect(reloaded.list().map((p) => p.name)).toEqual(["repo-a", "repo-b"]);

    // Deleting repoB from disk automatically excludes it from list()
    rmSync(repoB, { recursive: true, force: true });
    expect(reloaded.list().map((p) => p.name)).toEqual(["repo-a"]);
  });
});
