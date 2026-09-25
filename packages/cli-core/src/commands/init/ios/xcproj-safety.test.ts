import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIOSJSONFixture } from "./test-helpers.ts";
import { parseXCProjSource, type XCProjRecord } from "./xcproj.ts";
import { resolveXcodeProjectDocument } from "./project-document.ts";
import { planIOSMissingEntitlementsSettings } from "./entitlements-settings.ts";
import { inspectIOSProject } from "./inspect.ts";
import {
  planIOSSDKInstall,
  applyIOSSDKInstall,
  validateIOSSDKInstallPostcondition,
} from "./install-sdk.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clerk-xcproj-review-"));
  roots.push(root);
  await createIOSJSONFixture(root);
  return { root, projectPath: "MyApp.xcodeproj", targetId: "C1E000000000000000000001" };
}
async function edit(root: string, update: (document: XCProjRecord, target: XCProjRecord) => void) {
  const path = join(root, "MyApp.xcodeproj", "project.xcproj");
  const document = parseXCProjSource(await readFile(path, "utf8")).root;
  update(document, (document.targets as XCProjRecord[])[0]!);
  await writeFile(path, JSON.stringify(document, null, 2));
}

for (const regular of ["project.pbxproj", "project.xcproj"]) {
  test.each(["symlink", "directory"])(
    `blocks a second %s document beside ${regular}`,
    async (kind) => {
      const options = await fixture();
      const wrapper = join(options.root, options.projectPath);
      await rm(join(wrapper, "project.xcproj"));
      await writeFile(join(wrapper, regular), "{}");
      const other = join(
        wrapper,
        regular === "project.xcproj" ? "project.pbxproj" : "project.xcproj",
      );
      if (kind === "symlink") await symlink(regular, other);
      else await mkdir(other);
      expect(await resolveXcodeProjectDocument(wrapper)).toEqual({ status: "ambiguous" });
      expect((await inspectIOSProject(options.root)).selection.state).not.toBe("selected");
    },
  );
}

test.each(["missing", "ambiguous"])(
  "explains a %s document without claiming path escape",
  async (kind) => {
    const options = await fixture();
    if (kind === "missing") await rm(join(options.root, options.projectPath, "project.xcproj"));
    else await writeFile(join(options.root, options.projectPath, "project.pbxproj"), "{}");
    const plan = await planIOSMissingEntitlementsSettings(options);
    expect(plan.blockers[0]?.code).toBe("unreadable-project");
    expect(plan.blockers[0]?.message).not.toContain("outside");
  },
);

test.each([true, false])(
  "checks the selected JSON target's other platform (shared path: %s)",
  async (shared) => {
    const options = await fixture();
    await edit(options.root, (d, target) => {
      (d["build-settings"] as XCProjRecord).SDKROOT = "auto";
      const settings = target["build-settings"] as XCProjRecord;
      delete settings.CODE_SIGN_ENTITLEMENTS;
      settings.SUPPORTED_PLATFORMS = "iphoneos iphonesimulator macosx";
      settings.MACOSX_DEPLOYMENT_TARGET = "14.0";
      settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"] = shared
        ? "MyApp/MyApp.entitlements"
        : "MyApp/MyApp.mac.entitlements";
    });
    await rm(join(options.root, "MyApp", "MyApp.entitlements"));
    const plan = await planIOSMissingEntitlementsSettings(options);
    expect(plan.status).toBe(shared ? "blocked" : "ready");
    if (shared) expect(plan.blockers[0]?.message).toContain("entitlements destination");
  },
);

test("rejects a changed supported-platform set during JSON SDK postvalidation", async () => {
  const options = await fixture();
  const plan = await planIOSSDKInstall(options);
  expect((await applyIOSSDKInstall(plan)).status).toBe("applied");
  expect(await validateIOSSDKInstallPostcondition(plan)).toBe(true);
  await edit(options.root, (d, target) => {
    (d["build-settings"] as XCProjRecord).SDKROOT = "auto";
    const settings = target["build-settings"] as XCProjRecord;
    settings.SUPPORTED_PLATFORMS = "iphoneos iphonesimulator macosx";
    settings.MACOSX_DEPLOYMENT_TARGET = "14.0";
  });
  expect(await validateIOSSDKInstallPostcondition(plan)).toBe(false);
});

test.each([false, true])(
  "rejects ambiguous package identities regardless of order (fork first: %s)",
  async (forkFirst) => {
    const options = await fixture();
    const original = await planIOSSDKInstall(options);
    expect((await applyIOSSDKInstall(original)).status).toBe("applied");
    await edit(options.root, (d) => {
      const fork = {
        kind: "remote",
        repository: "https://github.com/example/clerk-ios",
        version: { "up-to-next-major-version": "1.0.0" },
      };
      const packages = d.packages as XCProjRecord[];
      if (forkFirst) packages.unshift(fork);
      else packages.push(fork);
    });
    expect((await inspectIOSProject(options.root)).appTargets[0]?.packages.package).toBe(
      "unattributed",
    );
    const plan = await planIOSSDKInstall(options);
    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("ambiguous-package");
    expect(await validateIOSSDKInstallPostcondition(original)).toBe(false);
  },
);
