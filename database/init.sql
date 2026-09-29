-- ft_transcendence practice database schema
-- This file runs automatically when the postgres container starts for the first time.

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         VARCHAR(255) UNIQUE NOT NULL,
    username      VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255),            -- NULL for OAuth users (bcrypt hash for email/password users)
    github_id     INTEGER UNIQUE,          -- NULL for email/password users
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Index on email for fast lookups during login
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
