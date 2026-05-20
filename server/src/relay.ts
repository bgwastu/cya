import type { ServerWebSocket } from "bun";
import type { CommandResult, ProtocolMsg, Role } from "./protocol.ts";
import { audit, closeSession, getSession, setAgentMeta, touchSession, updateSessionStatus } from "./db.ts";
import { SESSION_IDLE_TIMEOUT } from "./config.ts";

type WsData = { session: string; role: Role };
type PendingCommand = {
  resolve: (value: CommandResult) => void;
  reject: (error: Error) => void;
  timer: Timer;
};

interface SessionSlot {
  code: string;
  agent?: ServerWebSocket<unknown>;
  pendingHttp: Map<string, PendingCommand>;
  createdAt: number;
  lastActivity: number;
}

const sessions = new Map<string, SessionSlot>();

export function isSessionCode(value: string): boolean {
  return /^[0-9a-f]{12}$/.test(value);
}

export function getOrCreateSlot(code: string): SessionSlot {
  let slot = sessions.get(code);
  if (!slot) {
    slot = { code, pendingHttp: new Map(), createdAt: Date.now(), lastActivity: Date.now() };
    sessions.set(code, slot);
  }
  return slot;
}

export function getSlot(code: string) {
  return sessions.get(code);
}

export function removeSlot(code: string, reason = "session_closed") {
  const slot = sessions.get(code);
  if (!slot) {
    closeSession(code);
    return;
  }

  for (const pending of slot.pendingHttp.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Session closed"));
  }
  slot.pendingHttp.clear();

  slot.agent?.send(JSON.stringify({ type: "bye", reason }));
  slot.agent?.close();

  sessions.delete(code);
  closeSession(code);
  audit(code, "system", "session_closed", reason);
}

export function handleJoin(ws: ServerWebSocket<unknown>, msg: Extract<ProtocolMsg, { type: "join" }>) {
  if (!isSessionCode(msg.session) || msg.role !== "agent") {
    rejectJoin(ws, "Invalid join request");
    return;
  }

  const session = getSession(msg.session);
  if (!session || session.status === "closed") {
    rejectJoin(ws, "Session not found or closed");
    return;
  }

  const slot = getOrCreateSlot(msg.session);
  ws.data = { session: msg.session, role: msg.role } as WsData;
  slot.lastActivity = Date.now();

  if (slot.agent) {
    rejectJoin(ws, "Agent already connected");
    audit(msg.session, "agent", "rejected_duplicate");
    return;
  }
  slot.agent = ws;
  updateSessionStatus(msg.session, "active");
  if (msg.meta) {
    setAgentMeta(msg.session, msg.meta.os, msg.meta.arch, msg.meta.host, msg.meta.user, msg.meta.cwd, msg.meta.shell, msg.meta.elevated);
  }
  audit(msg.session, "agent", "connected", describeMeta(msg.meta));

  ws.send(JSON.stringify({ type: "output", data: `[CYA] Joined session ${msg.session} as agent\n` }));
}

export function handleMessage(ws: ServerWebSocket<unknown>, raw: string) {
  const data = ws.data as WsData | undefined;
  if (!data) return;

  const slot = sessions.get(data.session);
  if (!slot) return;
  slot.lastActivity = Date.now();
  touchSession(data.session);

  const msg = parseMessage(raw);
  if (!msg) return;

  if (msg.type === "command_result" && data.role === "agent") {
    const pending = slot.pendingHttp.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    slot.pendingHttp.delete(msg.id);
    pending.resolve({ output: msg.output, exit_code: msg.exit_code });
    return;
  }

  if (msg.type === "bye") {
    handleDisconnect(ws);
  }
}

export function handleDisconnect(ws: ServerWebSocket<unknown>) {
  const data = ws.data as WsData | undefined;
  if (!data) return;

  const slot = sessions.get(data.session);
  if (!slot) return;

  if (data.role === "agent") {
    slot.agent = undefined;
    audit(data.session, "agent", "disconnected");
    updateSessionStatus(data.session, "waiting");
  }
}

export function executeHttpCommand(code: string, cmd: string, timeoutMs?: number): Promise<CommandResult> {
  const slot = sessions.get(code);
  if (!slot) return Promise.reject(new Error("Session not found"));
  if (!slot.agent) return Promise.reject(new Error("Agent not connected"));

  const id = crypto.randomUUID();
  const timeout = Math.max(1000, Math.min(timeoutMs ?? 30_000, 300_000)); // 1s–300s

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      slot.pendingHttp.delete(id);
      reject(new Error(`Command timed out after ${Math.round(timeout / 1000)}s`));
    }, timeout);

    slot.pendingHttp.set(id, { resolve, reject, timer });
    slot.agent!.send(JSON.stringify({ type: "command", cmd, id }));
  });
}

export function cleanupStaleSlots() {
  const now = Date.now();
  const closed: string[] = [];
  for (const [code, slot] of sessions) {
    const idleSeconds = (now - slot.lastActivity) / 1000;
    if (!slot.agent && idleSeconds > SESSION_IDLE_TIMEOUT) {
      removeSlot(code, "expired");
      closed.push(code);
    }
  }
  return closed;
}

function rejectJoin(ws: ServerWebSocket<unknown>, message: string) {
  ws.send(JSON.stringify({ type: "error", message }));
  ws.close();
}

function parseMessage(raw: string): ProtocolMsg | null {
  try {
    return JSON.parse(raw) as ProtocolMsg;
  } catch {
    return null;
  }
}

function describeMeta(meta: Extract<ProtocolMsg, { type: "join" }>["meta"]): string | undefined {
  if (!meta) return undefined;
  return `${meta.user}@${meta.host} ${meta.os}/${meta.arch} cwd=${meta.cwd || "unknown"} shell=${meta.shell || "unknown"}`;
}
