import test from "node:test";
import assert from "node:assert/strict";

const { GrokCliExecutor } = await import("@omniroute/open-sse/executors/grok-cli");

function setVersion(t: { after: (fn: () => void) => void }, value: string) {
  const previous = process.env.GROK_CLI_VERSION;
  t.after(() => {
    if (previous === undefined) delete process.env.GROK_CLI_VERSION;
    else process.env.GROK_CLI_VERSION = previous;
  });
  process.env.GROK_CLI_VERSION = value;
}

test("Grok Build sends current CLIProxyAPI identity headers and preserves auth/content negotiation", (t) => {
  setVersion(t, "");
  const executor = new GrokCliExecutor();
  const headers = executor.buildHeaders({ accessToken: "test-oauth" }, true);
  assert.equal(headers["x-grok-client-version"], "1.0.46");
  assert.equal(headers["User-Agent"], "xai-grok-workspace/1.0.46");
  assert.equal(headers["x-grok-client-identifier"], "grok-shell");
  assert.equal(headers["X-XAI-Token-Auth"], "xai-grok-cli");
  assert.equal(headers["x-authenticateresponse"], "authenticate-response");
  assert.equal(headers.Authorization, "Bearer test-oauth");
  assert.equal(headers.Accept, "text/event-stream");
  assert.equal(
    executor.buildHeaders({ apiKey: "test-api" }, false).Authorization,
    "Bearer test-api"
  );
  assert.equal(executor.buildHeaders({}, false).Accept, "application/json");
  assert.equal(executor.buildHeaders({}, false).Authorization, undefined);
});

test("Grok CLI version override keeps the version and User-Agent synchronized", (t) => {
  setVersion(t, " 1.0.47 ");
  const headers = new GrokCliExecutor().buildHeaders({});
  assert.equal(headers["x-grok-client-version"], "1.0.47");
  assert.equal(headers["User-Agent"], "xai-grok-workspace/1.0.47");
});

test("Grok CLI rejects obsolete or unsafe operator version overrides", (t) => {
  setVersion(t, "");
  const executor = new GrokCliExecutor();
  for (const version of [
    "0.2.72",
    "1.0.12",
    "1.0.50-alpha",
    "1.2",
    "01.2.3",
    "1.0.46\r\nInjected: yes",
    "99999999999999999999.0.0",
  ]) {
    process.env.GROK_CLI_VERSION = version;
    assert.throws(() => executor.buildHeaders({}), /GROK_CLI_VERSION/);
  }
  for (const version of ["1.0.13", "1.1.0", "2.0.0"]) {
    process.env.GROK_CLI_VERSION = version;
    assert.equal(executor.buildHeaders({})["x-grok-client-version"], version);
  }
});
