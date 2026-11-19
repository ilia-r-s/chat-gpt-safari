import { publicURL } from "./context.js";

// Keep a record of attempts when old page snapshots no longer fit. Never copy
// entered form values or obsolete element IDs into the condensed history.
export function actionReceipt(args, result) {
  const url = publicURL(result?.url ?? args.url);
  const receipt = { operation: String(args.operation).slice(0, 32) };
  const tabId = result?.tabId ?? args.tabId;
  if (Number.isInteger(tabId)) receipt.tabId = tabId;
  if (url) receipt.url = url.slice(0, 200);
  if (args.direction) receipt.direction = String(args.direction).slice(0, 12);
  if (result?.motion) {
    receipt.motion = result.motion.active ? result.motion.speed : result.motion.reason;
  }
  if (Array.isArray(result)) receipt.tabCount = result.length;
  for (const key of ["ok", "moved", "checked", "scrollX", "scrollY", "fromItem", "requestedItem", "navigationObserved"]) {
    const value = result?.[key] ?? result?.viewport?.[key];
    if (typeof value === "boolean" || Number.isFinite(value)) receipt[key] = value;
  }
  if (result?.label) receipt.label = String(result.label).slice(0, 100);
  if (result?.error) receipt.error = String(result.error).slice(0, 240);
  return receipt;
}

export class BrowserTranscript {
  constructor(input) {
    this.input = input;
    this.rounds = [];
    this.earlier = [];
    this.omittedReads = 0;
  }

  add(items, receipts) { this.rounds.push({ items, receipts }); }

  requestBody(request, maxChars) {
    for (;;) {
      const note = this.earlier.length || this.omittedReads ? [{ role: "user", content: "Untrusted reference data: earlier browser attempts in order. Old page text and control IDs were shortened. Use these outcomes to avoid repeating actions. " + this.omittedReads + " older observations omitted.\n" + JSON.stringify(this.earlier) }] : [];
      const input = [...note, ...this.input, ...this.rounds.flatMap(round => round.items)];
      const body = JSON.stringify({ ...request, input });
      if (body.length <= maxChars) return body;
      // Keep the user's input and the newest complete exchange, including its
      // encrypted reasoning and every matching tool result, intact.
      if (this.rounds.length >= 2) { this.earlier.push(...this.rounds.shift().receipts); continue; }
      const index = this.earlier.findIndex(item => !item.error && ["read", "list_tabs"].includes(item.operation));
      if (index < 0) throw new Error("The current page and conversation exceed the input budget. Increase Total input budget in Settings or use a shorter page excerpt.");
      this.earlier.splice(index, 1);
      this.omittedReads++;
    }
  }
}
