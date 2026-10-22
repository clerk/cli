import { describe, expect, test } from "bun:test";
import { parseTeams } from "./teams.ts";

const team = (teamID: string, teamName: string, isFreeProvisioningTeam = false) => ({
  teamID,
  teamName,
  teamType: isFreeProvisioningTeam ? "Personal Team" : "Company",
  isFreeProvisioningTeam,
});

describe("parseTeams", () => {
  test("lists paid teams before Personal Teams", () => {
    const teams = parseTeams({
      "account-1": [team("PERSONAL01", "Sean Perez", true), team("COMPANY001", "Acme")],
    });
    expect(teams).toEqual([
      { id: "COMPANY001", name: "Acme", personal: false },
      { id: "PERSONAL01", name: "Sean Perez", personal: true },
    ]);
  });

  test("puts Xcode's last selected team first among equals", () => {
    const teams = parseTeams(
      { account: [team("AAAAAAAAAA", "Alpha"), team("BBBBBBBBBB", "Beta")] },
      "BBBBBBBBBB",
    );
    expect(teams.map((entry) => entry.id)).toEqual(["BBBBBBBBBB", "AAAAAAAAAA"]);
  });

  test("lists a team shared by two accounts once", () => {
    const teams = parseTeams({
      first: [team("COMPANY001", "Acme")],
      second: [team("COMPANY001", "Acme")],
    });
    expect(teams).toHaveLength(1);
  });

  test("skips entries without a valid Team ID", () => {
    expect(parseTeams({ account: [team("short", "Bad"), { teamName: "Missing" }, null] })).toEqual(
      [],
    );
  });

  test("falls back to the ID when a team has no name", () => {
    expect(parseTeams({ account: [team("COMPANY001", "")] })[0]!.name).toBe("COMPANY001");
  });

  test.each([undefined, null, "teams", 42])("reads %p as no teams", (value) => {
    expect(parseTeams(value)).toEqual([]);
  });
});
