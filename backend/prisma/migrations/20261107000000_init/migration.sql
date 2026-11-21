-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- CreateEnum
CREATE TYPE "Protocol" AS ENUM ('tcp', 'udp', 'icmp');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "refresh_token_hash" TEXT,
    "github_id" TEXT,
    "email_verified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_groups" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "floci_group_id" TEXT,
    "sync_status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "sync_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "security_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firewall_rules" (
    "id" UUID NOT NULL,
    "security_group_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" "Protocol" NOT NULL,
    "port" INTEGER,
    "cidr" TEXT NOT NULL,
    "description" TEXT,
    "risk_level" "RiskLevel" NOT NULL,
    "risk_reason" TEXT,
    "recommendation" TEXT,
    "sync_status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "sync_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "firewall_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "security_group_id" UUID,
    "rule_id" UUID,
    "action" "AuditAction" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_github_id_key" ON "users"("github_id");

-- CreateIndex
CREATE INDEX "security_groups_user_id_idx" ON "security_groups"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "security_groups_user_id_name_key" ON "security_groups"("user_id", "name");

-- CreateIndex
CREATE INDEX "firewall_rules_security_group_id_idx" ON "firewall_rules"("security_group_id");

-- CreateIndex
CREATE INDEX "firewall_rules_risk_level_idx" ON "firewall_rules"("risk_level");

-- CreateIndex
CREATE UNIQUE INDEX "firewall_rules_security_group_id_protocol_port_cidr_key" ON "firewall_rules"("security_group_id", "protocol", "port", "cidr");

-- CreateIndex
CREATE INDEX "rule_audit_logs_user_id_idx" ON "rule_audit_logs"("user_id");

-- AddForeignKey
ALTER TABLE "security_groups" ADD CONSTRAINT "security_groups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firewall_rules" ADD CONSTRAINT "firewall_rules_security_group_id_fkey" FOREIGN KEY ("security_group_id") REFERENCES "security_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_audit_logs" ADD CONSTRAINT "rule_audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

