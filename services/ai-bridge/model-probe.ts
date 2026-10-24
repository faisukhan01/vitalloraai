import ZAI from "z-ai-web-dev-sdk";

const MODELS = ["glm-4.6", "glm-4-plus", "glm-4.5", "glm-4.5-air", "glm-4-flash", "glm-4.5v"];

async function probe(model: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const zai = await ZAI.create();
    const res = await zai.chat.completions.create({
      model,
      messages: [{ role: "user", content: "Say hi in 5 words" }],
      max_tokens: 40,
    });
    const text = res.choices?.[0]?.message?.content ?? "(empty)";
    console.log(JSON.stringify({ model, ok: true, ms: Date.now() - startedAt, text: text.slice(0, 80) }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ model, ok: false, ms: Date.now() - startedAt, err: msg.slice(0, 140) }));
  }
}

const model = process.argv[2];
if (model) await probe(model);
else {
  for (const m of MODELS) {
    await probe(m);
    await new Promise((r) => setTimeout(r, 2500));
  }
}
