/** `text` with its first character in upper case, for a clause that opens a sentence. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
