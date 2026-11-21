-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('INGRESS', 'EGRESS');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('VIEWER', 'EDITOR');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('EMAIL', 'SLACK', 'WEBHOOK');

-- DropIndex
DROP INDEX "firewall_rules_security_group_id_protocol_port_cidr_key";

-- AlterTable
ALTER TABLE "security_groups" ADD COLUMN     "aws_account_id" UUID,
ADD COLUMN     "last_scan_at" TIMESTAMPTZ,
ADD COLUMN     "last_scan_status" TEXT;

-- AlterTable
ALTER TABLE "firewall_rules" ADD COLUMN     "direction" "Direction" NOT NULL DEFAULT 'INGRESS',
ADD COLUMN     "port_to" INTEGER;

-- CreateTable
CREATE TABLE "group_members" (
    "id" UUID NOT NULL,
    "security_group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'VIEWER',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channels" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "ChannelType" NOT NULL,
    "target_enc" TEXT NOT NULL,
    "secret_enc" TEXT,
    "events" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_status" TEXT,
    "last_error" TEXT,
    "last_delivered_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aws_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "access_key_id_enc" TEXT NOT NULL,
    "secret_access_key_enc" TEXT NOT NULL,
    "last_verified_at" TIMESTAMPTZ,
    "last_verify_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aws_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_members_user_id_idx" ON "group_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_members_security_group_id_user_id_key" ON "group_members"("security_group_id", "user_id");

-- CreateIndex
CREATE INDEX "notification_channels_user_id_idx" ON "notification_channels"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "aws_accounts_user_id_name_key" ON "aws_accounts"("user_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "firewall_rules_security_group_id_direction_protocol_port_po_key" ON "firewall_rules"("security_group_id", "direction", "protocol", "port", "port_to", "cidr");

-- AddForeignKey
ALTER TABLE "security_groups" ADD CONSTRAINT "security_groups_aws_account_id_fkey" FOREIGN KEY ("aws_account_id") REFERENCES "aws_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_security_group_id_fkey" FOREIGN KEY ("security_group_id") REFERENCES "security_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aws_accounts" ADD CONSTRAINT "aws_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

