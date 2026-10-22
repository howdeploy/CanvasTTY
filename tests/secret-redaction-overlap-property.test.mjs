/**
 * Property: registered secrets that overlap one another, sit next to one another or are wrapped by the terminal
 * never leave a character visible, in whole-text and tail masking alike.
 * Secrets use only lower-case letters; the surrounding text never does, so any lower-case letter left outside a
 * marker is part of a secret that leaked.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SecretRedactionRegistry } from "../src/main/services/safety/SecretRedaction.ts";

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILLER = "0123456789 .,;:!?()[]#%";
const WRAP = ["\n", "\n  ", "\n│ ", " ", "\r\n"];

function scenario(random) {
  const int = (n) => Math.floor(random() * n);
  const pick = (items) => items[int(items.length)];
  // A small alphabet makes accidental overlaps between secrets frequent; derived secrets force them.
  const alphabet = "abcdef".slice(0, 2 + int(5));
  const word = (length) => Array.from({ length }, () => pick([...alphabet])).join("");
  const secrets = [];
  for (let count = 1 + int(5); secrets.length < count;) {
    const roll = random();
    if (secrets.length && roll < 0.35) {
      // Shares a suffix of an earlier secret as its prefix: the two overlap when written back to back.
      const base = pick(secrets);
      secrets.push(base.slice(base.length - 2 - int(Math.max(1, base.length - 3))) + word(4 + int(8)));
    } else if (secrets.length && roll < 0.5) {
      const base = pick(secrets);
      secrets.push(word(1 + int(3)) + base.slice(0, Math.max(6, base.length - int(4))));
    } else secrets.push(word(8 + int(16)));
  }
  const valid = secrets.filter((secret) => secret.length >= 8);
  const filler = () => Array.from({ length: int(30) }, () => pick([...FILLER])).join("");
  const wrapped = (secret) => {
    if (random() < 0.6) return secret;
    let out = "";
    for (let i = 0; i < secret.length; i++) out += secret[i] + (i < secret.length - 1 && random() < 0.15 ? pick(WRAP) : "");
    return out;
  };
  let text = "";
  for (let pieces = 1 + int(12); pieces > 0; pieces--) {
    text += filler();
    const first = pick(valid);
    const second = pick(valid);
    const roll = random();
    if (roll < 0.4) {
      // Overlap: second starts inside first wherever their texts agree.
      let joined = first + second;
      for (let k = Math.min(first.length, second.length) - 1; k > 0; k--) {
        if (first.endsWith(second.slice(0, k))) { joined = first + second.slice(k); break; }
      }
      text += wrapped(joined);
    } else if (roll < 0.7) text += wrapped(first) + wrapped(second); // adjacent
    else text += wrapped(first);
  }
  text += filler();
  return { secrets: valid, text };
}

const leaked = (masked) => masked.replace(/<redacted:[a-z-]+>/gu, "").match(/[a-z]+/gu);

test("property: no character of overlapping, adjacent or wrapped secrets survives masking", () => {
  for (let seed = 1; seed <= 1500; seed++) {
    const random = prng(seed);
    const { secrets, text } = scenario(random);
    const registry = new SecretRedactionRegistry();
    registry.add("vault", secrets);
    const masked = registry.redact(text);
    assert.equal(leaked(masked), null, `seed ${seed}: ${JSON.stringify({ secrets, text, masked })}`);
    assert.equal(registry.redact(masked), masked, `seed ${seed}: idempotent`);
    const maxChars = 1 + Math.floor(random() * text.length);
    // The tail is the whole masked text cut to its last maxChars, so it can start inside a marker.
    assert.equal(registry.redactTail(text, maxChars), masked.slice(-maxChars), `seed ${seed}: tail`);
  }
});

test("property: tail masking equals masking the whole text and cutting it", () => {
  // Line ends next to tokens, header schemes, separators and wrapped runs: the cases a tail window's line start
  // must never split. The tail must equal whole-text masking cut to the same length.
  const anthropic = ["sk", "ant", ""].join("-");
  const fragments = [
    "plain words", "line 42 output", "x".repeat(30), "Authorization:", "Authorization: Bearer", "Bearer", "Basic", "token",
    `${anthropic}abcdefghij0123456789`, "abcd1234", "abcdefgh", "Q7vX2mK9pL4sT8wZ", "1nB6cR3yH5jD0fGa", "MY_TOKEN", "MY_TOKEN =",
    "= value123", ": secretvalue", '{"token": "', 'abc def"}', "?token=abc", "https://user:pw@host", "|", "│", "  ", "\t",
    "PASSWORD=", "hunter22", "界界界", "ünïcödé", "->", "=>", ",", "."
  ];
  const breaks = ["\n", "\r\n", "\r", "\n  ", "\n│ ", " ", ""];
  const registry = new SecretRedactionRegistry();
  registry.add("vault", ["registered-secret-value-1", "another_registered_value_22"]);
  for (let seed = 1; seed <= 400; seed++) {
    const random = prng(seed);
    const pick = (items) => items[Math.floor(random() * items.length)];
    let text = "";
    // Longer than the held values' reach plus the tail margin, so both cut where they would in a terminal.
    for (let pieces = 2_500 + Math.floor(random() * 1_000); pieces > 0; pieces--) {
      text += random() < 0.05 ? pick(["registered-secret-value-1", "another_registered_value_22", "registered-secret-\nvalue-1"]) : pick(fragments);
      text += pick(breaks);
    }
    const whole = registry.redact(text);
    const maxChars = 1 + Math.floor(random() * 4_000);
    assert.equal(registry.redactTail(text, maxChars), whole.slice(-maxChars), `seed ${seed}: tail`);
  }
});
