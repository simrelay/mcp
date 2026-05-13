import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { SimRelayApiError, SimRelayClient } from "../src/simrelay-client.js";

const fakeTokens = {
  getAccessToken: async () => "test-token",
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[] = [];
let respond: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = ((input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(input as RequestInfo | URL, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SimRelayClient", () => {
  it("listSims hits /api/sims with bearer token and normalizes", async () => {
    respond = async () =>
      jsonResponse({
        data: [
          { id: 1, seven_system_number: "+491", status: "active", country: "DE" },
          { id: 2, seven_system_number: "+442", status: "locked", country: "GB" },
        ],
      });
    const client = new SimRelayClient("https://simrelay.com", fakeTokens as never);
    const { sims } = await client.listSims();
    assert.equal(calls[0]!.url, "https://simrelay.com/api/sims");
    assert.equal((calls[0]!.init.headers as Headers).get("authorization"), "Bearer test-token");
    assert.equal(sims.length, 2);
    assert.equal(sims[0]!.phone_number, "+491");
    assert.equal(sims[1]!.country, "GB");
  });

  it("lockSim posts to /api/sims/{id}/lock", async () => {
    respond = async () => jsonResponse({ expires_at: "2026-05-12T11:00:00Z" });
    const client = new SimRelayClient("https://simrelay.com", fakeTokens as never);
    await client.lockSim(42);
    assert.equal(calls[0]!.url, "https://simrelay.com/api/sims/42/lock");
    assert.equal(calls[0]!.init.method, "POST");
  });

  it("releaseSimLock sends DELETE", async () => {
    respond = async () => new Response("", { status: 200 });
    const client = new SimRelayClient("https://simrelay.com", fakeTokens as never);
    await client.releaseSimLock(42);
    assert.equal(calls[0]!.init.method, "DELETE");
    assert.equal(calls[0]!.url, "https://simrelay.com/api/sims/42/lock");
  });

  it("getMessages serializes page + per_page query", async () => {
    respond = async () =>
      jsonResponse({
        data: [{ id: 100, hosted_sim_id: 42, text: "hi", direction: "inbound" }],
        meta: { current_page: 2, per_page: 5, total: 17, last_page: 4 },
      });
    const client = new SimRelayClient("https://simrelay.com", fakeTokens as never);
    const result = await client.getMessages(42, { page: 2, per_page: 5 });
    assert.equal(
      calls[0]!.url,
      "https://simrelay.com/api/sims/42/messages?page=2&per_page=5",
    );
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.direction, "in");
    assert.deepEqual(result.pagination, { page: 2, per_page: 5, total: 17, last_page: 4 });
  });

  it("getCurrentUser unwraps {data: {...}} envelopes", async () => {
    respond = async () =>
      jsonResponse({ data: { id: 7, name: "alice" } });
    const client = new SimRelayClient("https://simrelay.com", fakeTokens as never);
    const { id } = await client.getCurrentUser();
    assert.equal(id, 7);
  });

  it("getCurrentUser unwraps {user: {...}} envelopes", async () => {
    respond = async () =>
      jsonResponse({ user: { id: 9, name: "bob" } });
    const client = new SimRelayClient("https://simrelay.com", fakeTokens as never);
    const { id } = await client.getCurrentUser();
    assert.equal(id, 9);
  });

  it("getCurrentUser accepts root-level user payload", async () => {
    respond = async () => jsonResponse({ id: 11, name: "carol" });
    const client = new SimRelayClient("https://simrelay.com", fakeTokens as never);
    const { id } = await client.getCurrentUser();
    assert.equal(id, 11);
  });

  it("getCurrentUser tries user_id fallback", async () => {
    respond = async () => jsonResponse({ user_id: "42", email: "x@x" });
    const client = new SimRelayClient("https://simrelay.com", fakeTokens as never);
    const { id } = await client.getCurrentUser();
    assert.equal(id, 42);
  });

  it("surfaces SimRelay error message on non-2xx", async () => {
    respond = async () => jsonResponse({ message: "Forbidden" }, 403);
    const client = new SimRelayClient("https://simrelay.com", fakeTokens as never);
    await assert.rejects(
      () => client.lockSim(1),
      (err: unknown) =>
        err instanceof SimRelayApiError &&
        err.status === 403 &&
        err.message === "Forbidden",
    );
  });
});
