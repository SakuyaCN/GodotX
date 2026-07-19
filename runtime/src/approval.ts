import { randomUUID } from "node:crypto";
import type { ApprovalDecision } from "./protocol.js";

interface PendingApproval {
  sessionId: string;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalManager {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #sessionGrants = new Set<string>();

  async request(
    sessionId: string,
    category: string,
    mode: "ask" | "auto",
    notify: (requestId: string) => void,
    timeoutMs = 300_000,
  ): Promise<{ requestId: string; decision: ApprovalDecision }> {
    const requestId = randomUUID();
    notify(requestId);
    const grantKey = `${sessionId}:${category}`;
    if (mode === "auto" || this.#sessionGrants.has(grantKey)) {
      return { requestId, decision: "accept" };
    }

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve("decline");
      }, timeoutMs);
      this.#pending.set(requestId, { sessionId, resolve, timer });
    });
    if (decision === "accept_for_session") this.#sessionGrants.add(grantKey);
    return { requestId, decision };
  }

  respond(requestId: string, decision: ApprovalDecision): boolean {
    if (decision !== "accept" && decision !== "accept_for_session" && decision !== "decline") return false;
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.#pending.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  declineAll(): void {
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve("decline");
      this.#pending.delete(requestId);
    }
  }

  declineSession(sessionId: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      pending.resolve("decline");
      this.#pending.delete(requestId);
    }
  }
}
