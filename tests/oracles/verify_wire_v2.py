#!/usr/bin/env python3
"""Independent non-TypeScript wire validator for v2 protocol fixtures and v1 separation."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
import sys

DIAGNOSTIC_CODES = {
    "SCHEMA_INVALID",
    "CAPABILITY_UNAVAILABLE",
    "STALE_CAPABILITIES",
    "SEMANTIC_INVALID",
    "SCOPE_CONFLICT",
    "BUDGET_EXCEEDED",
    "DATA_FORBIDDEN",
    "RESULT_INVALID",
    "CANCELLED",
    "TRANSPORT_INTERRUPTED",
    "REVISION_CONFLICT",
    "IDEMPOTENCY_CONFLICT",
    "REPLAY_EXPIRED",
    "UNSUPPORTED_VERSION",
    "SOURCE_FAILURE",
    "AUTHENTICATION_EXPIRED",
}

EVENT_TYPES = {
    "request.started",
    "text.delta",
    "plan.accepted",
    "binding.pending",
    "binding.ready",
    "binding.failed",
    "response.committed",
    "request.completed",
    "request.failed",
    "request.cancelled",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def check_iso(ts: str, label: str) -> None:
    require(isinstance(ts, str) and len(ts) >= 10, f"{label}: invalid timestamp {ts!r}")
    datetime.fromisoformat(ts.replace("Z", "+00:00"))


def validate_diagnostic(diag: dict, ctx: str) -> None:
    require(diag.get("code") in DIAGNOSTIC_CODES, f"{ctx}: bad diagnostic code {diag.get('code')!r}")
    require(isinstance(diag.get("message"), str) and diag["message"], f"{ctx}: empty message")
    require(isinstance(diag.get("retryable"), bool), f"{ctx}: retryable not bool")


def validate_response(resp: dict, ctx: str) -> None:
    require(resp.get("protocolVersion") == 2, f"{ctx}: protocolVersion != 2")
    for key in ("messageId", "responseId", "plan", "bindingDescriptors", "datasets", "facts", "operations", "status", "diagnostics"):
        require(key in resp, f"{ctx}: missing {key}")
    require(isinstance(resp["revision"], int) and resp["revision"] >= 1, f"{ctx}: invalid revision")
    require(isinstance(resp["generation"], int) and resp["generation"] >= 0, f"{ctx}: invalid generation")
    require(resp["status"] in {"pending", "complete", "partial", "failed"}, f"{ctx}: invalid status")

    bindings = resp["plan"]["bindings"]
    binding_ids = {b["id"] for b in bindings}
    descs = {d["bindingId"]: d for d in resp["bindingDescriptors"]}
    datasets = resp["datasets"]
    require(set(descs.keys()) == binding_ids, f"{ctx}: descriptor keys mismatch")
    require(set(datasets.keys()) == binding_ids, f"{ctx}: dataset keys mismatch")

    statuses = {st["status"] for st in datasets.values()}
    if resp["status"] == "complete":
        require(all(st["status"] == "ready" for st in datasets.values()), f"{ctx}: complete must have all ready")
        for f in resp["plan"]["facts"]:
            require(f["id"] in resp["facts"], f"{ctx}: missing fact {f['id']}")
    elif resp["status"] == "partial":
        require("ready" in statuses and "failed" in statuses and "pending" not in statuses, f"{ctx}: invalid partial dataset states")
        for f in resp["plan"]["facts"]:
            b_status = datasets[f["field"]["bindingId"]]["status"]
            if b_status == "ready":
                require(f["id"] in resp["facts"], f"{ctx}: missing ready fact {f['id']}")
            elif b_status == "failed":
                require(f["id"] not in resp["facts"], f"{ctx}: leaked failed fact {f['id']}")

    for bid, st in datasets.items():
        if st["status"] == "ready":
            prov = st["result"]["provenance"]
            check_iso(prov["executedAt"], f"{ctx}.{bid}.executedAt")
            if prov.get("sourceAsOf") is not None:
                check_iso(prov["sourceAsOf"], f"{ctx}.{bid}.sourceAsOf")
            require(prov["grain"] == descs[bid]["grain"], f"{ctx}.{bid}: grain mismatch")
        elif st["status"] == "failed":
            validate_diagnostic(st["diagnostic"], f"{ctx}.{bid}")


def validate_stream(events: list[dict], ctx: str, start_seq: int = 0) -> None:
    require(len(events) >= 2, f"{ctx}: expected non-empty event stream")
    req_id = events[0]["requestId"]
    for idx, ev in enumerate(events):
        require(ev.get("protocolVersion") == 2, f"{ctx}[{idx}]: bad protocolVersion")
        require(ev.get("requestId") == req_id, f"{ctx}[{idx}]: mismatched requestId")
        require(ev.get("sequence") == start_seq + idx, f"{ctx}[{idx}]: non-monotonic sequence {ev.get('sequence')}")
        t = ev.get("type")
        require(t in EVENT_TYPES, f"{ctx}[{idx}]: unknown event type {t!r}")
        if start_seq == 0 and idx == 0:
            require(t == "request.started", f"{ctx}: first event must be request.started")
        if t == "response.committed":
            validate_response(ev["response"], f"{ctx}.response")
        elif t == "binding.failed":
            validate_diagnostic(ev["diagnostic"], f"{ctx}.binding.failed")
        elif t == "request.failed":
            validate_diagnostic(ev["diagnostic"], f"{ctx}.request.failed")
    require(events[-1]["type"] in {"request.completed", "request.failed", "request.cancelled"}, f"{ctx}: missing terminal event")


def validate_negotiation(neg: dict, ctx: str) -> None:
    require(neg.get("protocolVersion") == 2, f"{ctx}: protocolVersion != 2")
    require(isinstance(neg.get("history"), bool) and isinstance(neg.get("replay"), bool) and isinstance(neg.get("cancellation"), bool), f"{ctx}: invalid flags")


def validate_conversation(conv: dict, ctx: str) -> None:
    require(isinstance(conv.get("conversationId"), str) and conv["conversationId"], f"{ctx}: missing conversationId")
    messages = conv.get("messages", [])
    require(len({m["id"] for m in messages}) == len(messages), f"{ctx}: duplicate message IDs")
    for m in messages:
        if "response" in m and m["response"] is not None:
            require(m.get("role") == "assistant", f"{ctx}.{m['id']}: non-assistant response")
            require(m["response"].get("messageId") == m["id"], f"{ctx}.{m['id']}: response.messageId mismatch")
            validate_response(m["response"], f"{ctx}.{m['id']}")


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    wire = root / "tests" / "fixtures" / "wire-v2"

    tc = json.loads((wire / "text-and-clarification.json").read_text(encoding="utf-8"))
    validate_negotiation(tc["negotiation"], "tc.negotiation")
    validate_stream(tc["clarifyEvents"], "tc.clarifyEvents")
    validate_stream(tc["textEvents"], "tc.textEvents")
    validate_conversation(tc["snapshot"], "tc.snapshot")

    va = json.loads((wire / "visual-with-actions.json").read_text(encoding="utf-8"))
    validate_negotiation(va["negotiation"], "va.negotiation")
    for name in ("initialEvents", "paginateEvents", "sortEvents", "refreshEvents", "scopeChangeEvents"):
        validate_stream(va[name], f"va.{name}")
    # Verify full binding lifecycle events in initialEvents
    types = [e["type"] for e in va["initialEvents"]]
    require({"request.started", "plan.accepted", "binding.pending", "binding.ready", "response.committed", "request.completed"}.issubset(types), "va.initialEvents missing lifecycle events")
    # Verify sort clears cursor
    sorted_resp = [e["response"] for e in va["sortEvents"] if e["type"] == "response.committed"][0]
    require("cursor" not in sorted_resp["plan"]["bindings"][0]["args"], "va.sortEvents must clear cursor")
    # Verify change-answer produces revision 2 generation 0 with new responseId
    orig_resp = [e["response"] for e in va["initialEvents"] if e["type"] == "response.committed"][0]
    new_rev = [e["response"] for e in va["scopeChangeEvents"] if e["type"] == "response.committed"][0]
    require(new_rev["responseId"] != orig_resp["responseId"], "change-answer must issue new responseId")
    require(new_rev["revision"] == orig_resp["revision"] + 1 and new_rev["generation"] == 0, "change-answer must start revision+1 generation 0")
    validate_conversation(va["conversation"], "va.conversation")

    pr = json.loads((wire / "partial-and-retry.json").read_text(encoding="utf-8"))
    for name in ("partialTurnEvents", "retryEvents", "failedEvents"):
        validate_stream(pr[name], f"pr.{name}")
    require(any(e["type"] == "binding.failed" for e in pr["partialTurnEvents"]), "partialTurnEvents missing binding.failed")
    partial_resp = [e["response"] for e in pr["partialTurnEvents"] if e["type"] == "response.committed"][0]
    require(partial_resp["status"] == "partial", "expected partial response")
    retried_resp = [e["response"] for e in pr["retryEvents"] if e["type"] == "response.committed"][0]
    require(retried_resp["status"] == "complete" and retried_resp["generation"] == 1, "expected retry to complete generation 1")
    require(pr["failedEvents"][-1]["type"] == "request.failed", "expected failedEvents terminal request.failed")

    ing = json.loads((wire / "ingested-precomputed.json").read_text(encoding="utf-8"))
    validate_response(ing["ingestedResponse"], "ingested")

    rep = json.loads((wire / "replay-and-errors.json").read_text(encoding="utf-8"))
    opts = rep["optionPage"]["options"]
    require(len({o["value"] for o in opts}) == len(opts), "duplicate option values")
    require(rep["replayEvents"]["kind"] == "events", "expected replay events")
    validate_stream(rep["replayEvents"]["events"], "rep.replayEvents", start_seq=1)
    require(rep["replayExpired"]["kind"] == "expired", "expected expired replay kind")

    # Verify frozen v1 conversation fixture is cleanly distinguishable and never valid as v2
    v1 = json.loads((root / "tests" / "fixtures" / "v1-conversation.json").read_text(encoding="utf-8"))
    require(v1.get("protocolVersion") != 2, "v1 fixture must not carry protocolVersion 2")
    for rev in v1.get("revisions", []):
        require(rev.get("protocolVersion") != 2, "v1 artifact revision must not carry protocolVersion 2")
        require("plan" in rev and "artifactId" in rev and "bindingDescriptors" not in rev, "v1 revision shape drifted")

    print("wire-v2 validation passed (all fixtures + v1 non-reinterpretation guard).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
