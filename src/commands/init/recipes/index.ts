import nextjs from "./nextjs.md" with { type: "text" };
import react from "./react.md" with { type: "text" };
import expo from "./expo.md" with { type: "text" };
import astro from "./astro.md" with { type: "text" };
import nuxt from "./nuxt.md" with { type: "text" };
import tanstackStart from "./tanstack-start.md" with { type: "text" };
import reactRouter from "./react-router.md" with { type: "text" };
import fastify from "./fastify.md" with { type: "text" };
import express from "./express.md" with { type: "text" };
import vue from "./vue.md" with { type: "text" };

import type { FrameworkDep } from "../../../lib/framework.ts";

const RECIPES: Partial<Record<FrameworkDep, string>> = {
  next: nextjs,
  react: react,
  vite: react,
  expo: expo,
  astro: astro,
  nuxt: nuxt,
  "@tanstack/react-start": tanstackStart,
  "react-router": reactRouter,
  fastify: fastify,
  express: express,
  vue: vue,
};

export function getRecipe(dep: FrameworkDep): string | null {
  return RECIPES[dep] ?? null;
}
