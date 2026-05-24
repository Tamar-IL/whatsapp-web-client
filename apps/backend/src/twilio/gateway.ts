/**
 * TwilioGateway — abstraction over the Twilio SDK.
 *
 * The rest of the app depends on this interface, not on the SDK directly.
 * This is the swap-point if the Programmable Messaging fallback ever becomes
 * necessary (deep-dive §1).
 *
 * The implementation against the Conversations API lives in `gateway.conversations.ts`.
 * A fake/in-memory implementation for tests can live alongside.
 */

export interface SendResult {
  sid: string;
}

export interface UploadResult {
  mediaSid: string;
  url?: string;
}

export interface TwilioGateway {
  sendText(opts: {
    conversationSid: string;
    body: string;
    clientId?: string;
  }): Promise<SendResult>;

  sendMedia(opts: {
    conversationSid: string;
    mediaSid: string;
    clientId?: string;
    caption?: string;
  }): Promise<SendResult>;

  sendTemplate(opts: {
    conversationSid: string;
    contentSid: string;
    variables?: Record<string, string>;
    clientId?: string;
  }): Promise<SendResult>;

  uploadMedia(opts: {
    contentType: string;
    data: Buffer;
    filename?: string;
  }): Promise<UploadResult>;

  fetchMedia(opts: { mediaSid: string }): Promise<{ data: Buffer; contentType: string }>;

  /** Optional — depends on account / API support. Spike before relying on it. */
  reactToMessage?(opts: {
    conversationSid: string;
    messageSid: string;
    emoji: string | null; // null = remove reaction
  }): Promise<void>;
}
