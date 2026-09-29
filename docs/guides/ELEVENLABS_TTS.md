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

## ElevenLabs Web session (`elevenlabs-web`)

`elevenlabs-web` uses the subscription of an account signed in at elevenlabs.io
instead of an API key. It supports text-to-speech only and exposes the same four
models with the same request validation, for example `elevenlabs-web/eleven_v4`.

elevenlabs.io keeps its session in Firebase Auth Local Storage, not in a cookie.
To create a connection, sign in, open DevTools → Application → Local Storage →
`https://elevenlabs.io`, and paste the value of the `firebase:authUser:…:[DEFAULT]`
entry (or only its `stsTokenManager.refreshToken`). OmniRoute stores it as the
connection credential, exchanges it for a short-lived Firebase ID token, caches that
token until five minutes before expiry, and calls
`https://api.us.elevenlabs.io/v1/text-to-speech/{voice_id}` with
`Authorization: Bearer <ID token>`. A cached token rejected with 401 is refreshed once.
A revoked or expired session returns 401 and must be re-imported. Connection tests
probe `GET /v1/user` with a freshly refreshed token.

The public Firebase Web key comes from `open-sse/utils/publicCreds.ts`; set
`ELEVENLABS_FIREBASE_API_KEY` only to override it. Chat requests sent to
`elevenlabs-web` return 400 without contacting any upstream. Free accounts that sign
in with a password may be asked for a captcha by ElevenLabs; that flow is not
supported. This is an unofficial integration of the web application. See
`open-sse/services/elevenlabsWebAuth.ts` and `tests/unit/elevenlabs-web.test.ts`.
