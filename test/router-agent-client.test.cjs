const test = require("node:test");
const assert = require("node:assert/strict");

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

test("agent reports local tool failures instead of leaving the router to time out", async () => {
  const { AgentClient } = await import("../dist/routing/agent-client.js");
  const { RouterError } = await import("../dist/routing/types.js");
  const originalFetch = global.fetch;
  const originalWrite = process.stderr.write;
  let responseBody;
  let log = "";
  let pollCount = 0;

  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/agent/v1/poll")) {
      pollCount += 1;
      if (pollCount === 1) {
        return {
          ok: true,
          async json() {
            return {
              request: {
                correlationId: "correlation-1",
                seq: 7,
                tool: "start_process",
                args: { command: "open -a Safari" },
                owner: { userKey: "issuer|user", agentId: "agent-1" },
              },
            };
          },
        };
      }
      return new Promise(() => {});
    }
    if (String(url).endsWith("/agent/v1/respond")) {
      responseBody = JSON.parse(options.body);
      return { ok: true };
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  process.stderr.write = (chunk) => {
    log += String(chunk);
    return true;
  };

  const client = new AgentClient({
    baseUrl: "http://router.example",
    credentialId: "credential-id",
    secret: "credential-secret",
    maxBackoffMs: 1,
    agent: {
      async handle() {
        throw new RouterError("policy_denied", "Command not in allowlist: open", "correlation-1");
      },
    },
  });

  try {
    void client.run();
    await waitFor(() => responseBody !== undefined);
    assert.deepEqual(responseBody, {
      correlationId: "correlation-1",
      sequence: 7,
      result: {
        correlationId: "correlation-1",
        error: { code: "policy_denied", message: "Command not in allowlist: open" },
      },
    });
    assert.match(log, /tool=start_process/);
    assert.match(log, /correlationId=correlation-1/);
    assert.match(log, /code=policy_denied/);
    assert.match(log, /Command not in allowlist: open/);
    assert.doesNotMatch(log, /credential-secret/);
  } finally {
    client.stop();
    global.fetch = originalFetch;
    process.stderr.write = originalWrite;
  }
});
