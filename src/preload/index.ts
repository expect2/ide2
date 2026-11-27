import { contextBridge, ipcRenderer } from "electron";
import type {
  CreateAnnotationInput,
  DiffScope,
  ExportPromptOptions,
  FindInPathQuery,
  Ide2Bridge,
  ReviewUserResponse,
  UpdateAnnotationInput,
  WalkthroughUserResponse,
  WorkspaceEvent,
} from "../shared/protocol.js";

const bridge: Ide2Bridge = {
  getBootstrap: () => ipcRenderer.invoke("ide2:getBootstrap"),
  listFiles: (worktreePath: string) => ipcRenderer.invoke("ide2:listFiles", worktreePath),
  fuzzyFindFiles: (params) => ipcRenderer.invoke("ide2:fuzzyFindFiles", params),
  readFile: (worktreePath: string, filePath: string, diffScope?: DiffScope) =>
    ipcRenderer.invoke("ide2:readFile", worktreePath, filePath, diffScope),
  readAssetDataUrl: (worktreePath: string, relativeFromFile: string, rawHref: string) =>
    ipcRenderer.invoke("ide2:readAssetDataUrl", worktreePath, relativeFromFile, rawHref),
  getDiff: (worktreePath: string, filePath: string, scope: DiffScope) =>
    ipcRenderer.invoke("ide2:getDiff", worktreePath, filePath, scope),
  listChangedFiles: (worktreePath: string, scope: DiffScope) =>
    ipcRenderer.invoke("ide2:listChangedFiles", worktreePath, scope),
  listCommits: (worktreePath: string, limit?: number) =>
    ipcRenderer.invoke("ide2:listCommits", worktreePath, limit),
  getBlame: (worktreePath: string, filePath: string) =>
    ipcRenderer.invoke("ide2:getBlame", worktreePath, filePath),
  getStructure: (worktreePath: string, filePath: string) =>
    ipcRenderer.invoke("ide2:getStructure", worktreePath, filePath),
  searchSymbols: (params) => ipcRenderer.invoke("ide2:searchSymbols", params),
  findDefinitionAndUsages: (params) => ipcRenderer.invoke("ide2:findDefinitionAndUsages", params),
  findInPath: (query: FindInPathQuery) => ipcRenderer.invoke("ide2:findInPath", query),
  listAnnotations: (worktreePath?: string) => ipcRenderer.invoke("ide2:listAnnotations", worktreePath),
  createAnnotation: (input: CreateAnnotationInput) => ipcRenderer.invoke("ide2:createAnnotation", input),
  updateAnnotation: (input: UpdateAnnotationInput) => ipcRenderer.invoke("ide2:updateAnnotation", input),
  deleteAnnotation: (id: string) => ipcRenderer.invoke("ide2:deleteAnnotation", id),
  compileFeedbackPrompt: (options: ExportPromptOptions) =>
    ipcRenderer.invoke("ide2:compileFeedbackPrompt", options),
  copyToClipboard: (text: string) => ipcRenderer.invoke("ide2:copyToClipboard", text),
  openExternalUrl: (url: string) => ipcRenderer.invoke("ide2:openExternalUrl", url),
  revealInOs: (targetPath: string) => ipcRenderer.invoke("ide2:revealInOs", targetPath),
  createWorktree: (params) => ipcRenderer.invoke("ide2:createWorktree", params),
  openProjectWindow: (targetPath?: string) => ipcRenderer.invoke("ide2:openProjectWindow", targetPath),
  listRecentProjects: () => ipcRenderer.invoke("ide2:listRecentProjects"),
  respondWalkthrough: (response: WalkthroughUserResponse) =>
    ipcRenderer.invoke("ide2:respondWalkthrough", response),
  endWalkthrough: (sessionId?: string) => ipcRenderer.invoke("ide2:endWalkthrough", sessionId),
  getWalkthroughAgentPrompt: () => ipcRenderer.invoke("ide2:getWalkthroughAgentPrompt"),
  sendReviewResponse: (response: ReviewUserResponse) =>
    ipcRenderer.invoke("ide2:sendReviewResponse", response),
  getReviewAgentPrompt: () => ipcRenderer.invoke("ide2:getReviewAgentPrompt"),
  completeOnboarding: () => ipcRenderer.invoke("ide2:completeOnboarding"),
  onEvent: (listener: (event: WorkspaceEvent) => void) => {
    const handler = (_evt: Electron.IpcRendererEvent, payload: WorkspaceEvent) => {
      listener(payload);
    };
    ipcRenderer.on("ide2:event", handler);
    return () => {
      ipcRenderer.removeListener("ide2:event", handler);
    };
  },
};

contextBridge.exposeInMainWorld("ide2", bridge);
