import { AsyncLocalStorage } from 'node:async_hooks';

const uiOriginCallContext = new AsyncLocalStorage<boolean>();

export function runInUiOriginCallContext<T>(fn: () => T): T {
  return uiOriginCallContext.run(true, fn);
}

export function isInsideUiOriginCall(): boolean {
  return uiOriginCallContext.getStore() === true;
}

// Compatibility no-op. Runtime has no telemetry or remote analytics channel.
export async function capture(_event: string, _properties?: unknown): Promise<void> {}

export const capture_call_tool = capture;
export const capture_ui_event = capture;
export const captureRemote = capture;
