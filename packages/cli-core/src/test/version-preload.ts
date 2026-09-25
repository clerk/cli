// Bun macro imports can be order-dependent when a test first reaches the CLI
// through a deeply mocked command graph. Load the real version module before
// test files so every isolated worker resolves its macro deterministically.
import "../lib/version.ts";
