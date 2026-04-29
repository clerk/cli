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
  ESC: 27,
  CTRL_C: 3,
  ARROW_UP_SEQ: [27, 91, 65] as const,
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
type Phase = "title" | "play" | "paused" | "dead";

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
}

function makeState(W: number, H: number, offsetX: number, best: number): GameState {
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

function isFlap(data: Buffer): boolean {
  const k = data[0];
  if (k === KEY.SPACE || k === KEY.ENTER || k === KEY.W_LOWER || k === KEY.W_UPPER) return true;
  const [a, b, c] = KEY.ARROW_UP_SEQ;
  return data.length >= 3 && k === a && data[1] === b && data[2] === c;
}

function isPause(data: Buffer): boolean {
  const k = data[0];
  return k === KEY.P_LOWER || k === KEY.P_UPPER || (k === KEY.ESC && data.length === 1);
}

function isQuit(data: Buffer): boolean {
  const k = data[0];
  return k === KEY.Q_LOWER || k === KEY.Q_UPPER || k === KEY.CTRL_C;
}

function onInput(data: Buffer, gs: GameState): void {
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

  const isDead = gs.phase === "dead";
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
  writeText(cv, 2, 0, `Score: ${gs.score}`, COL.white + ansi.bold);

  if (gs.phase === "play" || gs.phase === "paused") {
    const pct = Math.min(1, (gs.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED));
    const filled = Math.round(pct * 5);
    const label = `Spd ${"█".repeat(filled)}${"░".repeat(5 - filled)}`;
    writeText(cv, Math.floor((gs.W - label.length) / 2), 0, label, COL.dim);
  }

  if (gs.best > 0) {
    const text = `★ Best: ${gs.best}`;
    writeText(cv, gs.W - text.length - 2, 0, text, COL.title + ansi.bold);
  }
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
  const bestLine = isNew ? "★ NEW BEST! ★" : `Best: ${gs.best}`;
  const lines = makeBox(22, [
    "GAME  OVER",
    "",
    `Score: ${gs.score}`,
    bestLine,
    "",
    "SPACE to retry",
    "Q to quit",
  ]);
  drawOverlay(cv, gs, lines, (i) => {
    if (i === 1) return COL.dead + ansi.bold;
    if (i === 4 && isNew) return COL.title;
    return COL.white;
  });
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
  if (!process.stdin.isTTY) {
    throw new Error("clerk-bird requires an interactive terminal.");
  }

  const layout = computeLayout();
  if (!layout) {
    throw new Error(`Terminal too small (need ${MIN_COLS}x${MIN_ROWS}). Resize and try again.`);
  }

  const best = await loadBest();
  const gs = makeState(layout.W, layout.H, layout.offsetX, best);
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
        if (gs.phase === "title" || gs.phase === "dead") updateClouds(gs, dt);
        accumulator -= TICK_MS;
      }

      render(cv, gs);
    }, TICK_MS);
  });
}
