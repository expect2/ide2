import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Ide2Preferences {
  version: 1;
  onboardingCompleted: boolean;
  onboardingCompletedAt?: number;
}

const DEFAULT_PREFERENCES: Ide2Preferences = {
  version: 1,
  onboardingCompleted: false,
};

export class PreferencesStore {
  private readonly dirPath: string;
  private readonly filePath: string;

  constructor(storageRoot?: string) {
    this.dirPath = storageRoot ?? join(homedir(), ".expect2-ide");
    this.filePath = join(this.dirPath, "preferences.json");
  }

  getStorageFilePath(): string {
    return this.filePath;
  }

  get(): Ide2Preferences {
    try {
      if (!existsSync(this.filePath)) {
        return { ...DEFAULT_PREFERENCES };
      }
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") {
        return { ...DEFAULT_PREFERENCES };
      }
      const obj = parsed as Partial<Ide2Preferences>;
      return {
        version: 1,
        onboardingCompleted: obj.onboardingCompleted === true,
        ...(typeof obj.onboardingCompletedAt === "number"
          ? { onboardingCompletedAt: obj.onboardingCompletedAt }
          : {}),
      };
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  }

  isOnboardingCompleted(): boolean {
    return this.get().onboardingCompleted;
  }

  markOnboardingCompleted(): Ide2Preferences {
    const next: Ide2Preferences = {
      ...this.get(),
      version: 1,
      onboardingCompleted: true,
      onboardingCompletedAt: Date.now(),
    };
    this.writeAtomic(next);
    return next;
  }

  resetOnboarding(): Ide2Preferences {
    const next: Ide2Preferences = {
      version: 1,
      onboardingCompleted: false,
    };
    this.writeAtomic(next);
    return next;
  }

  private writeAtomic(prefs: Ide2Preferences): void {
    try {
      mkdirSync(this.dirPath, { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
      renameSync(tmpPath, this.filePath);
    } catch {
      // Non-fatal persistence error
    }
  }
}
