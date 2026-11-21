-- STS AssumeRole support for connected AWS accounts.
ALTER TABLE "aws_accounts"
  ADD COLUMN "role_arn" TEXT,
  ADD COLUMN "external_id_enc" TEXT,
  ADD COLUMN "session_duration" INTEGER NOT NULL DEFAULT 3600;
