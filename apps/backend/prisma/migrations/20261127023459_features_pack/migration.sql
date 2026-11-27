-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "avatarFile" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "aiPausedUntil" TIMESTAMP(3),
ADD COLUMN     "aiSuggestion" TEXT,
ADD COLUMN     "aiSuggestionAt" TIMESTAMP(3),
ADD COLUMN     "lastAwaySentAt" TIMESTAMP(3),
ADD COLUMN     "markedUnread" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "needsHuman" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "isPinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isStarred" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "origin" TEXT,
ADD COLUMN     "pinnedAt" TIMESTAMP(3),
ADD COLUMN     "starredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "scheduled_messages" ADD COLUMN     "mediaMime" TEXT,
ADD COLUMN     "mediaName" TEXT,
ADD COLUMN     "mediaSize" INTEGER;

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "labels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#128C7E',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_labels" (
    "conversationId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,

    CONSTRAINT "conversation_labels_pkey" PRIMARY KEY ("conversationId","labelId")
);

-- CreateTable
CREATE TABLE "saved_replies" (
    "id" TEXT NOT NULL,
    "shortcut" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_chat_configs" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "instructions" TEXT NOT NULL DEFAULT '',
    "customerInfo" TEXT NOT NULL DEFAULT '',
    "rangeType" TEXT NOT NULL DEFAULT 'always',
    "activeFrom" TIMESTAMP(3),
    "activeUntil" TIMESTAMP(3),
    "useBusinessHours" TEXT NOT NULL DEFAULT 'any',
    "maxRepliesPerDay" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_chat_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentSid" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_recipients" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "bulk_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "labels_name_key" ON "labels"("name");

-- CreateIndex
CREATE INDEX "conversation_labels_labelId_idx" ON "conversation_labels"("labelId");

-- CreateIndex
CREATE UNIQUE INDEX "saved_replies_shortcut_key" ON "saved_replies"("shortcut");

-- CreateIndex
CREATE UNIQUE INDEX "ai_chat_configs_conversationId_key" ON "ai_chat_configs"("conversationId");

-- CreateIndex
CREATE INDEX "bulk_recipients_campaignId_status_idx" ON "bulk_recipients"("campaignId", "status");

-- AddForeignKey
ALTER TABLE "conversation_labels" ADD CONSTRAINT "conversation_labels_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_labels" ADD CONSTRAINT "conversation_labels_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chat_configs" ADD CONSTRAINT "ai_chat_configs_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_recipients" ADD CONSTRAINT "bulk_recipients_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "bulk_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_recipients" ADD CONSTRAINT "bulk_recipients_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
