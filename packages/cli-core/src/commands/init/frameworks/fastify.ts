import { scaffoldServerFramework, type ServerFrameworkConfig } from "./node-server.js";
import type { FrameworkScaffold } from "./types.js";

const FASTIFY_CONFIG: ServerFrameworkConfig = {
  clerkPackage: "@clerk/fastify",
  clerkImport: "clerkPlugin",
  // Matches `Fastify(...)`/`fastify(...)` and the inline-require form
  // `require("fastify")(...)`, with an optional type annotation
  // (`const server: FastifyInstance = Fastify()`).
  creationPattern:
    /(?:const|let|var)\s+(\w+)(?:\s*:\s*[\w$.]+(?:<[^>]*>)?)?\s*=\s*(?:[Ff]astify|require\(\s*["']fastify["']\s*\))\s*\(/,
  frameworkPackage: "fastify",
  attachStatement: (appVar) => `${appVar}.register(clerkPlugin);`,
  description: "Register clerkPlugin on Fastify app",
  docsUrl: "https://clerk.com/docs/fastify/getting-started/quickstart",
  manualWiring: "Register `clerkPlugin` from @clerk/fastify on your Fastify instance.",
};

export const fastify: FrameworkScaffold = {
  name: "Fastify",
  dep: "fastify",

  matches: (ctx) => ctx.framework.dep === "fastify",

  scaffold: (ctx) => scaffoldServerFramework(ctx, FASTIFY_CONFIG),
};
