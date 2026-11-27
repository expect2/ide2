import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RecentProject } from "../../shared/protocol.js";

const MAX_RECENT_PROJECTS = 15;

export class RecentProjectsStore {
  private readonly filePath: string;
  private readonly dirPath: string;

  constructor(storageRoot?: string) {
    this.dirPath = storageRoot ?? join(homedir(), ".expect2-ide");
    this.filePath = join(this.dirPath, "recent-projects.json");
  }

  getStorageFilePath(): string {
    return this.filePath;
  }

  list(): RecentProject[] {
    const all = this.readRaw();
    return all.filter((entry) => Boolean(entry.isRemote) || existsSync(entry.path));
  }

  record(project: {
    path: string;
    repoCommonDir: string;
    name: string;
    lastOpenedAt?: number;
    isRemote?: boolean;
    sshTarget?: string;
  }): RecentProject[] {
    const existing = this.readRaw().filter(
      (item) => item.repoCommonDir !== project.repoCommonDir && item.path !== project.path,
    );
    const updated: RecentProject[] = [
      {
        path: project.path,
        repoCommonDir: project.repoCommonDir,
        name: project.name,
        lastOpenedAt: project.lastOpenedAt ?? Date.now(),
        ...(project.isRemote ? { isRemote: true } : {}),
        ...(project.sshTarget ? { sshTarget: project.sshTarget } : {}),
      },
      ...existing,
    ].slice(0, MAX_RECENT_PROJECTS);

    this.writeAtomic(updated);
    return updated.filter((entry) => Boolean(entry.isRemote) || existsSync(entry.path));
  }

  private readRaw(): RecentProject[] {
    try {
      if (!existsSync(this.filePath)) return [];
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(
          (item): item is RecentProject =>
            Boolean(item) &&
            typeof item === "object" &&
            typeof (item as RecentProject).path === "string" &&
            typeof (item as RecentProject).repoCommonDir === "string" &&
            typeof (item as RecentProject).name === "string" &&
            typeof (item as RecentProject).lastOpenedAt === "number",
        )
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    } catch {
      return [];
    }
  }

  private writeAtomic(projects: RecentProject[]): void {
    try {
      mkdirSync(this.dirPath, { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(projects, null, 2)}\n`, "utf8");
      renameSync(tmpPath, this.filePath);
    } catch {
      // Non-fatal persistence error
    }
  }
}
