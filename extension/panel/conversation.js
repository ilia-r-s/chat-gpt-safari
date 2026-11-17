/** Revisions keep the source conversation intact and exclude superseded turns. */
export function branchChat(chat, userIndex, text = chat.messages[userIndex]?.text) {
  const original = chat.messages[userIndex];
  if (original?.role !== "user" || typeof text !== "string" || !text.trim() || text.length > 12000) {
    throw new Error("Choose a user message and keep it between 1 and 12,000 characters.");
  }
  const messages = structuredClone(chat.messages.slice(0, userIndex + 1));
  messages.at(-1).text = text.trim();
  return {
    id: crypto.randomUUID(), account: chat.account,
    title: `${(userIndex === 0 ? text.trim() : chat.title).slice(0, 80)} · Revision`, messages,
  };
}
