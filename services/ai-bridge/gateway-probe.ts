import ZAI from "z-ai-web-dev-sdk";

// One-shot-per-iteration LLM probe with an internal loop — survives as long
// as the bun process lives (no shell loop for the reaper to kill).
const LOG = "/home/z/probe/gateway-probe.log";
const INTERVAL_MS = 45_000;

function log(line: string): void {
  console.log(line);
  try {
    // deno-lint-ignore no-undef
    Bun.write(Bun.file(LOG), `${line}\n`, { append: true });
  } catch {
    /* logging must never crash the probe */
  }
}

const zai = await ZAI.create().catch(() => null);
if (!zai) {
  log(`${new Date().toISOString()} ZAI_CREATE_FAILED`);
  process.exit(1);
}

for (let i = 0; i < 80; i++) {
  const startedAt = Date.now();
  try {
    const res = await zai.chat.completions.create({
      model: "glm-4.6",
      messages: [{ role: "user", content: "Say hi in 5 words" }],
      max_tokens: 40,
    });
    const text = res.choices?.[0]?.message?.content ?? "(empty)";
    log(`${new Date().toISOString()} OK ${Date.now() - startedAt}ms "${text.slice(0, 60)}"`);
    log(new Date().toISOString() + " RECOVERED");
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`${new Date().toISOString()} FAIL ${Date.now() - startedAt}ms ${msg.slice(0, 90)}`);
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
log(new Date().toISOString() + " STILL_THROTTLED");
