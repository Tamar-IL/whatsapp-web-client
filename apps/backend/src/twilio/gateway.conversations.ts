import { twilioClient } from './client';
import { env } from '../config/env';
import type { TwilioGateway, SendResult, UploadResult } from './gateway';

/**
 * Concrete TwilioGateway built on the Conversations API.
 *
 * IMPORTANT: this file is the ONLY place that knows about Twilio's SDK details.
 * If you need to migrate to Programmable Messaging, write a parallel impl.
 *
 * Implementation notes:
 *  - `attributes` is serialised JSON; we use it to embed the client-generated
 *    clientId so the inbound webhook echo can reconcile optimistic UI bubbles.
 *  - Media is uploaded to Twilio first (returns a media SID), then attached
 *    to the message. We never give Twilio a public URL — see deep-dive §1.
 */
export class ConversationsGateway implements TwilioGateway {
  private readonly serviceSid = env.TWILIO_CONVERSATION_SERVICE_SID;
  private readonly sender = env.TWILIO_WHATSAPP_SENDER;

  async sendText(opts: {
    conversationSid: string;
    body: string;
    clientId?: string;
  }): Promise<SendResult> {
    const msg = await twilioClient.conversations.v1
      .services(this.serviceSid)
      .conversations(opts.conversationSid)
      .messages.create({
        author: this.sender,
        body: opts.body,
        attributes: opts.clientId ? JSON.stringify({ clientId: opts.clientId }) : undefined,
      });
    return { sid: msg.sid };
  }

  async sendMedia(opts: {
    conversationSid: string;
    mediaSid: string;
    clientId?: string;
    caption?: string;
  }): Promise<SendResult> {
    const msg = await twilioClient.conversations.v1
      .services(this.serviceSid)
      .conversations(opts.conversationSid)
      .messages.create({
        author: this.sender,
        mediaSid: opts.mediaSid,
        body: opts.caption,
        attributes: opts.clientId ? JSON.stringify({ clientId: opts.clientId }) : undefined,
      });
    return { sid: msg.sid };
  }

  async sendTemplate(opts: {
    conversationSid: string;
    contentSid: string;
    variables?: Record<string, string>;
    clientId?: string;
  }): Promise<SendResult> {
    const msg = await twilioClient.conversations.v1
      .services(this.serviceSid)
      .conversations(opts.conversationSid)
      .messages.create({
        author: this.sender,
        contentSid: opts.contentSid,
        contentVariables: opts.variables ? JSON.stringify(opts.variables) : undefined,
        attributes: opts.clientId ? JSON.stringify({ clientId: opts.clientId }) : undefined,
      });
    return { sid: msg.sid };
  }

  async uploadMedia(opts: {
    contentType: string;
    data: Buffer;
    filename?: string;
  }): Promise<UploadResult> {
    // The Twilio SDK exposes Media via the Content Service. Endpoint specifics
    // vary by SDK version — this is a thin wrapper to be filled in during Phase 4.
    // For now, throw an explicit not-implemented so accidental calls are loud.
    throw new Error(
      'ConversationsGateway.uploadMedia not yet implemented — see Phase 4 ticket 4.3.',
    );
    // Example shape (to be verified against current SDK):
    // const upload = await twilioClient.media.v1.contents.create({
    //   contentType: opts.contentType,
    //   body: opts.data,
    // });
    // return { mediaSid: upload.sid };
  }

  async fetchMedia(_opts: { mediaSid: string }): Promise<{ data: Buffer; contentType: string }> {
    throw new Error(
      'ConversationsGateway.fetchMedia not yet implemented — see Phase 2 ticket 2.7.',
    );
  }
}

export const twilioGateway: TwilioGateway = new ConversationsGateway();
