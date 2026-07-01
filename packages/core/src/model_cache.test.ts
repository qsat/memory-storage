import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// A fake embedder that returns a valid 768-d vector so put() can insert.
const FAKE_VEC = Array.from({ length: 768 }, (_, i) => (i % 13) / 13);
vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => async () => ({ tolist: () => [FAKE_VEC] })),
  env: {},
}));

// Reset module state so MODEL_CACHE_DIR is recomputed from env on each import.
async function loadWith(
  cache: string | undefined
): Promise<typeof import("./index.js")> {
  vi.resetModules();
  if (cache === undefined) delete process.env.MEMORY_MODEL_CACHE;
  else process.env.MEMORY_MODEL_CACHE = cache;
  return import("./index.js");
}

describe("resolveUserPath", () => {
  const origInitCwd = process.env.INIT_CWD;
  const origCache = process.env.MEMORY_MODEL_CACHE;

  afterEach(() => {
    if (origInitCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = origInitCwd;
    if (origCache === undefined) delete process.env.MEMORY_MODEL_CACHE;
    else process.env.MEMORY_MODEL_CACHE = origCache;
  });

  it("expands ~ to the home directory", async () => {
    const { resolveUserPath } = await loadWith(undefined);
    expect(resolveUserPath("~")).toBe(os.homedir());
    expect(resolveUserPath("~/foo/bar")).toBe(
      path.join(os.homedir(), "foo/bar")
    );
  });

  it("returns absolute paths unchanged", async () => {
    const { resolveUserPath } = await loadWith(undefined);
    const abs = path.join(os.tmpdir(), "abs-path");
    expect(resolveUserPath(abs)).toBe(abs);
  });

  it("resolves relative paths against INIT_CWD when set", async () => {
    const { resolveUserPath } = await loadWith(undefined);
    process.env.INIT_CWD = "/some/where";
    expect(resolveUserPath("models")).toBe(path.resolve("/some/where", "models"));
  });

  it("falls back to process.cwd() when INIT_CWD is unset", async () => {
    const { resolveUserPath } = await loadWith(undefined);
    delete process.env.INIT_CWD;
    expect(resolveUserPath("models")).toBe(path.resolve(process.cwd(), "models"));
  });
});

describe("MODEL_CACHE_DIR", () => {
  const origCache = process.env.MEMORY_MODEL_CACHE;
  afterEach(() => {
    if (origCache === undefined) delete process.env.MEMORY_MODEL_CACHE;
    else process.env.MEMORY_MODEL_CACHE = origCache;
  });

  it("defaults to ~/.cache/memory-storage", async () => {
    const { MODEL_CACHE_DIR } = await loadWith(undefined);
    expect(MODEL_CACHE_DIR).toBe(
      path.join(os.homedir(), ".cache", "memory-storage")
    );
  });

  it("honors an absolute override", async () => {
    const abs = path.join(os.tmpdir(), "explicit-cache");
    const { MODEL_CACHE_DIR } = await loadWith(abs);
    expect(MODEL_CACHE_DIR).toBe(abs);
  });
});

describe("cache directory creation guard", () => {
  const origCache = process.env.MEMORY_MODEL_CACHE;
  const cleanup: string[] = [];

  afterEach(() => {
    if (origCache === undefined) delete process.env.MEMORY_MODEL_CACHE;
    else process.env.MEMORY_MODEL_CACHE = origCache;
    for (const p of cleanup.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });

  it("errors when a non-~/.cache dir does not exist (no auto-create)", async () => {
    const missing = path.join(os.tmpdir(), `memstore-missing-${Date.now()}`, "sub");
    cleanup.push(path.dirname(missing));
    const { MemoryStore } = await loadWith(missing);
    const store = new MemoryStore(":memory:");
    await expect(store.put("x", { content: "hello" })).rejects.toThrow(
      /does not exist|Refusing to create/
    );
    expect(fs.existsSync(missing)).toBe(false);
    store.close();
  });

  it("allows an existing non-~/.cache dir", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memstore-exists-"));
    cleanup.push(dir);
    const { MemoryStore } = await loadWith(dir);
    const store = new MemoryStore(":memory:");
    // Reaches the (mocked) model load and succeeds — no guard error.
    const { id } = await store.put("x", { content: "hello" });
    expect(id).toBeTruthy();
    store.close();
  });

  it("auto-creates a dir under ~/.cache", async () => {
    const dir = path.join(os.homedir(), ".cache", `memory-storage-test-${Date.now()}`);
    cleanup.push(dir);
    expect(fs.existsSync(dir)).toBe(false);
    const { MemoryStore } = await loadWith(dir);
    const store = new MemoryStore(":memory:");
    const { id } = await store.put("x", { content: "hello" });
    expect(id).toBeTruthy();
    expect(fs.existsSync(dir)).toBe(true);
    store.close();
  });

  it("passes the registered onModelProgress callback to the model loader", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memstore-prog-"));
    cleanup.push(dir);
    const mod = await loadWith(dir);
    const transformers = await import("@huggingface/transformers");
    const cb = vi.fn();
    mod.onModelProgress(cb);
    const store = new mod.MemoryStore(":memory:");
    await store.put("x", { content: "hello" });
    expect(transformers.pipeline).toHaveBeenCalledWith(
      "feature-extraction",
      expect.any(String),
      expect.objectContaining({ progress_callback: cb })
    );
    store.close();
  });

  it("does not require the cache dir for read-only commands (lazy guard)", async () => {
    const missing = path.join(os.tmpdir(), `memstore-lazy-${Date.now()}`);
    cleanup.push(missing);
    const { MemoryStore } = await loadWith(missing);
    const store = new MemoryStore(":memory:");
    // No embedding → guard never runs.
    expect(store.getHistory("nothing")).toEqual([]);
    expect(fs.existsSync(missing)).toBe(false);
    store.close();
  });
});
