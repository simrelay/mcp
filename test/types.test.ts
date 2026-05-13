import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSim,
  normalizeMessage,
  extractMessageEventPayload,
} from "../src/types.js";

describe("normalizeSim", () => {
  it("maps seven_system_number to phone_number", () => {
    const sim = normalizeSim({
      id: 7,
      seven_system_number: "+491701234567",
      status: "active",
      country: "DE",
    });
    assert.equal(sim.id, 7);
    assert.equal(sim.phone_number, "+491701234567");
    assert.equal(sim.status, "active");
    assert.equal(sim.country, "DE");
    assert.equal(sim.lock, null);
  });

  it("falls back to alternative phone fields", () => {
    assert.equal(normalizeSim({ number: "+1234" }).phone_number, "+1234");
    assert.equal(normalizeSim({ msisdn: "999" }).phone_number, "999");
  });

  it("extracts organization and team from arrays with pivot alias", () => {
    const sim = normalizeSim({
      id: 9,
      number: "+44",
      organizations: [{ id: 1, name: "Acme", alias: "Marketing line", team_id: 3 }],
      teams: [{ id: 3, name: "Auth" }],
    });
    assert.deepEqual(sim.organization, { id: 1, name: "Acme" });
    assert.deepEqual(sim.team, { id: 3, name: "Auth" });
    assert.equal(sim.alias, "Marketing line");
  });

  it("still supports the legacy singular organization/team object shape", () => {
    const sim = normalizeSim({
      id: 9,
      organization: { id: 4, name: "Legacy Org" },
      team: { id: 7, name: "Legacy Team" },
    });
    assert.deepEqual(sim.organization, { id: 4, name: "Legacy Org" });
    assert.deepEqual(sim.team, { id: 7, name: "Legacy Team" });
  });

  it("returns -1 id and nulls for empty input", () => {
    const sim = normalizeSim({});
    assert.equal(sim.id, -1);
    assert.equal(sim.phone_number, null);
  });
});

describe("normalizeMessage", () => {
  it("maps inbound direction variants to 'in'", () => {
    assert.equal(normalizeMessage({ direction: "inbound" }).direction, "in");
    assert.equal(normalizeMessage({ direction: "received" }).direction, "in");
  });
  it("maps outbound direction variants to 'out'", () => {
    assert.equal(normalizeMessage({ direction: "sent" }).direction, "out");
    assert.equal(normalizeMessage({ direction: "outbound" }).direction, "out");
  });
  it("picks message_text or text or body", () => {
    assert.equal(normalizeMessage({ message_text: "hi" }).text, "hi");
    assert.equal(normalizeMessage({ text: "yo" }).text, "yo");
    assert.equal(normalizeMessage({ body: "k" }).text, "k");
  });
});

describe("extractMessageEventPayload", () => {
  it("normalizes Reverb payload fields", () => {
    const event = extractMessageEventPayload({
      hosted_sim_id: 42,
      message_text: "your code is 1234",
      from: "+49123",
      received_at: "2026-05-01T10:00:00Z",
    });
    assert.equal(event.event, "sms.received");
    assert.equal(event.sim_id, 42);
    assert.equal(event.text, "your code is 1234");
    assert.equal(event.from, "+49123");
  });
});
