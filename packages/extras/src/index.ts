import type { Command } from "@commander-js/extra-typings";
import { clerkBird } from "./clerk-bird/index.ts";

/**
 * Register easter-egg / extra commands on the main Clerk CLI program.
 * Kept in a separate package so the core CLI stays focused on its real surface area.
 */
export function registerExtras(program: Command): void {
  program
    .command("bird")
    .description("Play Clerk Bird, a Flappy Bird game in your terminal")
    .action(clerkBird);
}
