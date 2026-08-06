/**
 * The load → transform → validate pipeline.
 *
 * Ported from the standalone migration-tool's `src/migrate/functions.ts` and
 * the transform helpers in its `src/lib/index.ts`. Two dependencies were
 * dropped along the way: `mime-types` (an extension check covers the two
 * formats we accept) and the repo-specific `/samples/` path special-case.
 */

import fs from "node:fs";
import path from "node:path";
import csvParser from "csv-parser";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";
import { getTransformer } from "../transformers/registry.ts";
import {
  PASSWORD_HASHERS,
  type TransformContext,
  type TransformerRegistryEntry,
  type User,
} from "../types.ts";
import { userSchema } from "../validator.ts";
import { validationLogger } from "./logger.ts";

export type FileType = "application/json" | "text/csv";

export type TransformOptions = {
  /** Set `false` to keep invalid rows, for analysis passes that count fields. */
  validate?: boolean;
  /** Per-run values `postTransform` may need. */
  context?: TransformContext;
};

/** Resolves an import path against the current working directory. */
export function resolveImportFilePath(file: string): string {
  return path.resolve(process.cwd(), file.trim());
}

export function fileExists(file: string): boolean {
  return fs.existsSync(resolveImportFilePath(file));
}

/**
 * Classifies an import file by extension.
 *
 * @returns The MIME type, or `undefined` for anything that is not JSON or CSV.
 */
export function getFileType(file: string): FileType | undefined {
  const ext = path.extname(resolveImportFilePath(file)).toLowerCase();
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  return undefined;
}

// --- Field mapping ---------------------------------------------------------

/**
 * Flattens only the nested paths a transformer actually references.
 *
 * Lets a transformer map `"_id.$oid"` onto `userId` without flattening
 * (and thereby mangling) metadata objects it does not mention.
 */
export function flattenObjectSelectively(
  obj: Record<string, unknown>,
  transformer: Record<string, string>,
  prefix = "",
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = prefix ? `${prefix}.${key}` : key;
    const hasNestedMapping = Object.keys(transformer).some((mapped) =>
      mapped.startsWith(`${currentPath}.`),
    );

    if (hasNestedMapping && value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(
        result,
        flattenObjectSelectively(value as Record<string, unknown>, transformer, currentPath),
      );
    } else {
      result[currentPath] = value;
    }
  }

  return result;
}

/** Renames source fields onto Clerk's import schema, dropping empty values. */
export function transformKeys(
  data: Record<string, unknown>,
  transformerConfig: { transformer: Record<string, string> },
): Record<string, unknown> {
  const transformed: Record<string, unknown> = {};
  const { transformer } = transformerConfig;
  const flat = flattenObjectSelectively(data, transformer);

  for (const [key, value] of Object.entries(flat)) {
    if (value !== "" && value !== '"{}"' && value !== null) {
      transformed[transformer[key] ?? key] = value;
    }
  }

  return transformed;
}

// --- Value normalization ---------------------------------------------------

function parseJsonValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!["[", "{", '"'].includes(trimmed[0] ?? "")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function parseDelimitedStrings(field: unknown): string[] {
  if (Array.isArray(field)) return field as string[];
  if (typeof field === "string" && field) {
    const parsed = parseJsonValue(field);
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value).trim()).filter(Boolean);
    }
    return field
      .split(/[,|]/)
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeStringArrayField(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = parseJsonValue(trimmed);
  if (Array.isArray(parsed)) {
    return parsed.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof parsed === "string") {
    const parsedString = parsed.trim();
    if (parsedString.includes(",") || parsedString.includes("|")) {
      return parsedString
        .split(/[,|]/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return parsedString;
  }
  return parsed;
}

function normalizeBooleanField(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return value;
  }
  if (typeof value !== "string") return value;

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return value;
}

function normalizeNumberField(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}

function normalizeMetadataField(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return value;

  const parsed = parseJsonValue(value);
  return typeof parsed === "string" ? value : parsed;
}

function normalizeDateField(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

const ARRAY_FIELDS = [
  "email",
  "emailAddresses",
  "unverifiedEmailAddresses",
  "phone",
  "phoneNumbers",
  "unverifiedPhoneNumbers",
  "backupCodes",
] as const;

const BOOLEAN_FIELDS = [
  "backupCodesEnabled",
  "banned",
  "bypassClientTrust",
  "createOrganizationEnabled",
  "deleteSelfEnabled",
  "skipLegalChecks",
  "skipPasswordChecks",
] as const;

const METADATA_FIELDS = ["unsafeMetadata", "publicMetadata", "privateMetadata"] as const;

const DATE_FIELDS = ["createdAt", "legalAcceptedAt"] as const;

/**
 * Coerces CSV's all-strings-everything into the shapes the schema expects.
 *
 * A field that normalizes to `undefined` is deleted rather than set, so an
 * empty CSV column does not look like an explicitly-null value to Clerk.
 */
export function normalizeUserData(user: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...user };

  const setOrDelete = (field: string, value: unknown) => {
    if (value === undefined) delete normalized[field];
    else normalized[field] = value;
  };

  for (const field of ARRAY_FIELDS) {
    setOrDelete(field, normalizeStringArrayField(normalized[field]));
  }
  for (const field of BOOLEAN_FIELDS) {
    normalized[field] = normalizeBooleanField(normalized[field]);
  }
  for (const field of METADATA_FIELDS) {
    setOrDelete(field, normalizeMetadataField(normalized[field]));
  }
  for (const field of DATE_FIELDS) {
    setOrDelete(field, normalizeDateField(normalized[field]));
  }
  setOrDelete(
    "createOrganizationsLimit",
    normalizeNumberField(normalized.createOrganizationsLimit),
  );

  return normalized;
}

/**
 * Merges a Clerk export's three email fields (and three phone fields) into the
 * verified/unverified pair the schema models, deduping across all of them.
 */
export function consolidateClerkIdentifiers(user: Record<string, unknown>): void {
  const merge = (primaryKey: string, verifiedKey: string, unverifiedKey: string) => {
    const primary = user[primaryKey] as string | undefined;
    const verified = parseDelimitedStrings(user[verifiedKey]);
    const unverified = parseDelimitedStrings(user[unverifiedKey]);

    const all: string[] = [];
    if (primary) all.push(primary);
    for (const value of verified) {
      if (!all.includes(value)) all.push(value);
    }
    if (all.length > 0) user[primaryKey] = all;
    delete user[verifiedKey];

    const extraUnverified = unverified.filter((value) => !all.includes(value));
    if (extraUnverified.length > 0) user[unverifiedKey] = extraUnverified;
    else delete user[unverifiedKey];
  };

  merge("email", "emailAddresses", "unverifiedEmailAddresses");
  merge("phone", "phoneNumbers", "unverifiedPhoneNumbers");
}

// --- Validation ------------------------------------------------------------

/**
 * Validates prepared users, logging each failure and dropping it from the run.
 *
 * An unrecognized `passwordHasher` is the one failure that aborts instead:
 * importing those users would store credentials nobody can ever sign in with,
 * and the fix is a one-word edit to the transformer.
 */
export function validatePreparedUsers(
  users: Record<string, unknown>[],
  dateTime: string,
): { users: User[]; validationFailed: number } {
  const validated: User[] = [];
  let validationFailed = 0;

  for (let i = 0; i < users.length; i++) {
    const user = users[i] as Record<string, unknown>;
    const result = userSchema.safeParse(user);

    if (result.success) {
      validated.push(result.data);
      continue;
    }

    validationFailed++;
    const firstIssue = result.error.issues[0];
    if (!firstIssue) continue;

    if (firstIssue.path.includes("passwordHasher") && user.passwordHasher) {
      const invalidHasher =
        typeof user.passwordHasher === "string"
          ? user.passwordHasher
          : JSON.stringify(user.passwordHasher);
      throw new CliError(
        `Invalid password hasher "${invalidHasher}" on user ${String(user.userId)} (row ${i + 1}).\n` +
          `Expected one of: ${PASSWORD_HASHERS.join(", ")}`,
        {
          code: ERROR_CODE.USAGE_ERROR,
          docsUrl: "https://clerk.com/docs/guides/development/migrating/overview",
        },
      );
    }

    validationLogger(
      {
        error: firstIssue.message,
        path: firstIssue.path as (string | number)[],
        userId: (user.userId as string) || `row-${i}`,
        row: i,
      },
      dateTime,
    );
  }

  return { users: validated, validationFailed };
}

function addDefaultFields(
  users: Record<string, unknown>[],
  transformer: TransformerRegistryEntry,
): Record<string, unknown>[] {
  if (!transformer.defaults) return users;
  return users.map((user) => ({ ...user, ...transformer.defaults }));
}

/**
 * Maps, normalizes and (unless disabled) validates a batch of raw users.
 *
 * @param options.validate - Set `false` to get the mapped shape without
 *   dropping invalid rows, for analysis passes that count fields.
 * @param options.context - Per-run values `postTransform` may need, e.g.
 *   Firebase's hash parameters.
 */
export function transformUsers(
  users: Record<string, unknown>[],
  key: string,
  dateTime: string,
  options: TransformOptions = {},
): { transformedData: User[]; validationFailed: number } {
  const transformer = getTransformer(key);
  const context = options.context ?? {};
  const transformed: Record<string, unknown>[] = [];

  for (const user of users) {
    const mapped = transformKeys(user, transformer);

    if (key === "clerk") {
      consolidateClerkIdentifiers(mapped);
    }
    transformer.postTransform?.(mapped, context);

    transformed.push(normalizeUserData(mapped));
  }

  if (options.validate === false) {
    return { transformedData: transformed as User[], validationFailed: 0 };
  }

  const result = validatePreparedUsers(transformed, dateTime);
  return { transformedData: result.users, validationFailed: result.validationFailed };
}

// --- File loading ----------------------------------------------------------

async function readCsv(filePath: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const users: Record<string, unknown>[] = [];
    fs.createReadStream(filePath)
      .pipe(csvParser({ skipComments: true }))
      .on("data", (row: Record<string, unknown>) => users.push(row))
      .on("error", reject)
      .on("end", () => resolve(users));
  });
}

async function readUsersFromFile(
  file: string,
  transformer: TransformerRegistryEntry,
): Promise<Record<string, unknown>[]> {
  let filePath = resolveImportFilePath(file);
  const type = getFileType(file);
  let preExtracted: Record<string, unknown>[] | undefined;

  if (transformer.preTransform) {
    const result = await transformer.preTransform(filePath, type ?? "");
    filePath = result.filePath;
    preExtracted = result.data;
  }

  if (type === "text/csv") return readCsv(filePath);
  if (preExtracted) return preExtracted;

  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (!Array.isArray(parsed)) {
    throw new CliError(`Expected ${file} to contain a JSON array of users, got ${typeof parsed}.`, {
      code: ERROR_CODE.INVALID_JSON,
    });
  }
  return parsed as Record<string, unknown>[];
}

/**
 * Reads the export exactly as the transformer sees it, before any field
 * mapping.
 *
 * Used by the Supabase provider cross-reference, which reads
 * `raw_app_meta_data` — a column no transformer maps, so it is gone by the time
 * users are transformed.
 */
export async function readRawUsers(file: string, key: string): Promise<Record<string, unknown>[]> {
  return readUsersFromFile(file, getTransformer(key));
}

/**
 * Reads a JSON or CSV export and returns the users ready to import.
 *
 * @param options - Passed through to {@link transformUsers}.
 */
export async function loadUsersFromFile(
  file: string,
  key: string,
  dateTime: string,
  options: TransformOptions = {},
): Promise<{ users: User[]; validationFailed: number }> {
  const transformer = getTransformer(key);
  const raw = await readUsersFromFile(file, transformer);
  const withDefaults = addDefaultFields(raw, transformer);
  const { transformedData, validationFailed } = transformUsers(
    withDefaults,
    key,
    dateTime,
    options,
  );
  return { users: transformedData, validationFailed };
}
