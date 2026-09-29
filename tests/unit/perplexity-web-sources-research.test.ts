// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { PerplexityWebExecutor, __resetPerplexitySessionsForTesting, parsePerplexityOptions } =
  await import("../../open-sse/executors/perplexity-web.ts");
const { renderCitations, StreamingCitationRenderer } =
  await import("../../open-sse/executors/perplexity-web/protocol.ts");
const { __setTlsFetchOverrideForTesting } =
  await import("../../open-sse/services/perplexityTlsClient.ts");
const { sanitizeOpenAIResponse, sanitizeStreamingChunk } =
  await import("../../open-sse/handlers/responseSanitizer.ts");

// Live frames captured from www.perplexity.ai on 2026-09-29 (trimmed, tokens replaced).
// c1: expired cookie served as an anonymous visitor. c2: workflow API answer with sources.
const LIVE = JSON.parse(
  readFileSync(new URL("../fixtures/perplexity-web-live-2026-09-29.json", import.meta.url), "utf8")
);

function sse(events) {
  const body =
    events.map((e) => `event: message\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join("") +
    "event: end_of_stream\r\n\r\n";
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(body));
      c.close();
    },
  });
}

/** Queue of upstream turns; records every request body the executor sends. */
function upstream(...turns) {
  const requests = [];
  __setTlsFetchOverrideForTesting(async (_url, opts) => {
    requests.push({ body: JSON.parse(opts.body), timeoutMs: opts.timeoutMs });
    const events = turns.shift();
    return { status: 200, headers: new Headers(), text: null, body: sse(events) };
  });
  return requests;
}

function answerEvents(text, { sources = [], uuid = "thread-1", rw = "rw-1" } = {}) {
  return [
    {
      status: "PENDING",
      backend_uuid: uuid,
      read_write_token: rw,
      blocks: [
        {
          intended_usage: "web_results",
          web_result_block: {
            web_results: sources.map((s) => ({
              name: s.title,
              url: s.url,
              snippet: s.snippet,
              timestamp: "2020-05-31T00:00:00",
            })),
          },
        },
      ],
    },
    {
      status: "COMPLETED",
      backend_uuid: uuid,
      read_write_token: rw,
      blocks: [
        {
          intended_usage: "workflow_root",
          workflow_block: {
            steps: [
              {
                items: [
                  {
                    type: "WORKFLOW_ITEM_TEXT",
                    payload: { text_payload: { text, chunks: [text], variant: "answer" } },
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  ];
}

const SOURCES = [
  { title: "mos.ru news", url: "https://www.mos.ru/news/item/74898073/", snippet: "Стела" },
  { title: "Wiki", url: "https://ru.wikipedia.org/wiki/Lianozovo" },
];

async function run(body, { model = "pplx-auto", stream = false, apiKey = "cookie-a" } = {}) {
  const executor = new PerplexityWebExecutor();
  const { response } = await executor.execute({
    model,
    body: { stream, ...body },
    stream,
    credentials: { apiKey },
    signal: AbortSignal.timeout(10000),
    log: null,
  });
  return response;
}

async function readSse(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)));
}

test.beforeEach(() => __resetPerplexitySessionsForTesting());

test("live capture: logged-out cookie becomes 401 instead of a canned 200 answer", async () => {
  upstream(LIVE.c1);
  const res = await run({ messages: [{ role: "user", content: "hi" }] }, { stream: true });
  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.error.code, "session_logged_out");
});

test("live capture: workflow answer carries web sources in both API shapes", async () => {
  upstream(LIVE.c2);
  const res = await run({ messages: [{ role: "user", content: "стелы рядом?" }] });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.match(json.choices[0].message.content, /уточните/);
  assert.equal(json.citations.length, 3);
  assert.match(json.citations[0], /^https:\/\/ru\.wikipedia\.org\//);
  assert.equal(json.search_results[0].title, "Стела — Википедия");
  assert.equal(json.search_results[0].date, "2007-11-26");
  assert.equal(json.choices[0].message.annotations[0].type, "url_citation");
  assert.match(json.choices[0].message.reasoning_content, /Searching: /);
});

test("citation modes: clean strips, numbered keeps, markdown links markers", async () => {
  const text = "Стела установлена в 2018 году [1], рядом парк [2].";
  for (const [mode, expected] of [
    ["clean", "Стела установлена в 2018 году, рядом парк."],
    ["numbered", text],
    [
      "markdown",
      "Стела установлена в 2018 году [1](https://www.mos.ru/news/item/74898073/), рядом парк [2](https://ru.wikipedia.org/wiki/Lianozovo).",
    ],
  ]) {
    upstream(answerEvents(text, { sources: SOURCES }));
    const res = await run({
      messages: [{ role: "user", content: `q-${mode}` }],
      perplexity: { citation_mode: mode },
    });
    const json = await res.json();
    assert.equal(json.choices[0].message.content, expected, mode);
    assert.deepEqual(
      json.citations,
      SOURCES.map((s) => s.url)
    );
  }
});

test("markdown citations never rewrite code", () => {
  const out = renderCitations("see [1] and `arr[1]`", "markdown", SOURCES);
  assert.equal(out, "see [1](https://www.mos.ru/news/item/74898073/) and `arr[1]`");
});

test("streaming renderer handles a marker split across chunks", () => {
  const r = new StreamingCitationRenderer("markdown", () => SOURCES);
  const out =
    ["Стела [", "1", "] стоит", " у парка [2]."].map((d) => r.push(d)).join("") + r.finish();
  assert.equal(
    out,
    "Стела [1](https://www.mos.ru/news/item/74898073/) стоит у парка [2](https://ru.wikipedia.org/wiki/Lianozovo)."
  );
});

test("streaming: sources arrive on a chunk before the stop chunk", async () => {
  upstream(answerEvents("Ответ [1].", { sources: SOURCES }));
  const res = await run(
    { messages: [{ role: "user", content: "q" }], perplexity: { citation_mode: "numbered" } },
    { stream: true }
  );
  const chunks = await readSse(res);
  const content = chunks.map((c) => c.choices[0].delta.content || "").join("");
  assert.equal(content, "Ответ [1].");
  const srcIdx = chunks.findIndex((c) => c.citations);
  const stopIdx = chunks.findIndex((c) => c.choices[0].finish_reason === "stop");
  assert.ok(srcIdx > 0 && srcIdx === stopIdx - 1);
  assert.equal(chunks[srcIdx].choices[0].delta.annotations.length, 2);
  assert.equal(chunks[srcIdx].search_results[0].url, SOURCES[0].url);
});

test("thread continuity: echoed answer continues the same thread with its write token", async () => {
  const requests = upstream(
    answerEvents("Первый ответ [1].", { sources: SOURCES, uuid: "t-1", rw: "rw-1" }),
    answerEvents("Второй ответ.", { uuid: "t-2", rw: "rw-2" }),
    answerEvents("Третий ответ.", { uuid: "t-3", rw: "rw-3" })
  );
  const system = { role: "system", content: "Исследуй места для проекта." };
  const first = await (
    await run({
      messages: [system, { role: "user", content: "Стела у Лианозовского парка" }],
      perplexity: { citation_mode: "markdown" },
    })
  ).json();
  const answer1 = first.choices[0].message.content;
  assert.match(answer1, /\[1\]\(https:/);

  const second = await (
    await run({
      messages: [
        system,
        { role: "user", content: "Стела у Лианозовского парка" },
        { role: "assistant", content: answer1 },
        { role: "user", content: "Что рядом?" },
      ],
    })
  ).json();
  assert.equal(requests[1].body.params.last_backend_uuid, "t-1");
  assert.equal(requests[1].body.params.read_write_token, "rw-1");
  assert.equal(requests[1].body.params.query_source, "followup");
  assert.match(requests[1].body.query_str, /Что рядом\?$/);

  // Same transcript under another account must not reuse the first account's thread.
  await run(
    {
      messages: [
        system,
        { role: "user", content: "Стела у Лианозовского парка" },
        { role: "assistant", content: answer1 },
        { role: "user", content: "Что рядом?" },
      ],
    },
    { apiKey: "cookie-b" }
  );
  assert.equal(requests[2].body.params.last_backend_uuid, undefined);
  assert.ok(second.choices[0].message.content);
});

test("deep research: research mode, long timeout, clarifications answered in-thread", async () => {
  const clarification = [
    {
      status: "COMPLETED",
      backend_uuid: "r-1",
      read_write_token: "rw-r1",
      blocks: [
        {
          intended_usage: "workflow_root",
          workflow_block: {
            steps: [
              {
                tool_name: "research_clarifying_questions",
                items: [
                  {
                    type: "WORKFLOW_ITEM_CLARIFYING_QUESTIONS",
                    payload: { questions: ["Какой период вас интересует?"] },
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  ];
  const requests = upstream(
    clarification,
    answerEvents("Итог исследования [1].", { sources: SOURCES, uuid: "r-2", rw: "rw-r2" })
  );
  const res = await run(
    {
      messages: [{ role: "user", content: "История стелы" }],
      perplexity: { language: "ru-RU", coordinates: { latitude: 55.9, longitude: 37.57 } },
    },
    { model: "pplx-deep-research" }
  );
  const json = await res.json();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.params.mode, "research");
  assert.equal(requests[0].body.params.model_preference, "pplx_alpha");
  assert.equal(requests[0].body.params.language, "ru-RU");
  assert.equal(requests[0].body.params.local_search_enabled, true);
  assert.deepEqual(requests[0].body.params.client_coordinates, {
    location_lat: 55.9,
    location_lng: 37.57,
    name: "",
  });
  assert.ok(requests[0].timeoutMs >= 600_000);
  assert.equal(requests[1].body.params.last_backend_uuid, "r-1");
  assert.equal(requests[1].body.params.read_write_token, "rw-r1");
  assert.match(requests[1].body.query_str, /Какой период вас интересует\?/);
  assert.equal(json.choices[0].message.content, "Итог исследования.");
  assert.equal(json.citations.length, 2);
});

test("deep research manual mode returns the clarifying questions", async () => {
  upstream([
    {
      status: "COMPLETED",
      backend_uuid: "r-1",
      text: JSON.stringify([
        { step_type: "RESEARCH_CLARIFYING_QUESTIONS", content: { questions: ["Какой район?"] } },
      ]),
    },
  ]);
  const res = await run(
    {
      messages: [{ role: "user", content: "История" }],
      perplexity: { research_interaction: "manual" },
    },
    { model: "pplx-deep-research" }
  );
  const json = await res.json();
  assert.equal(json.choices[0].message.content, "1. Какой район?");
});

test("perplexity options are validated", async () => {
  assert.equal(parsePerplexityOptions({ citation_mode: "bogus" }).ok, false);
  assert.equal(parsePerplexityOptions({ language: "ru RU" }).ok, false);
  assert.equal(parsePerplexityOptions({ coordinates: { latitude: 95, longitude: 0 } }).ok, false);
  assert.equal(parsePerplexityOptions("x").ok, false);
  upstream();
  const res = await run({
    messages: [{ role: "user", content: "q" }],
    perplexity: { citation_mode: "bogus" },
  });
  assert.equal(res.status, 400);
});

test("sanitizers keep citations, search_results and annotations", () => {
  const annotations = [{ type: "url_citation", url_citation: { url: "https://a", title: "A" } }];
  const body = sanitizeOpenAIResponse({
    id: "x",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi", annotations },
        finish_reason: "stop",
      },
    ],
    citations: ["https://a"],
    search_results: [{ title: "A", url: "https://a" }],
    unknown_field: 1,
  });
  assert.deepEqual(body.citations, ["https://a"]);
  assert.deepEqual(body.search_results, [{ title: "A", url: "https://a" }]);
  assert.deepEqual(body.choices[0].message.annotations, annotations);
  assert.equal(body.unknown_field, undefined);

  const chunk = sanitizeStreamingChunk({
    id: "x",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { annotations } }],
    citations: ["https://a"],
  });
  assert.deepEqual(chunk.choices[0].delta.annotations, annotations);
  assert.deepEqual(chunk.citations, ["https://a"]);
});
