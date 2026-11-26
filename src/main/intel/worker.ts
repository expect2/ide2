import { parentPort } from "node:worker_threads";
import type { CodeSymbol, TokenSpan } from "../../shared/protocol";
import { detectLanguageFromPath, highlightLines } from "./highlight";
import { getStructure } from "./symbols";

export interface IntelWorkerAnalyzeRequest {
  id: number;
  type: "analyzeFile";
  worktreePath: string;
  filePath: string;
  contentHash: string;
  content: string;
  language?: string;
}

export interface IntelWorkerHighlightRequest {
  id: number;
  type: "highlight";
  content: string;
  language: string;
  contentHash?: string;
}

export interface IntelWorkerStructureRequest {
  id: number;
  type: "getStructure";
  worktreePath: string;
  filePath: string;
  content?: string;
}

export type IntelWorkerRequest =
  | IntelWorkerAnalyzeRequest
  | IntelWorkerHighlightRequest
  | IntelWorkerStructureRequest;

export interface IntelWorkerSuccessResponse {
  id: number;
  ok: true;
  tokens?: TokenSpan[][];
  symbols?: CodeSymbol[];
}

export interface IntelWorkerErrorResponse {
  id: number;
  ok: false;
  error: string;
}

export type IntelWorkerResponse = IntelWorkerSuccessResponse | IntelWorkerErrorResponse;

async function handleWorkerRequest(req: IntelWorkerRequest): Promise<IntelWorkerResponse> {
  try {
    if (req.type === "analyzeFile") {
      const lang = req.language ?? detectLanguageFromPath(req.filePath);
      const [tokens, symbols] = await Promise.all([
        highlightLines(req.content, lang, req.contentHash),
        getStructure(req.worktreePath, req.filePath, req.content),
      ]);
      return { id: req.id, ok: true, tokens, symbols };
    }

    if (req.type === "highlight") {
      const tokens = await highlightLines(req.content, req.language, req.contentHash);
      return { id: req.id, ok: true, tokens };
    }

    const symbols = await getStructure(req.worktreePath, req.filePath, req.content);
    return { id: req.id, ok: true, symbols };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: req.id, ok: false, error: message };
  }
}

if (parentPort) {
  parentPort.on("message", (msg: IntelWorkerRequest) => {
    void handleWorkerRequest(msg).then((res) => {
      parentPort?.postMessage(res);
    });
  });
}
