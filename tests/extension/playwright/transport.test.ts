import test from "node:test";
import assert from "node:assert/strict";
import { CrxTransport } from "../../../src/extension/playwright/transport.js";

function fixture(t: { after(fn: () => void): void }) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const events = new Set<Function>(),
    detaches = new Set<Function>();
  const calls: string[] = [];
  const commands: Array<{ target: unknown; method: string; params: unknown }> = [];
  let block: string | undefined, attachGate: Promise<void> | undefined;
  let failure: { method: string; error: Error } | undefined;
  const event = (listeners: Set<Function>) => ({
    addListener: (fn: Function) => listeners.add(fn),
    removeListener: (fn: Function) => listeners.delete(fn),
  });
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      debugger: {
        onEvent: event(events),
        onDetach: event(detaches),
        attach: async () => {
          calls.push("attach");
          await attachGate;
        },
        detach: async () => {
          calls.push("detach");
        },
        sendCommand: async (target: unknown, method: string, params?: unknown) => {
          calls.push(method);
          commands.push({ target, method, params });
          if (failure?.method === method) throw failure.error;
          if (method === block) return new Promise(() => {});
          return {};
        },
      },
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else Reflect.deleteProperty(globalThis, "chrome");
  });
  return {
    calls,
    commands,
    events,
    detaches,
    block: (method: string) => (block = method),
    fail: (method: string, error: Error) => (failure = { method, error }),
    attachGate: (gate: Promise<void>) => (attachGate = gate),
    disconnected: () => [...detaches].forEach((fn) => fn({ tabId: 7 })),
  };
}

test("CRX attaches once and detach leaves no listeners or pending operations", async (t) => {
  const f = fixture(t),
    transport = new CrxTransport(7, new AbortController().signal);
  await transport.attach();
  assert.deepEqual(f.commands.slice(0, 3), [
    { target: { tabId: 7 }, method: "Page.enable", params: undefined },
    { target: { tabId: 7 }, method: "Runtime.enable", params: undefined },
    { target: { tabId: 7 }, method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
  ]);
  await transport.send("Input.insertText", { text: "hello" });
  await transport.detach();
  await transport.detach();
  assert.equal(f.calls.filter((x) => x === "attach").length, 1);
  assert.equal(f.calls.filter((x) => x === "detach").length, 1);
  assert.equal(f.events.size + f.detaches.size, 0);
});

test("CRX releases the debugger if background activity initialization fails; no DOM action or retry", async (t) => {
  const f = fixture(t), transport = new CrxTransport(7, new AbortController().signal);
  f.fail("Emulation.setFocusEmulationEnabled", Error("Focus initialization failed"));
  await assert.rejects(transport.attach(), /Focus initialization failed/);
  assert.equal(f.calls.filter(method => method === "attach").length, 1);
  assert.equal(f.calls.filter(method => method === "detach").length, 1);
  assert.equal(f.calls.some(method => /^(?:Runtime.evaluate|Input\.)/.test(method)), false);
  assert.equal(f.events.size + f.detaches.size, 0);
});

test("CRX debugger disconnect rejects an in-flight command without reconnect or retry", async (t) => {
  const f = fixture(t),
    transport = new CrxTransport(7, new AbortController().signal);
  await transport.attach();
  f.block("Input.dispatchMouseEvent");
  const command = transport.send("Input.dispatchMouseEvent");
  f.disconnected();
  await assert.rejects(command, { code: "outcome_unknown" });
  await assert.rejects(transport.send("Input.dispatchMouseEvent"), {
    code: "outcome_unknown",
  });
  assert.equal(
    f.calls.filter((x) => x === "Input.dispatchMouseEvent").length,
    1,
  );
  assert.equal(f.calls.filter((x) => x === "attach").length, 1);
  assert.equal(f.events.size + f.detaches.size, 0);
});

test("CRX abort during command detaches once and does not issue another input", async (t) => {
  const f = fixture(t),
    controller = new AbortController(),
    transport = new CrxTransport(7, controller.signal);
  await transport.attach();
  f.block("Runtime.evaluate");
  const command = transport.send("Runtime.evaluate");
  controller.abort();
  await assert.rejects(command, { name: "AbortError" });
  await transport.detach();
  assert.equal(f.calls.filter((x) => x === "detach").length, 1);
  assert.equal(f.events.size + f.detaches.size, 0);
});

test("CRX abort before attach never touches the debugger", async (t) => {
  const f = fixture(t),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(new CrxTransport(7, controller.signal).attach(), {
    name: "AbortError",
  });
  assert.equal(f.calls.length, 0);
});

test("CRX normalizes a command detached mid-flight even without an onDetach event", async (t) => {
  const f = fixture(t);
  const transport = new CrxTransport(7, new AbortController().signal);
  await transport.attach();
  f.fail("Runtime.evaluate", Error("Detached while handling command."));
  await assert.rejects(transport.send("Runtime.evaluate"), { code: "outcome_unknown" });
  await assert.rejects(transport.send("Runtime.evaluate"), { code: "outcome_unknown" });
  assert.equal(f.calls.filter((method) => method === "Runtime.evaluate").length, 1);
  assert.equal(f.events.size + f.detaches.size, 0);
});

test("CRX abort during attach releases the late debugger connection", async (t) => {
  const f = fixture(t),
    controller = new AbortController();
  let release!: () => void;
  f.attachGate(new Promise<void>((resolve) => (release = resolve)));
  const transport = new CrxTransport(7, controller.signal),
    pending = transport.attach();
  controller.abort();
  release();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(f.calls, ["attach", "detach"]);
  assert.equal(f.events.size + f.detaches.size, 0);
});
