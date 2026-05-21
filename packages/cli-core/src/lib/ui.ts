import type { Writable } from "node:stream";
import { log as clackLog } from "@clack/prompts";

type LogOptions = Parameters<typeof clackLog.message>[1];

let outputStream: Writable | undefined;

export function setUiOutput(stream: Writable | undefined) {
  outputStream = stream;
}

export function getUiOutput(): Writable | undefined {
  return outputStream;
}

function withOutput<T extends LogOptions>(opts?: T): T {
  return { ...opts, output: opts?.output ?? outputStream } as T;
}

export const ui = {
  message(msg?: string | string[], opts?: LogOptions) {
    clackLog.message(msg, withOutput(opts));
  },
  info(msg: string, opts?: LogOptions) {
    clackLog.info(msg, withOutput(opts));
  },
  success(msg: string, opts?: LogOptions) {
    clackLog.success(msg, withOutput(opts));
  },
  warn(msg: string, opts?: LogOptions) {
    clackLog.warn(msg, withOutput(opts));
  },
  error(msg: string, opts?: LogOptions) {
    clackLog.error(msg, withOutput(opts));
  },
  step(msg: string, opts?: LogOptions) {
    clackLog.step(msg, withOutput(opts));
  },
};
