import { join } from "node:path";
import { yellow, dim, cyan } from "../../lib/color.js";
import { log } from "../../lib/log.js";

type AuthLibraryScan = {
  packages: string[];
  name: string;
  docsUrl: string;
};

type CodeScan = {
  pattern: string;
  flags?: string;
  message: string;
  docsUrl?: string;
  frameworks?: string[];
};

export type ScanFinding = {
  file: string;
  line: number;
  message: string;
  docsUrl?: string;
};

const AUTH_LIBRARY_SCANS: AuthLibraryScan[] = [
  {
    packages: ["next-auth"],
    name: "NextAuth / Auth.js",
    docsUrl: "https://clerk.com/docs/migrations/nextauth",
  },
  {
    packages: ["@auth0/nextjs-auth0", "auth0"],
    name: "Auth0",
    docsUrl: "https://clerk.com/docs/migrations/auth0",
  },
  {
    packages: ["@supabase/ssr", "@supabase/auth-helpers-nextjs"],
    name: "Supabase Auth",
    docsUrl: "https://clerk.com/docs/migrations/supabase",
  },
  {
    packages: ["firebase"],
    name: "Firebase",
    docsUrl: "https://clerk.com/docs/migrations/firebase",
  },
  {
    packages: ["passport"],
    name: "Passport.js",
    docsUrl: "https://clerk.com/docs/migrations/overview",
  },
  {
    packages: ["better-auth"],
    name: "Better Auth",
    docsUrl: "https://clerk.com/docs/migrations/overview",
  },
  {
    packages: ["@kinde-oss/kinde-auth-nextjs"],
    name: "Kinde",
    docsUrl: "https://clerk.com/docs/migrations/overview",
  },
];

export function detectAuthLibraries(deps: Record<string, string>): void {
  for (const scan of AUTH_LIBRARY_SCANS) {
    const found = scan.packages.some((pkg) => pkg in deps);
    if (!found) continue;

    log.data(yellow(`\n⚠ Detected ${scan.name} in your project.`));
    log.data(dim(`  Migration guide: ${scan.docsUrl}`));
  }
}

const CODE_SCANS: CodeScan[] = [
  {
    pattern: "(?:NEXT_PUBLIC_)?CLERK_PUBLISHABLE_KEY\\s*=\\s*pk_",
    message: "Hardcoded publishable key",
    docsUrl: "https://clerk.com/docs/deployments/clerk-environment-variables",
  },
  {
    pattern: "CLERK_SECRET_KEY\\s*=\\s*sk_",
    message: "Hardcoded secret key",
    docsUrl: "https://clerk.com/docs/deployments/clerk-environment-variables",
  },
  {
    pattern: "import\\s.*from\\s+['\"]next-auth",
    message: "NextAuth import still in use",
    frameworks: ["next"],
  },
  {
    pattern: "import\\s.*from\\s+['\"]@auth0/",
    message: "Auth0 import still in use",
  },
  {
    pattern: "import\\s.*from\\s+['\"]@supabase/(ssr|auth-helpers)",
    message: "Supabase Auth import still in use",
  },
  {
    pattern: "import\\s.*from\\s+['\"]firebase/auth",
    message: "Firebase Auth import still in use",
  },
  {
    pattern: "import\\s.*from\\s+['\"]better-auth",
    message: "Better Auth import still in use",
  },
  {
    pattern: "import\\s.*from\\s+['\"]@kinde-oss/",
    message: "Kinde import still in use",
  },
  {
    pattern: "import\\s.*from\\s+['\"]passport['\"]",
    message: "Passport import still in use",
  },
  {
    pattern: "getServerSession\\s*\\(",
    message: "NextAuth getServerSession() call still in use",
    frameworks: ["next"],
  },
];

const IGNORE_DIRS = new Set(["node_modules", ".next", "dist", ".git", "build", ".output", ".nuxt"]);

// Precompile regexes once instead of per-file
const COMPILED_CODE_SCANS = CODE_SCANS.map((scan) => ({
  ...scan,
  regex: new RegExp(scan.pattern, scan.flags ?? "m"),
}));

function findLineNumber(content: string, matchIndex: number): number {
  return content.slice(0, matchIndex).split("\n").length;
}

function isIgnored(relPath: string): boolean {
  return relPath.split("/").some((seg) => IGNORE_DIRS.has(seg));
}

function scanFileContent(content: string, relPath: string, frameworkDep: string): ScanFinding[] {
  const results: ScanFinding[] = [];

  for (const scan of COMPILED_CODE_SCANS) {
    if (scan.frameworks && !scan.frameworks.includes(frameworkDep)) continue;

    const match = scan.regex.exec(content);
    if (!match) continue;

    results.push({
      file: relPath,
      line: findLineNumber(content, match.index),
      message: scan.message,
      docsUrl: scan.docsUrl,
    });
  }

  return results;
}

export async function scanForIssues(cwd: string, frameworkDep: string): Promise<ScanFinding[]> {
  const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs,cjs,vue,astro}");
  const findings: ScanFinding[] = [];

  for await (const relPath of glob.scan({ cwd })) {
    if (isIgnored(relPath)) continue;

    const content = await Bun.file(join(cwd, relPath)).text();
    findings.push(...scanFileContent(content, relPath, frameworkDep));
  }

  return findings;
}

export function printFindings(findings: ScanFinding[]): void {
  if (findings.length === 0) return;

  log.data(dim("\n  Recommendations:"));
  for (const f of findings) {
    const location = `${cyan(f.file)}:${f.line}`;
    log.data(`  ${yellow("⚠")} ${location} ${dim("—")} ${f.message}`);
    if (f.docsUrl) log.data(`    ${dim(f.docsUrl)}`);
  }
}
