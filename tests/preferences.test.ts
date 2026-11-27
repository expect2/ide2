import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PreferencesStore } from "../src/main/services/preferences.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ide2-prefs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("PreferencesStore (first-run onboarding persistence)", () => {
  it("defaults to onboarding incomplete, persists completion atomically, and handles corrupt JSON", () => {
    const root = makeTempDir();
    const store = new PreferencesStore(root);

    expect(store.isOnboardingCompleted()).toBe(false);
    expect(existsSync(store.getStorageFilePath())).toBe(false);

    const completed = store.markOnboardingCompleted();
    expect(completed.onboardingCompleted).toBe(true);
    expect(typeof completed.onboardingCompletedAt).toBe("number");
    expect(existsSync(store.getStorageFilePath())).toBe(true);

    // Reloading from a fresh store instance reads the persisted flag
    const reloaded = new PreferencesStore(root);
    expect(reloaded.isOnboardingCompleted()).toBe(true);

    // Resetting puts onboarding back to incomplete
    reloaded.resetOnboarding();
    expect(new PreferencesStore(root).isOnboardingCompleted()).toBe(false);

    // Corrupt file falls back cleanly without throwing
    writeFileSync(store.getStorageFilePath(), "{not valid json", "utf8");
    expect(reloaded.isOnboardingCompleted()).toBe(false);
  });
});
