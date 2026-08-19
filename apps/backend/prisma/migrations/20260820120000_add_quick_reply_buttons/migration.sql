-- Quick-reply buttons.

-- Button titles rendered with an outbound message, as ["Yes", "No"].
ALTER TABLE "messages" ADD COLUMN "buttons" JSONB;

-- Reusable Twilio Content resources backing those buttons. One row per distinct
-- (body + buttons) pair so repeat sends don't create a new Content resource
-- in the Twilio account every time.
CREATE TABLE "quick_reply_templates" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "contentSid" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "buttons" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quick_reply_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quick_reply_templates_hash_key" ON "quick_reply_templates"("hash");
CREATE UNIQUE INDEX "quick_reply_templates_contentSid_key" ON "quick_reply_templates"("contentSid");
