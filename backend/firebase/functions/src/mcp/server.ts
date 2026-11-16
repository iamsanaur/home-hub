import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getAuth } from "firebase-admin/auth";
import { z } from "zod";
import { Ctx } from "../services/base";
import { executeTool, TOOLS } from "./tools";
import { secretEnv } from "../core/env";

export const MCP_SERVER_NAME = "homehub";
export const MCP_SERVER_VERSION = "1.0.0";

export function buildMcpServer(ctx: Ctx, callerUid?: string): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: "HomeHub household tools. Every call needs the `grant` from your run instructions. Amounts are integer minor units." },
  );
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: { grant: z.string().describe("HomeHub grant from your instructions"), ...t.shape },
        annotations: { readOnlyHint: t.risk === "read", destructiveHint: false, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        const result = await executeTool(ctx, t.name, args, callerUid);
        // Compact JSON keeps tool output small for the model.
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok && result.status !== "approval_required" };
      },
    );
  }
  return server;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Service authentication: only the HomeHub-managed Hermes runtime holds this key. */
export function authorizeMcp(req: Request): boolean {
  const expected = secretEnv("HOMEHUB_MCP_SERVICE_KEY");
  if (!expected || expected.length < 24) return false;
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token.length > 0 && constantTimeEquals(token, expected);
}

/** Stateless Streamable HTTP handler (one server+transport per request). */
export async function handleMcpRequest(ctx: Ctx, req: Request, res: Response): Promise<void> {
  // Two callers: the server Hermes (service key) and Hermes Mobile (the user's Firebase ID token).
  let callerUid: string | undefined;
  if (!authorizeMcp(req)) {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    try {
      callerUid = token ? (await getAuth().verifyIdToken(token, true)).uid : undefined;
    } catch {
      callerUid = undefined;
    }
    if (!callerUid) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
  }
  if (req.method !== "POST") {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    return;
  }
  const server = buildMcpServer(ctx, callerUid);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
