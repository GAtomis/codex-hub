import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "./db.js";

const normalizeHeader = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

export const requestIp = (request: FastifyRequest): string => {
  const forwarded = normalizeHeader(request.headers["x-forwarded-for"]);
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return request.ip;
};

const tokenFromRequest = (request: FastifyRequest): string | null => {
  const auth = normalizeHeader(request.headers.authorization);
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  const headerToken = normalizeHeader(request.headers["x-exec-token"]);
  if (headerToken?.trim()) {
    return headerToken.trim();
  }

  return null;
};

const ipAllowed = (ip: string, allowList: string[]): boolean => {
  if (allowList.length === 0) {
    return true;
  }
  return allowList.some((allowed) => {
    if (allowed === ip) {
      return true;
    }
    if (allowed.endsWith("*")) {
      return ip.startsWith(allowed.slice(0, -1));
    }
    return false;
  });
};

export const ensureExecAccess = async (args: {
  request: FastifyRequest;
  reply: FastifyReply;
  execApiToken: string;
  execAllowedIps: string[];
  projectSlug?: string;
  route: string;
  action: string;
}): Promise<boolean> => {
  const ip = requestIp(args.request);
  const origin = normalizeHeader(args.request.headers.origin) ?? null;

  if (!ipAllowed(ip, args.execAllowedIps)) {
    await writeExecAudit({
      request: args.request,
      projectSlug: args.projectSlug ?? null,
      route: args.route,
      action: args.action,
      status: "forbidden_ip",
      detail: { ip, allowed: args.execAllowedIps }
    });
    args.reply.code(403).send({ error: "exec_ip_not_allowed" });
    return false;
  }

  if (args.execApiToken) {
    const token = tokenFromRequest(args.request);
    if (!token || token !== args.execApiToken) {
      await writeExecAudit({
        request: args.request,
        projectSlug: args.projectSlug ?? null,
        route: args.route,
        action: args.action,
        status: "unauthorized",
        detail: { hasToken: Boolean(token), ip, origin }
      });
      args.reply.code(401).send({ error: "exec_unauthorized" });
      return false;
    }
  }

  return true;
};

export const writeExecAudit = async (args: {
  request: FastifyRequest;
  projectSlug: string | null;
  route: string;
  action: string;
  status: string;
  detail?: Record<string, unknown>;
}): Promise<void> => {
  const origin = normalizeHeader(args.request.headers.origin) ?? null;
  const userAgent = normalizeHeader(args.request.headers["user-agent"]) ?? null;
  const ip = requestIp(args.request);

  try {
    await pool.query(
      `
      INSERT INTO exec_audit_logs (log_id, project_slug, route, action, status, request_ip, request_origin, user_agent, detail_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      `,
      [randomUUID(), args.projectSlug, args.route, args.action, args.status, ip, origin, userAgent, JSON.stringify(args.detail ?? {})]
    );
  } catch {
    // ignore audit persistence failure
  }
};
