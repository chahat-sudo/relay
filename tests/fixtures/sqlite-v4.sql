-- Legacy SQLite v4 schema golden, without workspace row data.
PRAGMA foreign_keys=ON;
CREATE TABLE articles(id TEXT PRIMARY KEY,title TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,excerpt TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','published')),campaign_id TEXT REFERENCES campaigns(id),cta TEXT NOT NULL,origin TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,published_at TEXT);
CREATE TABLE campaigns(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,source TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','paused')),cost_cents INTEGER NOT NULL,fallback_id TEXT REFERENCES destinations(id),rules TEXT NOT NULL,postback_token TEXT NOT NULL,created_at TEXT NOT NULL, crawler_routing TEXT NOT NULL DEFAULT '{"enabled":false,"url":"","providers":["google","meta"]}');
CREATE TABLE clicks(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES campaigns(id),destination_id TEXT NOT NULL REFERENCES destinations(id),rule_name TEXT NOT NULL,visitor_hash TEXT NOT NULL,device TEXT NOT NULL,source TEXT NOT NULL,external_id TEXT NOT NULL,cost_cents INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE conversions(id TEXT PRIMARY KEY,click_id TEXT NOT NULL REFERENCES clicks(id),campaign_id TEXT NOT NULL REFERENCES campaigns(id),transaction_id TEXT NOT NULL,revenue_cents INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('approved','rejected')),created_at TEXT NOT NULL,UNIQUE(campaign_id,transaction_id));
CREATE TABLE crawler_requests(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES campaigns(id),provider TEXT NOT NULL CHECK(provider IN ('google','meta')),user_agent TEXT NOT NULL,destination_url TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE destinations(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','paused')),daily_cap INTEGER NOT NULL CHECK(daily_cap>=0),created_at TEXT NOT NULL);
CREATE TABLE intelligence_revisions(
        revision TEXT PRIMARY KEY,service TEXT NOT NULL,source TEXT NOT NULL,fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,ranges TEXT NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE telemetry_sessions(
        request_id TEXT PRIMARY KEY REFERENCES traffic_requests(id) ON DELETE CASCADE,token_hash TEXT NOT NULL,
        origin TEXT NOT NULL,expires_at TEXT NOT NULL,completed_at TEXT,payload_hash TEXT);
CREATE TABLE traffic_actions(
        id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES traffic_requests(id) ON DELETE CASCADE,
        action TEXT NOT NULL,created_at TEXT NOT NULL,reason TEXT NOT NULL);
CREATE TABLE traffic_assessments(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL REFERENCES traffic_requests(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,assessment TEXT NOT NULL);
CREATE TABLE traffic_challenges(
        token_hash TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES traffic_requests(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,completed_at TEXT);
CREATE TABLE traffic_config_history(sequence INTEGER PRIMARY KEY AUTOINCREMENT,policy_id TEXT NOT NULL REFERENCES traffic_policies(id),changed_at TEXT NOT NULL,raw_config TEXT NOT NULL);
CREATE TABLE traffic_labels(
        id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES traffic_requests(id) ON DELETE CASCADE,
        label TEXT NOT NULL,provenance TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE traffic_observations(
        id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES traffic_requests(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,created_at TEXT NOT NULL,schema_version INTEGER NOT NULL,facts TEXT NOT NULL);
CREATE TABLE traffic_policies(id TEXT PRIMARY KEY,policy TEXT NOT NULL);
CREATE TABLE traffic_requests(
        id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES campaigns(id),click_id TEXT REFERENCES clicks(id),
        source TEXT NOT NULL,external_id TEXT NOT NULL,created_at TEXT NOT NULL,context TEXT NOT NULL,
        destination_url TEXT,actual_action TEXT NOT NULL,mode TEXT NOT NULL,cost_cents INTEGER NOT NULL,
        collection TEXT NOT NULL,session_key TEXT NOT NULL,policy_id TEXT NOT NULL REFERENCES traffic_policies(id),rate_count INTEGER);
ALTER TABLE crawler_requests ADD COLUMN identity TEXT;
PRAGMA user_version=4;
