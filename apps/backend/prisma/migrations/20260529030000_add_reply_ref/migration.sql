-- AlterTable: add quoted-reply reference (Twilio SID of the message being replied to)
ALTER TABLE "messages" ADD COLUMN "replyToTwilioSid" TEXT;
