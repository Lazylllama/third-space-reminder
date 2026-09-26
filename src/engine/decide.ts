import type { Status } from "./plan";
import { FINAL_SPRINT_MS, type Slot } from "./slots";

export type MessageKind =
  | "nag"
  | "nagDebt"
  | "slackDayDebt"
  | "weekendWarning"
  | "finalDay"
  | "finalHours"
  | "impossible"
  | "overtime"
  | "dayDone"
  | "weekDone"
  | "ship"
  | "kickoff";

/** One-shot markers already recorded for this reminder. */
export interface DecideState {
  kickoffSent: boolean;
  weekDoneAnnounced: boolean;
  dayDoneAnnounced: boolean;
  shipped: boolean;
  shipNag: boolean;
}

export interface Decision {
  kind: MessageKind | null;
  /** One-shot marker keys to record if the message goes out. */
  markers: string[];
}

export const HEADS_UP_FACTOR = 1.5;

export function kickoffMarker(weekKey: string): string {
  return `kickoff|${weekKey}`;
}
export function weekDoneMarker(weekKey: string): string {
  return `weekDone|${weekKey}`;
}
export function dayDoneMarker(date: string): string {
  return `dayDone|${date}`;
}

const none: Decision = { kind: null, markers: [] };

/** What (if anything) to send for a due slot. Pure: everything it needs comes in through the arguments. */
export function decide(status: Status, slot: Slot, state: DecideState): Decision {
  const weekKey = status.week.key;

  if (status.phase === "weekDone") {
    if (!state.weekDoneAnnounced) return { kind: "weekDone", markers: [weekDoneMarker(weekKey)] };
    if (state.shipNag && !state.shipped && (slot.hour || slot.final)) return { kind: "ship", markers: [] };
    return none;
  }

  if (status.phase === "prestart") return none;

  if (status.today === status.plan.first && slot.hour && !state.kickoffSent) {
    return { kind: "kickoff", markers: [kickoffMarker(weekKey)] };
  }

  if (status.phase === "overtime") return slot.hour ? { kind: "overtime", markers: [] } : none;

  if (status.phase === "finalDay") {
    if (!slot.hour && !slot.final) return none;
    if (status.weekLeft * 1000 > status.timeToSoft) return { kind: "impossible", markers: [] };
    if (slot.at >= status.soft - FINAL_SPRINT_MS) return { kind: "finalHours", markers: [] };
    return { kind: "finalDay", markers: [] };
  }

  // normal phase
  if (slot.headsUp && status.weekLeft > HEADS_UP_FACTOR * status.base) return { kind: "weekendWarning", markers: [] };
  if (!slot.hour) return none;

  if (status.isSlackDay && status.debt === 0) return none;

  if (status.dayLeft === 0) {
    if (state.dayDoneAnnounced) return none;
    return { kind: "dayDone", markers: [dayDoneMarker(status.today)] };
  }

  if (status.isSlackDay) return { kind: "slackDayDebt", markers: [] };
  if (status.debt > 0) return { kind: "nagDebt", markers: [] };
  return { kind: "nag", markers: [] };
}
