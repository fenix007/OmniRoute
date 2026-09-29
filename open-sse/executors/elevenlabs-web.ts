/**
 * ElevenLabs Web is text-to-speech only (handled by /v1/audio/speech). Without this
 * executor, chat routing would fall back to DefaultExecutor and forward the imported
 * Firebase refresh token to an unrelated default upstream.
 */
import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { ELEVENLABS_WEB_API_BASE_URL } from "../services/elevenlabsWebAuth.ts";

export class ElevenLabsWebExecutor extends BaseExecutor {
  constructor() {
    super("elevenlabs-web", { id: "elevenlabs-web", baseUrl: ELEVENLABS_WEB_API_BASE_URL });
  }

  async execute(_input: ExecuteInput): Promise<{
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: unknown;
  }> {
    return {
      response: Response.json(
        {
          error: {
            message:
              "elevenlabs-web supports text-to-speech only; use POST /v1/audio/speech with model elevenlabs-web/<model>",
            type: "invalid_request_error",
          },
        },
        { status: 400 }
      ),
      url: ELEVENLABS_WEB_API_BASE_URL,
      headers: {},
      transformedBody: null,
    };
  }
}
