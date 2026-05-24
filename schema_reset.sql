-- Destroys all AdReady schema objects from the current database.
-- Run this only if you want to reset the database and import schema.sql again.

DROP TABLE IF EXISTS bg_removal_runs CASCADE;
DROP TABLE IF EXISTS analysis_runs CASCADE;
DROP TABLE IF EXISTS generation_outputs CASCADE;
DROP TABLE IF EXISTS generation_runs CASCADE;
DROP TABLE IF EXISTS generation_requests CASCADE;
DROP TABLE IF EXISTS assets CASCADE;
DROP TABLE IF EXISTS project_api_logs CASCADE;
DROP TABLE IF EXISTS project_api_pipeline_policies CASCADE;
DROP TABLE IF EXISTS project_api_runtime_settings CASCADE;
DROP TABLE IF EXISTS project_api_keys CASCADE;
DROP TABLE IF EXISTS projects CASCADE;
DROP TABLE IF EXISTS telegram_generation_jobs CASCADE;
DROP TABLE IF EXISTS stripe_topup_history CASCADE;
DROP TABLE IF EXISTS topup_packages CASCADE;
DROP TABLE IF EXISTS user_sessions CASCADE;
DROP TABLE IF EXISTS integration_settings CASCADE;
DROP TABLE IF EXISTS plan_settings CASCADE;
DROP TABLE IF EXISTS users CASCADE;

DROP FUNCTION IF EXISTS set_updated_at() CASCADE;
DROP FUNCTION IF EXISTS app_uuid() CASCADE;

DROP TYPE IF EXISTS cta_text CASCADE;
DROP TYPE IF EXISTS lighting_focus CASCADE;
DROP TYPE IF EXISTS camera_angle CASCADE;
DROP TYPE IF EXISTS aspect_ratio CASCADE;
DROP TYPE IF EXISTS run_status CASCADE;
DROP TYPE IF EXISTS reference_mode CASCADE;
DROP TYPE IF EXISTS bg_provider CASCADE;
DROP TYPE IF EXISTS ai_provider CASCADE;
DROP TYPE IF EXISTS storage_provider CASCADE;
DROP TYPE IF EXISTS asset_type CASCADE;
DROP TYPE IF EXISTS project_status CASCADE;
DROP TYPE IF EXISTS user_role CASCADE;
