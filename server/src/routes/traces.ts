import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { searchTraces, getTrace } from "../services/trace-query.js";

export function traceRoutes(db: Db) {
  const router = Router();

  // GET /api/traces
  router.get("/traces", async (req, res) => {
    const q = req.query;

    // If the caller is agent-scoped, force their company
    const companyId =
      req.actor.type === "agent"
        ? req.actor.companyId!
        : (q.companyId as string | undefined);

    if (companyId) {
      assertCompanyAccess(req, companyId);
    }

    const results = await searchTraces(db, {
      companyId,
      issueId: q.issueId as string | undefined,
      stage: q.stage as string | undefined,
      agentId: q.agentId as string | undefined,
      outcomeMarker: q.outcomeMarker as string | undefined,
      from: q.from as string | undefined,
      to: q.to as string | undefined,
      parseStatus: q.parseStatus as string | undefined,
      benchmarkOnly: q.benchmarkOnly === "true",
      limit: q.limit ? Number(q.limit) : undefined,
    });

    res.json(results);
  });

  // GET /api/traces/:traceId
  router.get("/traces/:traceId", async (req, res) => {
    const { traceId } = req.params;
    const q = req.query;

    const result = await getTrace(db, traceId, {
      includeRaw: q.includeRaw === "true",
      includeDigest: q.includeDigest !== "false",
      includeEvents: q.includeEvents !== "false",
      includeHandoffPayloads: q.includeHandoffPayloads !== "false",
      eventsLimit: q.eventsLimit ? Number(q.eventsLimit) : undefined,
    });

    if (!result) {
      res.status(404).json({ error: "Trace not found" });
      return;
    }

    // Company access check on the resolved trace
    assertCompanyAccess(req, result.trace.companyId);

    res.json(result);
  });

  return router;
}
