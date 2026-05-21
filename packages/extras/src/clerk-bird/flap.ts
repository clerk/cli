// ═══════════════════════════════════════════════════════
// Terminal Flappy Bird v2
// ═══════════════════════════════════════════════════════

import { homedir } from "os";
import { join } from "path";

// ═══════════════════════════════════════════════════════
// ANSI Helpers
// ═══════════════════════════════════════════════════════

const ansi = {
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  altEnter: "\x1b[?1049h",
  altExit: "\x1b[?1049l",
  clear: "\x1b[2J",
  home: "\x1b[H",
  fg: (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`,
} as const;

// ═══════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════

const PIPE_W = 6;
const DIST = 20;
const GRAV = 18.0; // px/s²
const FLAP_V = -9.0; // px/s upward
const MAX_V = 18.0; // px/s downward cap
const BASE_SPEED = 12.0; // px/s scroll at score 0
const MAX_SPEED = 22.0; // px/s scroll ceiling
const BASE_GAP = 7;
const MIN_GAP = 5;
const TARGET_FPS = 30;
const TICK_MS = 1000 / TARGET_FPS;
const MIN_COLS = 52;
const MIN_ROWS = 22;

// ═══════════════════════════════════════════════════════
// Key Codes
// ═══════════════════════════════════════════════════════

const KEY = {
  SPACE: 32,
  ENTER: 13,
  W_LOWER: 119,
  W_UPPER: 87,
  P_LOWER: 112,
  P_UPPER: 80,
  Q_LOWER: 113,
  Q_UPPER: 81,
  N_LOWER: 110,
  N_UPPER: 78,
  L_LOWER: 108,
  L_UPPER: 76,
  D_LOWER: 100,
  D_UPPER: 68,
  Y_LOWER: 121,
  Y_UPPER: 89,
  J_LOWER: 106,
  J_UPPER: 74,
  K_LOWER: 107,
  K_UPPER: 75,
  ESC: 27,
  CTRL_C: 3,
  CTRL_H: 8,
  BACKSPACE: 127,
  ARROW_UP_SEQ: [27, 91, 65] as const,
  ARROW_DOWN_SEQ: [27, 91, 66] as const,
} as const;

// ═══════════════════════════════════════════════════════
// Colors
// ═══════════════════════════════════════════════════════

const COL = {
  bird: ansi.fg(255, 210, 50),
  beak: ansi.fg(255, 130, 0),
  wing: ansi.fg(220, 180, 40),
  pipe: ansi.fg(108, 71, 255),
  pipeE: ansi.fg(75, 50, 180),
  pipeCap: ansi.fg(140, 110, 255),
  grass: ansi.fg(100, 200, 70),
  dirt: ansi.fg(140, 100, 50),
  white: ansi.fg(255, 255, 255),
  title: ansi.fg(255, 220, 60),
  dim: ansi.fg(120, 120, 150),
  dead: ansi.fg(255, 70, 70),
  popup: ansi.fg(255, 255, 100),
  cloud: ansi.fg(160, 175, 190),
  pause: ansi.fg(180, 200, 255),
} as const;

// ═══════════════════════════════════════════════════════
// Canvas
// ═══════════════════════════════════════════════════════

interface Cell {
  ch: string;
  fg: string;
}
type Canvas = Cell[][];

function mkCanvas(rows: number, cols: number): Canvas {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ ch: " ", fg: "" })),
  );
}

function clearCanvas(cv: Canvas): void {
  for (const row of cv)
    for (const cell of row) {
      cell.ch = " ";
      cell.fg = "";
    }
}

function sc(cv: Canvas, x: number, y: number, ch: string, fg: string): void {
  const xi = Math.round(x),
    yi = Math.round(y);
  const row = cv[yi];
  if (!row) return;
  if (xi < 0 || xi >= row.length) return;
  row[xi] = { ch, fg };
}

function scWide(cv: Canvas, x: number, y: number, ch: string, fg: string): void {
  sc(cv, x, y, ch, fg);
  sc(cv, x + 1, y, "", ""); // continuation cell — skipped by canvasStr
}

function writeText(cv: Canvas, x: number, y: number, text: string, fg: string): void {
  for (let i = 0; i < text.length; i++) sc(cv, x + i, y, text.charAt(i), fg);
}

function canvasStr(cv: Canvas, offsetX: number): string {
  const pad = offsetX > 0 ? " ".repeat(offsetX) : "";
  const cols = cv[0]?.length ?? 0;
  return cv
    .map((row) => {
      let out = "",
        prev = "";
      for (let i = 0; i < cols; i++) {
        const cell = row[i];
        if (!cell) continue;
        const { ch, fg } = cell;
        if (ch === "") continue; // wide-char continuation — skip
        if (fg !== prev) {
          if (prev) out += ansi.reset;
          if (fg) out += fg;
          prev = fg;
        }
        out += ch;
      }
      if (prev) out += ansi.reset;
      return pad + out;
    })
    .join("\n");
}

// ═══════════════════════════════════════════════════════
// Game State
// ═══════════════════════════════════════════════════════

interface Pipe {
  x: number;
  gapY: number;
  scored: boolean;
}
interface Popup {
  x: number;
  y: number;
  life: number;
}
interface Cloud {
  x: number;
  y: number;
  w: number;
}
type Phase = "title" | "play" | "paused" | "dead" | "name-entry" | "leaderboard";

interface GameState {
  W: number;
  H: number;
  frameH: number;
  birdX: number;
  offsetX: number;
  phase: Phase;
  by: number;
  bv: number;
  pipes: Pipe[];
  popups: Popup[];
  clouds: Cloud[];
  tick: number;
  groundTick: number;
  flash: number;
  deadTimer: number;
  pendingFlap: boolean;
  score: number;
  best: number;
  speed: number;
  gap: number;
  shake: { frames: number; intensity: number };
  stopped: boolean;
  stop: () => void;
  rankings: RankingEntry[];
  nameInput: string;
  lastSavedEntry: RankingEntry | null;
  selectedRank: number | null;
  confirmingDelete: boolean;
}

function makeState(
  W: number,
  H: number,
  offsetX: number,
  best: number,
  rankings: RankingEntry[],
): GameState {
  const gs: GameState = {
    W,
    H,
    frameH: H + 3,
    birdX: Math.floor(W * 0.2),
    offsetX,
    phase: "title",
    by: H / 2,
    bv: 0,
    pipes: [],
    popups: [],
    clouds: [],
    tick: 0,
    groundTick: 0,
    flash: 0,
    deadTimer: 0,
    pendingFlap: false,
    score: 0,
    best,
    speed: BASE_SPEED,
    gap: BASE_GAP,
    shake: { frames: 0, intensity: 0 },
    stopped: false,
    stop: () => {},
    rankings,
    nameInput: "",
    lastSavedEntry: null,
    selectedRank: null,
    confirmingDelete: false,
  };
  initClouds(gs);
  return gs;
}

function resetGame(gs: GameState): void {
  Object.assign(gs, {
    by: gs.H / 2,
    bv: FLAP_V,
    pipes: [],
    popups: [],
    score: 0,
    tick: 0,
    groundTick: 0,
    flash: 0,
    deadTimer: 0,
    speed: BASE_SPEED,
    gap: BASE_GAP,
    shake: { frames: 0, intensity: 0 },
    phase: "play" as Phase,
    lastSavedEntry: null,
    selectedRank: null,
    confirmingDelete: false,
  });
  for (let i = 0; i < 4; i++) spawnPipe(gs, gs.W + i * DIST);
}

// ═══════════════════════════════════════════════════════
// High Score I/O
// ═══════════════════════════════════════════════════════

const BEST_FILE = join(homedir(), ".flap-best");

async function loadBest(): Promise<number> {
  try {
    const n = parseInt((await Bun.file(BEST_FILE).text()).trim(), 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

function saveBest(n: number): void {
  void Bun.write(BEST_FILE, String(n)).catch(() => {
    /* best-effort */
  });
}

// ═══════════════════════════════════════════════════════
// Audio
// ═══════════════════════════════════════════════════════

// ASCII BEL — the host terminal plays/flashes/ignores per the user's bell setting.
export function beep(stream: { write(chunk: string): unknown } = process.stdout): void {
  stream.write("\x07");
}

// ═══════════════════════════════════════════════════════
// Farewell
// ═══════════════════════════════════════════════════════

const CHANGELOG_URL = "https://clerk.com/changelog";

function printFarewell(): void {
  // OSC 8 hyperlink — clickable in modern terminals, plain URL in older ones.
  const link = `\x1b]8;;${CHANGELOG_URL}\x1b\\${CHANGELOG_URL}\x1b]8;;\x1b\\`;
  process.stdout.write(
    "\n" +
      `${COL.dim}Thanks for flying with us!${ansi.reset}\n` +
      `${COL.dim}See what we're shipping next →${ansi.reset} ${COL.title}${ansi.bold}${link}${ansi.reset}\n` +
      "\n",
  );
}

// ═══════════════════════════════════════════════════════
// Rankings I/O
// ═══════════════════════════════════════════════════════

const RANKINGS_FILE = join(homedir(), ".flap-rankings.json");
const MAX_RANKINGS = 10;
const MAX_NAME_LEN = 12;
const NAME_FRAME_INNER = MAX_NAME_LEN + 2;
const NAME_FRAME_TOP = "┌" + "─".repeat(NAME_FRAME_INNER) + "┐";
const NAME_FRAME_BOT = "└" + "─".repeat(NAME_FRAME_INNER) + "┘";

interface RankingEntry {
  name: string;
  score: number;
  ts: number;
}

interface RankingsFile {
  version: 1;
  entries: RankingEntry[];
}

function sortRankings(entries: RankingEntry[]): RankingEntry[] {
  return [...entries].sort((a, b) => b.score - a.score || a.ts - b.ts);
}

export function insertEntry(
  list: RankingEntry[],
  entry: RankingEntry,
  cap: number = MAX_RANKINGS,
): { list: RankingEntry[]; rank: number | null } {
  const next = sortRankings([...list, entry]).slice(0, cap);
  const rank = next.indexOf(entry);
  return { list: next, rank: rank === -1 ? null : rank + 1 };
}

export function removeRanking(list: RankingEntry[], rank: number): RankingEntry[] {
  if (rank < 1 || rank > list.length) return list;
  return [...list.slice(0, rank - 1), ...list.slice(rank)];
}

function sanitizeEntry(raw: unknown): RankingEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["name"] !== "string") return null;
  if (typeof r["score"] !== "number" || !Number.isFinite(r["score"])) return null;
  if (typeof r["ts"] !== "number" || !Number.isFinite(r["ts"])) return null;
  const name = r["name"].slice(0, MAX_NAME_LEN).replace(/[^\x20-\x7e]/g, "");
  return { name, score: Math.floor(r["score"]), ts: Math.floor(r["ts"]) };
}

export async function loadRankings(file: string = RANKINGS_FILE): Promise<RankingEntry[]> {
  try {
    const text = await Bun.file(file).text();
    const parsed = JSON.parse(text) as unknown;
    const entriesRaw = (parsed as { entries?: unknown })?.entries;
    if (!Array.isArray(entriesRaw)) return [];
    const cleaned: RankingEntry[] = [];
    for (const e of entriesRaw) {
      const ok = sanitizeEntry(e);
      if (ok) cleaned.push(ok);
    }
    return sortRankings(cleaned).slice(0, MAX_RANKINGS);
  } catch {
    return [];
  }
}

function saveRankings(entries: RankingEntry[], file: string = RANKINGS_FILE): void {
  const payload: RankingsFile = { version: 1, entries: entries.slice(0, MAX_RANKINGS) };
  void Bun.write(file, JSON.stringify(payload, null, 2)).catch(() => {
    /* best-effort */
  });
}

// ═══════════════════════════════════════════════════════
// Terminal Size
// ═══════════════════════════════════════════════════════

interface Layout {
  W: number;
  H: number;
  offsetX: number;
}

function computeLayout(): Layout | null {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  if (cols < MIN_COLS || rows < MIN_ROWS) return null;
  const W = Math.min(cols - 2, 80);
  const H = Math.min(rows - 5, 24);
  return { W, H, offsetX: Math.floor((cols - W) / 2) };
}

// ═══════════════════════════════════════════════════════
// Input
// ═══════════════════════════════════════════════════════

const FLAP_KEYS = new Set<number>([
  KEY.SPACE,
  KEY.ENTER,
  KEY.W_LOWER,
  KEY.W_UPPER,
  KEY.K_LOWER,
  KEY.K_UPPER,
]);

function isFlap(data: Buffer): boolean {
  const k = data[0];
  if (k !== undefined && FLAP_KEYS.has(k)) return true;
  return isArrowSeq(data, KEY.ARROW_UP_SEQ);
}

function isPause(data: Buffer): boolean {
  const k = data[0];
  return k === KEY.P_LOWER || k === KEY.P_UPPER || (k === KEY.ESC && data.length === 1);
}

function isQuit(data: Buffer): boolean {
  const k = data[0];
  return k === KEY.Q_LOWER || k === KEY.Q_UPPER || k === KEY.CTRL_C;
}

function isOpenNameEntry(data: Buffer): boolean {
  const k = data[0];
  return data.length === 1 && (k === KEY.N_LOWER || k === KEY.N_UPPER);
}

function isOpenLeaderboard(data: Buffer): boolean {
  const k = data[0];
  return data.length === 1 && (k === KEY.L_LOWER || k === KEY.L_UPPER);
}

function isArrowSeq(data: Buffer, seq: readonly [number, number, number]): boolean {
  return data.length >= 3 && data[0] === seq[0] && data[1] === seq[1] && data[2] === seq[2];
}

function newRankOf(gs: GameState): number | null {
  if (!gs.lastSavedEntry) return null;
  const idx = gs.rankings.indexOf(gs.lastSavedEntry);
  return idx === -1 ? null : idx + 1;
}

function enterLeaderboard(gs: GameState): void {
  gs.phase = "leaderboard";
  gs.confirmingDelete = false;
  gs.pendingFlap = false;
  gs.selectedRank = newRankOf(gs) ?? (gs.rankings.length > 0 ? 1 : null);
}

function moveSelection(gs: GameState, delta: number): void {
  if (gs.rankings.length === 0) {
    gs.selectedRank = null;
    return;
  }
  const cur = gs.selectedRank ?? 1;
  gs.selectedRank = Math.max(1, Math.min(gs.rankings.length, cur + delta));
}

function deleteSelected(gs: GameState): void {
  gs.confirmingDelete = false;
  if (gs.selectedRank === null) return;
  const next = removeRanking(gs.rankings, gs.selectedRank);
  if (next === gs.rankings) return; // nothing changed (out of range)
  gs.rankings = next;
  saveRankings(next);
  gs.selectedRank = next.length === 0 ? null : Math.min(gs.selectedRank, next.length);
}

function commitNameEntry(gs: GameState): void {
  const trimmed = gs.nameInput.trim().slice(0, MAX_NAME_LEN);
  if (trimmed.length === 0) {
    gs.lastSavedEntry = null;
    enterLeaderboard(gs);
    return;
  }
  const entry: RankingEntry = { name: trimmed, score: gs.score, ts: Date.now() };
  const { list, rank } = insertEntry(gs.rankings, entry);
  gs.rankings = list;
  gs.lastSavedEntry = rank !== null ? entry : null;
  saveRankings(list);
  enterLeaderboard(gs);
}

function handleNameInput(data: Buffer, gs: GameState): void {
  const k = data[0];

  // ESC alone cancels — note that arrow keys also start with ESC but have length 3+.
  if (k === KEY.ESC && data.length === 1) {
    gs.lastSavedEntry = null;
    enterLeaderboard(gs);
    return;
  }

  if (k === KEY.ENTER) {
    commitNameEntry(gs);
    return;
  }

  if (k === KEY.BACKSPACE || k === KEY.CTRL_H) {
    if (gs.nameInput.length > 0) gs.nameInput = gs.nameInput.slice(0, -1);
    return;
  }

  if (data.length !== 1 || k === undefined || k < 32 || k > 126) return;
  if (gs.nameInput.length >= MAX_NAME_LEN) return;
  gs.nameInput += String.fromCharCode(k);
}

function handleDeleteConfirm(data: Buffer, gs: GameState): void {
  const k = data[0];
  if (data.length === 1 && (k === KEY.Y_LOWER || k === KEY.Y_UPPER)) {
    deleteSelected(gs);
    return;
  }
  // Anything else (N, ESC, D, even Q) just cancels the prompt.
  // Q won't quit during a confirmation — user can press Q again afterwards.
  gs.confirmingDelete = false;
}

function isLeaderboardRetry(data: Buffer): boolean {
  if (data.length !== 1) return false;
  const k = data[0];
  return k === KEY.SPACE || k === KEY.ENTER || k === KEY.W_LOWER || k === KEY.W_UPPER;
}

function handleLeaderboardInput(data: Buffer, gs: GameState): void {
  if (gs.confirmingDelete) {
    handleDeleteConfirm(data, gs);
    return;
  }

  const k = data[0];
  if (data.length === 1 && (k === KEY.Q_LOWER || k === KEY.Q_UPPER)) {
    gs.stop();
    return;
  }

  if (
    isArrowSeq(data, KEY.ARROW_UP_SEQ) ||
    (data.length === 1 && (k === KEY.K_LOWER || k === KEY.K_UPPER))
  ) {
    moveSelection(gs, -1);
    return;
  }
  if (
    isArrowSeq(data, KEY.ARROW_DOWN_SEQ) ||
    (data.length === 1 && (k === KEY.J_LOWER || k === KEY.J_UPPER))
  ) {
    moveSelection(gs, 1);
    return;
  }

  if (data.length === 1 && (k === KEY.D_LOWER || k === KEY.D_UPPER)) {
    if (gs.selectedRank !== null && gs.rankings.length > 0) gs.confirmingDelete = true;
    return;
  }

  if (isLeaderboardRetry(data)) {
    resetGame(gs);
  }
}

function handleDeadOverlayKeys(data: Buffer, gs: GameState): boolean {
  if (isOpenNameEntry(data)) {
    gs.nameInput = "";
    gs.lastSavedEntry = null;
    gs.pendingFlap = false;
    gs.phase = "name-entry";
    return true;
  }
  if (isOpenLeaderboard(data)) {
    enterLeaderboard(gs);
    return true;
  }
  return false;
}

function onInput(data: Buffer, gs: GameState): void {
  // Ctrl+C always kills the game, regardless of phase — never a literal name char.
  if (data[0] === KEY.CTRL_C) {
    gs.stop();
    return;
  }

  if (gs.phase === "name-entry") {
    handleNameInput(data, gs);
    return;
  }

  if (gs.phase === "leaderboard") {
    handleLeaderboardInput(data, gs);
    return;
  }

  if (gs.phase === "dead" && handleDeadOverlayKeys(data, gs)) return;

  if (isQuit(data)) {
    gs.stop();
    return;
  }

  if (isPause(data)) {
    if (gs.phase === "play") gs.phase = "paused";
    else if (gs.phase === "paused") gs.phase = "play";
    return;
  }

  if (isFlap(data)) {
    if (gs.phase === "paused") gs.phase = "play";
    gs.pendingFlap = true;
  }
}

// ═══════════════════════════════════════════════════════
// Difficulty
// ═══════════════════════════════════════════════════════

function applyDifficulty(gs: GameState): void {
  const t = Math.min(1, gs.score / 30);
  gs.speed = BASE_SPEED + (MAX_SPEED - BASE_SPEED) * (1 - Math.exp(-3 * t));
  gs.gap = Math.max(MIN_GAP, BASE_GAP - Math.floor(gs.score / 10));
}

// ═══════════════════════════════════════════════════════
// Clouds
// ═══════════════════════════════════════════════════════

function randomCloudY(H: number): number {
  return 1 + Math.floor(Math.random() * Math.floor(H * 0.4));
}

function randomCloudW(): number {
  return 3 + Math.floor(Math.random() * 3);
}

function makeCloud(x: number, H: number): Cloud {
  return { x, y: randomCloudY(H), w: randomCloudW() };
}

function initClouds(gs: GameState): void {
  gs.clouds = Array.from({ length: 5 }, () => makeCloud(Math.floor(Math.random() * gs.W), gs.H));
}

function updateClouds(gs: GameState, dt: number): void {
  const speed = gs.speed * 0.25;
  for (const c of gs.clouds) {
    c.x -= speed * dt;
    if (c.x + c.w >= 0) continue;
    c.x = gs.W + Math.floor(Math.random() * 10);
    c.y = randomCloudY(gs.H);
    c.w = randomCloudW();
  }
}

// ═══════════════════════════════════════════════════════
// Game Logic — Pipes
// ═══════════════════════════════════════════════════════

function randomGapY(gs: GameState): number {
  const min = 2;
  const max = gs.H - gs.gap - 2;
  const lastPipe = gs.pipes.at(-1);
  if (!lastPipe) return min + Math.floor(Math.random() * (max - min + 1));
  return Math.max(min, Math.min(max, lastPipe.gapY - 4 + Math.floor(Math.random() * 9)));
}

function spawnPipe(gs: GameState, x: number): void {
  gs.pipes.push({ x, gapY: randomGapY(gs), scored: false });
}

// ═══════════════════════════════════════════════════════
// Game Logic — Physics
// ═══════════════════════════════════════════════════════

function updatePhysics(gs: GameState, dt: number): void {
  gs.bv = Math.min(gs.bv + GRAV * dt, MAX_V);
  gs.by += gs.bv * dt;

  if (gs.by < 0) {
    gs.by = 0;
    gs.bv = 0;
  }
  if (gs.by >= gs.H - 1) die(gs);
}

function scrollPipes(gs: GameState, dt: number): void {
  const dx = gs.speed * dt;
  for (const p of gs.pipes) p.x -= dx;

  while (gs.pipes.length > 0) {
    const first = gs.pipes[0];
    if (!first || first.x + PIPE_W >= -1) break;
    gs.pipes.shift();
    const last = gs.pipes[gs.pipes.length - 1];
    if (last) spawnPipe(gs, last.x + DIST);
  }
}

function checkScoring(gs: GameState): void {
  for (const p of gs.pipes) {
    if (p.scored || p.x + PIPE_W >= gs.birdX) continue;
    p.scored = true;
    gs.score++;
    beep();
    gs.popups.push({ x: Math.round(p.x) + PIPE_W + 1, y: Math.round(gs.by), life: 10 });
  }
}

function checkCollision(gs: GameState): void {
  const bR = gs.birdX + 0.9;
  const bB = gs.by + 0.9;
  for (const p of gs.pipes) {
    const overlapsX = bR > p.x && gs.birdX < p.x + PIPE_W;
    const outsideGap = gs.by < p.gapY || bB >= p.gapY + gs.gap;
    if (overlapsX && outsideGap) {
      die(gs);
      return;
    }
  }
}

function tickPopups(gs: GameState): void {
  gs.popups = gs.popups.filter((p) => {
    p.life--;
    p.y -= 0.3;
    return p.life > 0;
  });
}

// ═══════════════════════════════════════════════════════
// Game Logic — Update
// ═══════════════════════════════════════════════════════

function handleDeadInput(gs: GameState): void {
  if (gs.deadTimer > 0) gs.deadTimer--;
  if (!gs.pendingFlap) return;
  gs.pendingFlap = false;
  if (gs.deadTimer <= 0) resetGame(gs);
}

function handleFlapInput(gs: GameState): boolean {
  if (!gs.pendingFlap) return false;
  gs.pendingFlap = false;
  if (gs.phase === "title") {
    resetGame(gs);
    return true;
  }
  if (gs.phase === "play") gs.bv = FLAP_V;
  return false;
}

function update(gs: GameState, dt: number): void {
  gs.tick++;
  if (gs.phase === "title" || gs.phase === "play") gs.groundTick++;

  if (gs.phase === "dead") {
    handleDeadInput(gs);
    return;
  }
  if (handleFlapInput(gs)) return;
  if (gs.phase !== "play") return;

  applyDifficulty(gs);
  updatePhysics(gs, dt);
  if (gs.phase !== "play") return; // died from ground hit

  scrollPipes(gs, dt);
  checkScoring(gs);
  checkCollision(gs);
  updateClouds(gs, dt);
  tickPopups(gs);
}

function die(gs: GameState): void {
  beep();
  gs.phase = "dead";
  gs.flash = 4;
  gs.deadTimer = 15;
  gs.shake = { frames: 6, intensity: 2 };
  if (gs.score <= gs.best) return;
  gs.best = gs.score;
  saveBest(gs.best);
}

// ═══════════════════════════════════════════════════════
// Rendering — Shared Helpers
// ═══════════════════════════════════════════════════════

function padBox(content: string, width: number): string {
  const inner = width - 2;
  const space = inner - content.length;
  const left = Math.floor(space / 2);
  return "║" + " ".repeat(left) + content + " ".repeat(space - left) + "║";
}

function makeBox(width: number, rows: string[]): string[] {
  const bar = "═".repeat(width - 2);
  return ["╔" + bar + "╗", ...rows.map((r) => padBox(r, width)), "╚" + bar + "╝"];
}

type Row = { text: string; color: string };

function drawBoxed(
  cv: Canvas,
  gs: GameState,
  width: number,
  rows: readonly Row[],
  border: string,
): void {
  const lines = makeBox(
    width,
    rows.map((r) => r.text),
  );
  drawOverlay(cv, gs, lines, (i) => {
    if (i === 0 || i === lines.length - 1) return border;
    return rows[i - 1]?.color ?? COL.white;
  });
}

function drawOverlay(
  cv: Canvas,
  gs: GameState,
  lines: string[],
  colorFn: (lineIdx: number) => string,
): void {
  const bw = lines[0]?.length ?? 0;
  const sx = Math.floor((gs.W - bw) / 2);
  const sy = Math.floor((gs.H - lines.length) / 2) + 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined) writeText(cv, sx, sy + i, line, colorFn(i));
  }
}

// ═══════════════════════════════════════════════════════
// Rendering — Pipes
// ═══════════════════════════════════════════════════════

function drawPipeRow(cv: Canvas, W: number, px: number, cy: number, isLip: boolean): void {
  const start = isLip ? 0 : 1;
  const end = isLip ? PIPE_W : PIPE_W - 1;
  const col = isLip ? COL.pipeCap : COL.pipe;
  const edge = isLip ? COL.pipeCap : COL.pipeE;

  for (let dx = start; dx < end; dx++) {
    const x = px + dx;
    if (x < 0 || x >= W) continue;
    const ch = dx === start ? "▐" : dx === end - 1 ? "▌" : "█";
    sc(cv, x, cy, ch, dx === start || dx === end - 1 ? edge : col);
  }
}

function drawPipes(cv: Canvas, gs: GameState): void {
  for (const p of gs.pipes) {
    const px = Math.round(p.x);
    for (let gy = 0; gy < p.gapY; gy++) drawPipeRow(cv, gs.W, px, gy + 1, gy === p.gapY - 1);
    for (let gy = p.gapY + gs.gap; gy < gs.H; gy++)
      drawPipeRow(cv, gs.W, px, gy + 1, gy === p.gapY + gs.gap);
  }
}

// ═══════════════════════════════════════════════════════
// Rendering — Bird
// ═══════════════════════════════════════════════════════

function getWingChar(gs: GameState): { ch: string; dy: number } {
  const isTitle = gs.phase === "title";
  const sin = isTitle ? Math.sin(gs.tick * 0.16) : 0;
  const up = isTitle ? sin > 0.3 : gs.bv < -2.0;
  const down = isTitle ? sin < -0.3 : gs.bv > 5.0;
  if (up) return { ch: "╱", dy: -1 };
  if (down) return { ch: "╲", dy: 1 };
  return { ch: "─", dy: 0 };
}

function getBirdY(gs: GameState): number {
  if (gs.phase === "title") return Math.round(gs.H / 2 + Math.sin(gs.tick * 0.08) * 2);
  return Math.round(gs.by);
}

function drawBird(cv: Canvas, gs: GameState): void {
  const cy = getBirdY(gs) + 1;
  if (cy < 1 || cy > gs.H) return;

  const wing = getWingChar(gs);
  const wingY = cy + wing.dy;
  if (wingY >= 1 && wingY <= gs.H) sc(cv, gs.birdX - 1, wingY, wing.ch, COL.wing);

  const isDead = gs.phase === "dead" || gs.phase === "name-entry" || gs.phase === "leaderboard";
  scWide(cv, gs.birdX, cy, isDead ? "💀" : "🍪", isDead ? COL.dead : COL.bird);
  sc(cv, gs.birdX + 2, cy, "▸", COL.beak);
}

// ═══════════════════════════════════════════════════════
// Rendering — Ground, Clouds, Popups
// ═══════════════════════════════════════════════════════

function drawGround(cv: Canvas, gs: GameState): void {
  const gy = gs.H + 1;
  const pat = "▓▒░▒";
  for (let x = 0; x < gs.W; x++) {
    sc(cv, x, gy, pat.charAt((x + gs.groundTick) % pat.length), COL.grass);
    sc(cv, x, gy + 1, "░", COL.dirt);
  }
}

function drawClouds(cv: Canvas, gs: GameState): void {
  for (const c of gs.clouds) {
    const cx = Math.round(c.x);
    for (let i = 0; i < c.w; i++) {
      const x = cx + i;
      if (x < 0 || x >= gs.W) continue;
      sc(cv, x, Math.round(c.y), i === 0 || i === c.w - 1 ? "░" : "▓", COL.cloud);
    }
  }
}

function drawPopups(cv: Canvas, gs: GameState): void {
  for (const p of gs.popups) {
    const py = Math.round(p.y) + 1;
    if (py > 0 && py < gs.frameH) writeText(cv, p.x, py, "+1", COL.popup);
  }
}

// ═══════════════════════════════════════════════════════
// Rendering — HUD
// ═══════════════════════════════════════════════════════

function drawHud(cv: Canvas, gs: GameState): void {
  if (gs.phase === "play" || gs.phase === "paused") {
    const pct = Math.min(1, (gs.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED));
    const filled = Math.round(pct * 5);
    writeText(cv, 2, 0, `Spd ${"█".repeat(filled)}${"░".repeat(5 - filled)}`, COL.dim);
  }

  const scoreText = `Score: ${gs.score}`;
  const bestText = gs.best > 0 ? `★ Best: ${gs.best}` : "";
  const gap = bestText ? "  " : "";
  const xRight = gs.W - (scoreText.length + gap.length + bestText.length) - 2;
  writeText(cv, xRight, 0, scoreText, COL.white + ansi.bold);
  if (bestText)
    writeText(cv, xRight + scoreText.length + gap.length, 0, bestText, COL.title + ansi.bold);
}

// ═══════════════════════════════════════════════════════
// Rendering — Title, Pause, Dead
// ═══════════════════════════════════════════════════════

function drawTitle(cv: Canvas, gs: GameState): void {
  const lines = makeBox(24, ["", "     Clerk Bird     ", ""]);
  const boxY = Math.floor(gs.H / 2) - 2;

  drawOverlay(cv, gs, lines, () => COL.pipe + ansi.bold);

  if (gs.tick % 50 < 35) {
    const prompt = "Press SPACE or ↑";
    writeText(cv, Math.floor((gs.W - prompt.length) / 2), boxY + 6, prompt, COL.white);
  }
  writeText(cv, Math.floor((gs.W - 17) / 2), boxY + 8, "P: Pause  Q: Quit", COL.dim);
}

function drawPause(cv: Canvas, gs: GameState): void {
  const lines = makeBox(20, ["PAUSED", "", "P to resume", "Q to quit"]);
  drawOverlay(cv, gs, lines, (i) => (i === 1 ? COL.pause + ansi.bold : COL.white));
}

function drawDead(cv: Canvas, gs: GameState): void {
  const isNew = gs.score === gs.best && gs.score > 0;
  const rows: Row[] = [
    { text: "GAME  OVER", color: COL.dead + ansi.bold },
    { text: "", color: COL.white },
    { text: `Score: ${gs.score}`, color: COL.white },
    { text: isNew ? "★ NEW BEST! ★" : `Best: ${gs.best}`, color: isNew ? COL.title : COL.white },
    { text: "", color: COL.white },
    { text: "SPACE to retry", color: COL.white },
    { text: "Q to quit", color: COL.white },
    { text: "N submit name", color: COL.dim },
    { text: "L leaderboard", color: COL.dim },
  ];
  drawBoxed(cv, gs, 22, rows, COL.white);
}

function drawNameEntry(cv: Canvas, gs: GameState): void {
  const showCursor = gs.tick % 30 < 15 && gs.nameInput.length < MAX_NAME_LEN;
  const display = (gs.nameInput + (showCursor ? "▏" : "")).padEnd(MAX_NAME_LEN, " ");
  const frameMid = "│ " + display + " │";

  const rows: Row[] = [
    { text: "", color: COL.white },
    { text: "Save your score?", color: COL.title + ansi.bold },
    { text: "", color: COL.white },
    { text: `Score: ${gs.score}`, color: COL.white + ansi.bold },
    { text: "", color: COL.white },
    { text: NAME_FRAME_TOP, color: COL.pause },
    { text: frameMid, color: COL.pause },
    { text: NAME_FRAME_BOT, color: COL.pause },
    { text: "", color: COL.white },
    { text: "ENTER save · ESC skip", color: COL.dim },
    { text: "", color: COL.white },
  ];

  drawBoxed(cv, gs, 34, rows, COL.pipe + ansi.bold);
}

function leaderboardRow(
  prefix: string,
  rank: string,
  name: string,
  score: string,
  marker: string,
): string {
  return `${prefix} ${rank.padStart(2)}  ${name.padEnd(MAX_NAME_LEN)} ${score.padStart(5)}  ${marker}`;
}

function drawLeaderboard(cv: Canvas, gs: GameState): void {
  const header = leaderboardRow(" ", "#", "NAME", "SCORE", "   ");
  const sep = "  ──  ────────────  ─────     ";

  const newRank = newRankOf(gs);
  const empty = gs.rankings.length === 0;

  const rows: Row[] = [
    { text: "", color: COL.white },
    { text: "★ TOP CLERK BIRDS ★", color: COL.title + ansi.bold },
    { text: "", color: COL.white },
  ];

  if (empty) {
    rows.push(
      { text: "No scores yet.", color: COL.dim },
      { text: "Press N on the dead screen", color: COL.dim },
      { text: "to enter one.", color: COL.dim },
    );
  } else {
    rows.push({ text: header, color: COL.dim }, { text: sep, color: COL.dim });
    for (let i = 0; i < gs.rankings.length && i < MAX_RANKINGS; i++) {
      const entry = gs.rankings[i];
      if (!entry) continue;
      const rank = i + 1;
      const isSelected = gs.selectedRank === rank;
      const isNew = newRank === rank;
      rows.push({
        text: leaderboardRow(
          isSelected ? "▶" : " ",
          String(rank),
          entry.name,
          String(entry.score),
          isNew ? "NEW" : "   ",
        ),
        color: isSelected || isNew ? COL.title + ansi.bold : COL.white,
      });
    }
  }

  rows.push({ text: "", color: COL.white });

  const sel =
    gs.confirmingDelete && gs.selectedRank !== null ? gs.rankings[gs.selectedRank - 1] : null;
  if (sel) {
    rows.push(
      { text: `Delete "${sel.name}" (${sel.score})?`, color: COL.dead + ansi.bold },
      { text: "Y confirm · N cancel", color: COL.dim },
    );
  } else if (empty) {
    rows.push({ text: "SPACE retry · Q quit", color: COL.dim });
  } else {
    rows.push(
      { text: "↑↓/jk select · D delete", color: COL.dim },
      { text: "SPACE retry · Q quit", color: COL.dim },
    );
  }

  rows.push({ text: "", color: COL.white });

  drawBoxed(cv, gs, 40, rows, COL.pipe + ansi.bold);
}

// ═══════════════════════════════════════════════════════
// Screen Shake
// ═══════════════════════════════════════════════════════

function applyFlash(cv: Canvas, gs: GameState): void {
  if (gs.flash <= 0) return;
  gs.flash--;
  if (gs.flash % 2 !== 0) return;
  for (let y = 1; y <= gs.H; y++) {
    const row = cv[y];
    if (!row) continue;
    for (let x = 0; x < gs.W; x++) {
      const cell = row[x];
      if (cell && cell.ch !== " ") cell.fg = COL.white;
    }
  }
}

function applyShake(cv: Canvas, gs: GameState): Canvas {
  if (gs.shake.frames <= 0) return cv;

  gs.shake.frames--;
  const mag = gs.shake.intensity;
  gs.shake.intensity *= 0.7;
  const sx = Math.round((Math.random() - 0.5) * mag * 2);
  const sy = Math.round((Math.random() - 0.5) * mag);
  if (sx === 0 && sy === 0) return cv;

  const cols = cv[0]?.length ?? 0;
  const out = mkCanvas(cv.length, cols);
  for (let y = 0; y < cv.length; y++) {
    const srcRow = cv[y];
    const dstRow = out[y + sy];
    if (!srcRow || !dstRow) continue;
    for (let x = 0; x < cols; x++) {
      const nx = x + sx;
      if (nx < 0 || nx >= cols) continue;
      const src = srcRow[x];
      const dst = dstRow[nx];
      if (src && dst) {
        dst.ch = src.ch;
        dst.fg = src.fg;
      }
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════
// Main Render
// ═══════════════════════════════════════════════════════

const PHASE_OVERLAYS: Record<string, (cv: Canvas, gs: GameState) => void> = {
  title: drawTitle,
  paused: drawPause,
  dead: drawDead,
  "name-entry": drawNameEntry,
  leaderboard: drawLeaderboard,
};

function render(cv: Canvas, gs: GameState): void {
  clearCanvas(cv);

  drawClouds(cv, gs);
  drawPipes(cv, gs);
  drawBird(cv, gs);
  drawGround(cv, gs);
  drawHud(cv, gs);
  drawPopups(cv, gs);

  PHASE_OVERLAYS[gs.phase]?.(cv, gs);
  applyFlash(cv, gs);
  const out = applyShake(cv, gs);

  process.stdout.write(ansi.home + canvasStr(out, gs.offsetX));
}

// ═══════════════════════════════════════════════════════
// Game Loop
// ═══════════════════════════════════════════════════════

export async function startFlap2(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "clerk-bird requires an interactive terminal (stdin and stdout must be a TTY).",
    );
  }

  const layout = computeLayout();
  if (!layout) {
    throw new Error(`Terminal too small (need ${MIN_COLS}x${MIN_ROWS}). Resize and try again.`);
  }

  const [best, rankings] = await Promise.all([loadBest(), loadRankings()]);
  const gs = makeState(layout.W, layout.H, layout.offsetX, best, rankings);
  const cv = mkCanvas(gs.frameH, gs.W);

  return new Promise<void>((resolve, reject) => {
    let interval: ReturnType<typeof setInterval> | null = null;

    const teardown = () => {
      if (interval) clearInterval(interval);
      interval = null;
      process.stdin.removeAllListeners("data");
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(ansi.show + ansi.reset + ansi.altExit);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("uncaughtException", onException);
    };

    const stop = () => {
      if (gs.stopped) return;
      gs.stopped = true;
      teardown();
      printFarewell();
      resolve();
    };

    const onSignal = () => stop();
    const onException = (err: Error) => {
      if (gs.stopped) return;
      gs.stopped = true;
      teardown();
      reject(err);
    };

    gs.stop = stop;

    process.stdout.write(ansi.altEnter + ansi.clear + ansi.hide);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data: Buffer) => onInput(data, gs));

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("uncaughtException", onException);

    let lastTime = performance.now();
    let accumulator = 0;
    const dt = TICK_MS / 1000;

    interval = setInterval(() => {
      const now = performance.now();
      accumulator += now - lastTime;
      lastTime = now;

      if (accumulator > TICK_MS * 5) accumulator = TICK_MS * 5;

      while (accumulator >= TICK_MS) {
        update(gs, dt);
        if (
          gs.phase === "title" ||
          gs.phase === "dead" ||
          gs.phase === "name-entry" ||
          gs.phase === "leaderboard"
        ) {
          updateClouds(gs, dt);
        }
        accumulator -= TICK_MS;
      }

      render(cv, gs);
    }, TICK_MS);
  });
}
