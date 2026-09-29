import test from "node:test";
import assert from "node:assert/strict";
import { handleAudioSpeech } from "../../open-sse/handlers/audioSpeech.ts";
import { buildElevenLabsSpeechRequest } from "../../open-sse/config/elevenlabsSpeech.ts";
import { AUDIO_SPEECH_PROVIDERS, parseSpeechModel } from "../../open-sse/config/audioRegistry.ts";

for (const modelId of ["eleven_v4", "eleven_v4_turbo"]) {
  test(`${modelId} is discoverable and routes bare and provider-prefixed IDs`, () => {
    assert.ok(AUDIO_SPEECH_PROVIDERS.elevenlabs.models.some((m) => m.id === modelId));
    for (const model of [modelId, `elevenlabs/${modelId}`]) {
      assert.deepEqual(parseSpeechModel(model), { provider: "elevenlabs", model: modelId });
    }
  });

  test(`${modelId} preserves audio tags, native settings, language and stitching`, async (t) => {
    let captured: { url: string; options: RequestInit };
    t.mock.method(globalThis, "fetch", async (url, options: RequestInit) => {
      captured = { url: String(url), options };
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/wav" },
      });
    });
    const body = {
      model: `elevenlabs/${modelId}`,
      input: "[whispering] Привет! [laughing]",
      voice: "JBFqnCBsd6RMkjVDRZzb",
      voice_settings: { stability: 0, similarity_boost: 1 },
      language_code: "ru",
      output_format: "wav_24000",
      response_format: "mp3",
      speed: 1,
      seed: 0,
      previous_text: "Ранее.",
      next_text: "Продолжение.",
      apply_text_normalization: "off",
      ignored_extension: "not forwarded",
    };
    const response = await handleAudioSpeech({ body, credentials: { apiKey: "test-key" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
    assert.equal(
      captured.url,
      "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=wav_24000"
    );
    assert.equal(new Headers(captured.options.headers).get("xi-api-key"), "test-key");
    assert.deepEqual(JSON.parse(String(captured.options.body)), {
      text: body.input,
      model_id: modelId,
      voice_settings: body.voice_settings,
      language_code: "ru",
      seed: 0,
      previous_text: body.previous_text,
      next_text: body.next_text,
      apply_text_normalization: "off",
    });
  });
}

test("invalid or unsupported v4 options fail before any upstream request", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not fetch");
  });
  for (const overrides of [
    { voice_settings: { stability: -0.01 } },
    { voice_settings: { similarity_boost: 1.01 } },
    { voice_settings: { stability: "0.5" } },
    { voice_settings: { style: 0.5 } },
    { voice_settings: { speed: 1.1 } },
    { voice_settings: { use_speaker_boost: true } },
    { voice_settings: { arbitrary: "extension" } },
    { speed: 1.1 },
    { output_format: "mp3&enable_logging=false" },
    { response_format: "flac" },
    { response_format: "constructor" },
    { language_code: "../invalid" },
    { seed: 4294967296 },
    { seed: -1 },
    { previous_text: [] },
    { apply_text_normalization: "invalid" },
    { input: "a".repeat(10001) },
  ]) {
    const response = await handleAudioSpeech({
      body: { model: "elevenlabs/eleven_v4", input: "Hello", ...overrides },
      credentials: { apiKey: "test-key" },
    });
    assert.equal(response.status, 400, JSON.stringify(overrides).slice(0, 120));
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("v4 accepts the character limit and leaves omitted voice settings to ElevenLabs", () => {
  const result = buildElevenLabsSpeechRequest({ input: "a".repeat(10000) }, "eleven_v4");
  assert.ok(!("error" in result));
  assert.equal(result.payload.text.length, 10000);
  assert.equal(result.payload.voice_settings, undefined);
  assert.equal(result.outputFormat, undefined);
});

test("legacy ElevenLabs requests retain their default voice, URL, body and audio stream", async (t) => {
  let captured;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body) };
    return new Response(new Uint8Array([7, 8]), { headers: { "content-type": "audio/mpeg" } });
  });
  const response = await handleAudioSpeech({
    body: { model: "elevenlabs/eleven_multilingual_v2", input: "Hello" },
    credentials: { apiKey: "test-key" },
  });
  assert.deepEqual(captured, {
    url: "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM",
    body: { text: "Hello", model_id: "eleven_multilingual_v2" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [7, 8]);
});

test("legacy models forward voice settings and drop unsupported multilingual v2 language", () => {
  for (const modelId of ["eleven_multilingual_v2", "eleven_turbo_v2_5"]) {
    const result = buildElevenLabsSpeechRequest(
      {
        input: "Hello",
        language_code: "en",
        speed: 1.1,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: false,
        },
      },
      modelId
    );
    assert.ok(!("error" in result));
    assert.deepEqual(result.payload.voice_settings, {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0,
      use_speaker_boost: false,
      speed: 1.1,
    });
    assert.equal(
      result.payload.language_code,
      modelId === "eleven_multilingual_v2" ? undefined : "en"
    );
  }
});

test("supported OpenAI output formats map to native ElevenLabs query formats", () => {
  for (const [response_format, expected] of Object.entries({
    mp3: "mp3_44100_128",
    opus: "opus_48000_128",
    pcm: "pcm_24000",
    wav: "wav_24000",
  })) {
    const result = buildElevenLabsSpeechRequest({ input: "Hello", response_format }, "eleven_v4");
    assert.ok(!("error" in result));
    assert.equal(result.outputFormat, expected);
  }
});

test("ElevenLabs audio streams before upstream completes and cancellation propagates", async (t) => {
  let canceled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "content-type": "audio/mpeg" } }
      )
  );
  const response = await handleAudioSpeech({
    body: { model: "elevenlabs/eleven_v4_turbo", input: "Hello" },
    credentials: { apiKey: "test-key" },
  });
  const reader = response.body!.getReader();
  assert.deepEqual(await reader.read(), { value: new Uint8Array([1]), done: false });
  await reader.cancel();
  assert.equal(canceled, true);
});

test("ElevenLabs upstream rate limits keep their status instead of becoming audio", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ detail: { message: "Rate limit exceeded" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })
  );
  const response = await handleAudioSpeech({
    body: { model: "elevenlabs/eleven_v4", input: "Hello" },
    credentials: { apiKey: "test-key" },
  });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.message, "Rate limit exceeded");
});

test("ElevenLabs fallback MIME matches the requested format", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array([0, 1])));
  const response = await handleAudioSpeech({
    body: { model: "elevenlabs/eleven_v4", input: "Hello", response_format: "pcm" },
    credentials: { apiKey: "test-key" },
  });
  assert.equal(response.headers.get("content-type"), "audio/pcm");
});
