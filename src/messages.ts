import { defineQuery, defineUpdate } from "@temporalio/workflow";
import type { ReplyInput, ReplyResult, StaffActionResult, WaitlistStatus } from "./types";

// Shared by the Workflow and the API so both sides agree on names and types.
export const getWaitlistStatus = defineQuery<WaitlistStatus>("getWaitlistStatus");
export const replyToOffer = defineUpdate<ReplyResult, [ReplyInput]>("replyToOffer");
export const cancelOpening = defineUpdate<StaffActionResult, []>("cancelOpening");
export const markHandled = defineUpdate<StaffActionResult, []>("markHandled");
export const dismissFilledNotice = defineUpdate<StaffActionResult, []>("dismissFilledNotice");
