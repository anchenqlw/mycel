import { describe, expect, it } from "vitest";
import { parseCardAction } from "./callback.js";

describe("parseCardAction", () => {
  it("parses structured card values", () => {
    expect(parseCardAction({
      outTrackId: "mut_1",
      userId: "owner-1",
      actionId: "approve",
      value: { aggregateId: "mut_1" },
    })).toEqual({
      outTrackId: "mut_1",
      actorUserId: "owner-1",
      action: "approve",
      aggregateId: "mut_1",
    });
  });

  it("parses JSON string values and localized actions", () => {
    expect(parseCardAction({
      outTrackId: "mut_2",
      operatorUserId: "owner-2",
      value: JSON.stringify({ action: "退回", workId: "work_2", reason: "test coverage" }),
    })).toMatchObject({
      action: "reject_acceptance",
      aggregateId: "work_2",
      reason: "test coverage",
    });
  });

  it("parses ProductionPlan approval actions", () => {
    expect(parseCardAction({ outTrackId: "proposal_1", userId: "owner-1", value: { action: "approve_proposal", aggregateId: "proposal_1" } })).toMatchObject({ action: "approve_proposal", aggregateId: "proposal_1" });
  });
});
