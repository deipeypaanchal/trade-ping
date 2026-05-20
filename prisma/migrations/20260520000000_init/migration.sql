-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PrivacyLevel" AS ENUM ('PUBLIC', 'NORMAL', 'PRIVATE', 'OFF');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'DISCONNECTED', 'ERROR', 'DISABLED', 'PENDING');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "BackfillStatus" AS ENUM ('BACKFILL', 'NEW');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramUserId" TEXT,
    "displayName" TEXT NOT NULL,
    "snaptradeUserId" TEXT,
    "encryptedUserSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "privacyLevel" "PrivacyLevel" NOT NULL DEFAULT 'NORMAL',
    "alertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokerConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'snaptrade',
    "authorizationId" TEXT NOT NULL,
    "brokerageName" TEXT,
    "brokerageSlug" TEXT,
    "connectionType" TEXT DEFAULT 'read',
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "disabledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "BrokerConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokerAccount" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "accountNameHash" TEXT,
    "accountType" TEXT,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT,
    "accountId" TEXT,
    "symbol" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "quantity" DECIMAL(65,30),
    "price" DECIMAL(65,30),
    "currency" TEXT DEFAULT 'USD',
    "tradeTime" TIMESTAMP(3) NOT NULL,
    "rawType" TEXT,
    "rawStatus" TEXT,
    "rawId" TEXT,
    "dedupeHash" TEXT NOT NULL,
    "backfillStatus" "BackfillStatus" NOT NULL DEFAULT 'NEW',
    "alertStatus" "AlertStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "tradeEventId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'telegram',
    "messageId" TEXT,
    "renderedText" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "key" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramUserId_key" ON "User"("telegramUserId");

-- CreateIndex
CREATE UNIQUE INDEX "User_snaptradeUserId_key" ON "User"("snaptradeUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Group_telegramChatId_key" ON "Group"("telegramChatId");

-- CreateIndex
CREATE INDEX "GroupMember_groupId_idx" ON "GroupMember"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMember_userId_groupId_key" ON "GroupMember"("userId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "BrokerConnection_authorizationId_key" ON "BrokerConnection"("authorizationId");

-- CreateIndex
CREATE INDEX "BrokerConnection_userId_idx" ON "BrokerConnection"("userId");

-- CreateIndex
CREATE INDEX "BrokerAccount_providerAccountId_idx" ON "BrokerAccount"("providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "BrokerAccount_connectionId_providerAccountId_key" ON "BrokerAccount"("connectionId", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_userId_accountId_key_key" ON "SyncState"("userId", "accountId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "TradeEvent_dedupeHash_key" ON "TradeEvent"("dedupeHash");

-- CreateIndex
CREATE INDEX "TradeEvent_userId_tradeTime_idx" ON "TradeEvent"("userId", "tradeTime");

-- CreateIndex
CREATE INDEX "TradeEvent_alertStatus_idx" ON "TradeEvent"("alertStatus");

-- CreateIndex
CREATE INDEX "Alert_groupId_idx" ON "Alert"("groupId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerConnection" ADD CONSTRAINT "BrokerConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerAccount" ADD CONSTRAINT "BrokerAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BrokerConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeEvent" ADD CONSTRAINT "TradeEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeEvent" ADD CONSTRAINT "TradeEvent_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeEvent" ADD CONSTRAINT "TradeEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BrokerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_tradeEventId_fkey" FOREIGN KEY ("tradeEventId") REFERENCES "TradeEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

