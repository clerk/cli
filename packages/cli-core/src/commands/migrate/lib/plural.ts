/** `1 user`, `2 users`: the count and the word, in English. */
export const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`;
