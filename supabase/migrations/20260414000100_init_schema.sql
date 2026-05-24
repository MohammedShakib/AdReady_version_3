-- Main PostgreSQL schema for AdReady.
-- Use this on a fresh, empty database.

CREATE TYPE user_role AS ENUM ('admin', 'member');
CREATE TYPE project_status AS ENUM ('active', 'archived');
CREATE TYPE asset_type AS ENUM (
    'reference_image',
    'logo_image',
    'generated_image',
    'bg_removed_image',
    'other'
);
CREATE TYPE storage_provider AS ENUM ('local', 's3', 'gcs', 'r2');
CREATE TYPE ai_provider AS ENUM ('openai', 'gemini');
CREATE TYPE bg_provider AS ENUM ('third_party', 'gemini');
CREATE TYPE reference_mode AS ENUM ('none', 'auto', 'edit', 'overlay', 'openai');
CREATE TYPE run_status AS ENUM ('queued', 'running', 'succeeded', 'failed');
CREATE TYPE aspect_ratio AS ENUM ('1:1', '9:16', '4:5', '16:9');
CREATE TYPE camera_angle AS ENUM ('eye-level', 'top-down', 'low-angle', 'three-quarter');
CREATE TYPE lighting_focus AS ENUM ('softbox', 'cinematic', 'studio', 'natural');
CREATE TYPE cta_text AS ENUM ('Shop Now', 'Buy Now', 'Learn More', 'Get Offer', 'Order Today');

CREATE OR REPLACE FUNCTION app_uuid()
RETURNS UUID AS $$
DECLARE
    value TEXT := md5(random()::text || clock_timestamp()::text);
BEGIN
    RETURN (
        substr(value, 1, 8) || '-' ||
        substr(value, 9, 4) || '-4' ||
        substr(value, 14, 3) || '-' ||
        substr('89ab', 1 + floor(random() * 4)::int, 1) ||
        substr(value, 18, 3) || '-' ||
        substr(value, 21, 12)
    )::uuid;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT app_uuid(),
    username VARCHAR(64) NOT NULL UNIQUE,
    email VARCHAR(255) UNIQUE,
    password_hash TEXT,
    telegram_id BIGINT UNIQUE,
    credits INTEGER NOT NULL DEFAULT 5,
    plan_tier VARCHAR(16) NOT NULL DEFAULT 'free',
    plan_status VARCHAR(16) NOT NULL DEFAULT 'active',
    daily_credit_quota INTEGER NOT NULL DEFAULT 5,
    last_credit_reset DATE,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    bot_state VARCHAR(32) NOT NULL DEFAULT 'IDLE',
    bot_data JSONB,
    role user_role NOT NULL DEFAULT 'member',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE plan_settings (
    tier VARCHAR(16) PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    price_usd_monthly NUMERIC(10,2) NOT NULL CHECK (price_usd_monthly >= 0),
    monthly_credits INTEGER NOT NULL CHECK (monthly_credits >= 0),
    is_editable BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT plan_settings_tier_check CHECK (tier IN ('free', 'basic', 'pro'))
);

INSERT INTO plan_settings (tier, name, price_usd_monthly, monthly_credits, is_editable)
VALUES
    ('free', 'Free', 0, 5, TRUE),
    ('basic', 'Basic', 30, 100, TRUE),
    ('pro', 'Pro', 50, 250, TRUE)
ON CONFLICT (tier) DO NOTHING;

CREATE TABLE topup_packages (
    credits INTEGER PRIMARY KEY CHECK (credits > 0),
    price_usd NUMERIC(10,2) NOT NULL CHECK (price_usd >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO topup_packages (credits, price_usd, is_active, sort_order)
VALUES
    (25, 7.50, TRUE, 1),
    (50, 15.00, TRUE, 2),
    (100, 30.00, TRUE, 3)
ON CONFLICT (credits) DO NOTHING;

CREATE TABLE integration_settings (
    provider VARCHAR(20) PRIMARY KEY,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT integration_settings_provider_check
        CHECK (provider IN ('telegram', 'stripe'))
);

INSERT INTO integration_settings (provider, is_enabled, config)
VALUES
    ('telegram', FALSE, '{}'::jsonb),
    ('stripe', FALSE, '{}'::jsonb)
ON CONFLICT (provider) DO NOTHING;

CREATE TABLE user_sessions (
    id UUID PRIMARY KEY DEFAULT app_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token_hash CHAR(64) NOT NULL UNIQUE,
    ip_address INET,
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE stripe_topup_history (
    session_id VARCHAR(255) PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    credits_added INTEGER NOT NULL CHECK (credits_added > 0),
    source VARCHAR(64) NOT NULL DEFAULT 'stripe',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE telegram_generation_jobs (
    job_token VARCHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    telegram_id BIGINT NOT NULL,
    chat_id BIGINT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    prompt TEXT NOT NULL,
    reference_image_url TEXT NOT NULL,
    reference_mime_type VARCHAR(100),
    reference_source_kind VARCHAR(32) NOT NULL DEFAULT 'document',
    reference_file_name TEXT,
    reference_mode VARCHAR(16) NOT NULL DEFAULT 'edit',
    logo_image_url TEXT,
    logo_mime_type VARCHAR(100),
    draft_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    variant_count SMALLINT NOT NULL DEFAULT 2 CHECK (variant_count > 0),
    reserved_credits INTEGER NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
    generated_count INTEGER NOT NULL DEFAULT 0 CHECK (generated_count >= 0),
    result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT app_uuid(),
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    description TEXT,
    status project_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE project_api_keys (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    api_key_hash CHAR(64) NOT NULL UNIQUE,
    api_key_encrypted TEXT NOT NULL,
    key_prefix VARCHAR(16) NOT NULL,
    key_last4 VARCHAR(4) NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE project_api_runtime_settings (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    external_generate_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    external_analyze_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE project_api_pipeline_policies (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    default_generate_pipeline VARCHAR(80) NOT NULL DEFAULT 'gemini-edit-pipeline',
    allowed_generate_pipelines TEXT[] NOT NULL DEFAULT ARRAY['gemini-edit-pipeline', 'gemini-reference-guided-pipeline', 'openai-image-pipeline']::TEXT[],
    allow_generate_override BOOLEAN NOT NULL DEFAULT TRUE,
    default_analyze_pipeline VARCHAR(80) NOT NULL DEFAULT 'gemini-edit-pipeline',
    allowed_analyze_pipelines TEXT[] NOT NULL DEFAULT ARRAY['gemini-edit-pipeline', 'openai-analyze-pipeline']::TEXT[],
    allow_analyze_override BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO project_api_runtime_settings (id, external_generate_enabled, external_analyze_enabled)
VALUES (1, TRUE, TRUE)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE project_api_logs (
    id UUID PRIMARY KEY DEFAULT app_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    project_name TEXT,
    method VARCHAR(16) NOT NULL,
    endpoint_path TEXT NOT NULL,
    source VARCHAR(64),
    status_code INTEGER,
    level VARCHAR(16) NOT NULL CHECK (level IN ('info', 'error')),
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    request_preview JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_preview JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE assets (
    id UUID PRIMARY KEY DEFAULT app_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    asset_type asset_type NOT NULL,
    storage_provider storage_provider NOT NULL DEFAULT 'local',
    storage_key TEXT NOT NULL,
    public_url TEXT,
    mime_type VARCHAR(100) NOT NULL,
    width INTEGER CHECK (width IS NULL OR width > 0),
    height INTEGER CHECK (height IS NULL OR height > 0),
    size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
    checksum_sha256 CHAR(64),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (storage_provider, storage_key)
);

CREATE TABLE generation_requests (
    id UUID PRIMARY KEY DEFAULT app_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    reference_asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
    logo_asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
    product_name TEXT,
    main_ingredient TEXT,
    visual_mood TEXT,
    dynamic_elements TEXT,
    color_palette TEXT,
    background_style TEXT,
    brand_name TEXT,
    cta_text cta_text,
    aspect_ratio aspect_ratio,
    camera_angle camera_angle,
    lighting_focus lighting_focus,
    extra_notes TEXT,
    add_quality_tags BOOLEAN NOT NULL DEFAULT TRUE,
    final_prompt TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE generation_runs (
    id UUID PRIMARY KEY DEFAULT app_uuid(),
    request_id UUID NOT NULL REFERENCES generation_requests(id) ON DELETE CASCADE,
    provider ai_provider NOT NULL,
    model_name TEXT NOT NULL,
    reference_mode reference_mode NOT NULL DEFAULT 'none',
    status run_status NOT NULL DEFAULT 'queued',
    caption_type VARCHAR(32) NOT NULL DEFAULT 'caption',
    generated_caption TEXT,
    edit_instruction TEXT,
    background_prompt TEXT,
    error_text TEXT,
    raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE generation_outputs (
    id UUID PRIMARY KEY DEFAULT app_uuid(),
    run_id UUID NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
    variant_no SMALLINT NOT NULL CHECK (variant_no > 0),
    caption TEXT NOT NULL DEFAULT '',
    image_asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, variant_no)
);

CREATE TABLE analysis_runs (
    id UUID PRIMARY KEY DEFAULT app_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    reference_asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
    model_name TEXT NOT NULL,
    status run_status NOT NULL DEFAULT 'queued',
    result_json JSONB,
    error_text TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE bg_removal_runs (
    id UUID PRIMARY KEY DEFAULT app_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    input_asset_id UUID NOT NULL REFERENCES assets(id),
    output_asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
    provider bg_provider NOT NULL,
    status run_status NOT NULL DEFAULT 'queued',
    error_text TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users (telegram_id);
CREATE INDEX IF NOT EXISTS idx_stripe_topup_history_telegram_id ON stripe_topup_history (telegram_id);
CREATE INDEX IF NOT EXISTS idx_stripe_topup_history_created_at ON stripe_topup_history (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_generation_jobs_status_queued ON telegram_generation_jobs (status, queued_at ASC);
CREATE INDEX IF NOT EXISTS idx_tg_generation_jobs_telegram_created ON telegram_generation_jobs (telegram_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_projects_owner_user_id ON projects (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_api_keys_hash ON project_api_keys (api_key_hash);
CREATE INDEX IF NOT EXISTS idx_project_api_keys_enabled ON project_api_keys (is_enabled);
CREATE INDEX IF NOT EXISTS idx_project_api_keys_last_used ON project_api_keys (last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_api_logs_created_at ON project_api_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_api_logs_project_created ON project_api_logs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_api_logs_level_created ON project_api_logs (level, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_assets_project_created ON assets (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_project_type_created ON assets (project_id, asset_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_checksum ON assets (checksum_sha256);

CREATE INDEX IF NOT EXISTS idx_generation_requests_project_created
    ON generation_requests (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_requests_user_created
    ON generation_requests (created_by_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generation_runs_request_created
    ON generation_runs (request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_runs_status_created
    ON generation_runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_runs_provider_created
    ON generation_runs (provider, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generation_outputs_run_variant
    ON generation_outputs (run_id, variant_no);

CREATE INDEX IF NOT EXISTS idx_analysis_runs_project_created
    ON analysis_runs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_status_created
    ON analysis_runs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bg_removal_runs_project_created
    ON bg_removal_runs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bg_removal_runs_status_created
    ON bg_removal_runs (status, created_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_set_updated_at ON users;
CREATE TRIGGER trg_users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS trg_projects_set_updated_at ON projects;
CREATE TRIGGER trg_projects_set_updated_at
BEFORE UPDATE ON projects
FOR EACH ROW
EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS trg_project_api_keys_set_updated_at ON project_api_keys;
CREATE TRIGGER trg_project_api_keys_set_updated_at
BEFORE UPDATE ON project_api_keys
FOR EACH ROW
EXECUTE PROCEDURE set_updated_at();
