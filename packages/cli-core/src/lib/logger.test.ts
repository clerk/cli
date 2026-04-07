import { test, expect, spyOn } from "bun:test";
import { logger } from "./logger.ts";
import { log } from "./log.ts";

test("logger.info routes to log.info", () => {
  const spy = spyOn(log, "info").mockImplementation(() => {});
  try {
    logger.info("hello info");
    expect(spy).toHaveBeenCalledWith("hello info");
  } finally {
    spy.mockRestore();
  }
});

test("logger.success routes to log.success", () => {
  const spy = spyOn(log, "success").mockImplementation(() => {});
  try {
    logger.success("done");
    expect(spy).toHaveBeenCalledWith("done");
  } finally {
    spy.mockRestore();
  }
});

test("logger.warn routes to log.warn", () => {
  const spy = spyOn(log, "warn").mockImplementation(() => {});
  try {
    logger.warn("hello warn");
    expect(spy).toHaveBeenCalledWith("hello warn");
  } finally {
    spy.mockRestore();
  }
});

test("logger.error routes to log.error", () => {
  const spy = spyOn(log, "error").mockImplementation(() => {});
  try {
    logger.error("hello error");
    expect(spy).toHaveBeenCalledWith("hello error");
  } finally {
    spy.mockRestore();
  }
});

test("logger.debug routes to log.debug", () => {
  const spy = spyOn(log, "debug").mockImplementation(() => {});
  try {
    logger.debug("debugging");
    expect(spy).toHaveBeenCalledWith("debugging");
  } finally {
    spy.mockRestore();
  }
});

test("logger.data routes to log.data (stdout)", () => {
  const spy = spyOn(log, "data").mockImplementation(() => {});
  try {
    logger.data("pipeable");
    expect(spy).toHaveBeenCalledWith("pipeable");
  } finally {
    spy.mockRestore();
  }
});

test("logger.raw routes to log.raw", () => {
  const spy = spyOn(log, "raw").mockImplementation(() => {});
  try {
    logger.raw('{"ok":true}');
    expect(spy).toHaveBeenCalledWith('{"ok":true}');
  } finally {
    spy.mockRestore();
  }
});

test("logger.blank routes to log.blank", () => {
  const spy = spyOn(log, "blank").mockImplementation(() => {});
  try {
    logger.blank();
    expect(spy).toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
