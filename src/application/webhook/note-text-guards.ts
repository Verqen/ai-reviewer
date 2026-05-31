function isBotMentioned(note: string, botUsername: string): boolean {
  return note.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
}

function isReviewRequest(noteText: string): boolean {
  return /\breview\b/i.test(noteText.replace(/@ai/i, ""));
}

export { isBotMentioned, isReviewRequest };
