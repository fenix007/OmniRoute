# ElevenLabs text-to-speech

Configure an ElevenLabs API-key connection in OmniRoute. Requests use
`POST /v1/audio/speech` with the OmniRoute API key in the Bearer header;
the upstream ElevenLabs key stays on the provider connection.

The catalog exposes `elevenlabs/eleven_v4`, `elevenlabs/eleven_v4_turbo`,
`elevenlabs/eleven_multilingual_v2`, and `elevenlabs/eleven_turbo_v2_5`.

This request is exercised in `tests/unit/elevenlabs-speech.test.ts`:

```json
{
  "model": "elevenlabs/eleven_v4",
  "input": "[whispering] Привет! [laughing]",
  "voice": "JBFqnCBsd6RMkjVDRZzb",
  "voice_settings": { "stability": 0, "similarity_boost": 1 },
  "language_code": "ru",
  "output_format": "wav_24000"
}
```

ElevenLabs also supports `elevenlabs/eleven_v4_turbo`. `eleven_v4` accepts up to
10,000 input characters. Audio tags in `input` are preserved. Under `voice_settings`,
v4 accepts only `stability` and `similarity_boost` (numbers from 0 to 1). Other voice
settings and a non-default top-level `speed` return 400; `speed: 1` is accepted and
omitted upstream. Legacy models retain their existing default request behavior.

The ElevenLabs adapter validates optional `language_code`, `seed`, `previous_text`,
`next_text`, and `apply_text_normalization`. `language_code` is omitted for
`eleven_multilingual_v2`, which does not support it. A native `output_format` takes
precedence over `response_format`; the latter supports `mp3`, `opus`, `pcm`, and `wav`
(mapped to MP3 44.1 kHz/128 kbps, Opus 48 kHz/128 kbps, PCM 24 kHz, and WAV 24 kHz).
The upstream audio body streams through unchanged. See
`open-sse/config/elevenlabsSpeech.ts` for the validated options and
`tests/unit/elevenlabs-speech.test.ts` for exercised requests.
