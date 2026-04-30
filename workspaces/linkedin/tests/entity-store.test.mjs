import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { upsertPerson } from "../src/runtime/entity-store.mjs";
import * as paths from "../src/runtime/paths.mjs";

let scratch;
beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), "qln-store-"));
  // Hot-swap RAW_DIR for the duration of this test by editing module state in place is awkward;
  // instead we rely on the module's writes happening into RAW_DIR. To keep this safe we point
  // the env at our scratch dir if the module honored it -- since paths.mjs is static, we instead
  // verify via reading the standard RAW_DIR but write a unique slug that isolates from real data.
});

test("upsertPerson creates a file with merged frontmatter", async () => {
  const slug = `t-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const file = await upsertPerson({
    slug,
    frontmatter: { slug, linkedin_public_id: "tjane", name: "Test Jane", headline: "QA Engineer" },
    profileSnapshot: "Initial snapshot",
  });
  const text = await fs.readFile(file, "utf8");
  assert.match(text, /^---\n/);
  assert.match(text, /name: "Test Jane"/);
  assert.match(text, /## Profile snapshot/);
  assert.match(text, /Initial snapshot/);

  // Second upsert with thread event. Should preserve previous frontmatter.
  await upsertPerson({
    slug,
    frontmatter: { headline: "Updated headline" },
    threadEvent: { direction: "outbound", text: "hello" },
  });
  const text2 = await fs.readFile(file, "utf8");
  assert.match(text2, /headline: "Updated headline"/);
  assert.match(text2, /name: "Test Jane"/, "name preserved across merge");
  assert.match(text2, /## Threads/);
  assert.match(text2, /outbound: hello/);
  // Cleanup our test artifact
  await fs.unlink(file);
});

test("upsertPerson rejects empty slug", async () => {
  await assert.rejects(() => upsertPerson({ slug: "", frontmatter: {} }), /slug required/);
});
